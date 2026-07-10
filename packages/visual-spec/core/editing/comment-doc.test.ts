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

  // R-2.4 — setStatus writes result atomically when provided
  it('setStatus with result writes both status and result atomically (R-2.4)', () => {
    let doc = addComment(parseDoc(null), rec({ id: 'c-r' }));
    doc = setStatus(doc, 'c-r', 'applied', 'Added keyboard shortcut docs');
    const c = doc.comments[0]!;
    expect(c.status).toBe('applied');
    expect(c.result).toBe('Added keyboard shortcut docs');
  });

  it('setStatus without result leaves existing result value untouched (R-2.4)', () => {
    let doc = addComment(parseDoc(null), rec({ id: 'c-keep', status: 'applied', result: 'prior summary' }));
    doc = setStatus(doc, 'c-keep', 'applied');
    expect(doc.comments[0]!.result).toBe('prior summary');
  });

  // R-2.1 / R-2.2 / R-2.3 — result field round-trip for new-shape and legacy records
  it('round-trips result field for new-shape records', () => {
    const withResult = rec({ id: 'c-res', status: 'applied', result: 'Added keyboard shortcut section' });
    const doc = addComment(parseDoc(null), withResult);
    const [parsed] = parseDoc(serializeDoc(doc)).comments;
    expect(parsed!.result).toBe('Added keyboard shortcut section');
  });

  it('new-shape record without result parses without error', () => {
    const noResult = rec({ id: 'c-nores' });
    const doc = addComment(parseDoc(null), noResult);
    const [parsed] = parseDoc(serializeDoc(doc)).comments;
    expect(parsed!.result).toBeUndefined();
  });

  it('legacy record with result field preserves it across upgrade (R-2.2)', () => {
    const legacy = JSON.stringify({
      version: 1,
      comments: [
        {
          id: 'c-leg-res',
          file: 'tasks/post-it-notes',
          anchor: { heading: 'AC', line: 5, snippet: 'a note' },
          comment: 'fix this',
          status: 'applied',
          result: 'Fixed the heading',
          ts: '2026-06-20T00:00:00Z',
        },
      ],
    });
    const [c] = parseDoc(legacy).comments;
    expect(c!.result).toBe('Fixed the heading');
  });

  it('legacy record without result parses without error (R-2.3)', () => {
    const legacy = JSON.stringify({
      version: 1,
      comments: [
        {
          id: 'c-leg-nores',
          file: 'tasks/notes',
          anchor: { line: 1 },
          comment: 'fix',
          status: 'open',
          ts: '2026-06-20T00:00:00Z',
        },
      ],
    });
    const [c] = parseDoc(legacy).comments;
    expect(c!.result).toBeUndefined();
  });
});
