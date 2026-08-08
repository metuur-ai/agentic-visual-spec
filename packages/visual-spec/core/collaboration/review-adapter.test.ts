/**
 * review-adapter.test.ts — the review-comment half of the adapter (R-4.4, R-4.5,
 * R-4.11 … R-4.15, R-12.11, R-12.12).
 *
 * Every case runs against an injected executor (R-4.8 / R-12.3), so nothing here
 * touches the network. The payloads are the ones GitHub actually returned for the
 * spike PR — including the `422` body, which is the reason the file-level fallback
 * exists at all.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type GhExecutor, type GhResult } from './github-executor';
import { GitHubError, createGitHubAdapter } from './github-adapter';

const REPO = { owner: 'metuur-ai', repo: 'visual-spec-collaboration-test' };

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

/** Record the argv of every call, and reply from a queue. */
function scriptedExec(replies: GhResult[]): { exec: GhExecutor; calls: string[][] } {
  const calls: string[][] = [];
  const queue = [...replies];
  const exec: GhExecutor = async (args) => {
    calls.push(args);
    return queue.shift() ?? { stdout: '[]', stderr: '', exitCode: 0 };
  };
  return { exec, calls };
}

const ok = (stdout: string): GhResult => ({ stdout, stderr: '', exitCode: 0 });

describe('listReviewComments', () => {
  it('hits the review-comment endpoint, not the issue-comment one', async () => {
    const { exec, calls } = scriptedExec([ok(fixture('review-comments-list.json'))]);
    const out = await createGitHubAdapter(exec).listReviewComments(REPO, 9);

    expect(out).toHaveLength(4);
    const endpoint = calls[0]?.find((a) => a.startsWith('/repos/'));
    expect(endpoint).toContain('/pulls/9/comments');
    expect(endpoint).not.toContain('/issues/');
  });

  it('does not send sort or direction — the default order is what threading needs', async () => {
    const { exec, calls } = scriptedExec([ok('[]')]);
    await createGitHubAdapter(exec).listReviewComments(REPO, 9);
    const argv = calls[0]?.join(' ') ?? '';
    expect(argv).not.toContain('sort=');
    expect(argv).not.toContain('direction=');
  });

  it('accumulates every page before returning (R-5.17 / R-12.11)', async () => {
    const page = (ids: number[], inReplyTo: number | null = null) =>
      ok(JSON.stringify(ids.map((id) => ({ id, in_reply_to_id: inReplyTo, path: 'a.md', line: 1 }))));
    // A full page forces a second request; the reply lives on that second page.
    const full = Array.from({ length: 100 }, (_, i) => i + 1);
    const { exec, calls } = scriptedExec([page(full), page([500], 1)]);

    const out = await createGitHubAdapter(exec).listReviewComments(REPO, 9);
    expect(calls).toHaveLength(2);
    expect(out).toHaveLength(101);
    // The reply arrived on page 2 — had we grouped page 1 alone, it would be lost.
    expect(out.at(-1)?.inReplyToId).toBe(1);
  });

  it('stops on a short page', async () => {
    const { exec, calls } = scriptedExec([ok('[{"id":1}]')]);
    await createGitHubAdapter(exec).listReviewComments(REPO, 9);
    expect(calls).toHaveLength(1);
  });
});

describe('createReviewComment', () => {
  it('sends path, body and the supplied head sha (R-4.13)', async () => {
    let sent = '';
    const argv: string[] = [];
    const exec: GhExecutor = async (args, input) => {
      argv.push(...args);
      sent = input ?? '';
      return ok('{"id":1,"path":"doc.md","line":23}');
    };
    await createGitHubAdapter(exec).createReviewComment(REPO, 9, {
      path: 'doc.md',
      body: 'hola',
      commitId: 'deadbeef',
      line: 23,
    });

    expect(argv.join(' ')).toContain('/pulls/9/comments');
    const payload = JSON.parse(sent) as Record<string, unknown>;
    expect(payload).toMatchObject({ path: 'doc.md', body: 'hola', commit_id: 'deadbeef', line: 23, side: 'RIGHT' });
  });

  it('omits the line and declares subject_type=file for the fallback (R-4.14)', async () => {
    let sent = '';
    const exec: GhExecutor = async (_args, input) => {
      sent = input ?? '';
      return ok('{"id":2,"subject_type":"file","path":"doc.md","line":1}');
    };
    const out = await createGitHubAdapter(exec).createReviewComment(REPO, 9, {
      path: 'doc.md',
      body: 'sin ancla',
      commitId: 'deadbeef',
    });
    const payload = JSON.parse(sent) as Record<string, unknown>;
    expect(payload.subject_type).toBe('file');
    expect(payload.line).toBeUndefined();
    expect(out.subjectType).toBe('file');
  });

  it('sends a multi-line range only when start differs from end', async () => {
    let sent = '';
    const exec: GhExecutor = async (_args, input) => {
      sent = input ?? '';
      return ok('{"id":3}');
    };
    const adapter = createGitHubAdapter(exec);

    await adapter.createReviewComment(REPO, 9, { path: 'd.md', body: 'x', commitId: 'a', line: 20, startLine: 18 });
    expect((JSON.parse(sent) as Record<string, unknown>).start_line).toBe(18);

    await adapter.createReviewComment(REPO, 9, { path: 'd.md', body: 'x', commitId: 'a', line: 20, startLine: 20 });
    // A one-line range must not carry start_line — GitHub rejects start == line.
    expect((JSON.parse(sent) as Record<string, unknown>).start_line).toBeUndefined();
  });

  it('surfaces the out-of-diff 422 as a GitHubError the caller can branch on', async () => {
    const exec: GhExecutor = async () => ({
      stdout: fixture('error-line-not-in-diff.json'),
      stderr: 'gh: Validation Failed (HTTP 422)',
      exitCode: 1,
    });
    const err = await createGitHubAdapter(exec)
      .createReviewComment(REPO, 9, { path: 'doc.md', body: 'x', commitId: 'a', line: 7 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(422);
    // The adapter must not silently retry: the caller owns the disclose-then-degrade
    // policy, and burying it here would hide the fallback from the user.
    expect((err as GitHubError).operation).toBe('createReviewComment');
  });
});

describe('replyToReviewComment', () => {
  it('posts to the replies endpoint of the root comment', async () => {
    const { exec, calls } = scriptedExec([ok('{"id":9,"in_reply_to_id":1}')]);
    const out = await createGitHubAdapter(exec).replyToReviewComment(REPO, 9, 1, 'respuesta');
    expect(calls[0]?.join(' ')).toContain('/pulls/9/comments/1/replies');
    expect(out.inReplyToId).toBe(1);
  });
});

describe('listThreadResolution', () => {
  it('reads resolution over graphql and joins on the REST integer id (R-4.15)', async () => {
    const { exec, calls } = scriptedExec([ok(fixture('review-threads-graphql.json'))]);
    const out = await createGitHubAdapter(exec).listThreadResolution(REPO, 9);

    expect(calls[0]?.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(out).toHaveLength(2);
    // 3740897151 is the root of the line thread in the recorded REST list.
    const line = out.find((t) => t.rootCommentId === 3740897151);
    expect(line).toEqual({ rootCommentId: 3740897151, isResolved: true, isOutdated: true });
  });

  it('fails on a graphql error even though it arrives with HTTP 200 (R-4.11 / R-12.12)', async () => {
    // gh exits non-zero, and there is no `(HTTP nnn)` marker for the REST classifier.
    const exec: GhExecutor = async () => ({
      stdout: '{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","message":"Could not resolve to a Repository"}]}',
      stderr: 'gh: Could not resolve to a Repository',
      exitCode: 1,
    });
    const err = await createGitHubAdapter(exec).listThreadResolution(REPO, 9).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).ghErrorCode).toBe('graphql_error');
    expect((err as GitHubError).message).toContain('Could not resolve to a Repository');
  });

  it('fails on a PARTIAL graphql error that also returns usable data', async () => {
    // The dangerous shape: exit code alone is not the only guard, because a caller
    // reading `data` would see a half-answer that looks complete.
    const exec: GhExecutor = async () => ({
      stdout: JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } },
        errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }],
      }),
      stderr: '',
      exitCode: 0, // success exit, errors in the body — the case exit codes miss
    });
    const err = await createGitHubAdapter(exec).listThreadResolution(REPO, 9).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).message).toContain('Resource not accessible');
  });

  it('skips a thread whose root id cannot be read rather than inventing a join key', async () => {
    const exec: GhExecutor = async () =>
      ok(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false },
                  nodes: [{ isResolved: true, isOutdated: false, comments: { nodes: [] } }],
                },
              },
            },
          },
        }),
      );
    expect(await createGitHubAdapter(exec).listThreadResolution(REPO, 9)).toEqual([]);
  });

  it('follows the cursor across pages', async () => {
    const pageOf = (databaseId: number, hasNextPage: boolean) =>
      ok(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage, endCursor: 'CURSOR2' },
                  nodes: [{ isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId }] } }],
                },
              },
            },
          },
        }),
      );
    const { exec, calls } = scriptedExec([pageOf(1, true), pageOf(2, false)]);
    const out = await createGitHubAdapter(exec).listThreadResolution(REPO, 9);

    expect(out.map((t) => t.rootCommentId)).toEqual([1, 2]);
    expect(calls[1]?.join(' ')).toContain('after=CURSOR2');
  });
});
