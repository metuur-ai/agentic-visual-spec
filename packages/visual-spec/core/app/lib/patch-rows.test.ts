import { describe, expect, it } from 'vitest';

import { patchRows } from './patch-rows';

/** Build a patch the way `apply.ts` does, so the tests exercise the real shape. */
function patch(body: string): string {
  return `Index: doc.md\n===================================================================\n--- doc.md\n+++ doc.md\n${body}`;
}

describe('patchRows — a unified patch re-shaped into before | after', () => {
  it('pairs a replaced line so both versions sit on one row', () => {
    const { hunks } = patchRows(patch('@@ -1,3 +1,3 @@\n ctx\n-one paragraph per idea\n+one paragraph per idea, and no more\n tail\n'));

    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.rows).toEqual([
      { kind: 'context', oldNo: 1, newNo: 1, text: 'ctx' },
      { kind: 'change', oldNo: 2, newNo: 2, before: 'one paragraph per idea', after: 'one paragraph per idea, and no more' },
      { kind: 'context', oldNo: 3, newNo: 3, text: 'tail' },
    ]);
  });

  it('pairs a multi-line rewrite positionally rather than listing all removals then all additions', () => {
    const { hunks } = patchRows(patch('@@ -1,2 +1,2 @@\n-a old\n-b old\n+a new\n+b new\n'));

    // The point of the whole module: 2 rows the reader scans across, not 4 they match up.
    expect(hunks[0]!.rows).toEqual([
      { kind: 'change', oldNo: 1, newNo: 1, before: 'a old', after: 'a new' },
      { kind: 'change', oldNo: 2, newNo: 2, before: 'b old', after: 'b new' },
    ]);
  });

  it('leaves the surplus side unpaired when the runs are uneven', () => {
    const { hunks } = patchRows(patch('@@ -1,1 +1,3 @@\n-single\n+first\n+second\n+third\n'));

    expect(hunks[0]!.rows).toEqual([
      { kind: 'change', oldNo: 1, newNo: 1, before: 'single', after: 'first' },
      { kind: 'add', newNo: 2, text: 'second' },
      { kind: 'add', newNo: 3, text: 'third' },
    ]);
  });

  it('numbers each side independently once the sides drift apart', () => {
    const { hunks } = patchRows(patch('@@ -10,4 +10,3 @@\n keep\n-gone\n after\n more\n'));

    const rows = hunks[0]!.rows;
    expect(rows[1]).toEqual({ kind: 'remove', oldNo: 11, text: 'gone' });
    // The removal advanced the old file only; the new side is now one behind.
    expect(rows[2]).toEqual({ kind: 'context', oldNo: 12, newNo: 11, text: 'after' });
  });

  it('drops the "no newline" marker instead of rendering it as a line of the document', () => {
    const { hunks } = patchRows(patch('@@ -1,1 +1,1 @@\n-old\n+new\n\\ No newline at end of file\n'));

    expect(hunks[0]!.rows).toEqual([{ kind: 'change', oldNo: 1, newNo: 1, before: 'old', after: 'new' }]);
  });

  it('keeps the real line numbers of a region far into the file', () => {
    // Starts at line 47 — everything above it is absent from the patch and unrecoverable,
    // so the numbers are the only thing telling the reader where they are.
    const { hunks } = patchRows(patch('@@ -47,1 +47,1 @@\n-a\n+b\n'));

    expect(hunks[0]!.oldStart).toBe(47);
    expect(hunks[0]!.rows[0]).toEqual({ kind: 'change', oldNo: 47, newNo: 47, before: 'a', after: 'b' });
  });

  it('returns no hunks for a patch truncated mid-stream rather than throwing', () => {
    // `apply.ts` slices at MAX_PATCH_CHARS and can cut anywhere; the panel must survive it.
    const cut = patch('@@ -1,80 +1,80 @@\n ctx\n-half a li').slice(0, 60);

    expect(() => patchRows(cut)).not.toThrow();
    expect(patchRows(cut).hunks.length).toBeGreaterThanOrEqual(0);
  });

  it('keeps every hunk of a multi-region edit', () => {
    const { hunks } = patchRows(patch('@@ -1,1 +1,1 @@\n-a\n+A\n@@ -20,1 +20,1 @@\n-b\n+B\n'));

    expect(hunks.map((h) => h.oldStart)).toEqual([1, 20]);
  });

  it('rejects the whole patch when any hunk\'s @@ counts disagree with its lines', () => {
    // A mid-stream cut produces exactly this. The parser refuses the file outright rather
    // than salvaging the intact hunks, so the caller falls back to raw text — the panel is
    // never handed a half-view whose line numbers have quietly slid out of step.
    const { hunks } = patchRows(patch('@@ -1,9 +1,9 @@\n-a\n+A\n@@ -20,1 +20,1 @@\n-b\n+B\n'));

    expect(hunks).toEqual([]);
  });
});
