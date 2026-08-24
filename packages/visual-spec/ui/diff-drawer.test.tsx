// @vitest-environment jsdom
/**
 * The panel's job is to answer "what did this say before?" without lying about scope.
 * These tests pin the two ways it could lie — presenting a truncated patch as complete,
 * and presenting a patch it could not parse as if it had — plus the split itself, which
 * is the only reason the panel exists rather than a wider popover.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DiffDrawer } from './diff-drawer';

const PATCH = [
  '--- a/doc.md',
  '+++ b/doc.md',
  '@@ -1,3 +1,3 @@',
  ' Tone',
  '-We write in the third person.',
  '+We write in the second person and in the present tense.',
  ' Length',
].join('\n');

describe('DiffDrawer', () => {
  it('shows the old text and the new text side by side', () => {
    render(<DiffDrawer entries={[{ path: 'docs/doc.md', patch: PATCH }]} onClose={vi.fn()} />);

    const split = screen.getByTestId('diff-drawer-split');
    expect(within(split).getByText('We write in the third person.')).toBeTruthy();
    expect(within(split).getByText('We write in the second person and in the present tense.')).toBeTruthy();
    // Both columns are labelled: an unlabelled pair leaves the reader guessing which is which.
    expect(within(split).getByText('Before')).toBeTruthy();
    expect(within(split).getByText('After')).toBeTruthy();
  });

  it('says out loud that it is only showing the changed region', () => {
    render(<DiffDrawer entries={[{ path: 'docs/doc.md', patch: PATCH }]} onClose={vi.fn()} />);
    expect(screen.getByText('only the changed region')).toBeTruthy();
  });

  it('warns when the patch was truncated rather than presenting a short read as whole', () => {
    render(<DiffDrawer entries={[{ path: 'docs/doc.md', patch: PATCH, truncated: true }]} onClose={vi.fn()} />);
    expect(screen.getByText(/truncated/)).toBeTruthy();
  });

  it('falls back to the raw patch when the hunks cannot be parsed', () => {
    // A patch cut mid-hunk has line numbers that have slid out of step. Rendering rows
    // from it would be confidently mislabelled, so the raw text is the honest answer.
    render(<DiffDrawer entries={[{ path: 'docs/doc.md', patch: 'not a patch at all' }]} onClose={vi.fn()} />);
    expect(screen.queryByTestId('diff-drawer-split')).toBeNull();
    expect(screen.getByText('not a patch at all')).toBeTruthy();
    expect(screen.getByText('unreadable patch')).toBeTruthy();
  });

  it('says so when the run changed nothing, instead of rendering an empty shell', () => {
    render(<DiffDrawer entries={[]} onClose={vi.fn()} />);
    expect(screen.getByText('Claude did not change any file in this run.')).toBeTruthy();
  });

  it('dismisses on Escape — nothing here is in flight', () => {
    const onClose = vi.fn();
    render(<DiffDrawer entries={[{ path: 'docs/doc.md', patch: PATCH }]} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
