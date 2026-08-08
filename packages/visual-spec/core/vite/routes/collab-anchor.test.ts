/**
 * collab-anchor.test.ts — how a collaborative comment gets its anchor, and what happens
 * when the anchor is refused.
 *
 * WHAT THIS FILE USED TO ASSERT. It pinned `nodeId` anchor capture on the creation path:
 * the block's text and its projected version, stamped into a trailer at creation time.
 * That premise is retired with the JSON document format (Unit 2) — there is no canonical
 * JSON to carry a `nodeId`, and a comment is now anchored by `path` + `line` (R-0.3).
 * The suite is rewritten in place rather than weakened, because the *question* it asks —
 * "is the anchor really captured on the live path, or only in a module nobody calls?" —
 * is the same one, and the two rules that answer it now are the ones most easily lost:
 *
 *   R-4.13  the `commit_id` is re-read at creation time, never reused from open
 *   R-7.13  a line outside the diff degrades to a file-level comment exactly ONCE,
 *           and the caller is told
 *   R-7.12  that file-level comment restates the selection and its line number, so the
 *           reference survives for a reader on github.com
 *   R-5.11  a retried create cannot produce a duplicate comment
 *
 * The 422 is not invented here: it is `fixtures/error-line-not-in-diff.json`, recorded
 * from GitHub against a real pull request, and the error this suite throws is built from
 * that file's own `status` and `errors[0].code`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CollaborationRecord } from '../../collaboration/document-record';
import type { CollaborationPreflight } from '../../collaboration/credentials';
import type { CollaborationStore } from '../../collaboration/record-store';
import { GitHubError, type CreateReviewCommentInput, type GitHubAdapter } from '../../collaboration/github-adapter';
import { createJobHubRegistry } from '../../collaboration/job-hub';
import type { ResolvedVisualSpecConfig } from '../../config';
import type { ReviewComment, ReviewThreadRecord } from '../../collaboration/review-comments';
import { createCollabRoutes } from './collab';
import type { CollabAuthorizer } from './collab';

/** Test double. This suite is about anchoring, not gating; the router requires one. */
const TEST_ALLOW_ALL: CollabAuthorizer = () => ({ ok: true });

const REPO = { owner: 'acme', repo: 'specs', baseBranch: 'main' } as const;
const ENABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: { ...REPO } };
const OK_PREFLIGHT: CollaborationPreflight = {
  available: true,
  source: 'gh-auth-state',
  login: 'octocat',
  scopes: ['repo'],
  repo: { ...REPO },
};

const HEAD_SHA = 'd63287a5a1702a511ac4f2145dab0d33a48a673e';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../collaboration/fixtures');

/**
 * The recorded refusal, rebuilt exactly as `github-adapter`'s classifier would hand it to
 * this layer: the fixture's `status` and `errors[0].code`, and its `message`.
 *
 * `errors[0].field` — `pull_request_review_thread.line`, the field that actually names the
 * cause — is deliberately NOT part of the assertion, because `GitHubError` does not carry
 * it. That is why the route discriminates on status, and this construction is the proof
 * that it has nothing finer to go on.
 */
const LINE_NOT_IN_DIFF = (() => {
  const raw = JSON.parse(readFileSync(resolve(fixturesDir, 'error-line-not-in-diff.json'), 'utf8')) as {
    message: string;
    status: string;
    errors: { code: string; field: string }[];
  };
  expect(raw.errors[0]?.field).toBe('pull_request_review_thread.line');
  return new GitHubError('createReviewComment', raw.message, Number(raw.status), raw.errors[0]?.code);
})();

const doc: CollaborationRecord = {
  documentId: 'doc-1',
  documentPath: 'docs/spec.md',
  title: 'Spec',
  markdown: '# Onboarding guide\n\nhello\n',
  github: { owner: 'acme', repo: 'specs', branch: 'vs/doc-1', pullNumber: 7, resolved: false },
};

function documents(): CollaborationStore {
  return {
    async read(id) {
      return id === 'doc-1' ? doc : null;
    },
    async write() {},
    async list() {
      return ['doc-1'];
    },
  };
}

/**
 * The adapter double. `createFails` is consumed one entry per attempt, which is what makes
 * "exactly once" observable: one queued 422 fails the first create and lets the second
 * through, so a route that never retried, or retried forever, fails here.
 */
function harness(options: { createFails?: (Error | null)[]; delayMs?: number } = {}) {
  const creates: CreateReviewCommentInput[] = [];
  const pulls: number[] = [];
  const createFails = [...(options.createFails ?? [])];
  let nextId = 900100;

  const adapter = {
    async getPullRequest(_repo: unknown, pullNumber: number) {
      pulls.push(pullNumber);
      return { number: pullNumber, headSha: HEAD_SHA, state: 'open' };
    },
    async createReviewComment(_repo: unknown, _pullNumber: number, input: CreateReviewCommentInput) {
      creates.push(input);
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      const fail = createFails.shift();
      if (fail) throw fail;
      nextId += 1;
      const created: ReviewComment = {
        id: nextId,
        inReplyToId: null,
        path: input.path,
        line: input.line ?? null,
        startLine: input.startLine ?? null,
        originalLine: input.line ?? 0,
        side: 'RIGHT',
        subjectType: input.line === undefined ? 'file' : 'line',
        commitId: input.commitId,
        originalCommitId: input.commitId,
        diffHunk: '',
        body: input.body,
        user: 'octocat',
        createdAt: 'T0',
        updatedAt: 'T0',
        htmlUrl: `https://github.com/acme/specs/pull/7#discussion_r${nextId}`,
      };
      return created;
    },
  } as unknown as GitHubAdapter;

  const routes = createCollabRoutes({
    jobs: createJobHubRegistry(),
    config: () => ENABLED,
    documents,
    adapter: () => adapter,
    preflight: async () => OK_PREFLIGHT,
    authorize: TEST_ALLOW_ALL,
  });
  return { routes, creates, pulls, dispose: () => routes.dispose() };
}

const post = (routes: ReturnType<typeof harness>['routes'], body: Record<string, unknown>) =>
  routes.handle({ method: 'POST', pathname: '/doc-1/comments', query: {}, body });

describe('R-4.13 — the commit_id is the head sha, read at creation time', () => {
  it('reads the pull request on every create and sends its head as commit_id', async () => {
    const h = harness();
    await post(h.routes, { comment: 'tighten this', startLine: 12 });
    await post(h.routes, { comment: 'and this', startLine: 20 });
    expect(h.pulls).toEqual([7, 7]);
    expect(h.creates.map((c) => c.commitId)).toEqual([HEAD_SHA, HEAD_SHA]);
    h.dispose();
  });

  it('sends the same fresh sha on the degraded retry — the retry is not a second policy', async () => {
    const h = harness({ createFails: [LINE_NOT_IN_DIFF] });
    await post(h.routes, { comment: 'tighten this', startLine: 12 });
    expect(h.creates).toHaveLength(2);
    expect(h.creates[1]?.commitId).toBe(HEAD_SHA);
    // One read for the whole logical create, not one per attempt.
    expect(h.pulls).toEqual([7]);
    h.dispose();
  });
});

describe('R-7.13 — a line the diff does not cover degrades once, and says so', () => {
  it('retries as a file-level comment and reports that it degraded, with GitHub’s cause', async () => {
    const h = harness({ createFails: [LINE_NOT_IN_DIFF] });
    const res = (await post(h.routes, { comment: 'tighten this', startLine: 12, selectedText: 'The reviewer reads this block.' })) as {
      status: number;
      json: { ok: boolean; comment: ReviewThreadRecord; degraded?: { to: string; reason: string } };
    };

    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.degraded).toEqual({ to: 'file', reason: 'Validation Failed' });

    // Attempt 1 carried the line; attempt 2 omitted it, which is how the adapter is told
    // to send `subject_type: file` (R-4.14).
    expect(h.creates[0]).toMatchObject({ line: 12, startLine: 12 });
    expect(h.creates[1]?.line).toBeUndefined();
    expect(res.json.comment.target).toEqual({ path: 'docs/spec.md', kind: 'file' });
    h.dispose();
  });

  it('retries EXACTLY once — a second refusal is a failure, not a third attempt', async () => {
    const h = harness({ createFails: [LINE_NOT_IN_DIFF, LINE_NOT_IN_DIFF] });
    const res = await post(h.routes, { comment: 'tighten this', startLine: 12 });
    expect(h.creates).toHaveLength(2);
    expect(res.status).toBe(422);
    expect((res.json as { error: string }).error).toBe('Validation Failed');
    h.dispose();
  });

  it('does not degrade on a refusal that is not a 422 — that is a real failure', async () => {
    const h = harness({ createFails: [new GitHubError('createReviewComment', 'Resource not accessible', 403)] });
    const res = await post(h.routes, { comment: 'tighten this', startLine: 12 });
    expect(h.creates).toHaveLength(1);
    expect(res.status).toBe(403);
    h.dispose();
  });

  /*
   * R-7.13's other half: "SHALL NOT discard the text the user typed". The degraded body
   * ends with the comment exactly as it was written — no truncation, no rewording — so a
   * client that shows the disclosure is showing it about a comment that still says what
   * the user said.
   */
  it('keeps the user’s text intact inside the degraded body', async () => {
    const h = harness({ createFails: [LINE_NOT_IN_DIFF] });
    await post(h.routes, { comment: 'tighten this paragraph, it repeats §3', startLine: 12 });
    expect(h.creates[1]?.body.endsWith('tighten this paragraph, it repeats §3')).toBe(true);
    h.dispose();
  });
});

describe('R-7.12 — a file-level comment restates the reference it lost', () => {
  it('names the path and the line, and quotes the selected text', async () => {
    const h = harness({ createFails: [LINE_NOT_IN_DIFF] });
    await post(h.routes, { comment: 'tighten this', startLine: 12, selectedText: 'The reviewer reads this block.' });
    const body = h.creates[1]!.body;
    expect(body).toContain('docs/spec.md');
    expect(body).toContain('line 12');
    expect(body).toContain('> The reviewer reads this block.');
    h.dispose();
  });

  it('names a range when the selection spans lines', async () => {
    const h = harness({ createFails: [LINE_NOT_IN_DIFF] });
    await post(h.routes, { comment: 'c', startLine: 12, endLine: 15 });
    expect(h.creates[1]!.body).toContain('lines 12–15');
    h.dispose();
  });

  it('still names the line when the client sent no selected text — the line is the reference', async () => {
    const h = harness({ createFails: [LINE_NOT_IN_DIFF] });
    await post(h.routes, { comment: 'c', startLine: 12 });
    expect(h.creates[1]!.body).toContain('line 12');
    expect(h.creates[1]!.body.endsWith('\n\nc')).toBe(true);
    h.dispose();
  });

  /*
   * A document-level comment was never anchored to a line, so it has no reference to
   * restate. Prefixing one would be a claim about a selection the user never made.
   */
  it('leaves a genuinely document-level comment’s body untouched', async () => {
    const h = harness();
    await post(h.routes, { comment: 'overall: good' });
    expect(h.creates[0]?.body).toBe('overall: good');
    expect(h.creates[0]?.line).toBeUndefined();
    h.dispose();
  });
});

describe('R-5.11 — a retried create cannot produce a duplicate', () => {
  it('a retry under the same key joins the first attempt instead of posting again', async () => {
    // The requirement's own case: the first request is still in flight (the client gave
    // up waiting), and the retry arrives before it answers.
    const h = harness({ delayMs: 5 });
    const first = post(h.routes, { comment: 'tighten this', startLine: 12, idempotencyKey: 'k-1' });
    const second = post(h.routes, { comment: 'tighten this', startLine: 12, idempotencyKey: 'k-1' });
    const [a, b] = await Promise.all([first, second]);

    expect(h.creates).toHaveLength(1);
    expect(a.json).toBe(b.json);

    // And after it has answered: a retry of an answer the client never received still
    // resolves to the comment that already exists.
    const third = await post(h.routes, { comment: 'tighten this', startLine: 12, idempotencyKey: 'k-1' });
    expect(h.creates).toHaveLength(1);
    expect(third.json).toBe(a.json);
    h.dispose();
  });

  it('a different key is a different comment, and no key dedupes nothing', async () => {
    const h = harness();
    await post(h.routes, { comment: 'one', startLine: 12, idempotencyKey: 'k-1' });
    await post(h.routes, { comment: 'two', startLine: 12, idempotencyKey: 'k-2' });
    await post(h.routes, { comment: 'three', startLine: 12 });
    await post(h.routes, { comment: 'three', startLine: 12 });
    expect(h.creates).toHaveLength(4);
    h.dispose();
  });

  /*
   * A failed create must stay retryable: pinning the failure under its key would turn one
   * transient 403 into a comment the user can never post, and the text they typed is
   * still sitting in the panel waiting to be sent again.
   */
  it('a failed create is not remembered, so the same key retries for real', async () => {
    const h = harness({ createFails: [new GitHubError('createReviewComment', 'Resource not accessible', 403)] });
    const failed = await post(h.routes, { comment: 'tighten this', startLine: 12, idempotencyKey: 'k-1' });
    expect(failed.status).toBe(403);
    const retried = await post(h.routes, { comment: 'tighten this', startLine: 12, idempotencyKey: 'k-1' });
    expect(retried.status).toBe(200);
    expect(h.creates).toHaveLength(2);
    h.dispose();
  });
});
