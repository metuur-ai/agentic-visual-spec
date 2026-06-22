/**
 * routes/comments.ts — the sidecar /__vs/comments API. Backed by one JSON file
 * (visual-spec-comments.json). The client supplies the full anchor (file,
 * heading, line, snippet) computed from the rendered markdown, so the server just
 * manages the JSON document.
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  type CommentDoc,
  type CommentRecord,
  type CommentStatus,
  type CommentTarget,
  type CommentTargetKind,
  DEFAULT_WORKFLOW,
  addComment,
  listComments,
  parseDoc,
  removeComment,
  serializeDoc,
  setStatus,
} from '../../editing/comment-doc';
import { randomHex8 } from '../../editing/id';

export type RouteResult = { status: number; json: unknown };

export interface CommentDocStore {
  read(): Promise<CommentDoc>;
  write(doc: CommentDoc): Promise<void>;
}

export function fileCommentStore(path: string): CommentDocStore {
  return {
    async read() {
      try {
        return parseDoc(await readFile(path, 'utf8'));
      } catch {
        return parseDoc(null);
      }
    },
    async write(doc) {
      await writeFile(path, serializeDoc(doc), 'utf8');
    },
  };
}

export type AddCommentRequest = {
  // Generic target (preferred).
  path?: string;
  kind?: CommentTargetKind;
  workflow?: string;
  startLine?: number;
  endLine?: number;
  snippet?: string;
  endSnippet?: string;
  heading?: string | null;
  selectedContent?: string;
  comment: string;
  dialect?: CommentRecord['dialect'];
  spec?: string;
  id?: string;
  ts?: string;
  // Legacy markdown body (surface id + single line) — still accepted & normalized.
  file?: string;
  line?: number;
  selection?: 'range';
};

/** Build a CommentTarget from either the generic or the legacy markdown body. */
function buildTarget(req: AddCommentRequest): CommentTarget {
  const fromLegacy = req.file && !req.file.endsWith('.md') ? `${req.file}.md` : req.file;
  const path = req.path ?? fromLegacy;
  if (!path) throw new Error('missing target path');
  if (req.kind === 'folder') return { path, kind: 'folder' };
  const startLine = req.startLine ?? req.line;
  const kind: CommentTargetKind = req.kind ?? (typeof startLine === 'number' ? 'range' : 'file');
  if (kind !== 'range') return { path, kind };
  const target: CommentTarget = { path, kind: 'range' };
  if (typeof startLine === 'number') target.startLine = startLine;
  if (typeof req.endLine === 'number') target.endLine = req.endLine;
  if (req.snippet) target.snippet = req.snippet.slice(0, 160);
  if (req.endSnippet || req.selection === 'range') target.endSnippet = (req.endSnippet ?? '').slice(0, 160);
  if (req.heading !== undefined) target.heading = req.heading;
  return target;
}

export async function handleCommentsRequest(
  store: CommentDocStore,
  method: string,
  pathname: string,
  query: Record<string, string>,
  body: Record<string, unknown>,
  now: () => string = () => new Date().toISOString(),
): Promise<RouteResult> {
  try {
    if (method === 'GET' && (pathname === '' || pathname === '/')) {
      const doc = await store.read();
      return { status: 200, json: listComments(doc, query.path ?? query.file) };
    }
    if (method === 'GET' && pathname === '/all') {
      return { status: 200, json: await store.read() };
    }
    if (method === 'POST' && pathname === '/add') {
      const req = body as unknown as AddCommentRequest;
      const record: CommentRecord = {
        id: req.id ?? `c-${randomHex8()}`,
        workflow: req.workflow ?? DEFAULT_WORKFLOW,
        target: buildTarget(req),
        comment: req.comment,
        ...(req.selectedContent ? { selectedContent: req.selectedContent } : {}),
        ...(req.dialect ? { dialect: req.dialect } : {}),
        ...(req.spec ? { spec: req.spec } : {}),
        status: 'open',
        ts: req.ts ?? now(),
      };
      await store.write(addComment(await store.read(), record));
      return { status: 200, json: { ok: true, id: record.id } };
    }
    const idMatch = /^\/(c-[a-f0-9]+)$/.exec(pathname);
    if (idMatch) {
      const id = idMatch[1]!;
      if (method === 'PATCH') {
        await store.write(setStatus(await store.read(), id, body.status as CommentStatus));
        return { status: 200, json: { ok: true } };
      }
      if (method === 'DELETE') {
        await store.write(removeComment(await store.read(), id));
        return { status: 200, json: { ok: true } };
      }
    }
    return { status: 404, json: { error: `no route: ${method} /__vs/comments${pathname}` } };
  } catch (err) {
    return { status: 400, json: { error: (err as Error).message } };
  }
}
