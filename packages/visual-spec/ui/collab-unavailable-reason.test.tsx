// @vitest-environment jsdom
/**
 * collab-unavailable-reason.test.tsx — R-10.7, the indicator that does not go quiet.
 *
 * The header's collaboration control used to render `null` for every `available: false`
 * answer. Switching to a directory with no GitHub repository therefore looked exactly
 * like switching to one with a broken credential, which looked exactly like a header
 * that had not finished loading: the control was simply gone. The reason existed, on the
 * server's stdout, where nobody using the browser could read it.
 *
 * The load-bearing assertion is the one R-10.4 insists on — `no-credential` and
 * `not-a-repo` must not read the same, because their fixes are `gh auth login` and
 * "serve a different directory" respectively.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainHeader } from './main-header';
import { resetVisitedFiles } from './use-visited-files';

const FILE = 'test/javier/for-comment.md';

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function installFetch(availability: unknown) {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/__vs/collab') return jsonRes(availability);
    if (url === '/__vs/git') return jsonRes({ state: 'none' });
    if (url === '/__vs/git/branches') return jsonRes({ error: 'no route' }, 404);
    if (url === '/__vs/git/changed') return jsonRes({ paths: [] });
    if (url.startsWith('/__vs/collab/pulls')) return jsonRes({ pulls: [] });
    if (url.startsWith('/__vs/comments')) return jsonRes([]);
    if (url === '/__vs/source/root') return jsonRes({ root: '/repo' });
    if (url.startsWith('/__vs/tree/file')) return jsonRes({ path: FILE, kind: 'markdown', content: '# x\n', size: 4 });
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', impl);
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
  resetVisitedFiles();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function chipFor(reason: string, message: string) {
  installFetch({ available: false, reason, message, missingScopes: [] });
  const view = render(<MainHeader file={FILE} isMarkdown onModeChange={() => {}} />);
  const chip = await screen.findByTestId('collab-unavailable');
  const text = chip.textContent ?? '';
  view.unmount();
  return text;
}

describe('R-10.7 — the disabled state is on screen, not only in the log', () => {
  it('says collaboration is off instead of rendering nothing', async () => {
    const text = await chipFor('not-a-repo', 'Collaboration is off: the directory being served is not a git repository.');
    expect(text).toContain('collaboration off');
  });

  it('distinguishes a missing credential from an unrecognised repository (R-10.4)', async () => {
    const noRepo = await chipFor('not-a-repo', 'Collaboration is off: the directory being served is not a git repository.');
    const noCred = await chipFor('no_credential', 'Collaboration is unavailable: no GitHub credential is configured.');
    expect(noCred).not.toBe(noRepo);
    expect(noCred).toContain('credential');
    expect(noRepo).not.toContain('credential');
  });

  it('gives each of the four re-root outcomes its own wording', async () => {
    // Sequential on purpose: `chipFor` mounts a header and queries the one chip on screen.
    const texts: string[] = [];
    for (const [reason, message] of [
      ['not-a-repo', 'not a git repository'],
      ['no-remote', 'no remote'],
      ['remote-not-github', 'remote is not GitHub'],
      ['no_credential', 'no credential'],
    ]) {
      texts.push(await chipFor(reason as string, message as string));
    }
    expect(new Set(texts).size).toBe(4);
  });

  it('renders nothing at all while the probe is still out — an unanswered question is not a verdict', async () => {
    installFetch(new Promise(() => {}) as unknown);
    render(<MainHeader file={FILE} isMarkdown onModeChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'More: help and history' })).toBeTruthy());
    expect(screen.queryByTestId('collab-unavailable')).toBeNull();
  });
});
