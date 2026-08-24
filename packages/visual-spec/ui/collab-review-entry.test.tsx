// @vitest-environment jsdom
/**
 * collab-review-entry.test.tsx — C1.7, the way into a review session on the collaborative
 * surface (R-9.8, R-9.9).
 *
 * Everything here goes through a real `CollabApp` mount rather than through the source
 * module, because the claim under test is that the *surface* offers the act and sends what
 * the server needs. The projected record only exists in this app's memory (R-9.1), so
 * "does the start request carry it" is a question about the component, not about a pure
 * function — asserting it on `collabCommentPanelSource` alone would test the seam and miss
 * the wiring, which is exactly the gap `copyHandoff` sat in for a whole phase.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CollabApp } from './collab-app';

const BINDING = { owner: 'acme', repo: 'docs', branch: 'visual-spec/doc-c', pullNumber: 10 };
const DOCUMENT = { documentId: 'doc-c', documentPath: 'docs/spec.md', title: 'The Spec', markdown: '# The Spec\n\nFirst paragraph.\n' };

/** One projected review thread, as `projectReviewThread` mints it. */
const THREAD = {
  id: 'c-000aabbc',
  workflow: 'visual-spec',
  target: { path: 'docs/spec.md', kind: 'range', startLine: 3, heading: 'The Spec' },
  comment: 'Name the audience in this paragraph.',
  status: 'open',
  ts: '2026-08-01T00:00:00.000Z',
  github: {
    reviewCommentId: 700003,
    isOutdated: false,
    htmlUrl: 'https://github.com/acme/docs/pull/10#discussion_r700003',
    user: 'octocat',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  replies: [],
};

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === '/__vs/collab') return jsonRes({ available: true, login: 'ana', repo: { owner: 'acme', repo: 'docs' }, scopes: [] });
    if (url === '/__vs/collab/doc-c') {
      return jsonRes({ documentId: 'doc-c', state: 'draft', running: false, job: null, events: [], droppedEvents: 0, document: { ...DOCUMENT, github: BINDING } });
    }
    if (url === '/__vs/collab/doc-c/document') return jsonRes(DOCUMENT);
    if (url === '/__vs/collab/doc-c/comments') return jsonRes([THREAD]);
    if (url === '/__vs/review') return jsonRes({ running: false, startedAt: null, commentId: null });
    if (url === '/__vs/review/start') return jsonRes({ ok: true });
    if (url === '/__vs/tree') return jsonRes([]);
    if (url === '/__vs/collab/pulls/mounted') return jsonRes({ worktrees: [] });
    if (url.startsWith('/__vs/collab/pulls')) return jsonRes({ pulls: [] });
    return jsonRes({});
  });
}

/** The body of the one `POST /__vs/review/start` the surface sent. */
function startBody(): Record<string, unknown> {
  const call = vi.mocked(fetch).mock.calls.find(([u]) => String(u) === '/__vs/review/start');
  expect(call, 'the surface must POST /__vs/review/start').toBeTruthy();
  return JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>;
}

describe('C1.7 — a per-comment review action on the collaborative panel (R-9.8)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', stubFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mountAndClick() {
    render(<CollabApp onExit={() => {}} initial={{ documentId: 'doc-c' }} />);
    const button = await screen.findByRole('button', { name: 'Review & apply' });
    fireEvent.click(button);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u) === '/__vs/review/start')).toBe(true));
  }

  it('offers the action on the comment row and starts a session for that comment', async () => {
    await mountAndClick();
    expect(startBody().commentId).toBe('c-000aabbc');
  });

  it('R-8.8 — the start request carries the document and the projected record', async () => {
    await mountAndClick();
    expect(startBody()).toMatchObject({
      documentId: 'doc-c',
      documentPath: 'docs/spec.md',
      comment: {
        id: 'c-000aabbc',
        text: 'Name the audience in this paragraph.',
        workflow: 'visual-spec',
        // Which conversation the R-9.10 reply belongs on. The projected id is the same
        // `c-<hex>` shape for a review thread and a flat issue comment, so the server
        // cannot work this out and the client has to say.
        reviewCommentId: 700003,
      },
    });
  });

  it('R-9.3 — a review thread carries no node id, so the comment goes document-level', async () => {
    await mountAndClick();
    expect((startBody().comment as Record<string, unknown>).nodeId).toBeUndefined();
  });

  it('opens the review drawer on the document rather than in the 340px panel', async () => {
    await mountAndClick();
    // The drawer is what renders the approval gate; its presence is the visible half of
    // "a session started here" (the stream itself is faked).
    await screen.findByRole('button', { name: /approve/i });
  });
});

/*
 * R-9.8's other half, and the one that is only ever broken by accident: the manual path.
 *
 * `copyHandoff` is the escape hatch — every open comment, in one prompt, run by the
 * reviewer in their own session, with no server session and no approval gate. It is what
 * works when a review session cannot start, and it is what someone who would rather drive
 * the agent themselves uses. A session-based path arriving beside it is not a reason to
 * take it away, so this asserts against the source that it is still built the same way and
 * still on the toolbar.
 */
describe('R-9.8 — the clipboard handoff is unchanged and still available', () => {
  // Read off the process cwd (the package root), not `import.meta.url`: under jsdom that
  // is an `http:` URL and `fileURLToPath` refuses it.
  const src = readFileSync(resolve(process.cwd(), 'ui/collab-app.tsx'), 'utf8');

  it('still builds the same collab apply prompt from the open comments', () => {
    expect(src).toContain("const open = comments.filter((c) => c.status === 'open');");
    expect(src).toContain("const prompt = buildApplyPrompt(open, { mode: 'collab', documentPath: fullDocument.documentPath });");
    expect(src).toContain('await navigator.clipboard.writeText(prompt);');
  });

  it('still has its control on the review toolbar', () => {
    expect(src).toContain('onClick={() => void copyHandoff()}');
    expect(src).toContain('Copy agent prompt');
  });

  it('is reachable from the rendered surface', async () => {
    render(<CollabApp onExit={() => {}} initial={{ documentId: 'doc-c' }} />);
    expect(await screen.findByRole('button', { name: 'Copy agent prompt' })).toBeTruthy();
  });

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', stubFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});

/*
 * R-9.9 — cancel or failure leaves the canonical document unchanged.
 *
 * The document's bytes are the server's business and are asserted there
 * (`core/collaboration/review-session-collab.test.ts` cancels a session over a real
 * repository and compares the file). What belongs here is the client obligation that makes
 * that reachable: Cancel must end the session rather than merely hide the view, and
 * closing the view must NOT end it.
 */
describe('R-9.9 — the client half of a safe cancel', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', stubFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Cancel posts a cancel, and no write route is ever called from this surface', async () => {
    render(<CollabApp onExit={() => {}} initial={{ documentId: 'doc-c' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review & apply' }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u) === '/__vs/review/start')).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /^cancel/i }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u) === '/__vs/review/cancel')).toBe(true));
    // Nothing on this path may publish or commit — the only review calls are the four.
    const reviewCalls = vi.mocked(fetch).mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/__vs/review'));
    expect(new Set(reviewCalls)).toEqual(new Set(['/__vs/review', '/__vs/review/start', '/__vs/review/cancel']));
  });
});
