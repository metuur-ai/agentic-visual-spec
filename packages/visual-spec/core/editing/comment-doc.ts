/**
 * comment-doc.ts — the sidecar comment model. Comments on browsed artifacts are
 * NOT written into the files; they live in one JSON document (visual-spec-comments
 * .json) that an agent reads. Each record pins a comment to a `target` (a file, a
 * line range within a file, or a folder) and carries a `workflow` routing tag so
 * the reusable Apply Comments capability can hand it to the right primary skill.
 *
 * Pure functions over the doc; the route owns file I/O. `parseDoc` upgrades the
 * earlier markdown-only `{ file, anchor }` shape on read, so old sidecars keep
 * working.
 */
import type { SpecDialect } from './specs';

export type CommentStatus = 'open' | 'applied';

/** What a comment points at. `range` covers one-or-more lines within a file. */
export type CommentTargetKind = 'file' | 'range' | 'folder';

export type CommentTarget = {
  path: string; // posix path relative to the base dir — a file or a folder
  kind: CommentTargetKind;
  // kind === 'range': line anchoring within the file.
  startLine?: number; // 1-indexed first line
  endLine?: number; // 1-indexed last line (absent for a single block)
  snippet?: string; // text at the start line (<=160 chars) — drift-resilient anchor
  endSnippet?: string; // text at the end line (<=160 chars)
  heading?: string | null; // markdown hint: nearest heading above the block
};

export type CommentRecord = {
  id: string; // c-<8hex>
  workflow: string; // routing tag for Apply Comments handoff (default "visual-spec")
  target: CommentTarget;
  comment: string; // the user's instruction
  selectedContent?: string; // verbatim text the user highlighted, if any
  dialect?: SpecDialect; // optional: comment authored as a formal spec
  spec?: string; // optional: normalized EARS sentence(s) for the agent
  status: CommentStatus;
  ts: string;
  result?: string; // short summary of the resulting change, set when applied (R-2.1)
};

export type CommentDoc = { version: 1; comments: CommentRecord[] };

export const DEFAULT_WORKFLOW = 'visual-spec';
export const EMPTY_DOC: CommentDoc = { version: 1, comments: [] };

/** Legacy markdown-only record shape, kept only for the read-time upgrader. */
type LegacyAnchor = {
  heading?: string | null;
  line?: number;
  snippet?: string;
  selection?: 'range';
  endLine?: number;
  endSnippet?: string;
};

/** Map an old `{ file, anchor }` record (or pass through a new one) → CommentRecord. */
function upgrade(raw: unknown): CommentRecord {
  const rec = raw as Record<string, unknown>;
  if (rec.target && typeof rec.target === 'object') {
    return { workflow: DEFAULT_WORKFLOW, ...(rec as object) } as CommentRecord;
  }
  const a = (rec.anchor ?? {}) as LegacyAnchor;
  const file = typeof rec.file === 'string' ? rec.file : '';
  const path = file && !file.endsWith('.md') ? `${file}.md` : file; // surface id → real path
  const hasLine = typeof a.line === 'number';
  const target: CommentTarget = { path, kind: hasLine ? 'range' : 'file' };
  if (hasLine) {
    target.startLine = a.line;
    if (a.snippet) target.snippet = a.snippet;
    if (a.selection === 'range') {
      target.endLine = a.endLine;
      target.endSnippet = a.endSnippet;
    }
  }
  if (a.heading !== undefined) target.heading = a.heading;
  return {
    id: String(rec.id ?? ''),
    workflow: typeof rec.workflow === 'string' ? rec.workflow : DEFAULT_WORKFLOW,
    target,
    comment: String(rec.comment ?? ''),
    ...(rec.selectedContent ? { selectedContent: rec.selectedContent as string } : {}),
    ...(rec.dialect ? { dialect: rec.dialect as SpecDialect } : {}),
    ...(rec.spec ? { spec: rec.spec as string } : {}),
    status: (rec.status as CommentStatus) ?? 'open',
    ts: String(rec.ts ?? ''),
    ...(rec.result ? { result: rec.result as string } : {}), // R-2.2: preserve result in legacy branch
  };
}

export function parseDoc(raw: string | null | undefined): CommentDoc {
  if (!raw || !raw.trim()) return { version: 1, comments: [] };
  const parsed = JSON.parse(raw) as Partial<CommentDoc>;
  const comments = Array.isArray(parsed.comments) ? parsed.comments.map(upgrade) : [];
  return { version: 1, comments };
}

export function serializeDoc(doc: CommentDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function addComment(doc: CommentDoc, record: CommentRecord): CommentDoc {
  return { ...doc, comments: [...doc.comments, record] };
}

/** Filter by target path (a file or folder). Omit `path` to list everything. */
export function listComments(doc: CommentDoc, path?: string): CommentRecord[] {
  return path ? doc.comments.filter((c) => c.target.path === path) : doc.comments;
}

export function removeComment(doc: CommentDoc, id: string): CommentDoc {
  return { ...doc, comments: doc.comments.filter((c) => c.id !== id) };
}

export function setStatus(doc: CommentDoc, id: string, status: CommentStatus, result?: string): CommentDoc {
  return {
    ...doc,
    comments: doc.comments.map((c) =>
      c.id === id ? { ...c, status, ...(result !== undefined ? { result } : {}) } : c
    ),
  };
}

/** Group open comments by target path — the shape an in-place apply consumes. */
export function openByPath(doc: CommentDoc): Record<string, CommentRecord[]> {
  const out: Record<string, CommentRecord[]> = {};
  for (const c of doc.comments) {
    if (c.status !== 'open') continue;
    (out[c.target.path] ??= []).push(c);
  }
  return out;
}

/** Group open comments by workflow tag — the shape the Apply Comments dispatch uses. */
export function openByWorkflow(doc: CommentDoc): Record<string, CommentRecord[]> {
  const out: Record<string, CommentRecord[]> = {};
  for (const c of doc.comments) {
    if (c.status !== 'open') continue;
    (out[c.workflow] ??= []).push(c);
  }
  return out;
}

/**
 * R-3.2 / R-3.3 / R-3.4 — applied comments for a path, sorted ts descending.
 * Non-mutating (copies before sort).
 */
export function historyFor(comments: CommentRecord[], path: string): CommentRecord[] {
  return comments
    .filter((c) => c.target.path === path && c.status === 'applied')
    .slice()
    .sort((a, b) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0));
}

/**
 * R-3.7 — human-readable anchor label for a comment.
 * Priority: heading → line range → path fallback.
 */
export function anchorLabelOf(c: CommentRecord): string {
  if (c.target.heading) return c.target.heading;
  if (c.target.startLine != null) {
    return c.target.endLine != null && c.target.endLine !== c.target.startLine
      ? `L${c.target.startLine}–${c.target.endLine}`
      : `L${c.target.startLine}`;
  }
  return c.target.path;
}
