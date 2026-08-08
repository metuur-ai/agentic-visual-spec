/**
 * node-location.ts — locating a node inside a persisted document. Pure, and that is the
 * whole point of the file.
 *
 * WHY THIS IS NOT IN `document-store.ts`. It used to be, next to `fsDocumentStore`, which
 * imports `node:fs/promises` and `node:path`. `anchor-resolution.ts` needs `resolveNodeIn`
 * and the browser needs `anchor-resolution.ts`, so that one value import dragged the whole
 * filesystem store into the browser bundle and the Vite build failed on
 * `"join" is not exported by "__vite-browser-external"`. Splitting the pure lookup out of
 * the Node-only store is the fix; `document-store.ts` re-exports these so existing callers
 * are unchanged.
 *
 * Nothing here may import a node builtin — `ui/browser-safety.test.ts` fails if one
 * becomes reachable from the app again.
 */
import type { CollaborationDocument, CollaborationNode } from './document-protocol';

/** A document id is a single path segment — guards against traversal. */
export const DOCUMENT_ID_RE = /^[a-z0-9][a-z0-9-_]*$/i;

/**
 * R-3.4 — where a node lives inside the persisted JSON.
 *
 * `path` is the structural path from `doc.root` to the node: a list of child indices,
 * each one indexing the `children` array of the node reached so far. `[]` denotes
 * `doc.root` itself (never returned — the root carries no id), `[2]` is
 * `doc.root.children[2]`, `[2, 0]` is `doc.root.children[2].children[0]`.
 *
 * The path is a *location*, not an identity: it is valid only against the document
 * revision it was resolved from, and it changes when blocks move. Identity stays on
 * `node.id` (R-2.2). Callers that need to re-locate after an edit resolve again.
 */
export type NodeLocation = {
  path: number[];
  node: CollaborationNode;
};

/**
 * R-3.8 — the result of a `nodeId` lookup. An unresolved id is *reported*, never
 * thrown: a comment whose anchor no longer exists is orphaned (LLD §6), which is an
 * expected state of the document, not a failure of the store. Callers discriminate on
 * `found` — `if (r.found) { r.path; r.node }` narrows, `else` is the orphan branch.
 *
 * `found: false` also covers "the document itself does not exist".
 */
export type NodeResolution = ({ found: true } & NodeLocation) | { found: false };

/**
 * R-3.4 — the pure lookup behind `DocumentStore.resolveNode`, exported for callers that
 * already hold a document (anchor resolution, task 6.1) and should not pay a re-read.
 *
 * Serialized Lexical nodes carry the id under the NodeState `$` key —
 * `{"type":"paragraph", …, "$":{"nodeId":"…"}}` — which is where task 2.1's
 * extension writes it (R-2.2). That is the authoritative spelling and is checked
 * first. The `ui/` side reads it via `getSerializedNodeId()`; `core/` inlines the
 * same read rather than importing it, because anything under `ui/` pulls in Luthor
 * and this module is Node-reachable from the CLI (R-3.3, enforced by the bundle guard).
 *
 * A bare `id` / `nodeId` field is also accepted, because the protocol's
 * `CollaborationNode` (task 1.1) uses `id` for the flattened node list on the
 * envelope, which is a different shape from the Lexical tree under `doc.root`.
 */
export function resolveNodeIn(doc: CollaborationDocument, nodeId: string): NodeResolution {
  if (!nodeId) return { found: false };

  const idOf = (n: Record<string, unknown>): string | null => {
    const state = n.$;
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      const stateId = (state as Record<string, unknown>).nodeId;
      if (typeof stateId === 'string' && stateId) return stateId;
    }
    const id = n.id ?? n.nodeId;
    return typeof id === 'string' ? id : null;
  };

  const walk = (node: Record<string, unknown>, path: number[]): NodeResolution => {
    if (idOf(node) === nodeId) return { found: true, path, node: node as unknown as CollaborationNode };
    const children = node.children;
    if (!Array.isArray(children)) return { found: false };
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
      const hit = walk(child as Record<string, unknown>, [...path, i]);
      if (hit.found) return hit;
    }
    return { found: false };
  };

  const root = doc.doc?.root;
  if (!root || typeof root !== 'object') return { found: false };
  return walk(root as Record<string, unknown>, []);
}
