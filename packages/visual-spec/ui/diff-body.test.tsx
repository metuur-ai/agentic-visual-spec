// @vitest-environment jsdom
/**
 * diff-body.test.tsx — the apply popover's answer to "what did this say before?".
 *
 * The unified patch was always there; what was missing was a form in which the old and
 * new wording sit next to each other. These tests pin the two things that make the split
 * view worth having: the sides are actually paired, and the view never overstates how
 * much of the file it is showing.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DiffBody } from './main-header';

const PATCH = [
  'Index: guia-estilo.md',
  '===================================================================',
  '--- guia-estilo.md',
  '+++ guia-estilo.md',
  '@@ -2,3 +2,3 @@',
  ' Tono',
  '-Un párrafo por idea.',
  '+Un párrafo por idea, y ni uno más.',
  ' Ejemplos',
].join('\n');

describe('DiffBody', () => {
  it('opens on the split view and puts both wordings on the same row', () => {
    render(<DiffBody patch={PATCH} />);

    const rows = screen.getByTestId('diff-split');
    // Old and new are siblings in one row — the pairing the reader used to do by eye.
    expect(within(rows).getByText('Un párrafo por idea.')).toBeTruthy();
    expect(within(rows).getByText('Un párrafo por idea, y ni uno más.')).toBeTruthy();
  });

  it('shows the real line numbers of the region, not a count from one', () => {
    render(<DiffBody patch={PATCH} />);

    expect(screen.getByText(/línea 2 → 2/)).toBeTruthy();
    // The changed line is the 3rd of the file, and says so on both sides.
    expect(within(screen.getByTestId('diff-split')).getAllByText('3').length).toBe(2);
  });

  it('always states that it is showing only the changed regions', () => {
    // The patch cannot prove it covers the file, so the label must never imply it does.
    render(<DiffBody patch={PATCH} />);

    expect(screen.getByText('solo las regiones cambiadas')).toBeTruthy();
  });

  it('swaps to the unified text and back', () => {
    render(<DiffBody patch={PATCH} />);

    fireEvent.click(screen.getByRole('button', { name: 'Ver unificado' }));
    expect(screen.queryByTestId('diff-split')).toBeNull();
    // Unified is the copy-pasteable form, so the `@@` header has to survive the swap.
    expect(screen.getByText('@@ -2,3 +2,3 @@')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Ver antes | después' }));
    expect(screen.getByTestId('diff-split')).toBeTruthy();
  });

  it('falls back to raw text with no toggle when the patch will not parse', () => {
    // A truncated payload is cut mid-hunk. Offering a split view that cannot be built
    // would be a dead button, so the toggle is absent rather than disabled.
    render(<DiffBody patch={'@@ -1,80 +1,80 @@\n ctx\n-half a li'} />);

    expect(screen.queryByTestId('diff-split')).toBeNull();
    expect(screen.queryByRole('button', { name: /Ver / })).toBeNull();
    expect(screen.getByText('-half a li')).toBeTruthy();
  });
});
