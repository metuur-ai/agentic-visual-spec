import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GitHubError, createGitHubAdapter } from './github-adapter';
import { buildPullRequestBody } from './lifecycle';
import type { GhExecutor, GhResult } from './github-executor';
import { scrubCredentials } from './github-executor';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (rel: string): string => readFileSync(`${here}${rel}`, 'utf8');
const fixture = (name: string): string => read(`fixtures/${name}`);

const repo = { owner: 'acme', repo: 'docs' };

type Call = { args: string[]; input?: string };

/**
 * A recorded-response executor (R-4.8 / R-12.3). Queue one `GhResult` per
 * expected `gh` invocation; every argv is captured so the endpoint the adapter
 * chose can be asserted — that is the only place a wrong endpoint shows up.
 */
function recorder(responses: Array<Partial<GhResult>>): { exec: GhExecutor; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const exec: GhExecutor = async (args, input) => {
    calls.push(input === undefined ? { args } : { args, input });
    const r = responses[i++] ?? {};
    // `exitCode: null` is meaningful (gh could not be started) — do not coalesce it.
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: 'exitCode' in r ? (r.exitCode as number | null) : 0 };
  };
  return { exec, calls };
}

const ACCEPT_FLAG_VALUE = 'Accept: application/vnd.github+json';
/** The endpoint always follows the Accept header value in the argv. */
const endpointOf = (args: string[]): string => args[args.indexOf(ACCEPT_FLAG_VALUE) + 1] as string;

describe('createGitHubAdapter — branch, commit, PR (R-4.3)', () => {
  it('reads a branch head through the git refs API', async () => {
    const { exec, calls } = recorder([{ stdout: fixture('git-ref.json') }]);
    const ref = await createGitHubAdapter(exec).getBranch(repo, 'main');

    expect(calls[0]?.args).toEqual([
      'api',
      '--method',
      'GET',
      '-H',
      ACCEPT_FLAG_VALUE,
      '/repos/acme/docs/git/ref/heads/main',
    ]);
    expect(ref).toEqual({ ref: 'refs/heads/main', sha: '5f2a1c9b8d4e6f0a1b2c3d4e5f60718293a4b5c6' });
  });

  it('creates a branch by POSTing a ref', async () => {
    const { exec, calls } = recorder([{ stdout: fixture('create-ref.json') }]);
    const ref = await createGitHubAdapter(exec).createBranch(repo, 'vs/doc-1', '5f2a1c9b8d4e6f0a1b2c3d4e5f60718293a4b5c6');

    expect(endpointOf(calls[0]?.args ?? [])).toBe('/repos/acme/docs/git/refs');
    expect(calls[0]?.args).toContain('POST');
    expect(JSON.parse(calls[0]?.input ?? '{}')).toEqual({
      ref: 'refs/heads/vs/doc-1',
      sha: '5f2a1c9b8d4e6f0a1b2c3d4e5f60718293a4b5c6',
    });
    expect(ref.ref).toBe('refs/heads/vs/doc-1');
  });

  it('commits through the Contents API with base64 content', async () => {
    const { exec, calls } = recorder([{ stdout: fixture('contents-put.json') }]);
    const result = await createGitHubAdapter(exec).commitFile(repo, {
      path: 'documents/doc-1.json',
      content: '{"documentId":"doc-1"}\r\n',
      message: 'docs: update doc-1',
      branch: 'vs/doc-1',
      sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    });

    expect(calls[0]?.args).toEqual([
      'api',
      '--method',
      'PUT',
      '-H',
      ACCEPT_FLAG_VALUE,
      '/repos/acme/docs/contents/documents/doc-1.json',
      '--input',
      '-',
    ]);
    const body = JSON.parse(calls[0]?.input ?? '{}') as Record<string, string>;
    // The CRLF survives the encode untouched — this is the byte fidelity that a
    // `git add` shell-out would destroy via .gitattributes normalization.
    expect(Buffer.from(body.content as string, 'base64').toString('utf8')).toBe('{"documentId":"doc-1"}\r\n');
    expect(body.branch).toBe('vs/doc-1');
    expect(body.sha).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    expect(result).toEqual({
      path: 'documents/doc-1.json',
      commitSha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',
      contentSha: 'bb11cc22dd33ee44ff5566778899aabbccddeeff',
    });
  });

  it('omits sha when creating a new file', async () => {
    const { exec, calls } = recorder([{ stdout: fixture('contents-put.json') }]);
    await createGitHubAdapter(exec).commitFile(repo, {
      path: 'documents/doc-1.json',
      content: '{}',
      message: 'create',
      branch: 'vs/doc-1',
    });
    expect(JSON.parse(calls[0]?.input ?? '{}')).not.toHaveProperty('sha');
  });

  it('reads a file back and decodes the wrapped base64', async () => {
    const { exec, calls } = recorder([{ stdout: fixture('contents-get.json') }]);
    const file = await createGitHubAdapter(exec).getFile(repo, 'documents/doc-1.json', 'vs/doc-1');

    expect(endpointOf(calls[0]?.args ?? [])).toBe('/repos/acme/docs/contents/documents/doc-1.json?ref=vs/doc-1');
    expect(file?.content).toBe('{\n  "documentId": "doc-1"\n}\n');
    expect(file?.sha).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  });

  it('reports a missing file as null, not an error', async () => {
    const { exec } = recorder([{ stdout: fixture('error-not-found.json'), stderr: 'gh: Not Found (HTTP 404)', exitCode: 1 }]);
    await expect(createGitHubAdapter(exec).getFile(repo, 'nope.json', 'main')).resolves.toBeNull();
  });

  it('opens a pull request', async () => {
    const { exec, calls } = recorder([{ stdout: fixture('pull-create.json') }]);
    const pr = await createGitHubAdapter(exec).createPullRequest(repo, {
      title: 'Doc: onboarding guide',
      head: 'vs/doc-1',
      base: 'main',
      body: 'Open with visual-spec.',
    });

    expect(endpointOf(calls[0]?.args ?? [])).toBe('/repos/acme/docs/pulls');
    expect(JSON.parse(calls[0]?.input ?? '{}')).toEqual({
      title: 'Doc: onboarding guide',
      head: 'vs/doc-1',
      base: 'main',
      body: 'Open with visual-spec.',
    });
    expect(pr).toEqual({
      number: 42,
      headSha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',
      htmlUrl: 'https://github.com/acme/docs/pull/42',
      state: 'open',
    });
  });
});

describe('createGitHubAdapter — issue comments (R-4.4)', () => {
  it('creates a comment on the issue endpoint, never the review endpoint', async () => {
    const { exec, calls } = recorder([{ stdout: fixture('issue-comment-create.json') }]);
    const created = await createGitHubAdapter(exec).createIssueComment(repo, 42, 'Tighten this paragraph.');

    const endpoint = endpointOf(calls[0]?.args ?? []);
    expect(endpoint).toBe('/repos/acme/docs/issues/42/comments');
    expect(endpoint).not.toContain('/pulls/42/comments'); // review comments — 422 on a JSON payload
    expect(JSON.parse(calls[0]?.input ?? '{}')).toEqual({ body: 'Tighten this paragraph.' });
    expect(created.id).toBe(900001);
    expect(created.user).toBe('reviewer-rita');
  });

  it('updates a comment by id', async () => {
    const { exec, calls } = recorder([{ stdout: fixture('issue-comment-update.json') }]);
    const updated = await createGitHubAdapter(exec).updateIssueComment(repo, 900001, 'Tighten this paragraph, and drop the second sentence.');

    expect(calls[0]?.args).toContain('PATCH');
    expect(endpointOf(calls[0]?.args ?? [])).toBe('/repos/acme/docs/issues/comments/900001');
    expect(updated.updatedAt).toBe('2026-08-07T11:30:00Z');
  });

  it('deletes a comment by id and tolerates the empty 204 body', async () => {
    const { exec, calls } = recorder([{ stdout: '' }]);
    await expect(createGitHubAdapter(exec).deleteIssueComment(repo, 900001)).resolves.toBeUndefined();

    expect(calls[0]?.args).toEqual([
      'api',
      '--method',
      'DELETE',
      '-H',
      ACCEPT_FLAG_VALUE,
      '/repos/acme/docs/issues/comments/900001',
    ]);
    expect(calls[0]?.input).toBeUndefined();
  });

  it('surfaces a failed delete as a structured error', async () => {
    const { exec } = recorder([{ stdout: fixture('error-not-found.json'), stderr: 'gh: Not Found (HTTP 404)', exitCode: 1 }]);
    await expect(createGitHubAdapter(exec).deleteIssueComment(repo, 1)).rejects.toMatchObject({
      operation: 'deleteIssueComment',
      status: 404,
    });
  });
});

describe('createGitHubAdapter — pagination (R-4.5)', () => {
  it('follows page= until a short page and returns every comment', async () => {
    const { exec, calls } = recorder([
      { stdout: fixture('issue-comments-page-1.json') },
      { stdout: fixture('issue-comments-page-2.json') },
    ]);
    const comments = await createGitHubAdapter(exec).listIssueComments(repo, 42);

    expect(calls).toHaveLength(2);
    expect(endpointOf(calls[0]?.args ?? [])).toBe('/repos/acme/docs/issues/42/comments?per_page=100&page=1');
    expect(endpointOf(calls[1]?.args ?? [])).toBe('/repos/acme/docs/issues/42/comments?per_page=100&page=2');
    expect(comments).toHaveLength(102);
    expect(comments[0]?.id).toBe(800000);
    expect(comments[101]?.id).toBe(800101);
    // A comment authored on github.com with no trailer still comes back.
    expect(comments[100]?.body).toBe('This one was written on github.com and carries no trailer.');
  });

  it('stops after one page when the first page is short', async () => {
    const { exec, calls } = recorder([{ stdout: fixture('issue-comments-page-2.json') }]);
    const comments = await createGitHubAdapter(exec).listIssueComments(repo, 42);
    expect(calls).toHaveLength(1);
    expect(comments).toHaveLength(2);
  });

  it('throws rather than looping forever when a short page never arrives', async () => {
    // Every page is full, so the normal exit condition never fires. The loop must
    // stop on its own and fail loudly — a truncated list would read as deleted
    // comments to the resolve/reply path.
    const fullPage = fixture('issue-comments-page-1.json');
    const { exec, calls } = recorder(Array.from({ length: 200 }, () => ({ stdout: fullPage })));

    await expect(createGitHubAdapter(exec).listIssueComments(repo, 42)).rejects.toThrow(/did not terminate within 100 pages/);
    expect(calls).toHaveLength(100);
  });
});

describe('createGitHubAdapter — merge (R-4.7)', () => {
  it('merges a pull request', async () => {
    const { exec, calls } = recorder([{ stdout: fixture('pull-merge.json') }]);
    const result = await createGitHubAdapter(exec).mergePullRequest(repo, 42, 'squash');

    expect(calls[0]?.args).toContain('PUT');
    expect(endpointOf(calls[0]?.args ?? [])).toBe('/repos/acme/docs/pulls/42/merge');
    expect(JSON.parse(calls[0]?.input ?? '{}')).toEqual({ merge_method: 'squash' });
    expect(result).toEqual({
      merged: true,
      sha: '0011223344556677889900aabbccddeeff001122',
      message: 'Pull Request successfully merged',
    });
  });
});

describe('createGitHubAdapter — structured errors (R-4.9, R-4.10)', () => {
  it('carries operation, status and the GitHub error code', async () => {
    const { exec } = recorder([{ stdout: fixture('error-ref-exists.json'), stderr: 'gh: Reference already exists (HTTP 422)', exitCode: 1 }]);

    const err = await createGitHubAdapter(exec)
      .createBranch(repo, 'vs/doc-1', 'deadbeef')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitHubError);
    const ghErr = err as GitHubError;
    expect(ghErr.operation).toBe('createBranch');
    expect(ghErr.status).toBe(422);
    expect(ghErr.ghErrorCode).toBe('already_exists');
    expect(ghErr.message).toBe('Reference already exists');
  });

  it('scrubs token-shaped material out of gh stderr', async () => {
    const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const { exec } = recorder([{ stdout: '', stderr: `gh: request failed with Authorization: Bearer ${token} (HTTP 401)`, exitCode: 1 }]);

    const err = (await createGitHubAdapter(exec)
      .getBranch(repo, 'main')
      .catch((e: unknown) => e)) as GitHubError;

    expect(err.status).toBe(401);
    expect(err.message).not.toContain(token);
    expect(err.message).not.toContain('ghp_');
    expect(err.message).toContain('[redacted]');
  });

  it('reports an unrunnable gh as unavailable, not as an operation failure', async () => {
    const { exec } = recorder([{ stdout: '', stderr: 'spawn gh ENOENT', exitCode: null }]);

    const err = (await createGitHubAdapter(exec)
      .getBranch(repo, 'main')
      .catch((e: unknown) => e)) as GitHubError;

    expect(err.ghErrorCode).toBe('executor_unavailable');
    expect(err.status).toBeUndefined();
    expect(err.message).toContain('GitHub CLI could not be started');
  });
});

describe('scrubCredentials', () => {
  it('redacts classic and fine-grained tokens', () => {
    expect(scrubCredentials('ghp_AAAAAAAAAAAAAAAAAAAA and github_pat_BBBBBBBBBBBBBBBBBBBB')).toBe(
      '[redacted] and [redacted]',
    );
  });

  it('leaves ordinary diagnostics alone', () => {
    expect(scrubCredentials('Reference already exists')).toBe('Reference already exists');
  });
});

/*
 * `listPullRequests` — the projection the header's count and list read.
 *
 * Asserted against `fixtures/pulls-list.json`, which is a captured list-endpoint
 * payload rather than a hand-written one: the fields that matter here (`head.ref`
 * beside `head.label`, a `null` body) are exactly the ones a hand-written double
 * gets wrong, and one did.
 */
describe('createGitHubAdapter — listPullRequests (R-7.4 / R-7.5)', () => {
  const list = () => createGitHubAdapter(recorder([{ stdout: fixture('pulls-list.json') }]).exec).listPullRequests(repo);

  /*
   * The fork case. GitHub owner-qualifies `head.label` (`contributor:patch-1`) and
   * leaves `head.ref` bare (`patch-1`); the adapter maps `ref`. A double that mocked
   * `headBranch: 'contributor:patch-1'` was teaching the opposite.
   */
  it('maps the bare head ref of a fork pull request, never the owner-qualified label', async () => {
    const raw = JSON.parse(fixture('pulls-list.json')) as { head: { ref: string; label: string } }[];
    expect(raw[0]?.head.label).toBe('contributor:patch-1');

    const pulls = await list();
    expect(pulls[0]?.headBranch).toBe('patch-1');
    expect(pulls.map((p) => p.headBranch)).not.toContain('contributor:patch-1');
  });

  it('resolves documentId from the body trailer, on the server', async () => {
    const pulls = await list();
    expect(pulls.find((p) => p.number === 11)?.documentId).toBe('doc-1');
  });

  it('reads back what buildPullRequestBody writes — one format, one parser', async () => {
    const body = buildPullRequestBody({
      repo: { owner: 'acme', repo: 'docs' },
      branch: 'visual-spec/doc-9',
      documentId: 'doc-9',
      documentPath: 'docs/doc-9.md',
      title: 'Spec: doc-9',
    });
    const payload = JSON.stringify([{ number: 9, body, head: { ref: 'visual-spec/doc-9' }, base: { ref: 'main' } }]);
    const { exec } = recorder([{ stdout: payload }]);
    const pulls = await createGitHubAdapter(exec).listPullRequests(repo);
    expect(pulls[0]?.documentId).toBe('doc-9');
  });

  it('leaves documentId undefined for a pull request that carries no trailer', async () => {
    const pulls = await list();
    // Number 12 has a `null` body; number 9 has prose and no trailer.
    expect(pulls.find((p) => p.number === 12)?.documentId).toBeUndefined();
    expect(pulls.find((p) => p.number === 9)?.documentId).toBeUndefined();
  });

  it('answers undefined rather than throwing on a malformed trailer', async () => {
    // `documentId=%zz` is not decodable — `decodeURIComponent` throws on it, and a
    // throw here would take the whole list down over one hand-edited pull request.
    const pulls = await list();
    expect(pulls.find((p) => p.number === 10)?.documentId).toBeUndefined();
    expect(pulls).toHaveLength(4);
  });

  /*
   * R-7.5 is structural, not a convention: the client cannot parse a body it was
   * never given. So the assertion is that no body reaches the projection at all,
   * not merely that nothing currently reads one.
   */
  it('carries no pull request body text whatsoever', async () => {
    const pulls = await list();
    for (const pull of pulls) expect(Object.keys(pull)).not.toContain('body');
    const serialized = JSON.stringify(pulls);
    for (const fragment of ['visual-spec collab open', 'Bumps eslint', 'Half-written by hand', '<!--']) {
      expect(serialized).not.toContain(fragment);
    }
  });
});

describe('execution-path invariants', () => {
  // Comments are stripped first: the modules *document* the git-subprocess and
  // GraphQL prohibitions in prose, and prose must not satisfy or break the check.
  const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
  const source = [stripComments(read('github-adapter.ts')), stripComments(read('github-executor.ts'))].join('\n');

  it('spawns no git subprocess — commits go through the Contents API only (LLD §7)', () => {
    // `git add` applies .gitattributes CRLF normalization, which would break the
    // publish byte-verification step permanently.
    expect(source).not.toMatch(/spawn\(\s*['"`]git['"`]/);
    expect(source).not.toMatch(/\bexecFile\(\s*['"`]git['"`]/);
    expect(source).not.toMatch(/\bgit (add|commit|push|checkout|clone)\b/);
  });

  it('spawns exactly one binary, gh (R-4.1)', () => {
    const spawned = [...source.matchAll(/spawn\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
    expect(spawned).toEqual(['gh']);
  });

  /*
   * This assertion used to be "no GraphQL anywhere". It was correct while comments
   * were PR *issue* comments, which have no resolvable-thread state to reach for.
   * Review comments do, and `isResolved` exists **only** on GraphQL — verified
   * against a live pull request: the REST review-comment payload carries no
   * `resolved` field and no thread id.
   *
   * So R-4.6 narrowed rather than disappeared: GraphQL reads resolution and does
   * nothing else. The blanket ban is replaced by the two checks below, because a
   * ban that no longer matches the design would simply be deleted by whoever hit
   * it — and then nothing would guard the part that still matters.
   */
  it('sends exactly one GraphQL operation, and it is a query (R-4.6)', () => {
    const operations = [...source.matchAll(/\b(query|mutation)\s*\(/g)].map((m) => m[1]);
    expect(operations).toEqual(['query']);
  });

  it('never writes over GraphQL — resolving happens on github.com (R-5.13)', () => {
    // The mutation names that would reintroduce a second resolution writer.
    expect(source).not.toMatch(/resolveReviewThread|unresolveReviewThread|addPullRequestReview/i);
  });

  it('uses no bespoke HTTP client (R-4.2)', () => {
    expect(source).not.toMatch(/\bfetch\(|node:https?\b|require\(['"]https?['"]\)|axios|octokit/i);
  });

  it('imports only node builtins — core/ is Node-reachable from the CLI', () => {
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);
    for (const spec of imports) {
      const local = spec.startsWith('.');
      expect(local || spec.startsWith('node:')).toBe(true);
    }
  });
});

/*
 * A repository renamed or transferred on GitHub answers 301 to a write, with a body whose
 * whole message is "Moved Permanently". That reached the reviewer verbatim, on the one
 * action that matters, saying nothing about what to do — and the surface looked healthy up
 * to that point because `gh` follows the redirect on reads.
 */
describe('R-4.9 — a moved repository says so, not "Moved Permanently"', () => {
  /*
   * `gh`'s real output for a write against a renamed repository. Two details matter and
   * both were got wrong the first time: the status is **307** (a method-preserving
   * redirect, which `gh` will not follow for a POST) and the stderr carries no
   * parentheses, so the `(HTTP nnn)` regex that reads every other failure found nothing.
   */
  const moved = {
    exitCode: 1,
    stdout: JSON.stringify({ message: 'Moved Permanently', url: 'https://api.github.com/repositories/1276508763' }),
    stderr: 'gh: HTTP 307',
  };

  it('names the repository and what to change', async () => {
    const { exec } = recorder([moved]);
    const adapter = createGitHubAdapter(exec);

    await expect(
      adapter.createReviewComment({ owner: 'metuur', repo: 'agentic-visual-spec' }, 1, {
        path: 'docs/spec.md',
        body: 'a comment',
        commitId: 'abc1234',
      }),
    ).rejects.toMatchObject({
      status: 307,
      ghErrorCode: 'repo_moved',
      message: expect.stringContaining('metuur/agentic-visual-spec'),
    });
  });

  it('explains why reading kept working, so the silence up to now is not a second mystery', async () => {
    const { exec } = recorder([moved]);
    const adapter = createGitHubAdapter(exec);

    const err = await adapter
      .createReviewComment({ owner: 'metuur', repo: 'agentic-visual-spec' }, 1, { path: 'a.md', body: 'x', commitId: 'c' })
      .then(() => null, (e: Error) => e);

    expect(err?.message).toMatch(/renamed or transferred/i);
    expect(err?.message).toMatch(/origin/);
    expect(err?.message).not.toBe('Moved Permanently');
  });

  /* The read's redirect is 301, and it says the same thing. */
  it('answers for the read redirect too', async () => {
    const { exec } = recorder([
      { exitCode: 1, stdout: JSON.stringify({ message: 'Moved Permanently' }), stderr: 'gh: Moved Permanently (HTTP 301)' },
    ]);
    await expect(
      createGitHubAdapter(exec).createReviewComment({ owner: 'acme', repo: 'docs' }, 1, { path: 'a.md', body: 'x', commitId: 'c' }),
    ).rejects.toMatchObject({ status: 301, ghErrorCode: 'repo_moved' });
  });

  /* The parenthesised form is what every other failure uses; it must keep working. */
  it('still reads the status out of the parenthesised form', async () => {
    const { exec } = recorder([
      { exitCode: 1, stdout: JSON.stringify({ message: 'Validation Failed' }), stderr: 'gh: Validation Failed (HTTP 422)' },
    ]);
    await expect(
      createGitHubAdapter(exec).createReviewComment({ owner: 'acme', repo: 'docs' }, 1, { path: 'a.md', body: 'x', commitId: 'c' }),
    ).rejects.toMatchObject({ status: 422, message: 'Validation Failed' });
  });

  /* Every other status keeps GitHub's own words — R-11.4's rule, unchanged. */
  it('leaves other failures alone', async () => {
    const { exec } = recorder([
      { exitCode: 1, stdout: JSON.stringify({ message: 'Not Found' }), stderr: 'gh: Not Found (HTTP 404)' },
    ]);
    const adapter = createGitHubAdapter(exec);

    await expect(
      adapter.createReviewComment({ owner: 'acme', repo: 'docs' }, 1, { path: 'a.md', body: 'x', commitId: 'c' }),
    ).rejects.toMatchObject({ status: 404, message: 'Not Found' });
  });
});
