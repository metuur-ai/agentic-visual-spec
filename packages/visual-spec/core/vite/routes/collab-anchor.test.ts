/**
 * collab-anchor.test.ts — task 7.3, wiring proof #1.
 *
 * Task 6.1 shipped `captureTargetText` and `collabNodeVersion` correct and *uncalled*.
 * This suite asserts they are now on the live creation path: what
 * `POST /__vs/collab/:id/comments` hands to the comment store must carry the block's
 * current text and its projected version, taken from the document at that moment.
 *
 * These are behavioural assertions, not source greps — the expected values are read
 * from the document fixture, so deleting the call fails here even if the import stays.
 */
import { describe, expect, it } from 'vitest';
import { TARGET_TEXT_MAX } from '../../collaboration/anchor-resolution';
import type { CollaborationDocument } from '../../collaboration/document-protocol';
import type { CollaborationPreflight } from '../../collaboration/credentials';
import type { DocumentStore } from '../../collaboration/document-store';
import { createJobHubRegistry } from '../../collaboration/job-hub';
import type { ResolvedVisualSpecConfig } from '../../config';
import type { CommentDoc, CommentRecord } from '../../editing/comment-doc';
import { createCollabRoutes } from './collab';
import type { CommentDocStore } from './comments';

const REPO = { owner: 'acme', repo: 'specs', baseBranch: 'main' } as const;
const ENABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: { ...REPO } };
const OK_PREFLIGHT: CollaborationPreflight = {
  available: true,
  source: 'gh-auth-state',
  login: 'octocat',
  scopes: ['repo'],
  repo: { ...REPO },
};

const LONG = 'word '.repeat(80).trim();

const doc: CollaborationDocument = {
  documentId: 'doc-1',
  documentPath: 'docs/spec.md',
  title: 'Spec',
  frontmatter: {},
  nodes: [
    { id: 'n-1', type: 'paragraph', version: 4, content: 'The reviewer reads this block.' },
    { id: 'n-2', type: 'paragraph', version: 1, content: LONG },
    // No projection entry for `n-3`; it exists only in the tree.
  ],
  doc: {
    root: {
      type: 'root',
      children: [
        { type: 'paragraph', version: 1, $: { nodeId: 'n-1' }, children: [{ type: 'text', text: 'The reviewer reads this block.' }] },
        { type: 'paragraph', version: 1, $: { nodeId: 'n-2' }, children: [{ type: 'text', text: LONG }] },
        { type: 'paragraph', version: 1, $: { nodeId: 'n-3' }, children: [{ type: 'text', text: 'Unprojected block.' }] },
      ],
    },
  },
  github: { owner: 'acme', repo: 'specs', branch: 'vs/doc-1', pullNumber: 7 },
};

function documents(): DocumentStore {
  return {
    async read(id) {
      return id === 'doc-1' ? doc : null;
    },
    async write() {},
    async list() {
      return ['doc-1'];
    },
    async resolveNode() {
      return { found: false };
    },
  };
}

function harness() {
  const saved: CommentRecord[] = [];
  const store: CommentDocStore = {
    async read(): Promise<CommentDoc> {
      return { version: 1, comments: saved };
    },
    async write() {},
    async addComment(record) {
      saved.push(record);
      return { ...record, id: `c-0000000${saved.length}` };
    },
    async updateComment() {
      return null;
    },
  };
  const jobs = createJobHubRegistry();
  const routes = createCollabRoutes({
    jobs,
    config: () => ENABLED,
    documents,
    commentStore: () => store,
    preflight: async () => OK_PREFLIGHT,
    now: () => '2026-08-07T00:00:00.000Z',
  });
  return { routes, saved, dispose: () => routes.dispose() };
}

const post = (routes: ReturnType<typeof harness>['routes'], body: Record<string, unknown>) =>
  routes.handle({ method: 'POST', pathname: '/doc-1/comments', query: {}, body });

/** The trailer fields a saved record carries. */
const collabOf = (record: CommentRecord) => (record as { collab?: Record<string, string> }).collab ?? {};

describe('R-6.5 / R-7.5 — comment creation captures its anchor', () => {
  it('records `nodeId` as primary identity', async () => {
    const h = harness();
    await post(h.routes, { comment: 'looks wrong', nodeId: 'n-1' });
    expect(collabOf(h.saved[0]!).nodeId).toBe('n-1');
    h.dispose();
  });

  it('captureTargetText IS CALLED: the trailer carries the block text read from the document', async () => {
    const h = harness();
    await post(h.routes, { comment: 'looks wrong', nodeId: 'n-1' });
    // Exactly the fixture's own content — nothing the route could have invented.
    expect(collabOf(h.saved[0]!).text).toBe('The reviewer reads this block.');
    h.dispose();
  });

  it('the captured text is clamped to the trailer budget', async () => {
    const h = harness();
    await post(h.routes, { comment: 'c', nodeId: 'n-2' });
    expect(collabOf(h.saved[0]!).text).toHaveLength(TARGET_TEXT_MAX);
    expect(LONG.length).toBeGreaterThan(TARGET_TEXT_MAX);
    h.dispose();
  });

  it('the projected version is recorded, so R-6.3 has two versions to compare', async () => {
    const h = harness();
    await post(h.routes, { comment: 'c', nodeId: 'n-1' });
    // 4 is the `nodes` projection version, NOT the serialized node's own `version: 1`.
    expect(collabOf(h.saved[0]!).nodeVersion).toBe('4');
    h.dispose();
  });

  it('an unprojected node records its text but no version — nothing is fabricated', async () => {
    const h = harness();
    await post(h.routes, { comment: 'c', nodeId: 'n-3' });
    expect(collabOf(h.saved[0]!)).toEqual({ nodeId: 'n-3', text: 'Unprojected block.' });
    h.dispose();
  });

  it('a nodeId that is not in the document records neither text nor version', async () => {
    const h = harness();
    await post(h.routes, { comment: 'c', nodeId: 'n-gone' });
    expect(collabOf(h.saved[0]!)).toEqual({ nodeId: 'n-gone' });
    h.dispose();
  });

  it('a document-level comment (no nodeId) carries no anchor fields at all — R-5.7', async () => {
    const h = harness();
    await post(h.routes, { comment: 'general note' });
    expect((h.saved[0] as { collab?: unknown }).collab).toBeUndefined();
    h.dispose();
  });
});
