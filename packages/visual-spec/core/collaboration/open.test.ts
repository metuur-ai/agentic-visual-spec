/**
 * open.test.ts — the open-from-PR path (R-11.1 … R-11.4).
 *
 * Everything here drives the real `createOpenBody` through a recorded-response `gh`
 * executor: no network, no real `gh`, no fixtures of a shape GitHub does not send
 * (R-4.8 / R-12.3). The pull request bodies are produced by 8.2's own
 * `buildPullRequestBody`, so the round trip between the writer and this reader is
 * asserted rather than assumed (R-11.1).
 */
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config';
import type { CollaborationDocument } from './document-protocol';
import { serializeCollaborationDocument } from './document-protocol';
import type { DocumentStore } from './document-store';
import { resolveNodeIn } from './document-store';
import { createGitHubAdapter } from './github-adapter';
import type { GhExecutor, GhResult } from './github-executor';
import { type JobContext, type LifecycleState } from './job-hub';
import { buildPullRequestBody, openCommandFor } from './lifecycle';
import {
  OpenDocumentError,
  type OpenFailureReason,
  classifyBranchLookupFailure,
  createOpenBody,
  findPullNumberForBranch,
  parseOpenCommand,
  parseRepoFlag,
  parseServeCollaborationFlags,
  readPullRequestReference,
} from './open';

const REPO = { owner: 'acme', repo: 'docs', baseBranch: 'main' } as const;
const REPO_REF = { owner: 'acme', repo: 'docs' } as const;
const BRANCH = 'visual-spec/doc-1';

const ACCEPT_FLAG_VALUE = 'Accept: application/vnd.github+json';
const endpointOf = (args: string[]): string => args[args.indexOf(ACCEPT_FLAG_VALUE) + 1] as string;
const methodOf = (args: string[]): string => args[args.indexOf('--method') + 1] as string;

function recorder(responses: Array<Partial<GhResult>>) {
  const calls: Array<{ args: string[]; input?: string }> = [];
  let i = 0;
  const exec: GhExecutor = async (args, input) => {
    calls.push(input === undefined ? { args } : { args, input });
    const r = responses[i++] ?? {};
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: 'exitCode' in r ? (r.exitCode as number | null) : 0 };
  };
  return { exec, calls, endpoints: () => calls.map((c) => endpointOf(c.args)), methods: () => calls.map((c) => methodOf(c.args)) };
}

function makeDoc(overrides: Partial<CollaborationDocument> = {}): CollaborationDocument {
  return {
    documentId: 'doc-1',
    documentPath: 'documents/doc-1.json',
    title: 'Onboarding guide',
    frontmatter: {},
    nodes: [{ id: 'n-7', type: 'paragraph', version: 1, content: 'hello' }],
    doc: { root: { children: [{ id: 'n-7', type: 'paragraph', version: 1, content: 'hello' }] } },
    ...overrides,
  };
}

/** A `GET /pulls/:n` response whose body is what 8.2 actually writes (R-11.1). */
function pullResponse(doc: CollaborationDocument, overrides: { body?: string; number?: number } = {}): string {
  return JSON.stringify({
    number: overrides.number ?? 42,
    state: 'open',
    html_url: `https://github.com/acme/docs/pull/${overrides.number ?? 42}`,
    body:
      overrides.body ??
      buildPullRequestBody({
        repo: REPO_REF,
        branch: BRANCH,
        documentId: doc.documentId,
        documentPath: doc.documentPath,
        title: doc.title,
      }),
    head: { ref: BRANCH, sha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432' },
    base: { ref: 'main', sha: '5f2a1c9b8d4e6f0a1b2c3d4e5f60718293a4b5c6' },
  });
}

/** A `GET /contents/:path` response carrying a real serialized collaboration document. */
function contentsResponse(doc: CollaborationDocument): string {
  const content = serializeCollaborationDocument(doc);
  return JSON.stringify({
    name: `${doc.documentId}.json`,
    path: doc.documentPath,
    sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(content, 'utf8').toString('base64'),
  });
}

/** An empty store — the reviewer has never seen this document (R-11.2). */
function memoryStore(seed?: CollaborationDocument) {
  const docs = new Map<string, CollaborationDocument>();
  if (seed) docs.set(seed.documentId, seed);
  const store: DocumentStore = {
    async read(id) {
      return docs.get(id) ?? null;
    },
    async write(doc) {
      docs.set(doc.documentId, doc);
    },
    async list() {
      return [...docs.keys()].sort();
    },
    async resolveNode(id, nodeId) {
      const doc = docs.get(id);
      return doc ? resolveNodeIn(doc, nodeId) : { found: false };
    },
  };
  return { store, docs };
}

function context(): JobContext & { logs: string[]; states: LifecycleState[] } {
  const logs: string[] = [];
  const states: LifecycleState[] = [];
  return {
    documentId: 'doc-1',
    jobId: 'job-1',
    kind: 'sync',
    signal: new AbortController().signal,
    log: (text: string) => logs.push(text),
    setState: (state: LifecycleState) => states.push(state),
    now: () => 1_700_000_000_000,
    logs,
    states,
  };
}

type RunResult = {
  err: unknown;
  ctx: ReturnType<typeof context>;
  docs: Map<string, CollaborationDocument>;
  endpoints: () => string[];
  methods: () => string[];
};

async function run(
  responses: Array<Partial<GhResult>>,
  options: { seed?: CollaborationDocument; documentId?: string; pullNumber?: number } = {},
): Promise<RunResult> {
  const { exec, endpoints, methods } = recorder(responses);
  const { store, docs } = memoryStore(options.seed);
  const body = createOpenBody({ adapter: createGitHubAdapter(exec) })({
    documentId: options.documentId ?? 'doc-1',
    repo: { ...REPO },
    store,
    pullNumber: options.pullNumber ?? 42,
  });
  const ctx = context();
  let err: unknown;
  await body(ctx).catch((e: unknown) => {
    err = e;
  });
  return { err, ctx, docs, endpoints, methods };
}

const reasonOf = (err: unknown): OpenFailureReason | undefined =>
  err instanceof OpenDocumentError ? err.reason : undefined;

/* ================================================================== *
 * R-11.1 — one format: 8.2 writes it, 11.1 reads it back
 * ================================================================== */
describe('R-11.1 — the PR body carries repo, branch and document', () => {
  it('renders the repository, the branch, the document and the open command', () => {
    const doc = makeDoc();
    const prBody = buildPullRequestBody({
      repo: REPO_REF,
      branch: BRANCH,
      documentId: doc.documentId,
      documentPath: doc.documentPath,
      title: doc.title,
    });
    expect(prBody).toContain('acme/docs');
    expect(prBody).toContain(BRANCH);
    expect(prBody).toContain(doc.documentPath);
    expect(prBody).toContain(openCommandFor(REPO_REF, BRANCH, doc.documentId));
  });

  it('round-trips through the 5.1 trailer — the writer and this reader agree', () => {
    const doc = makeDoc();
    const pr = JSON.parse(pullResponse(doc)) as { body: string; head: { ref: string } };
    const reference = readPullRequestReference(
      {
        number: 42,
        headSha: 'sha',
        htmlUrl: '',
        state: 'open',
        body: pr.body,
        headBranch: pr.head.ref,
        baseBranch: 'main',
        merged: false,
        mergeable: true,
        mergeableState: 'clean',
      },
      REPO_REF,
    );
    expect(reference).toEqual({
      owner: 'acme',
      repo: 'docs',
      branch: BRANCH,
      documentId: 'doc-1',
      documentPath: 'documents/doc-1.json',
    });
  });

  it('parses the command it printed, so the CLI and the PR body cannot drift', () => {
    expect(parseOpenCommand(openCommandFor(REPO_REF, BRANCH, 'doc-1'))).toEqual({
      owner: 'acme',
      repo: 'docs',
      branch: BRANCH,
      documentId: 'doc-1',
    });
    expect(parseOpenCommand('visual-spec init .')).toBeNull();
  });
});

/* ================================================================== *
 * R-9.19 — the standalone CLI's `--repo` / `--base-branch` flags
 * ================================================================== */
describe('serve collaboration flags', () => {
  it('turns --repo owner/name into a collaboration config', () => {
    expect(parseServeCollaborationFlags('acme/docs', undefined)).toEqual({
      collaboration: { owner: 'acme', repo: 'docs' },
    });
  });

  it('leaves baseBranch unset so resolveConfig applies its own default', () => {
    const config = parseServeCollaborationFlags('acme/docs', undefined);
    expect(config?.collaboration && 'baseBranch' in config.collaboration).toBe(false);
    expect(resolveConfig(config ?? undefined).collaboration).toEqual({ owner: 'acme', repo: 'docs', baseBranch: 'main' });
  });

  it('honours --base-branch when given', () => {
    expect(parseServeCollaborationFlags('acme/docs', 'release')).toEqual({
      collaboration: { owner: 'acme', repo: 'docs', baseBranch: 'release' },
    });
    expect(resolveConfig(parseServeCollaborationFlags('acme/docs', 'release') ?? undefined).collaboration?.baseBranch).toBe('release');
  });

  it('leaves collaboration off when --repo is absent, base branch or not', () => {
    expect(parseServeCollaborationFlags(undefined, undefined)).toBeUndefined();
    expect(parseServeCollaborationFlags(undefined, 'release')).toBeUndefined();
    // Which is what the server was already doing with no config at all.
    expect(resolveConfig(undefined).collaboration).toBeNull();
  });

  it('rejects every malformed --repo so the CLI can print its usage line', () => {
    for (const bad of ['acme', 'a/b/c', '', '/docs', 'acme/', '/']) {
      expect(parseServeCollaborationFlags(bad, undefined)).toBeNull();
      expect(parseRepoFlag(bad)).toBeNull();
    }
  });

  it('shares one owner/name parser with `collab open`', () => {
    expect(parseRepoFlag('acme/docs')).toEqual(REPO_REF);
    expect(parseOpenCommand('visual-spec collab open --repo a/b/c --branch b --document d')).toBeNull();
  });
});

/* ================================================================== *
 * R-11.2 — open by PR reference, with nothing local to start from
 * ================================================================== */
describe('R-11.2 — opening by pull request reference', () => {
  it('fetches the canonical JSON off the branch into a store that had nothing', async () => {
    const doc = makeDoc();
    const r = await run([{ stdout: pullResponse(doc) }, { stdout: contentsResponse(doc) }]);

    expect(r.err).toBeUndefined();
    expect(r.endpoints()).toEqual([
      '/repos/acme/docs/pulls/42',
      `/repos/acme/docs/contents/documents/doc-1.json?ref=${BRANCH}`,
    ]);
    // The document the routes serve from `GET /__vs/collab/:id` is this one.
    const stored = r.docs.get('doc-1');
    expect(stored).toMatchObject({ documentId: 'doc-1', title: 'Onboarding guide' });
    expect(stored?.nodes).toEqual(doc.nodes);
    expect(stored?.doc).toEqual(doc.doc);
  });

  it('binds the fetched document to the pull request so comments and sync work', async () => {
    const doc = makeDoc();
    const r = await run([{ stdout: pullResponse(doc) }, { stdout: contentsResponse(doc) }]);
    expect((r.docs.get('doc-1') as { github?: unknown }).github).toEqual({
      owner: 'acme',
      repo: 'docs',
      branch: BRANCH,
      pullNumber: 42,
      headSha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',
      resolved: false,
    });
    expect(r.ctx.states).toEqual(['pr-open']);
  });

  it('refreshes a document that is already here from the branch (same PR)', async () => {
    const stale = makeDoc({
      title: 'Stale local copy',
      nodes: [{ id: 'n-7', type: 'paragraph', version: 1, content: 'old' }],
      github: { owner: 'acme', repo: 'docs', branch: BRANCH, pullNumber: 42, resolved: false },
    } as Partial<CollaborationDocument>);
    const fresh = makeDoc({ title: 'Onboarding guide' });
    const r = await run([{ stdout: pullResponse(fresh) }, { stdout: contentsResponse(fresh) }], { seed: stale });

    expect(r.err).toBeUndefined();
    expect(r.docs.get('doc-1')?.title).toBe('Onboarding guide');
    expect(r.docs.get('doc-1')?.nodes?.[0]?.content).toBe('hello');
  });

  it('refuses to re-point a document that is attached to a different pull request', async () => {
    const attached = makeDoc({
      github: { owner: 'acme', repo: 'docs', branch: BRANCH, pullNumber: 7, resolved: false },
    } as Partial<CollaborationDocument>);
    const r = await run([{ stdout: pullResponse(makeDoc()) }], { seed: attached });

    expect(reasonOf(r.err)).toBe('already_attached');
    expect((r.err as Error).message).toBe(
      'document "doc-1" is already attached to acme/docs#7 — it cannot be opened from acme/docs#42 as well.',
    );
    // Nothing was fetched and nothing was overwritten.
    expect(r.endpoints()).toEqual(['/repos/acme/docs/pulls/42']);
    expect(r.docs.get('doc-1')?.title).toBe('Onboarding guide');
  });

  it('resolves a branch to its open pull request — how the printed command finds a number', async () => {
    const { exec, endpoints } = recorder([{ stdout: `[${pullResponse(makeDoc())}]` }]);
    const found = await findPullNumberForBranch(createGitHubAdapter(exec), REPO_REF, BRANCH);
    expect(found).toBe(42);
    expect(endpoints()).toEqual([`/repos/acme/docs/pulls?state=open&head=acme:${BRANCH}`]);
  });

  it('answers null for a branch with no open pull request', async () => {
    const { exec } = recorder([{ stdout: '[]' }]);
    await expect(findPullNumberForBranch(createGitHubAdapter(exec), REPO_REF, BRANCH)).resolves.toBeNull();
  });
});

/* ================================================================== *
 * classifyBranchLookupFailure — the CLI's first-ever GitHub call, before a
 * pull number exists (src/cli.ts's `collab open`).
 * ================================================================== */
describe('classifyBranchLookupFailure — remediation for the branch-lookup path', () => {
  const ghFailure = (status: number, message: string): Partial<GhResult> => ({
    stdout: JSON.stringify({ message, status: String(status) }),
    stderr: `gh: ${message} (HTTP ${status})`,
    exitCode: 1,
  });

  it('reports an unrunnable gh as executor_unavailable, naming the branch, with the install/auth remediation', async () => {
    const { exec } = recorder([{ stdout: '', stderr: 'spawn gh ENOENT', exitCode: null }]);
    const err = await findPullNumberForBranch(createGitHubAdapter(exec), REPO_REF, BRANCH).catch((e) => e);
    const classified = classifyBranchLookupFailure(err, REPO_REF, BRANCH);
    expect(classified.reason).toBe('executor_unavailable');
    expect(classified.message).toBe(
      `cannot open acme/docs@${BRANCH}: the GitHub CLI could not be started — install \`gh\` and run \`gh auth login\` (read access is enough).`,
    );
  });

  it('reports a rejected credential as no_credential, naming the branch, with the gh auth login remediation', async () => {
    const { exec } = recorder([ghFailure(401, 'Bad credentials')]);
    const err = await findPullNumberForBranch(createGitHubAdapter(exec), REPO_REF, BRANCH).catch((e) => e);
    const classified = classifyBranchLookupFailure(err, REPO_REF, BRANCH);
    expect(classified.reason).toBe('no_credential');
    expect(classified.message).toBe(
      `cannot open acme/docs@${BRANCH}: GitHub rejected the credential (HTTP 401) — run \`gh auth login\` (read access is enough).`,
    );
  });
});

/* ================================================================== *
 * R-11.3 — read-only credentials are enough
 * ================================================================== */
describe('R-11.3 — open requires no write access', () => {
  it('issues GET requests only — no branch, no commit, no PR, no merge', async () => {
    const doc = makeDoc();
    const r = await run([{ stdout: pullResponse(doc) }, { stdout: contentsResponse(doc) }]);
    expect(r.methods()).toEqual(['GET', 'GET']);
    expect(r.endpoints().some((e) => /\/git\/refs|\/merge$/.test(e))).toBe(false);
  });
});

/* ================================================================== *
 * R-11.4 — every failure names its own cause
 * ================================================================== */
describe('R-11.4 — specific causes, never a generic failure', () => {
  const ghFailure = (status: number, message: string): Partial<GhResult> => ({
    stdout: JSON.stringify({ message, status: String(status) }),
    stderr: `gh: ${message} (HTTP ${status})`,
    exitCode: 1,
  });

  it('reports a 404 as "not found or no read access", naming the repository', async () => {
    const r = await run([ghFailure(404, 'Not Found')]);
    expect(reasonOf(r.err)).toBe('no_access');
    expect((r.err as Error).message).toBe(
      'cannot open acme/docs#42: not found (HTTP 404) — either it does not exist or this credential cannot read acme/docs.',
    );
  });

  it('reports a 403 as denied read access, distinct from a 404', async () => {
    const r = await run([ghFailure(403, 'Resource not accessible by personal access token')]);
    expect(reasonOf(r.err)).toBe('no_access');
    expect((r.err as Error).message).toBe(
      'cannot open acme/docs#42: read access denied (HTTP 403) — this credential can reach GitHub but not acme/docs.',
    );
  });

  it('separates a throttled 403 from a forbidden one — the permanent verdict is not reported for a transient limit', async () => {
    const r = await run([ghFailure(403, 'API rate limit exceeded for user ID 1234.')]);
    expect(reasonOf(r.err)).toBe('rate_limited');
    expect((r.err as Error).message).toBe(
      'cannot open acme/docs#42: GitHub is throttling this credential — wait and try again (the access itself is fine).',
    );
  });

  it('reads the secondary limit and the abuse-detection wording as the same throttle', async () => {
    const secondary = await run([ghFailure(403, 'You have exceeded a secondary rate limit. Please wait a few minutes.')]);
    expect(reasonOf(secondary.err)).toBe('rate_limited');
    const abuse = await run([ghFailure(403, 'You have triggered an abuse detection mechanism.')]);
    expect(reasonOf(abuse.err)).toBe('rate_limited');
  });

  it('reads a 429 as a throttle whatever the message says', async () => {
    const r = await run([ghFailure(429, 'Too Many Requests')]);
    expect(reasonOf(r.err)).toBe('rate_limited');
  });

  it('reports a rejected credential as no_credential, not as missing access', async () => {
    const r = await run([ghFailure(401, 'Bad credentials')]);
    expect(reasonOf(r.err)).toBe('no_credential');
    expect((r.err as Error).message).toContain('GitHub rejected the credential (HTTP 401)');
  });

  it('reports an unrunnable gh as executor_unavailable, not as missing access (R-4.10)', async () => {
    const r = await run([{ stdout: '', stderr: 'spawn gh ENOENT', exitCode: null }]);
    expect(reasonOf(r.err)).toBe('executor_unavailable');
    expect((r.err as Error).message).toBe(
      'cannot open acme/docs#42: the GitHub CLI could not be started — install `gh` and run `gh auth login` (read access is enough).',
    );
  });

  it('reports a pull request that is not a collaboration document', async () => {
    const r = await run([{ stdout: pullResponse(makeDoc(), { body: 'Bump lodash from 4.17.20 to 4.17.21.' }) }]);
    expect(reasonOf(r.err)).toBe('not_collaboration_document');
    expect((r.err as Error).message).toBe(
      'acme/docs#42 is not a visual-spec collaboration document — its body carries no visual-spec trailer.',
    );
  });

  it('reports a document-id mismatch by naming the id the pull request actually carries', async () => {
    const r = await run([{ stdout: pullResponse(makeDoc()) }], { documentId: 'other-doc' });
    expect(reasonOf(r.err)).toBe('document_id_mismatch');
    expect((r.err as Error).message).toBe(
      'acme/docs#42 carries document "doc-1", not "other-doc" — open it as "doc-1".',
    );
  });

  it('reports a trailer that names a file which is not on the branch', async () => {
    const r = await run([{ stdout: pullResponse(makeDoc()) }, { stdout: JSON.stringify({ message: 'Not Found', status: '404' }), stderr: 'gh: Not Found (HTTP 404)', exitCode: 1 }]);
    expect(reasonOf(r.err)).toBe('document_missing');
    expect((r.err as Error).message).toBe(
      `acme/docs#42 references documents/doc-1.json on ${BRANCH}, and there is no such file on that branch.`,
    );
  });

  it('falls back to open_failed for anything else, still carrying GitHub’s own words', async () => {
    const r = await run([ghFailure(500, 'Server Error')]);
    expect(reasonOf(r.err)).toBe('open_failed');
    expect((r.err as Error).message).toBe('cannot open acme/docs#42: Server Error');
  });
});
