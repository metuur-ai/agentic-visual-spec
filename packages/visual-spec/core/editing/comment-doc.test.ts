import { describe, expect, it } from 'vitest';
import {
  type CommentRecord,
  addComment,
  listComments,
  openByPath,
  openByWorkflow,
  parseDoc,
  removeComment,
  serializeDoc,
  setStatus,
} from './comment-doc';

const rec = (over: Partial<CommentRecord> = {}): CommentRecord => ({
  id: 'c-11112222',
  workflow: 'visual-spec',
  target: { path: 'tasks/post-it-notes.md', kind: 'range', startLine: 42, snippet: 'The user can pin a note' },
  comment: 'also cover the keyboard shortcut',
  status: 'open',
  ts: '2026-06-20T00:00:00Z',
  ...over,
});

describe('comment-doc', () => {
  it('round-trips through serialize → parse', () => {
    const doc = addComment(parseDoc(null), rec());
    expect(parseDoc(serializeDoc(doc))).toEqual(doc);
  });

  it('parseDoc tolerates empty / missing input', () => {
    expect(parseDoc(null)).toEqual({ version: 1, comments: [] });
    expect(parseDoc('')).toEqual({ version: 1, comments: [] });
    expect(parseDoc('{}')).toEqual({ version: 1, comments: [] });
  });

  it('upgrades legacy {file, anchor} records on read', () => {
    const legacy = JSON.stringify({
      version: 1,
      comments: [
        {
          id: 'c-old',
          file: 'tasks/post-it-notes', // surface id, no extension
          anchor: { heading: 'Acceptance Criteria', line: 42, snippet: 'pin a note' },
          comment: 'cover the shortcut',
          status: 'open',
          ts: '2026-06-20T00:00:00Z',
        },
      ],
    });
    const [c] = parseDoc(legacy).comments;
    expect(c!.workflow).toBe('visual-spec');
    expect(c!.target).toEqual({
      path: 'tasks/post-it-notes.md', // .md restored
      kind: 'range',
      startLine: 42,
      snippet: 'pin a note',
      heading: 'Acceptance Criteria',
    });
  });

  it('lists by path and groups open comments by path and workflow', () => {
    let doc = parseDoc(null);
    doc = addComment(doc, rec({ id: 'c-1', target: { path: 'a.md', kind: 'file' } }));
    doc = addComment(doc, rec({ id: 'c-2', target: { path: 'a.md', kind: 'file' }, status: 'applied' }));
    doc = addComment(doc, rec({ id: 'c-3', target: { path: 'b.md', kind: 'file' }, workflow: 'uncle-dev-research' }));

    expect(listComments(doc, 'a.md')).toHaveLength(2);

    const byPath = openByPath(doc);
    expect(Object.keys(byPath).sort()).toEqual(['a.md', 'b.md']);
    expect(byPath['a.md']).toHaveLength(1); // applied one excluded

    const byWorkflow = openByWorkflow(doc);
    expect(Object.keys(byWorkflow).sort()).toEqual(['uncle-dev-research', 'visual-spec']);
  });

  it('advances status and removes', () => {
    let doc = addComment(parseDoc(null), rec({ id: 'c-x' }));
    doc = setStatus(doc, 'c-x', 'applied');
    expect(doc.comments[0]!.status).toBe('applied');
    doc = removeComment(doc, 'c-x');
    expect(doc.comments).toHaveLength(0);
  });
});
