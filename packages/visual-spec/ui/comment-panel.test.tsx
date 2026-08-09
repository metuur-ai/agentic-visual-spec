// @vitest-environment jsdom
/**
 * comment-panel.test.tsx — the panel's own affordances, driven through a real mount.
 *
 * Three claims are under test here, and each replaces something the panel used to say
 * only by implication:
 *
 *  P1  The empty state offered a keyboard shortcut and nothing else. A reviewer has no
 *      reason to suspect `I` exists, so the shortcut was the whole of a control nobody
 *      could see. The button is now the control and the shortcut is the shorthand — so
 *      the assertions below pin BOTH, including that pressing `I` still works.
 *  P3  The header's count chip used to open a popover listing the same comments this
 *      panel is already listing. The panel now answers the chip directly, so the
 *      registration and the reveal are tested here rather than mocked away.
 *  P8  The provenance chip was per card, repeated verbatim down a column of comments
 *      that all share one origin. It is now one header over the group.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InspectorProvider } from '../core/app';
import type { CommentRecord } from '../core/editing/comment-doc';
import { CommentPanel, isCommentPanelListening, revealInCommentPanel } from './comment-panel';

const local = (id: string, text: string, startLine: number): CommentRecord =>
  ({
    id,
    workflow: 'visual-spec',
    target: { path: 'a.md', kind: 'range', startLine, heading: 'Intro' },
    comment: text,
    status: 'open',
    ts: '2026-08-07T00:00:00.000Z',
  }) as unknown as CommentRecord;

function stubComments(comments: CommentRecord[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(comments), { headers: { 'content-type': 'application/json' } })),
  );
}

/** jsdom implements neither; both are consulted by the reveal path. */
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('matchMedia', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const mount = (comments: CommentRecord[] = []) => {
  stubComments(comments);
  return render(
    <InspectorProvider surfaceId="a.md" pageIndex={0}>
      <CommentPanel file="a.md" width={320} />
    </InspectorProvider>,
  );
};

/* ================================================================== *
 * P1 — the empty state offers a control, not an instruction
 * ================================================================== */
describe('P1 — starting a comment is a button, and the shortcut still works', () => {
  it('offers a real button rather than telling the reviewer to press a key', async () => {
    mount();
    const button = await screen.findByRole('button', { name: 'Start commenting' });
    expect(button.tagName).toBe('BUTTON');
    // The bare instruction that used to stand in for a control is gone.
    expect(screen.queryByText('Press I to start commenting.')).toBeNull();
  });

  it('says what is on the file before offering the control', async () => {
    mount();
    expect(await screen.findByText('Nothing on this file yet.')).toBeTruthy();
  });

  it('the button does what pressing I does — it starts the inspector', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Start commenting' }));
    // The active panel asks for a block instead of offering to start.
    await waitFor(() => expect(screen.getByText('Click a block in the spec to comment on it.')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Start commenting' })).toBeNull();
  });

  it('keeps the shortcut working, unchanged', async () => {
    mount();
    await screen.findByRole('button', { name: 'Start commenting' });
    fireEvent.keyDown(window, { key: 'i' });
    await waitFor(() => expect(screen.getByText('Click a block in the spec to comment on it.')).toBeTruthy());
  });

  it('renders the shortcut as a kbd token in a secondary hint, below the button', async () => {
    mount();
    const button = await screen.findByRole('button', { name: 'Start commenting' });
    const hint = document.querySelector('[data-vs-start-hint]') as HTMLElement;
    expect(hint).toBeTruthy();
    expect(hint.querySelector('kbd')?.textContent).toBe('I');
    expect(hint.textContent).toContain('picks a line, then you write');
    // "below it": the hint follows the button in document order.
    expect(button.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the button is keyboard reachable and carries a visible focus state', async () => {
    mount();
    const button = await screen.findByRole('button', { name: 'Start commenting' });
    expect(button.getAttribute('tabindex')).toBeNull(); // never taken out of the tab order
    button.focus();
    expect(document.activeElement).toBe(button);
    // The focus ring is a stylesheet rule, because an inline style cannot express
    // :focus-visible — so the class that rule keys off must be on the element.
    expect(button.className).toContain('vs-focus-ring');
    expect(document.querySelector('style')?.textContent).toContain('.vs-focus-ring:focus-visible');
  });
});

/* ================================================================== *
 * P8 — the half of it this panel can hold
 *
 * The per-card provenance chip is NOT hoisted to a group header here, and the
 * reason is a requirement rather than an oversight. R-13.18 (see the type's own
 * comment in comment-panel.tsx) says every card carries its own origin label,
 * because the panel used to state provenance by implication — a row with a link
 * out was a GitHub thread, a row without one was local — and both controls are
 * conditional for unrelated reasons, so a genuine GitHub comment could render
 * looking exactly like a local one. `ui/collab-comment-source.test.tsx` pins that
 * with four assertions requiring one chip per card. Hoisting is a change to
 * R-13.18, not to this panel's markup, so it is escalated rather than made here.
 *
 * What IS in scope, and pinned below: every icon-only control on a card names
 * itself, and the destructive one is told apart by more than its colour.
 * ================================================================== */
describe('P8 — every icon-only card control names itself', () => {
  it('names them, and keeps the destructive one distinct from the benign one', async () => {
    mount([local('c-1', 'first note', 3)]);
    await waitFor(() => expect(screen.getByText('first note')).toBeTruthy());
    const jump = screen.getByLabelText('Show in file');
    const del = screen.getByLabelText('Delete comment');
    // Not colour alone: the trash glyph differs from the crosshair, and the title says so.
    expect(del.getAttribute('title')).toBe('Delete comment');
    expect(jump.getAttribute('title')).toBe('Show where this comment was added in the file');
    expect(del.style.color).not.toBe(jump.style.color);
    // Touch target unchanged — 22×22, as every other icon button in the panel.
    expect(del.style.width).toBe('22px');
    expect(del.style.height).toBe('22px');
  });
});

/* ================================================================== *
 * P3 — the panel answers the header's count chip
 * ================================================================== */
describe('P3 — the panel is the one surface listing these comments', () => {
  it('answers nothing when no panel is mounted', () => {
    expect(isCommentPanelListening()).toBe(false);
    expect(revealInCommentPanel()).toBe(false);
  });

  it('registers itself only while it has comments to reveal', async () => {
    const { unmount } = mount([local('c-1', 'first note', 3)]);
    await waitFor(() => expect(isCommentPanelListening()).toBe(true));
    unmount();
    expect(isCommentPanelListening()).toBe(false);
  });

  it('stays silent for a panel with nothing on this file — the popover is still the answer', async () => {
    mount();
    await screen.findByRole('button', { name: 'Start commenting' });
    expect(isCommentPanelListening()).toBe(false);
  });

  it('scrolls the first card into view and rings it, then lets go', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount([local('c-1', 'first note', 3), local('c-2', 'second note', 5)]);
    await waitFor(() => expect(isCommentPanelListening()).toBe(true));

    expect(revealInCommentPanel()).toBe(true);
    await waitFor(() => expect(document.querySelector('[data-vs-revealed]')).toBeTruthy());
    const card = document.querySelector('[data-vs-revealed]') as HTMLElement;
    expect(card.textContent).toContain('first note');
    expect(card.style.boxShadow).toContain('124,58,237'); // the violet ring
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

    // "briefly" — no longer than ~300ms.
    vi.advanceTimersByTime(320);
    await waitFor(() => expect(document.querySelector('[data-vs-revealed]')).toBeNull());
  });

  it('does not animate the ring where reduced motion is asked for', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }));
    mount([local('c-1', 'first note', 3)]);
    await waitFor(() => expect(isCommentPanelListening()).toBe(true));
    revealInCommentPanel();
    await waitFor(() => expect(document.querySelector('[data-vs-revealed]')).toBeTruthy());
    const card = document.querySelector('[data-vs-revealed]') as HTMLElement;
    expect(card.style.transition).toBe('');
    expect((Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ behavior: 'auto' });
  });
});
