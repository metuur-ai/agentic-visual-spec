/**
 * document-store.ts — the persistence boundary for collaboration documents (R-3.1 …
 * R-3.8). Route handlers and lifecycle jobs depend on this interface, not on `fs` or on
 * the GitHub adapter directly, so a local checkout and a PR branch are interchangeable.
 *
 * **Deliberately not `SurfaceStore` (R-3.7).** `core/vite/surface-store.ts` reads and
 * writes surface *text* (`read(): Promise<string>`); a collaboration document is a
 * structured envelope with a node graph inside it. Routing the JSON through the text
 * contract would mean stringifying at every call site and would lose the one operation
 * that matters here — `resolveNode`. This module therefore never imports surface-store,
 * and `document-store.test.ts` asserts it.
 *
 * **Deliberately no Markdown surface (R-3.2).** There is no `render`, no
 * `serializeMarkdown`, no `toMarkdown`. Markdown generation happens in the browser
 * (LLD §12) via Luthor's headless serializer, so the server never needs one — and
 * generated Markdown is write-only (R-2.10), so nothing parses it back either. Keeping
 * the surface absent is what stops a server-side Markdown path from growing back.
 *
 * **Persisted form is the 1.1 envelope (R-2.1).** Reads and writes go through
 * `parseCollaborationDocument` / `serializeCollaborationDocument`, so unknown fields on
 * the envelope and on nodes survive the store layer untouched (R-1.8). No bespoke node
 * schema is defined here.
 *
 * Node-reachable from the CLI, so it imports node builtins and the protocol types only —
 * no `@lyfie/luthor`, no react (R-3.3, guarded by `core/bundle-guard.test.ts`).
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type CollaborationDocument,
  type CollaborationNode,
  parseCollaborationDocument,
  serializeCollaborationDocument,
} from './document-protocol';

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
 * R-3.1 — read, write and list collaboration documents.
 *
 * Every method is async so the same interface can be implemented over a PR branch
 * (task 3.2) as well as the local filesystem.
 */
export interface DocumentStore {
  /** The persisted document, or `null` when no document has that id. */
  read(documentId: string): Promise<CollaborationDocument | null>;
  /** Persist the envelope. The id written is `doc.documentId`. */
  write(doc: CollaborationDocument): Promise<void>;
  /** Every known `documentId`, sorted. */
  list(): Promise<string[]>;
  /** R-3.4 / R-3.8 — locate `nodeId` inside a document, or report it unresolved. */
  resolveNode(documentId: string, nodeId: string): Promise<NodeResolution>;
}

/**
 * R-3.4 — the pure lookup behind `DocumentStore.resolveNode`, exported for callers that
 * already hold a document (anchor resolution, task 6.1) and should not pay a re-read.
 *
 * Nodes are matched on `id`, the field name the protocol's `CollaborationNode` uses.
 * `nodeId` is accepted as an alias because that is the name the Lexical replacement
 * classes register it under (R-2.2), and both spellings reach the persisted JSON.
 */
export function resolveNodeIn(doc: CollaborationDocument, nodeId: string): NodeResolution {
  if (!nodeId) return { found: false };

  const idOf = (n: Record<string, unknown>): string | null => {
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

/**
 * R-3.5 — file-backed store. Documents live at `<baseDir>/documents/<documentId>.json`.
 * `baseDir` is the only configuration: no cache, no watcher.
 */
export function fsDocumentStore(baseDir: string, documentsDir = 'documents'): DocumentStore {
  const filePath = (documentId: string) => {
    if (!DOCUMENT_ID_RE.test(documentId)) throw new Error(`invalid documentId: ${documentId}`);
    return join(baseDir, documentsDir, `${documentId}.json`);
  };

  const store: DocumentStore = {
    async read(documentId) {
      let raw: string;
      try {
        raw = await readFile(filePath(documentId), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
      return parseCollaborationDocument(raw);
    },

    async write(doc) {
      const target = filePath(doc.documentId);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, serializeCollaborationDocument(doc), 'utf8');
    },

    async list() {
      let entries: string[];
      try {
        entries = await readdir(join(baseDir, documentsDir));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      return entries
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
        .sort();
    },

    async resolveNode(documentId, nodeId) {
      const doc = await store.read(documentId);
      return doc ? resolveNodeIn(doc, nodeId) : { found: false };
    },
  };

  return store;
}
