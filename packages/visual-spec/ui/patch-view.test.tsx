// @vitest-environment jsdom
/**
 * patch-view.test.tsx — R-4.5 / R-6.2.
 *
 * The patch is the artifact the user approves, so the claims here are about it being
 * *readable as a diff*: which lines are additions, which are removals, and what line of
 * the file each one is. A test that only asserted "the patch text appears somewhere"
 * would pass for the raw blob this component exists to replace.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { parseUnifiedDiff, PatchView } from './patch-view';

const PATCH = [
  'diff --git a/docs/intro.md b/docs/intro.md',
  '--- a/docs/intro.md',
  '+++ b/docs/intro.md',
  '@@ -3,4 +3,5 @@',
  ' Some context line',
  '-old sentence',
  '+new sentence',
  '+an added sentence',
  ' trailing context',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('splits into files and hunks and numbers both sides', () => {
    const parsed = parseUnifiedDiff(PATCH);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]!.path).toBe('docs/intro.md');
    expect(parsed.added).toBe(2);
    expect(parsed.removed).toBe(1);

    const lines = parsed.files[0]!.hunks[0]!.lines;
    expect(lines.map((l) => l.kind)).toEqual(['context', 'del', 'add', 'add', 'context']);
    // The pre-image side skips added lines; the post-image side skips removed ones.
    expect(lines.map((l) => l.oldLine)).toEqual([3, 4, null, null, 5]);
    expect(lines.map((l) => l.newLine)).toEqual([3, null, 4, 5, 6]);
  });

  it('reads a bare ---/+++ patch with no `diff --git` header', () => {
    const parsed = parseUnifiedDiff('--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-a\n+b\n');
    expect(parsed.files.map((f) => f.path)).toEqual(['x.md']);
    expect(parsed.files[0]!.hunks[0]!.lines).toHaveLength(2);
  });

  /*
   * The ambiguity that actually bites in a Markdown repository: deleting the line `-- x`
   * emits `--- x` *inside* a hunk. Read as a file header it would silently split one
   * file's diff into two and lose the deletion.
   */
  it('does not mistake a deleted `-- x` line for a file header', () => {
    const parsed = parseUnifiedDiff('--- a/x.md\n+++ b/x.md\n@@ -1,2 +1,1 @@\n--- x\n a\n');
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]!.hunks[0]!.lines[0]).toMatchObject({ kind: 'del', text: '-- x' });
  });

  it('keeps text it cannot place instead of dropping it', () => {
    const parsed = parseUnifiedDiff('this is not a patch at all');
    expect(parsed.preamble).toEqual(['this is not a patch at all']);
    expect(parsed.files).toEqual([]);
  });
});

describe('PatchView', () => {
  it('marks every line with what it does to the file', () => {
    const { container } = render(<PatchView patch={PATCH} />);
    const kinds = [...container.querySelectorAll('[data-vs-patch-line]')].map((el) => el.getAttribute('data-vs-patch-line'));
    expect(kinds).toEqual(['context', 'del', 'add', 'add', 'context']);
    expect(container.querySelector('[data-vs-patch-file="docs/intro.md"]')).not.toBeNull();
    expect(screen.getByText('+2')).toBeTruthy();
    expect(screen.getByText('−1')).toBeTruthy();
  });

  it('names itself as the thing being approved', () => {
    render(<PatchView patch={PATCH} />);
    expect(screen.getByText('The change you are approving')).toBeTruthy();
  });

  it('says so when a proposal carried no diff, rather than showing an empty box', () => {
    const { container } = render(<PatchView patch="" />);
    expect(container.querySelector('[data-vs-patch-empty]')).not.toBeNull();
  });
});
