// @vitest-environment jsdom
/**
 * use-awaiting-pulls.test.tsx — the store behind the two counts (R-A4.1 … R-A4.4).
 *
 * THE FIRST SUITE IS WHY THIS IS A STORE AND NOT A HOOK'S `useState`. The header chips and
 * the panel's sections render in different trees — `MainHeader` in one, `CollabPullsPanel`
 * from `collab-app.tsx` / `collab-drawer.tsx` in another — with no common ancestor short of
 * `App`. Two copies would mean two reads of a route that spends a search budget of 30
 * requests a minute, and two render cascades over identical numbers. Both properties are
 * invisible on screen and visible only in the request log and the profiler, which is
 * exactly why they are pinned here. The two roots below are that pair of trees.
 *
 * THE NO-TIMER ASSERTION IS NEGATIVE AND LOAD-BEARING. A stray interval is invisible to any
 * test that counts reads after events; it shows up as somebody's exhausted quota on an idle
 * tab. R-A4.1 forbids one, so it is asserted rather than assumed.
 *
 * THE RETENTION SUITE ASSERTS RENDERED OUTPUT, not only the stored value. R-A4.3 says a
 * failed read leaves the previous counts on screen and puts no error in their place, and
 * "no error in their place" is a claim about the DOM. The chips do not exist yet, so a
 * probe renders exactly what they will — the numbers, and nothing else.
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshAwaiting, resetAwaitingCache, useAwaitingPulls } from './use-awaiting-pulls';

const CONFIGURED = { available: true, login: 'ana', repo: { owner: 'acme', repo: 'docs', baseBranch: 'main' }, scopes: [] };

const AWAITING = {
  reviewRequested: { ok: true, total: 3, items: [{ number: 41, title: 'Spec: retention', htmlUrl: 'https://github.com/acme/docs/pull/41' }], complete: true },
  mentioned: { ok: true, total: 2, items: [{ number: 41, title: 'Spec: retention', htmlUrl: 'https://github.com/acme/docs/pull/41', mention: { author: 'bo', excerpt: 'ping @ana' } }], complete: true },
};

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

type Server = { availability?: unknown; awaiting?: () => Response };

let calls: string[];

function installFetch(server: Server = {}) {
  calls = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === '/__vs/collab') return jsonRes(server.availability ?? CONFIGURED);
    if (url === '/__vs/collab/pulls/awaiting') return (server.awaiting ?? (() => jsonRes(AWAITING)))();
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

const awaitingReads = () => calls.filter((u) => u === '/__vs/collab/pulls/awaiting').length;

/** What the chips will render, and nothing else — no error surface exists for them. */
function Counts({ renders }: { renders: { n: number } }) {
  const awaiting = useAwaitingPulls();
  renders.n += 1;
  return createElement(
    'div',
    null,
    awaiting?.reviewRequested.ok ? createElement('span', { id: 'review' }, awaiting.reviewRequested.total) : null,
    awaiting?.mentioned.ok ? createElement('span', { id: 'mentioned' }, awaiting.mentioned.total) : null,
  );
}

/** One mounted tree. Two of these are two unrelated trees, which is the point. */
function tree() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

let mounted: ReturnType<typeof tree>[];

beforeEach(() => {
  resetAwaitingCache();
  mounted = [];
});

afterEach(() => {
  act(() => {
    for (const m of mounted) m.root.unmount();
  });
  for (const m of mounted) m.container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Mount `n` independent roots, all reading the store, and settle the first read. */
async function readers(n: number, renders = { n: 0 }) {
  for (let i = 0; i < n; i += 1) mounted.push(tree());
  await act(async () => {
    for (const m of mounted) m.root.render(createElement(Counts, { renders }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return renders;
}

const text = (id: string) => document.querySelector(`#${id}`)?.textContent ?? null;

describe('one cache, however many surfaces read it (R-A4.2)', () => {
  it('two trees mounted at once cost one request, not two', async () => {
    installFetch();
    await readers(2);

    // The header and the panel, as far as the store can tell them apart: two roots, two
    // subscriptions, one read. The second arrived while the first was in flight and was
    // handed the same promise.
    expect(awaitingReads()).toBe(1);
    expect(text('review')).toBe('3');
  });

  it('costs one read per tab switch, though the switch fires two events', async () => {
    installFetch();
    await readers(2);

    // One tab switch as the browser delivers it: both events, same tick, nothing awaited
    // between them — and now two trees are listening to neither of them, because the
    // listeners belong to the store.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(awaitingReads()).toBe(2);
  });

  it('reads again on the next switch, once the first has landed', async () => {
    installFetch();
    await readers(1);

    for (const dispatch of [() => window.dispatchEvent(new Event('focus')), () => document.dispatchEvent(new Event('visibilitychange'))]) {
      await act(async () => {
        dispatch();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    // Coalescing collapses *overlapping* reads, not consecutive ones: an in-flight promise
    // that was never cleared would look identical above and freeze the counts forever.
    expect(awaitingReads()).toBe(3);
  });

  it('reads on no timer (R-A4.1)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installFetch();
    await readers(1);
    expect(awaitingReads()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    expect(awaitingReads()).toBe(1);
  });

  it('issues nothing where collaboration is not configured (R-A2.9)', async () => {
    installFetch({ availability: { available: false, reason: 'not-configured', message: 'off' } });
    await readers(1);

    // A statement about calls, not about what is displayed: the count nobody can use is
    // still a rate limit spent to obtain it. The stub would have thrown on the request,
    // so the absence is asserted directly rather than inferred from the empty render.
    expect(awaitingReads()).toBe(0);
    expect(text('review')).toBeNull();
  });
});

describe('a read that finds nothing new (R-A4.2)', () => {
  it('re-renders nobody', async () => {
    installFetch();
    const renders = await readers(2);
    const settled = renders.n;
    expect(text('review')).toBe('3');

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The steady state of a tab being switched back to. The store compared the response
    // with what it held, found it identical, and told nobody — so neither tree
    // reconciled, and the numbers on screen are the same objects they were.
    expect(awaitingReads()).toBe(2);
    expect(renders.n).toBe(settled);
    expect(text('review')).toBe('3');
  });
});

describe('a refresh asked for by hand (R-C3.4)', () => {
  it('joins the read already in flight instead of issuing a second', async () => {
    installFetch();
    await readers(1);
    expect(awaitingReads()).toBe(1);

    // The press that R-C3.4 is about: a tab switch has just started a read and the user
    // reaches for refresh before it lands. Both happen in one tick with nothing awaited
    // between them, so the second arrives while the first is genuinely still running.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await refreshAwaiting();
    });

    // Counted in requests, not in what was rendered. Two reads issued would agree with the
    // first read's answer and leave the DOM identical, so a test that asserted the numbers
    // would pass while the panel quietly spent double against a 30-a-minute search budget.
    expect(awaitingReads()).toBe(2);
    expect(text('review')).toBe('3');
  });

  it('re-renders neither tree when it finds what the store already held', async () => {
    installFetch();
    const renders = await readers(2);
    const settled = renders.n;

    await act(async () => {
      await refreshAwaiting();
    });

    // Two roots, one shared counter: the header's chips and the panel's sections. The panel
    // asking for a refresh must not reconcile the header, which is the coupling this store
    // exists to prevent — and "nothing new" is the ordinary outcome of pressing refresh.
    expect(awaitingReads()).toBe(2);
    expect(renders.n).toBe(settled);
    expect(text('review')).toBe('3');
  });
});

describe('a read that fails after one that did not (R-A4.3)', () => {
  it('leaves the rendered numbers exactly as they were, and renders no error', async () => {
    let attempt = 0;
    installFetch({
      awaiting: () => {
        attempt += 1;
        return attempt === 1 ? jsonRes(AWAITING) : jsonRes({ error: 'API rate limit exceeded for search' }, 403);
      },
    });
    await readers(1);
    expect(text('review')).toBe('3');

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });

    // A rate-limited search is an ordinary Tuesday against a 30/minute budget. The last
    // thing that was true stays on screen, and the server's refusal reaches no DOM node.
    expect(awaitingReads()).toBe(2);
    expect(text('review')).toBe('3');
    expect(text('mentioned')).toBe('2');
    expect(document.body.textContent).not.toMatch(/rate limit|error|failed/i);
  });

  it('keeps a side that failed and takes the side that did not (R-A4.4)', async () => {
    let attempt = 0;
    installFetch({
      awaiting: () => {
        attempt += 1;
        return attempt === 1
          ? jsonRes(AWAITING)
          : jsonRes({ reviewRequested: { ok: true, total: 5, items: [], complete: true }, mentioned: { ok: false } });
      },
    });
    await readers(1);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The two sides fail independently and are retained independently: the review count
    // moved to what the server just said, the mention count kept what it last knew rather
    // than falling back to "not yet known" and vanishing under R-A1.5.
    expect(text('review')).toBe('5');
    expect(text('mentioned')).toBe('2');
  });

  it('survives a 200 whose shape is not the contract', async () => {
    // Not hypothetical: every existing suite whose stub matches `/collab/pulls` by prefix
    // answers this route with the *listing* body. A missing side has to read as "said
    // nothing", because throwing here would take down every subscriber — the header among
    // them, which R-A4.7 forbids outright.
    installFetch({ awaiting: () => jsonRes({ pulls: [] }) });
    await readers(1);

    expect(text('review')).toBeNull();
    expect(text('mentioned')).toBeNull();
  });
});
