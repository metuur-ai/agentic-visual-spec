// @vitest-environment jsdom
/**
 * spinner.test.tsx — the busy signal itself.
 *
 * Nearly every asynchronous control already had a busy state and nearly none of it was
 * visible: the button disabled itself and its label changed a word, which on a 12px
 * control reads as nothing happening. Reported as "some actions may have it but I don't
 * see it, so it looks like nothing happened". These pin the parts of the answer that a
 * refactor could quietly undo — the motion, the announcement, and the reduced-motion path.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BusyLabel, LoadingLine, Spinner } from './spinner';

describe('the busy signal is something that moves', () => {
  it('animates, so it is caught without being looked for', () => {
    render(<Spinner />);
    const css = document.getElementById('vs-spinner-css')?.textContent ?? '';
    expect(css).toContain('@keyframes vs-spin');
    expect(css).toContain('.vs-spinner{animation:vs-spin');
  });

  /*
   * The rings live inside buttons, and a `<style>` child is part of a button's
   * `textContent` — so a spinning button was carrying a keyframes declaration in its text.
   */
  it('keeps its rules in the head, not inside the control it spins in', () => {
    const { container } = render(
      <button type="button">
        <Spinner />
        Send
      </button>,
    );
    expect(document.getElementById('vs-spinner-css')?.parentElement).toBe(document.head);
    expect(container.querySelector('style')).toBeNull();
    expect(container.textContent).toBe('Send');
  });

  /* Two rings on screen is still one stylesheet. */
  it('injects the rules once however many rings are up', () => {
    render(
      <>
        <Spinner />
        <Spinner />
        <Spinner />
      </>,
    );
    expect(document.querySelectorAll('#vs-spinner-css')).toHaveLength(1);
  });

  /*
   * The alternative to spinning is not stillness — a static ring beside a disabled button
   * is indistinguishable from an icon — so the opacity breathes instead.
   */
  it('keeps saying "waiting" under prefers-reduced-motion, without travelling', () => {
    render(<Spinner />);
    const css = document.getElementById('vs-spinner-css')?.textContent ?? '';
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('vs-spin-pulse');
  });

  /* The control it sits in is disabled while it spins, so nothing else announces the press. */
  it('announces itself, because the disabled control cannot', () => {
    render(<Spinner label="Sending…" />);
    expect(screen.getByRole('status', { name: 'Sending…' })).toBeTruthy();
  });

  it('inherits its colour, so one component serves every button tone', () => {
    const { container } = render(<Spinner />);
    const strokes = [...container.querySelectorAll('[stroke]')].map((e) => e.getAttribute('stroke'));
    expect(strokes.every((s) => s === 'currentColor')).toBe(true);
  });
});

describe('BusyLabel puts the ring beside the word without displacing it', () => {
  it('shows the ring only while busy, and always the label', () => {
    const { rerender } = render(<BusyLabel busy={false}>Send</BusyLabel>);
    expect(screen.getByText('Send')).toBeTruthy();
    expect(document.querySelector('[data-vs-spinner]')).toBeNull();

    rerender(<BusyLabel busy>Sending…</BusyLabel>);
    expect(document.querySelector('[data-vs-spinner]')).toBeTruthy();
    expect(screen.getByText('Sending…')).toBeTruthy();
  });
});

describe('LoadingLine', () => {
  /* A bare "Loading…" is indistinguishable from a label somebody left behind. */
  it('pairs the word with the thing that says it is still going', () => {
    render(<LoadingLine>Loading pull requests…</LoadingLine>);
    expect(screen.getByText('Loading pull requests…')).toBeTruthy();
    expect(document.querySelector('[data-vs-spinner]')).toBeTruthy();
  });
});
