/**
 * github-document-store.ts — the GitHub-backed `DocumentStore` (R-3.6). The same
 * read / write / list / resolveNode operations as `fsDocumentStore`, mapped onto a
 * single PR branch, so route handlers and lifecycle jobs stay backend-agnostic:
 * a directory on disk and a branch on GitHub are interchangeable behind the interface.
 *
 * `document-store.contract.test.ts` runs one suite against both implementations —
 * that shared suite is what "backend-agnostic" actually means here.
 *
 * **The mapping.** `<documentsDir>/<documentId>.json` on `branch`, the identical
 * layout the local store uses (R-3.5), so a document committed by one backend reads
 * back through the other. Reads are `GET /contents/:path?ref=<branch>`, writes are
 * `PUT /contents/:path`, and `list()` is the same `GET /contents` endpoint against
 * the *directory* — GitHub answers a directory path with an array. There is no
 * manifest file: a manifest is derived state that drifts from the branch it claims
 * to describe, which contradicts GitHub being the system of record (LLD §5).
 *
 * **Contents API only, never a working tree (LLD Constraints).** Nothing here shells
 * out to git; `.gitattributes` CRLF normalization runs at `git add` inside a checkout
 * and would corrupt publish byte-verification permanently. Every call goes through
 * `GitHubAdapter`.
 *
 * **No Markdown surface (R-3.2).** No render, no prose serializer, no Markdown path. Markdown
 * generation happens in the browser (LLD §12) and is write-only (R-2.10).
 *
 * **No cache (LLD §5 / simplicity).** Every `read` hits the branch. GitHub is the
 * system of record; a cache here would be a second one.
 *
 * Node-reachable from the CLI: protocol types and the adapter only — no
 * `@lyfie/luthor`, no react (R-3.3, guarded by `core/bundle-guard.test.ts`).
 */
import { parseCollaborationDocument, serializeCollaborationDocument } from './document-protocol';
import { DOCUMENT_ID_RE, type DocumentStore, type NodeResolution, resolveNodeIn } from './document-store';
import { GitHubError, type GitHubAdapter, type RepoRef } from './github-adapter';

/** Where the documents live: which repo, which PR branch, which directory. */
export type GitHubDocumentStoreConfig = {
  /** Owner + repo holding the collaboration branch. */
  repo: RepoRef;
  /** The PR branch every read and write is scoped to. Never the base branch. */
  branch: string;
  /** Repo-relative directory, matching the local store's layout. */
  documentsDir?: string;
};

/**
 * A write that lost a race (R-3.6, and the input to the R-8.x conflict states).
 *
 * `write()` returns `Promise<void>`, so the interface offers no return channel for
 * this — surfacing it as a *typed* error is the only way to make it distinguishable
 * without changing the `DocumentStore` shape that other tasks are building against.
 * Callers discriminate with `err instanceof DocumentWriteConflictError`.
 *
 * It is raised for exactly two GitHub answers, which are the same race seen from two
 * sides:
 *
 * - **409** — a `sha` was sent and no longer matches; the file moved under us since
 *   the read-before-write.
 * - **422 mentioning `sha`** — no `sha` was sent because the read-before-write saw no
 *   file, and one has since been created.
 *
 * Everything else stays a `GitHubError` (`cause` carries it either way).
 */
export class DocumentWriteConflictError extends Error {
  readonly name = 'DocumentWriteConflictError';
  readonly documentId: string;
  /** Repo-relative path of the contested file. */
  readonly path: string;
  readonly branch: string;
  /** The blob sha the write was based on; `undefined` when it was a create. */
  readonly expectedSha: string | undefined;
  /** The underlying adapter error, already credential-scrubbed (R-4.9). */
  readonly cause: GitHubError;

  constructor(args: {
    documentId: string;
    path: string;
    branch: string;
    expectedSha: string | undefined;
    cause: GitHubError;
  }) {
    super(
      `document ${args.documentId} changed on ${args.branch} since it was read` +
        `${args.expectedSha ? ` (expected blob ${args.expectedSha})` : ' (expected it to be absent)'}: ${args.cause.message}`,
    );
    this.documentId = args.documentId;
    this.path = args.path;
    this.branch = args.branch;
    this.expectedSha = args.expectedSha;
    this.cause = args.cause;
  }
}

/** The two GitHub answers that mean "the branch moved under this write". */
function isConflict(err: GitHubError): boolean {
  if (err.status === 409) return true;
  return err.status === 422 && /\bsha\b/i.test(err.message);
}

/**
 * R-3.6 — build a `DocumentStore` over a PR branch. `adapter` is the only GitHub
 * seam; tests inject one built on a recorded-response executor, so no network is
 * touched (R-4.8 / R-12.3).
 */
export function githubDocumentStore(adapter: GitHubAdapter, config: GitHubDocumentStoreConfig): DocumentStore {
  const { repo, branch } = config;
  const documentsDir = config.documentsDir ?? 'documents';

  // Same guard and same layout as the local store, so ids stay portable between the
  // two backends and cannot inject path segments into the Contents endpoint.
  const filePath = (documentId: string): string => {
    if (!DOCUMENT_ID_RE.test(documentId)) throw new Error(`invalid documentId: ${documentId}`);
    return `${documentsDir}/${documentId}.json`;
  };

  const store: DocumentStore = {
    async read(documentId) {
      // `getFile` already maps 404 → null, so an absent document reads as `null`
      // rather than throwing, exactly as the local store does (R-3.1 / R-3.8).
      const file = await adapter.getFile(repo, filePath(documentId), branch);
      return file ? parseCollaborationDocument(file.content) : null;
    },

    /**
     * Read-before-write. The Contents API needs the *current* blob sha to replace a
     * file, and the store has no cache to take one from, so `write` reads the path on
     * `branch` first:
     *
     * - file present → PUT carrying its `sha` (update);
     * - file absent  → PUT with no `sha` (create);
     * - either answer contradicted by GitHub → `DocumentWriteConflictError`.
     *
     * The read/PUT pair is not atomic and cannot be made so over this API. That window
     * is precisely what the conflict error reports: this layer detects the race and
     * refuses, it never re-reads and retries. Resolution is R-8.x's, not the store's.
     */
    async write(doc) {
      const path = filePath(doc.documentId);
      const existing = await adapter.getFile(repo, path, branch);
      const sha = existing?.sha;
      try {
        await adapter.commitFile(repo, {
          path,
          content: serializeCollaborationDocument(doc),
          message: `${existing ? 'docs: update' : 'docs: create'} ${doc.documentId}`,
          branch,
          ...(sha ? { sha } : {}),
        });
      } catch (err) {
        if (err instanceof GitHubError && isConflict(err)) {
          throw new DocumentWriteConflictError({ documentId: doc.documentId, path, branch, expectedSha: sha, cause: err });
        }
        throw err;
      }
    },

    /**
     * The directory listing *is* the answer — the branch is the system of record, so
     * there is nothing to reconcile a manifest against. A missing directory lists as
     * `[]`, matching the local store on a missing `documents/` folder.
     */
    async list() {
      const entries = await adapter.listFiles(repo, documentsDir, branch);
      return entries
        .filter((e) => e.type === 'file' && e.name.endsWith('.json'))
        .map((e) => e.name.slice(0, -'.json'.length))
        // Anything else committed into the directory is not a document id.
        .filter((id) => DOCUMENT_ID_RE.test(id))
        .sort();
    },

    async resolveNode(documentId, nodeId): Promise<NodeResolution> {
      const doc = await store.read(documentId);
      return doc ? resolveNodeIn(doc, nodeId) : { found: false };
    },
  };

  return store;
}
