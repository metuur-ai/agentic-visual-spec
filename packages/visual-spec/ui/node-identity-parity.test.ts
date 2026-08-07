// @vitest-environment jsdom
/**
 * node-identity-parity.test.ts — the two halves of the `nodeId` layer live on opposite
 * sides of the bundle guard: `ui/node-id-extension.ts` assigns ids inside the editor
 * (and imports Luthor), `core/collaboration/node-identity.ts` backfills and versions
 * the persisted JSON (and must never import Luthor, R-3.3). Both need the same answer
 * to "which node types are addressable blocks", so the exclusion list is stated twice.
 *
 * This test is the only place that may import both, and it fails if they drift.
 */
import './prism-global'; // must precede @lyfie/luthor — sets the global Prism
import { describe, expect, it } from 'vitest';
import { isAddressableBlockType, NODE_IDENTITY_EXCLUDED_TYPES } from '../core/collaboration/node-identity';
import { NODE_ID_BLOCK_TYPES, NODE_ID_EXCLUDED_TYPES } from './node-id-extension';

describe('nodeId exclusion lists stay in sync across the core/ui boundary', () => {
  it('core lists exactly the types the editor extension excludes', () => {
    expect([...NODE_IDENTITY_EXCLUDED_TYPES].sort()).toEqual(Object.keys(NODE_ID_EXCLUDED_TYPES).sort());
  });

  it('every block type the editor identifies is addressable in core (R-12.2)', () => {
    for (const type of NODE_ID_BLOCK_TYPES) expect(isAddressableBlockType(type)).toBe(true);
  });
});
