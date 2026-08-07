/**
 * server.ts — the standalone HTTP server behind `visual-spec <dir>`.
 *
 * It serves the prebuilt static UI (dist/ui) and exposes the same /__vs API the
 * Vite dev plugin did, but rooted at the user's spec directory. No Vite at
 * runtime — just Node's http server + the framework-agnostic store/route helpers
 * already living in core.
 *
 *   GET  /__vs/source/list            → surface ids (relative .md paths, no ext)
 *   GET  /__vs/source?surfaceId=<id>  → { surfaceId, source }
 *   GET  /__vs/comments[?file=<id>]   → comments (all / by file)
 *   POST /__vs/comments/add           → append a comment
 *   PATCH/DELETE /__vs/comments/:id   → status / remove
 *
 * Comments are written to <dir>/visual-spec-comments.json so the agent (running
 * in the user's project) finds them next to the specs it edits.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
// Relative source imports into core — bundled at build time (esbuild), so the
// shipped dist/cli.js carries this logic inline with no runtime dependency.
import { mdSurfaceStore } from '../core/vite/md-store';
import { pickDirectoryNative } from '../core/vite/native-pick';
import { checkRequest } from '../core/vite/request-guard';
import type { SurfaceStore } from '../core/vite/surface-store';
import { type TreeStore, treeStore } from '../core/vite/tree-store';
import {
  type CommentDocStore,
  fileCommentStore,
  handleCommentsRequest,
} from '../core/vite/routes/comments';
import { createApplyHub } from '../core/vite/routes/apply';
import { createCollabRoutes } from '../core/vite/routes/collab';
import { createJobHubRegistry } from '../core/collaboration/job-hub';
import { fsDocumentStore } from '../core/collaboration/document-store';
import { type VisualSpecConfig, resolveConfig } from '../core/config';
import { MAX_UPLOAD_BYTES, saveUploadedAsset } from '../core/vite/routes/upload';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, json: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(json));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'PUT') return {};
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

/** Read a raw request body up to `limit` bytes; throws 'too-large' past it. */
async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('too-large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function handleTree(store: TreeStore, method: string, pathname: string, query: Record<string, string>) {
  if (method === 'GET' && (pathname === '' || pathname === '/')) {
    return { status: 200, json: await store.tree() };
  }
  if (method === 'GET' && pathname === '/file') {
    if (!query.path) return { status: 400, json: { error: 'missing path' } };
    return { status: 200, json: await store.file(query.path) };
  }
  return { status: 404, json: { error: `no route: ${method} /__vs/tree${pathname}` } };
}

async function handleSource(store: SurfaceStore, method: string, pathname: string, query: Record<string, string>, root: string, body?: Record<string, unknown>) {
  if (method === 'GET' && pathname === '/list') return { status: 200, json: await store.list() };
  if (method === 'GET' && pathname === '/root') return { status: 200, json: { root } };
  if (method === 'GET' && (pathname === '' || pathname === '/')) {
    return { status: 200, json: { surfaceId: query.surfaceId, source: await store.read(query.surfaceId!) } };
  }
  // Save an edited surface back to disk. Body: { source: string }.
  if (method === 'PUT' && (pathname === '' || pathname === '/')) {
    if (!query.surfaceId) return { status: 400, json: { error: 'missing surfaceId' } };
    if (typeof body?.source !== 'string') return { status: 400, json: { error: 'missing source' } };
    await store.write(query.surfaceId, body.source);
    return { status: 200, json: { surfaceId: query.surfaceId, ok: true } };
  }
  return { status: 404, json: { error: `no route: ${method} /__vs/source${pathname}` } };
}

/** Serve a file from the static UI dir, falling back to index.html (SPA). */
async function serveStatic(uiDir: string, urlPath: string, res: ServerResponse) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(uiDir, rel === '/' || rel === '' ? 'index.html' : rel);
  try {
    if ((await stat(filePath)).isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    filePath = join(uiDir, 'index.html'); // SPA fallback
  }
  try {
    await stat(filePath);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', MIME[extname(filePath)] ?? 'application/octet-stream');
  createReadStream(filePath).pipe(res);
}

export type ServeOptions = {
  /** Directory of .md specs to read/comment on. */
  contentDir: string;
  /** Directory of the prebuilt UI (dist/ui). */
  uiDir: string;
  /** Where the sidecar comments JSON lives. Defaults to <contentDir>/visual-spec-comments.json. */
  commentsFile?: string;
  /** Folder (relative to contentDir) where toolbar image uploads are saved. Defaults to "assets". */
  assetsDir?: string;
  /** visual-spec.config.ts contents. Omitting `collaboration` keeps collaboration off (R-9.19). */
  config?: VisualSpecConfig;
  port: number;
  host?: string;
};

export function createVisualSpecServer(opts: ServeOptions) {
  // Mutable so the directory can be changed at runtime (POST /__vs/dir/pick).
  // The request handlers below read these `let`s at request time, so re-rooting
  // takes effect immediately for subsequent requests.
  let contentDir = resolve(opts.contentDir);
  let surfaces: SurfaceStore = mdSurfaceStore(contentDir);
  let tree: TreeStore = treeStore(contentDir);
  let specsRoot = contentDir;
  let commentsPath = opts.commentsFile ?? join(contentDir, 'visual-spec-comments.json');
  let comments: CommentDocStore = fileCommentStore(commentsPath);
  // The apply job is shared across every connected browser: one run at a time,
  // many SSE subscribers. The thunk reads the current (mutable) dir + store so a
  // runtime "change directory" re-roots the next run too.
  const applyHub = createApplyHub(() => ({ cwd: contentDir, comments }));
  // Collaboration (R-7.1). One job registry per server, never module-level. The route
  // layer is shared with the Vite host verbatim (R-7.6): both hosts do nothing but slice
  // the prefix off the path and hand the request to `collab.handle`. With no
  // `collaboration` block configured this stays inert and reports itself unavailable
  // (R-7.8 / R-9.19) — local mode is untouched (R-7.2).
  const collabConfig = resolveConfig(opts.config);
  const collabJobs = createJobHubRegistry();
  const collab = createCollabRoutes({
    jobs: collabJobs,
    config: () => collabConfig,
    documents: () => fsDocumentStore(contentDir),
  });

  /** Re-root every store at a new directory (comments follow to <dir>/…json). */
  const setRoot = (dir: string) => {
    contentDir = resolve(dir);
    surfaces = mdSurfaceStore(contentDir);
    tree = treeStore(contentDir);
    specsRoot = contentDir;
    commentsPath = join(contentDir, 'visual-spec-comments.json');
    comments = fileCommentStore(commentsPath);
    console.log(`\n  visual-spec → switched directory\n  ➜  dir:      ${contentDir}\n  ➜  comments: ${commentsPath}\n`);
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';

        // Refuse anything a browser issued for another origin before it can reach
        // a handler — see core/vite/request-guard.ts for why this is not a token.
        if (url.pathname.startsWith('/__vs/')) {
          const verdict = checkRequest(req.headers);
          if (!verdict.ok) return sendJson(res, 403, { error: verdict.reason });
        }

        if (url.pathname === '/__vs/tree' || url.pathname.startsWith('/__vs/tree/')) {
          const sub = url.pathname.slice('/__vs/tree'.length);
          const query = Object.fromEntries(url.searchParams.entries());
          const r = await handleTree(tree, method, sub, query);
          return sendJson(res, r.status, r.json);
        }

        // Raw bytes for image previews / binary downloads.
        if (url.pathname === '/__vs/raw') {
          const p = url.searchParams.get('path');
          if (!p) return sendJson(res, 400, { error: 'missing path' });
          let abs: string;
          try {
            abs = tree.resolve(p);
          } catch (err) {
            return sendJson(res, 400, { error: (err as Error).message });
          }
          try {
            await stat(abs);
          } catch {
            res.statusCode = 404;
            return res.end('Not found');
          }
          res.statusCode = 200;
          res.setHeader('content-type', MIME[extname(abs)] ?? 'application/octet-stream');
          return createReadStream(abs).pipe(res);
        }

        // Current directory + the native "change directory" picker.
        if (url.pathname === '/__vs/dir' || url.pathname.startsWith('/__vs/dir/')) {
          const sub = url.pathname.slice('/__vs/dir'.length);
          if (method === 'GET' && (sub === '' || sub === '/')) {
            return sendJson(res, 200, { root: specsRoot, comments: commentsPath });
          }
          if (method === 'POST' && sub === '/pick') {
            const picked = await pickDirectoryNative(contentDir);
            if (!picked.ok) {
              if (picked.cancelled) return sendJson(res, 200, { cancelled: true });
              return sendJson(res, 501, { error: picked.error });
            }
            try {
              if (!(await stat(picked.path)).isDirectory()) {
                return sendJson(res, 400, { error: `Not a directory: ${picked.path}` });
              }
            } catch {
              return sendJson(res, 400, { error: `Directory not found: ${picked.path}` });
            }
            setRoot(picked.path);
            return sendJson(res, 200, { root: specsRoot, comments: commentsPath });
          }
          return sendJson(res, 404, { error: `no route: ${method} /__vs/dir${sub}` });
        }

        if (url.pathname === '/__vs/source' || url.pathname.startsWith('/__vs/source/')) {
          const sub = url.pathname.slice('/__vs/source'.length);
          const query = Object.fromEntries(url.searchParams.entries());
          const body = method === 'PUT' ? await readJsonBody(req) : undefined;
          const r = await handleSource(surfaces, method, sub, query, specsRoot, body);
          return sendJson(res, r.status, r.json);
        }

        // Persist an image uploaded from the WYSIWYG toolbar. Body: raw file
        // bytes; query: ?name=<original filename>. Returns { path } relative to
        // the specs root (under assets/).
        if (url.pathname === '/__vs/upload') {
          if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
          const name = url.searchParams.get('name');
          if (!name) return sendJson(res, 400, { error: 'missing name' });
          let bytes: Buffer;
          try {
            bytes = await readRawBody(req, MAX_UPLOAD_BYTES);
          } catch {
            return sendJson(res, 413, { error: 'file too large' });
          }
          if (bytes.length === 0) return sendJson(res, 400, { error: 'empty upload' });
          // A per-upload ?dir wins over the configured default, so the editor
          // can target a folder chosen at insert time.
          const dir = url.searchParams.get('dir') || opts.assetsDir;
          const path = await saveUploadedAsset(contentDir, name, bytes, req.headers['content-type'], dir);
          return sendJson(res, 200, { path });
        }

        // Apply the open comments via `claude -p` — a shared job any browser can
        // watch (SSE), start, or cancel.
        if (url.pathname === '/__vs/apply' || url.pathname.startsWith('/__vs/apply/')) {
          const sub = url.pathname.slice('/__vs/apply'.length);
          if (method === 'GET' && sub === '/events') return applyHub.subscribe(res);
          if (method === 'POST' && sub === '/start') {
            const body = await readJsonBody(req);
            const ids = Array.isArray(body.ids) ? (body.ids as string[]) : undefined;
            const r = applyHub.start(ids);
            return sendJson(res, r.status, r.json);
          }
          if (method === 'POST' && sub === '/cancel') {
            const r = applyHub.cancel();
            return sendJson(res, r.status, r.json);
          }
          if (method === 'GET' && (sub === '' || sub === '/')) {
            const r = applyHub.status();
            return sendJson(res, r.status, r.json);
          }
          return sendJson(res, 404, { error: `no route: ${method} ${url.pathname}` });
        }

        // Collaboration routes (R-7.1). Everything below `/__vs/collab` is decided by the
        // shared router — no host-specific logic (R-7.6).
        if (url.pathname === '/__vs/collab' || url.pathname.startsWith('/__vs/collab/')) {
          const sub = url.pathname.slice('/__vs/collab'.length);
          const query = Object.fromEntries(url.searchParams.entries());
          const body = await readJsonBody(req);
          const r = await collab.handle({ method, pathname: sub, query, body, sse: res });
          if (r.streamed) return; // SSE: the hub already wrote the head and the sync frame
          return sendJson(res, r.status, r.json);
        }

        if (url.pathname === '/__vs/comments' || url.pathname.startsWith('/__vs/comments/')) {
          const sub = url.pathname.slice('/__vs/comments'.length);
          const query = Object.fromEntries(url.searchParams.entries());
          const body = await readJsonBody(req);
          const r = await handleCommentsRequest(comments, method, sub, query, body);
          return sendJson(res, r.status, r.json);
        }

        await serveStatic(opts.uiDir, url.pathname, res);
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
    })();
  });

  // Abort every in-flight collaboration job and drop every hub on shutdown.
  server.on('close', () => collab.dispose());

  return { server, commentsPath };
}
