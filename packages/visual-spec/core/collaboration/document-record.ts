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
  github?: GitHubBinding;
};

/** The metadata half, which is what actually gets persisted beside the Markdown. */
export type CollaborationRecordMeta = Omit<CollaborationRecord, 'markdown'>;

/** The record a document starts life as, before it has ever met GitHub. */
export function newCollaborationRecord(input: {
  documentId: string;
  documentPath: string;
  title?: string;
  markdown?: string;
}): CollaborationRecord {
  return {
    documentId: input.documentId,
    documentPath: input.documentPath,
    title: input.title?.trim() || input.documentId,
    markdown: input.markdown ?? '',
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
  return {
    ...(rec as object),
    documentId: String(rec.documentId ?? ''),
    documentPath: String(rec.documentPath ?? ''),
    title: typeof rec.title === 'string' ? rec.title : '',
    ...(github && typeof github === 'object' && !Array.isArray(github) ? { github: github as GitHubBinding } : {}),
  } as CollaborationRecordMeta;
}

/** Write the metadata half. The Markdown is never folded in — it is its own file. */
export function serializeRecordMeta(record: CollaborationRecord | CollaborationRecordMeta): string {
  const { markdown: _markdown, ...meta } = record as CollaborationRecord;
  return `${JSON.stringify(meta, null, 2)}\n`;
}
