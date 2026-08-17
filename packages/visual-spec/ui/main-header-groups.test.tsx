// @vitest-environment jsdom
/**
 * main-header-groups.test.tsx — the header as three zones and an overflow (P2), and
 * the count chip deferring to the panel (P3).
 *
 * The defect being pinned is not that any one control was wrong. It is that eight of
 * them sat in one undifferentiated row at equal weight, three of them looking equally
 * like the thing to press, so the eye had no entry point and no way to tell "what am I
 * looking at" from "what do I do with it". So these assertions are about grouping,
 * order and weight — the properties a screenshot has and a control list does not.
 *
 * Driven through `MainHeader` rather than through extracted zone components, because
 * "the divider is between Review and Agent" is a claim about the header, and a test of
 * the pieces would hold whether or not the header ever assembled them.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InspectorProvider } from '../core/app';
import type { CommentRecord } from '../core/editing/comment-doc';
import { CommentPanel } from './comment-panel';
import { MainHeader } from './main-header';

const FILE = 'docs/spec.md';

const comment = (id: string, text: string, startLine: number): CommentRecord =>
  ({
    id,
    workflow: 'visual-spec',
    target: { path: FILE, kind: 'range', startLine, heading: 'The Spec' },
    comment: text,
    status: 'open',
    ts: '2026-08-08T00:00:00.000Z',
    replies: [],
  }) as unknown as CommentRecord;

const CONFIGURED = { available: true, login: 'author-ana', repo: { owner: 'acme', repo: 'docs', baseBranch: 'main' }, scopes: [] };

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function installFetch(comments: CommentRecord[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/__vs/git') return jsonRes({ state: 'none' });
      if (url === '/__vs/git/branches') return jsonRes({ error: 'no route' }, 404);
      if (url === '/__vs/collab') return jsonRes(CONFIGURED);
      if (url.startsWith('/__vs/collab/pulls')) return jsonRes({ pulls: [] });
      if (url.startsWith('/__vs/comments')) return jsonRes(comments);
      if (url === '/__vs/source/root') return jsonRes({ root: '/repo/docs' });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

/** jsdom has no `EventSource`; `ApplyButton` opens one unconditionally. */
class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const zoneNames = () =>
  Array.from(document.querySelectorAll('[data-vs-header-zone]')).map((z) => z.getAttribute('data-vs-header-zone'));

const zone = (name: string) => document.querySelector(`[data-vs-header-zone="${name}"]`) as HTMLElement;

async function mountHeader(comments: CommentRecord[] = []) {
  installFetch(comments);
  const view = render(
    <InspectorProvider surfaceId={FILE} pageIndex={0}>
      <MainHeader file={FILE} isMarkdown withInspector mode="view" onModeChange={() => {}} />
    </InspectorProvider>,
  );
  // The pull request control appears only once availability comes back — wait for the
  // slowest zone member so ordering assertions see the settled header.
  await screen.findByRole('button', { name: 'Start collaboration' });
  return view;
}

/* ================================================================== *
 * P2 — three zones, in order, separated by dividers
 * ================================================================== */
describe('P2 — the header groups its controls instead of listing them', () => {
  it('lays out Document, then Review, then Agent', async () => {
    await mountHeader();
    expect(zoneNames()).toEqual(['document', 'review', 'agent']);
  });

  it('separates them with a thin divider each, and nothing else', async () => {
    await mountHeader();
    const dividers = document.querySelectorAll('[data-vs-header-divider]');
    // Three zones take two dividers — a leading or trailing rule would be a border,
    // not a separation.
    expect(dividers).toHaveLength(2);
    expect((dividers[0] as HTMLElement).getAttribute('aria-hidden')).toBe('true');
  });

  it('puts the View/Edit switch in Document, alone', async () => {
    await mountHeader();
    expect(within(zone('document')).getByRole('tablist', { name: 'View or edit' })).toBeTruthy();
    expect(within(zone('document')).queryByRole('button', { name: /pull request/ })).toBeNull();
  });

  it('puts starting comments, the count and the pull request in Review', async () => {
    await mountHeader([comment('c-1', 'needs a citation', 3)]);
    const review = zone('review');
    expect(within(review).getByText('Start comments')).toBeTruthy();
    expect(within(review).getByRole('button', { name: 'Start collaboration' })).toBeTruthy();
    expect(within(review).getByTitle(/collected comments|Show these comments/)).toBeTruthy();
  });

  it('puts the prompt and the apply run in Agent', async () => {
    await mountHeader([comment('c-1', 'needs a citation', 3)]);
    const agent = zone('agent');
    // By accessible name, not by the glyph beside it: the mark is an inline SVG that
    // contributes nothing to the name, which is the point of it not being an emoji.
    expect(within(agent).getByRole('button', { name: 'Copy prompt' })).toBeTruthy();
    expect(within(agent).getByTitle(/Apply the open comments/)).toBeTruthy();
  });

  it('never prints the zone names — the dividers carry the grouping', async () => {
    await mountHeader();
    const bar = document.querySelector('header') as HTMLElement;
    for (const label of ['Document', 'Review', 'Agent']) {
      expect(within(bar).queryByText(label)).toBeNull();
    }
  });

  it('makes Apply the only filled control in the bar', async () => {
    await mountHeader([comment('c-1', 'needs a citation', 3)]);
    const apply = screen.getByTitle(/Apply the open comments/) as HTMLElement;
    expect(apply.style.background).toBe('rgb(124, 58, 237)');
    const filled = Array.from(document.querySelectorAll('header button')).filter(
      (b) => (b as HTMLElement).style.background === 'rgb(124, 58, 237)',
    );
    expect(filled).toEqual([apply]);
  });
});

/* ================================================================== *
 * P2 — Apply names what it is about to do
 * ================================================================== */
describe('P2 — Apply names its count', () => {
  it('says nothing about a count it does not have', async () => {
    await mountHeader([]);
    expect(screen.getByTitle(/Apply the open comments/).textContent).toContain('Apply');
    expect(screen.getByTitle(/Apply the open comments/).textContent).not.toMatch(/comment/);
  });

  it('says "1 comment" for one', async () => {
    await mountHeader([comment('c-1', 'a', 3)]);
    await waitFor(() => expect(screen.getByTitle(/Apply the open comments/).textContent).toContain('Apply 1 comment'));
    expect(screen.getByTitle(/Apply the open comments/).textContent).not.toContain('comments');
  });

  it('says "2 comments" for two', async () => {
    await mountHeader([comment('c-1', 'a', 3), comment('c-2', 'b', 5)]);
    await waitFor(() => expect(screen.getByTitle(/Apply the open comments/).textContent).toContain('Apply 2 comments'));
  });
});

/* ================================================================== *
 * P2 — Help and History behind one overflow
 * ================================================================== */
describe('P2 — the two reference controls sit behind an overflow', () => {
  it('shows neither Help nor History in the bar itself', async () => {
    await mountHeader();
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Help/ })).toBeNull();
  });

  it('offers one named button that reveals both', async () => {
    await mountHeader();
    const more = screen.getByRole('button', { name: 'More: help and history' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'History' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Help/ })).toBeTruthy();
  });

  it('sits at the far right, after every zone', async () => {
    await mountHeader();
    const more = screen.getByRole('button', { name: 'More: help and history' });
    const agent = zone('agent');
    expect(agent.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('closes on Escape', async () => {
    await mountHeader();
    const more = screen.getByRole('button', { name: 'More: help and history' });
    fireEvent.click(more);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(more.getAttribute('aria-expanded')).toBe('false'));
  });
});

/* ================================================================== *
 * P3 — the chip does not duplicate a panel that is already open
 * ================================================================== */
describe('P3 — one surface per dataset', () => {
  const chip = () => screen.getByTitle(/collected comments|Show these comments/);

  it('opens its popover where there is no panel to defer to', async () => {
    await mountHeader([comment('c-1', 'needs a citation', 3)]);
    await waitFor(() => expect(chip().textContent).toContain('1'));
    fireEvent.click(chip());
    expect(await screen.findByText('1 comment collected')).toBeTruthy();
  });

  it('reveals it in the panel instead, and opens nothing, where a panel is listing it', async () => {
    installFetch([comment('c-1', 'needs a citation', 3)]);
    render(
      <InspectorProvider surfaceId={FILE} pageIndex={0}>
        <MainHeader file={FILE} isMarkdown withInspector mode="view" onModeChange={() => {}} />
        <CommentPanel file={FILE} width={320} />
      </InspectorProvider>,
    );
    // Both the header cart and the panel list have to have loaded.
    await waitFor(() => expect(screen.getAllByText('needs a citation').length).toBeGreaterThan(0));
    await waitFor(() => expect(chip().getAttribute('title')).toBe('Show these comments in the panel'));

    fireEvent.click(chip());
    await waitFor(() => expect(document.querySelector('[data-vs-revealed]')).toBeTruthy());
    // The popover the panel made redundant never appeared.
    expect(screen.queryByText('1 comment collected')).toBeNull();
  });
});
