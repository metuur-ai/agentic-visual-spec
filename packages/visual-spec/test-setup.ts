/**
 * test-setup.ts — per-test reset of module-level caches.
 *
 * `useComments` keeps one cache per query for the whole page rather than one copy per
 * component (see the header of use-comments.ts). That is right for a running app and
 * wrong for a test file, where the next test would render against the previous test's
 * records before its own stubbed fetch answered. Clearing it between tests keeps each
 * one starting from an empty sidecar, which is what it did when the records lived in
 * component state.
 */
import { beforeEach } from 'vitest';
import { resetCommentsCache } from './core/app/lib/use-comments';
import { resetAwaitingCache } from './ui/use-awaiting-pulls';

beforeEach(() => {
  resetCommentsCache();
  // Same reasoning, and one more: `/pulls/awaiting` is gated on an availability answer
  // this store remembers for the life of the page. A test whose server has collaboration
  // off would otherwise inherit the previous test's "configured", and read a route its
  // own stub never expected.
  resetAwaitingCache();
});
