/**
 * review-source.test.ts — R-W1.4, at the only level the seam can be checked at yet.
 *
 * There is no behaviour to test: `review-source.ts` declares types and a contract and
 * nothing else. What *can* fail today is the shape — an interface that no plausible
 * implementation can satisfy, or that one of the two can satisfy only by leaking its
 * mechanism through it. So both future implementations are written here as stubs, one
 * shaped like the checkout side and one like the host side, and the compiler is asked
 * whether they conform. `tsc --noEmit` is the assertion; the runtime bodies exist only
 * because a stub has to return something.
 *
 * The two stubs differ in exactly one visible way — `kind` — which is the property the
 * seam is supposed to have. If a later story finds it has to add a method for only one
 * of them, this file stops compiling for the other, which is the failure worth catching
 * early.
 *
 * Neither stub imports anything from a real implementation. That is deliberate: this
 * asserts the contract, not any code that happens to satisfy it.
 */
import { describe, expect, it } from 'vitest';
import type { ReviewSource } from './review-source';

/**
 * Shaped like `review-source-worktree.ts` (story 1.2): the sha is whatever the checkout
 * is detached at, and every read would go to disk.
 */
const checkoutStub: ReviewSource = {
  kind: 'checkout',
  headSha: '0000000000000000000000000000000000000000',
  changedPaths: async () => ({ ok: true, value: ['docs/spec.md'] }),
  listDirectory: async (path) => ({
    ok: true,
    value: [{ name: 'spec.md', path: `${path}/spec.md`, kind: 'file' }],
  }),
  readFile: async (path) => ({ ok: true, value: { path, text: '' } }),
};

/**
 * Shaped like `review-source-api.ts` (stories 2.2 / 2.3): the sha is the pull request's
 * head as the host reported it, and every read is a round trip — which is why this one
 * is the side that has the three R-W2.7 failures to report.
 */
const hostStub: ReviewSource = {
  kind: 'host',
  headSha: '1111111111111111111111111111111111111111',
  changedPaths: async () => ({ ok: false, reason: 'unreachable' }),
  listDirectory: async () => ({ ok: false, reason: 'no-credential' }),
  readFile: async () => ({ ok: false, reason: 'not-readable', detail: 'HTTP 404' }),
};

describe('ReviewSource (R-W1.4)', () => {
  // The compile is the test. This body only proves the stubs above were reachable —
  // an unreferenced binding would be typechecked but is easy to delete by accident.
  it.each([checkoutStub, hostStub])('$kind conforms to the one interface', (source) => {
    expect(source.kind === 'checkout' || source.kind === 'host').toBe(true);
  });
});
