/**
 * patch-rows.ts — a unified patch, re-shaped into aligned before | after rows.
 *
 * WHY THIS EXISTS AND WHY IT DID NOT BEFORE. The apply popover renders the patch as
 * coloured text, and for "what did claude touch?" that is enough. It stops being enough
 * the moment the question becomes "what did that paragraph *say* before?": in a unified
 * patch the old and new versions of a line sit several rows apart, and the reader has to
 * do the pairing in their head. Two columns do the pairing for them.
 *
 * A structured parse was deliberately *not* written for the first cut of the diff view —
 * it buys nothing until you want side-by-side, folded hunks, or comments on diff lines.
 * Side-by-side is now the ask, so the parse earns its place.
 *
 * WHAT IT DOES NOT DO. It reconstructs only what the patch carries: the changed regions
 * and their context lines. The untouched body of the file is not here and cannot be —
 * `createTwoFilesPatch` never wrote it down. Callers that need the whole prior document
 * must fetch it from disk.
 *
 * There is deliberately no "does this cover the whole file?" flag, because the patch
 * cannot answer it: a 500-line file edited at line 1 yields `@@ -1,7 +1,7 @@`, which is
 * indistinguishable from a 7-line file rewritten end to end. Nothing here knows the file's
 * length, so the UI labels every view as the changed regions and never claims otherwise.
 *
 * PARSING IS BORROWED. `diff` already ships `parsePatch` and is already a runtime
 * dependency (`apply.ts` builds the patch with `createTwoFilesPatch` from it). Hand-rolling
 * a hunk parser here would be a second, worse implementation of a solved problem.
 */
import { parsePatch } from 'diff';

/** One line of the comparison, with the sides already paired up. */
export type PatchRow =
  /** Unchanged — the same text on both sides, carried for context. */
  | { kind: 'context'; oldNo: number; newNo: number; text: string }
  /** A line that exists on both sides but differs. */
  | { kind: 'change'; oldNo: number; newNo: number; before: string; after: string }
  /** Only on the right: claude added this. */
  | { kind: 'add'; newNo: number; text: string }
  /** Only on the left: claude removed this. */
  | { kind: 'remove'; oldNo: number; text: string };

/** One contiguous changed region of a file. */
export type PatchHunk = {
  /** 1-based line number this region starts at in the *old* file. */
  oldStart: number;
  /** 1-based line number this region starts at in the *new* file. */
  newStart: number;
  rows: PatchRow[];
};

export type ParsedPatch = {
  hunks: PatchHunk[];
};

/**
 * Split a hunk's lines into aligned rows.
 *
 * Removals and additions arrive from `diff` as two consecutive runs (`---` then `+++`),
 * never interleaved. Pairing them by position is what turns "3 lines gone, 3 lines
 * arrived" into three `change` rows a reader can scan across, instead of six rows they
 * have to match up themselves. An uneven run is the honest case where one side simply
 * has no counterpart, and those become `remove`/`add`.
 */
function rowsOfHunk(lines: string[], oldStart: number, newStart: number): PatchRow[] {
  const rows: PatchRow[] = [];
  let oldNo = oldStart;
  let newNo = newStart;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const marker = line[0];
    const text = line.slice(1);

    if (marker === '-') {
      // Collect this run of removals, then the additions that immediately follow.
      const removed: string[] = [];
      while (i < lines.length && lines[i]![0] === '-') removed.push(lines[i++]!.slice(1));
      const added: string[] = [];
      while (i < lines.length && lines[i]![0] === '+') added.push(lines[i++]!.slice(1));

      const paired = Math.min(removed.length, added.length);
      for (let k = 0; k < paired; k++) {
        rows.push({ kind: 'change', oldNo: oldNo++, newNo: newNo++, before: removed[k]!, after: added[k]! });
      }
      for (let k = paired; k < removed.length; k++) rows.push({ kind: 'remove', oldNo: oldNo++, text: removed[k]! });
      for (let k = paired; k < added.length; k++) rows.push({ kind: 'add', newNo: newNo++, text: added[k]! });
      continue;
    }

    if (marker === '+') {
      rows.push({ kind: 'add', newNo: newNo++, text });
      i++;
      continue;
    }

    // `\ No newline at end of file` is a note about the line above, not a line of the
    // document. Showing it as content would put a sentence in the file that is not there.
    if (marker === '\\') {
      i++;
      continue;
    }

    rows.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text });
    i++;
  }

  return rows;
}

/**
 * Parse one file's unified patch into side-by-side rows.
 *
 * Returns no hunks for input that is not a patch — a truncated payload can cut mid-hunk,
 * and the caller's fallback (show the raw text) is a better answer than a throw that
 * blanks the panel. `parsePatch` rejects the entire patch if any hunk's `@@` counts
 * disagree with the lines that follow — which is what a mid-stream cut produces — so the
 * result is all-or-nothing: either every row is correctly numbered, or the caller shows
 * raw text. There is no partial render whose line numbers have slid out of step.
 */
export function patchRows(patch: string): ParsedPatch {
  let files: ReturnType<typeof parsePatch>;
  try {
    files = parsePatch(patch);
  } catch {
    return { hunks: [] };
  }

  const hunks: PatchHunk[] = [];
  for (const file of files) {
    for (const h of file.hunks ?? []) {
      hunks.push({
        oldStart: h.oldStart,
        newStart: h.newStart,
        rows: rowsOfHunk(h.lines, h.oldStart, h.newStart),
      });
    }
  }

  return { hunks };
}
