import { describe, expect, it } from 'vitest';
import type { CommentDoc } from '../../editing/comment-doc';
import { type CommentDocStore, handleCommentsRequest } from './comments';

function memoryStore(): CommentDocStore {
  let doc: CommentDoc = { version: 1, comments: [] };
  return {
    async read() {
      return doc;
    },
    async write(d) {
      doc = d;
    },
  };
}

describe('handleCommentsRequest', () => {
  it('add (legacy md body) → list (by file) → patch → delete', async () => {
    const store = memoryStore();

    const add = await handleCommentsRequest(store, 'POST', '/add', {}, {
      file: 'tasks/post-it-notes', // surface id, no extension
      heading: 'Acceptance Criteria',
      line: 42,
      snippet: 'The user can pin a note',
      comment: 'cover keyboard shortcut too',
      id: 'c-deadbeef',
    });
    expect(add.status).toBe(200);
    expect((add.json as { id: string }).id).toBe('c-deadbeef');

    // Legacy body normalizes to a range target on the real .md path.
    const all0 = (await handleCommentsRequest(store, 'GET', '/all', {}, {})).json as CommentDoc;
    expect(all0.comments[0]!.target).toMatchObject({ path: 'tasks/post-it-notes.md', kind: 'range', startLine: 42 });
    expect(all0.comments[0]!.workflow).toBe('visual-spec');

    const list = await handleCommentsRequest(store, 'GET', '', { path: 'tasks/post-it-notes.md' }, {});
    expect((list.json as unknown[]).length).toBe(1);

    const otherFile = await handleCommentsRequest(store, 'GET', '', { path: 'nope.md' }, {});
    expect((otherFile.json as unknown[]).length).toBe(0);

    const patch = await handleCommentsRequest(store, 'PATCH', '/c-deadbeef', {}, { status: 'applied' });
    expect(patch.status).toBe(200);
    const all = await handleCommentsRequest(store, 'GET', '/all', {}, {});
    expect((all.json as CommentDoc).comments[0]!.status).toBe('applied');

    const del = await handleCommentsRequest(store, 'DELETE', '/c-deadbeef', {}, {});
    expect(del.status).toBe(200);
    const empty = await handleCommentsRequest(store, 'GET', '', {}, {});
    expect((empty.json as unknown[]).length).toBe(0);
  });

  it('auto-generates an id and timestamp when omitted', async () => {
    const store = memoryStore();
    await handleCommentsRequest(store, 'POST', '/add', {}, { path: 'a.md', comment: 'x' }, () => 'T0');
    const all = (await handleCommentsRequest(store, 'GET', '/all', {}, {})).json as CommentDoc;
    expect(all.comments[0]!.id).toMatch(/^c-[a-f0-9]{8}$/);
    expect(all.comments[0]!.ts).toBe('T0');
  });

  it('accepts a generic body: workflow tag, folder + range targets', async () => {
    const store = memoryStore();
    await handleCommentsRequest(store, 'POST', '/add', {}, {
      path: 'src/auth',
      kind: 'folder',
      workflow: 'architecture-review',
      comment: 'this module needs an owner',
      id: 'c-folder01',
    });
    await handleCommentsRequest(store, 'POST', '/add', {}, {
      path: 'src/auth/login.ts',
      kind: 'range',
      startLine: 10,
      endLine: 20,
      snippet: 'function login(',
      endSnippet: '}',
      selectedContent: 'function login() { ... }',
      comment: 'validate input here',
      id: 'c-range01',
    });
    const all = (await handleCommentsRequest(store, 'GET', '/all', {}, {})).json as CommentDoc;
    const folder = all.comments.find((c) => c.id === 'c-folder01')!;
    expect(folder).toMatchObject({ workflow: 'architecture-review', target: { path: 'src/auth', kind: 'folder' } });
    const range = all.comments.find((c) => c.id === 'c-range01')!;
    expect(range.target).toMatchObject({ kind: 'range', startLine: 10, endLine: 20, snippet: 'function login(' });
    expect(range.selectedContent).toBe('function login() { ... }');
  });
});
