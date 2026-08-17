/**
 * record-store.ts — where a collaboration document lives locally.
 *
 * TWO FILES, AND THE SPLIT IS THE POINT (R-0.1). The Markdown is written at
 * `<baseDir>/<documentPath>` — a real `.md` file, in the tree the user already browses,
 * at the same path it occupies on the branch. That is what makes the apply handoff work:
 * the agent is spawned with `baseDir` as its cwd and told to edit `documentPath`, so the
 * file it opens is the file under review. The bookkeeping — id, title, GitHub binding —
 * goes in a sidecar under `<baseDir>/<metaDir>/<documentId>.json`, because none of it is
 * the document and none of it belongs in the document.
 *
 * There is deliberately no structured representation of the *content* anywhere here
 * (R-0.2). The store reads and writes bytes.
 *
 * Node-reachable from the CLI: node builtins and sibling core modules only — no
 * `@lyfie/luthor`, no react (R-12.6 / R-12.6a, guarded by `core/bundle-guard.test.ts`).
 * The pure half — `DOCUMENT_ID_RE` and the record types — lives in `document-record.ts`
 * so the browser can reach it without dragging `node:fs` in.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  DOCUMENT_ID_RE,
  type CollaborationRecord,
  parseRecordMeta,
  serializeRecordMeta,
} from './document-record';

/** Where the metadata sidecars live, relative to the content directory. */
export const DEFAULT_META_DIR = '.visual-spec/collab';

/**
 * Read, write and list collaboration records.
 *
 * Every method is async so a future backend (a PR branch, say) can implement the same
 * three operations without reshaping the callers.
 */
export interface CollaborationStore {
  /** The record, or `null` when no document has that id. */
  read(documentId: string): Promise<CollaborationRecord | null>;
  /** Persist the Markdown and the metadata. The id written is `record.documentId`. */
  write(record: CollaborationRecord): Promise<void>;
  /** Every known `documentId`, sorted. */
  list(): Promise<string[]>;
}

/**
 * Refuse a path that would escape the content directory. `documentPath` reaches this
 * layer from a request body, so it is untrusted in exactly the way `documentId` is.
 */
function safeJoin(baseDir: string, relativePath: string): string {
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\0')) {
    throw new Error(`invalid documentPath: ${relativePath}`);
  }
  const base = resolve(baseDir);
  const full = resolve(base, relativePath);
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`invalid documentPath: ${relativePath}`);
  return full;
}

/** File-backed store. `baseDir` is the content directory — the agent's cwd. */
export function fsCollaborationStore(baseDir: string, metaDir = DEFAULT_META_DIR): CollaborationStore {
  const metaPath = (documentId: string): string => {
    if (!DOCUMENT_ID_RE.test(documentId)) throw new Error(`invalid documentId: ${documentId}`);
    return join(baseDir, metaDir, `${documentId}.json`);
  };

  const readIfPresent = async (path: string): Promise<string | null> => {
    try {
      return await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };

  return {
    async read(documentId) {
      const raw = await readIfPresent(metaPath(documentId));
      if (raw === null) return null;
      const { companions: companionPaths, ...meta } = parseRecordMeta(raw);
      // A missing local `.md` is an empty document, not a failure: the metadata is what
      // says the document exists, and `open` writes the file a moment after the sidecar.
      const markdown = (await readIfPresent(safeJoin(baseDir, meta.documentPath))) ?? '';
      // Companions are read on the same terms — the sidecar names them, the tree holds
      // their bytes, and a missing file reads as empty rather than failing the document.
      const companions = await Promise.all(
        (companionPaths ?? []).map(async ({ path }) => ({
          path,
          markdown: (await readIfPresent(safeJoin(baseDir, path))) ?? '',
        })),
      );
      return { ...meta, markdown, ...(companions.length ? { companions } : {}) };
    },

    async write(record) {
      const meta = metaPath(record.documentId);
      const write = async (relativePath: string, contents: string) => {
        const full = safeJoin(baseDir, relativePath);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, contents, 'utf8');
      };
      await write(record.documentPath, record.markdown);
      // R-8.32 — `safeJoin` refuses an escaping path, and it refuses inside this loop
      // before any of the remaining companions are written. The route rejects the whole
      // request earlier for the same reason; this is the layer that cannot be bypassed.
      for (const companion of record.companions ?? []) await write(companion.path, companion.markdown);
      await mkdir(dirname(meta), { recursive: true });
      await writeFile(meta, serializeRecordMeta(record), 'utf8');
    },

    async list() {
      let entries: string[];
      try {
        entries = await readdir(join(baseDir, metaDir));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      return entries
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
        .filter((id) => DOCUMENT_ID_RE.test(id))
        .sort();
    },
  };
}
