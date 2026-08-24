/**
 * R-10.9 — the browser half of the root-epoch handshake.
 *
 * The router (`core/vite/routes/collab.ts`) refuses a write whose `x-vs-root-epoch`
 * does not match the current one. That refusal only reaches a stale tab if the client
 * actually echoes the epoch back, which is what these tests hold.
 */
import { describe, expect, it } from 'vitest';

import { ROOT_EPOCH_HEADER as ROUTER_HEADER } from '../core/vite/routes/collab';
import { ROOT_EPOCH_HEADER, createCollabClient } from './collab-client';

/** A `fetch` that records the headers it was handed and answers a fixed epoch. */
function fetchStub(epochs: (string | null)[]) {
  const seen: (string | null)[] = [];
  let i = 0;
  const impl = (async (_url: string, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get(ROOT_EPOCH_HEADER));
    const epoch = epochs[Math.min(i++, epochs.length - 1)];
    return {
      ok: true,
      status: 200,
      headers: new Headers(epoch === null ? {} : { [ROOT_EPOCH_HEADER]: epoch }),
      json: async () => ({ pulls: [] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe('collab client root epoch (R-10.9)', () => {
  it('spells the same header name the router reads', () => {
    // The client cannot import the router's value without pulling server code into the
    // browser bundle, so the two copies are pinned to each other here instead.
    expect(ROOT_EPOCH_HEADER).toBe(ROUTER_HEADER);
  });

  it('sends no epoch on the first request — it has not been told one yet', async () => {
    const { impl, seen } = fetchStub(['3']);
    await createCollabClient(impl).pullRequests();
    expect(seen).toEqual([null]);
  });

  it('echoes the epoch the server last reported on every later request', async () => {
    const { impl, seen } = fetchStub(['3']);
    const client = createCollabClient(impl);
    await client.pullRequests();
    await client.pullRequests();
    await client.pullRequests();
    expect(seen).toEqual([null, '3', '3']);
  });

  it('adopts a new epoch after a re-root rather than pinning the first one', async () => {
    const { impl, seen } = fetchStub(['3', '4', '4']);
    const client = createCollabClient(impl);
    await client.pullRequests();
    await client.pullRequests();
    await client.pullRequests();
    // Third request carries 4: a tab that stayed open follows the server across a
    // re-root. It is the tab that *stops* calling that goes stale and gets refused.
    expect(seen).toEqual([null, '3', '4']);
  });

  it('keeps the last known epoch when a response omits the header', async () => {
    // Not every response comes from the collab router; a proxy or an error page may
    // answer without it. Forgetting the epoch there would silently un-stale the tab.
    const { impl, seen } = fetchStub(['3', null, null]);
    const client = createCollabClient(impl);
    await client.pullRequests();
    await client.pullRequests();
    await client.pullRequests();
    expect(seen).toEqual([null, '3', '3']);
  });

  it('does not drop the caller-supplied headers when it adds its own', async () => {
    const seen: (string | null)[][] = [];
    const impl = (async (_url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seen.push([h.get('content-type'), h.get(ROOT_EPOCH_HEADER)]);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ [ROOT_EPOCH_HEADER]: '7' }),
        json: async () => ({ pulls: [] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const client = createCollabClient(impl);
    await client.pullRequests();
    await client.sync('doc-1');
    expect(seen[1]).toEqual(['application/json', '7']);
  });
});
