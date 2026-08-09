/**
 * document-record.ts — what the system holds *about* a Markdown document under review.
 *
 * R-0.1 / R-0.2 — THE DOCUMENT IS THE MARKDOWN FILE. There is no envelope, no node list
 * and no block identity scheme here. A `CollaborationRecord` is bookkeeping: which file,
 * which branch, which Pull Request, and the Markdown bytes as they stood the last time
 * the local copy and the branch agreed. The bytes are the document; everything else on
 * the record exists only to say where they live.
 *
 * WHY THIS FILE IMPORTS NOTHING. `DOCUMENT_ID_RE` is reached from `job-hub.ts`, which the
 * browser value-imports, and the record types are reached from `ui/collab-client.ts`. The
 * moment a `node:` builtin lands in this module the Vite build fails on
 * `"join" is not exported by "__vite-browser-external"` — which is exactly what happened
 * the last time these two halves shared a file. The filesystem half lives next door in
 * `record-store.ts` and is Node-only. `ui/browser-safety.test.ts` and
 * `core/bundle-guard.test.ts` both fail if that separation is broken.
 */

/** A document id is a single path segment — guards against traversal. */
export const DOCUMENT_ID_RE = /^[a-z0-9][a-z0-9-_]*$/i;

/** Where a document lives on GitHub. */
export type GitHubBinding = {
  owner: string;
  repo: string;
  branch: string;
  pullNumber?: number; // absent until the PR is opened
  headSha?: string;
  /**
   * R-11.6 — the hash of the Markdown as it stood at the last point the local copy and
   * the branch provably agreed: written by create, by open, and by publish once the
   * committed bytes are verified.
   *
   * It exists because nothing else can answer "does the local copy hold work that is not
   * on the branch?". `headSha` is a commit pointer, is not updated on publish, and cannot
   * see a local edit that never became a commit — and an agent applying review comments
   * produces exactly that.
   */
  contentSha?: string;
  resolved: boolean;
  [key: string]: unknown;
};

/**
 * One Markdown document under (or heading for) Pull Request review.
 *
 * `documentPath` is a posix path and means the same thing on both sides: it is where the
 * file sits on the branch **and** where the local copy sits under the content directory.
 * That single meaning is what lets the apply agent — spawned with the content directory
 * as its cwd — be handed `documentPath` and find the file (see `core/bundle-guard.test.ts`).
 */
export type CollaborationRecord = {
  documentId: string;
  documentPath: string;
  title: string;
  /** The document itself (R-0.1). */
  markdown: string;
  /** R-8.29 — the other files travelling on the same branch. Absent means just the one. */
  companions?: CompanionFile[];
  github?: GitHubBinding;
};

/**
 * A file that travels with the document on the same branch and Pull Request (R-8.29).
 *
 * IT IS NOT A SECOND DOCUMENT. A collaboration has exactly one `documentId`, because
 * resume resolves exactly one from the Pull Request body (R-7.4, R-7.7) and the review
 * surface mounts exactly one. Companions have no id, no title and no GitHub binding of
 * their own — they are bytes at a path, committed alongside, reviewed in the same
 * conversation. R-8.30 is what this shape enforces: the set has a head.
 *
 * `path` means what `documentPath` means — where the file sits on the branch *and* where
 * the local copy sits under the content directory. One meaning, so the apply agent finds
 * the file it was told to edit.
 */
export type CompanionFile = {
  path: string;
  markdown: string;
};

/**
 * The metadata half, which is what actually gets persisted beside the Markdown.
 *
 * Companions lose their bytes here for the same reason the document does: the bytes are
 * the file, and the file is already on disk at `path`. Persisting them twice would let
 * the sidecar and the tree disagree, and the sidecar would be the copy nobody edits.
 */
export type CollaborationRecordMeta = Omit<CollaborationRecord, 'markdown' | 'companions'> & {
  companions?: { path: string }[];
};

/** The record a document starts life as, before it has ever met GitHub. */
export function newCollaborationRecord(input: {
  documentId: string;
  documentPath: string;
  title?: string;
  markdown?: string;
  companions?: CompanionFile[];
}): CollaborationRecord {
  return {
    documentId: input.documentId,
    documentPath: input.documentPath,
    title: input.title?.trim() || input.documentId,
    markdown: input.markdown ?? '',
    // Absent, not empty: a record with `companions: []` and one with none are the same
    // fact, and only one of them survives a round trip through the sidecar unchanged.
    ...(input.companions?.length ? { companions: input.companions } : {}),
  };
}

/**
 * A display title for a Markdown document: its first ATX heading, or `fallback`.
 *
 * With the JSON envelope gone there is nowhere else for a title to live — the branch
 * carries the `.md` and nothing beside it, so `open` has to read one out of the bytes or
 * invent one. Frontmatter is deliberately not consulted here: the surface renders it as a
 * card of its own, and a `title:` key there is authored content rather than the document's
 * name.
 */
export function titleFromMarkdown(markdown: string, fallback: string): string {
  for (const raw of markdown.split('\n')) {
    const atx = /^ {0,3}#{1,6}\s+(.*)$/.exec(raw);
    if (atx) {
      const text = atx[1]?.replace(/\s+#+\s*$/, '').trim();
      if (text) return text;
    }
  }
  return fallback;
}

/** Read the persisted metadata. Unknown keys survive the round trip untouched. */
export function parseRecordMeta(raw: string | null | undefined): CollaborationRecordMeta {
  if (!raw || !raw.trim()) throw new Error('parseRecordMeta: empty input');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('parseRecordMeta: expected a JSON object');
  }
  const rec = parsed as Record<string, unknown>;
  const github = rec.github;
  const companions = parseCompanionPaths(rec.companions);
  return {
    ...(rec as object),
    documentId: String(rec.documentId ?? ''),
    documentPath: String(rec.documentPath ?? ''),
    title: typeof rec.title === 'string' ? rec.title : '',
    ...(companions.length ? { companions } : {}),
    ...(github && typeof github === 'object' && !Array.isArray(github) ? { github: github as GitHubBinding } : {}),
  } as CollaborationRecordMeta;
}

/**
 * The companion list as the sidecar holds it: paths only, and only the well-formed ones.
 *
 * A malformed entry is dropped rather than thrown on. This parser already tolerates a
 * missing `documentId` and an absent `title`, because a sidecar that cannot be read at
 * all strands the document it describes — and a companion is the *least* load-bearing
 * thing in the file. Dropping one loses a file from the next commit; throwing loses the
 * collaboration.
 */
function parseCompanionPaths(raw: unknown): { path: string }[] {
  if (!Array.isArray(raw)) return [];
  const paths: { path: string }[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const path = (entry as Record<string, unknown>).path;
    if (typeof path === 'string' && path) paths.push({ path });
  }
  return paths;
}

/** Write the metadata half. The Markdown is never folded in — it is its own file. */
export function serializeRecordMeta(record: CollaborationRecord | CollaborationRecordMeta): string {
  const { markdown: _markdown, companions, ...rest } = record as CollaborationRecord;
  const meta = {
    ...rest,
    // Same rule as `markdown`, applied one level down: the path is bookkeeping, the bytes
    // are the file. `CompanionFile` and the persisted shape differ by exactly this.
    ...(companions?.length ? { companions: companions.map((c) => ({ path: c.path })) } : {}),
  };
  return `${JSON.stringify(meta, null, 2)}\n`;
}
