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

/** What a PATCH may change on a single comment. */
export type CommentPatch = {
  status?: CommentStatus;
  result?: string;
  comment?: string;
};

/**
 * `read`/`write` are the original snapshot contract and stay required.
 *
 * The three mutation methods are **optional and intent-based** (LLD §5 "The seam").
 * `write(doc)` is a whole-document snapshot swap returning `void`, so a remote-backed
 * store cannot tell "one comment was added" from a new snapshot and has no channel to
 * return the created comment's id. Making them optional keeps every existing store —
 * including the in-memory ones in the test suites — a valid `CommentDocStore` with no
 * change; `handleCommentsRequest` falls back to the snapshot path when they are absent.
 */
export interface CommentDocStore {
  read(): Promise<CommentDoc>;
  write(doc: CommentDoc): Promise<void>;
  /** Persist one new comment and return the stored record (ids may be assigned here). */
  addComment?(record: CommentRecord): Promise<CommentRecord>;
  /** Apply a patch to one comment. Resolves `null` when the id is unknown. */
  updateComment?(id: string, patch: CommentPatch): Promise<CommentRecord | null>;
  deleteComment?(id: string): Promise<void>;
}

/**
 * The sidecar-file store. Its intent methods are written in terms of the same
 * snapshot read/modify/write it has always used, so local-mode behaviour — including
 * the quirks pinned by `local-mode.regression.test.ts` — is unchanged.
 */
export function fileCommentStore(path: string): CommentDocStore {
  const read = async (): Promise<CommentDoc> => {
    try {
      return parseDoc(await readFile(path, 'utf8'));
    } catch {
      return parseDoc(null);
    }
  };
  const write = async (doc: CommentDoc): Promise<void> => {
    await writeFile(path, serializeDoc(doc), 'utf8');
  };
  return {
    read,
    write,
    async addComment(record) {
      await write(addComment(await read(), record));
      return record;
    },
    async updateComment(id, patch) {
      const base = await read();
      // `status` is assigned whenever the key is present, even as undefined — that is
      // the existing PATCH behaviour and a regression test pins it.
      const withStatus = 'status' in patch ? setStatus(base, id, patch.status as CommentStatus, patch.result) : base;
      const next =
        patch.comment === undefined
          ? withStatus
          : {
              ...withStatus,
              comments: withStatus.comments.map((c) => (c.id === id ? { ...c, comment: patch.comment as string } : c)),
            };
      await write(next);
      return next.comments.find((c) => c.id === id) ?? null;
    },
    async deleteComment(id) {
      await write(removeComment(await read(), id));
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
      const saved = store.addComment
        ? await store.addComment(record)
        : (await store.write(addComment(await store.read(), record)), record);
      return { status: 200, json: { ok: true, id: saved.id } };
    }
    const idMatch = /^\/(c-[a-f0-9]+)$/.exec(pathname);
    if (idMatch) {
      const id = idMatch[1]!;
      if (method === 'PATCH') {
        const result = typeof body.result === 'string' ? body.result : undefined;
        const patch: CommentPatch = { status: body.status as CommentStatus, ...(result !== undefined ? { result } : {}) };
        if (store.updateComment) await store.updateComment(id, patch);
        else await store.write(setStatus(await store.read(), id, patch.status as CommentStatus, result));
        return { status: 200, json: { ok: true } };
      }
      if (method === 'DELETE') {
        if (store.deleteComment) await store.deleteComment(id);
        else await store.write(removeComment(await store.read(), id));
        return { status: 200, json: { ok: true } };
      }
    }
    return { status: 404, json: { error: `no route: ${method} /__vs/comments${pathname}` } };
  } catch (err) {
    return { status: 400, json: { error: (err as Error).message } };
  }
}
