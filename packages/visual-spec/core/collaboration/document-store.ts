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
  parseCollaborationDocument,
  serializeCollaborationDocument,
} from './document-protocol';
import { DOCUMENT_ID_RE, localDocumentPath, type NodeResolution, resolveNodeIn } from './node-location';

export { DOCUMENT_ID_RE };

export { localDocumentPath, resolveNodeIn } from './node-location';
export type { NodeLocation, NodeResolution } from './node-location';

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
 * R-3.5 — file-backed store. Documents live at `<baseDir>/documents/<documentId>.json`.
 * `baseDir` is the only configuration: no cache, no watcher.
 */
export function fsDocumentStore(baseDir: string, documentsDir = 'documents'): DocumentStore {
  const filePath = (documentId: string) => {
    if (!DOCUMENT_ID_RE.test(documentId)) throw new Error(`invalid documentId: ${documentId}`);
    return join(baseDir, localDocumentPath(documentId, documentsDir));
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
