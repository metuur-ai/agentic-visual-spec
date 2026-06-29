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
import type { SurfaceStore } from '../core/vite/surface-store';
import { type TreeStore, treeStore } from '../core/vite/tree-store';
import {
  type CommentDocStore,
  fileCommentStore,
  handleCommentsRequest,
} from '../core/vite/routes/comments';
import { createApplyHub } from '../core/vite/routes/apply';

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
  if (req.method !== 'POST' && req.method !== 'PATCH') return {};
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
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

async function handleSource(store: SurfaceStore, method: string, pathname: string, query: Record<string, string>, root: string) {
  if (method === 'GET' && pathname === '/list') return { status: 200, json: await store.list() };
  if (method === 'GET' && pathname === '/root') return { status: 200, json: { root } };
  if (method === 'GET' && (pathname === '' || pathname === '/')) {
    return { status: 200, json: { surfaceId: query.surfaceId, source: await store.read(query.surfaceId!) } };
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
          const r = await handleSource(surfaces, method, sub, query, specsRoot);
          return sendJson(res, r.status, r.json);
        }

        // Apply the open comments via `claude -p` — a shared job any browser can
        // watch (SSE), start, or cancel.
        if (url.pathname === '/__vs/apply' || url.pathname.startsWith('/__vs/apply/')) {
          const sub = url.pathname.slice('/__vs/apply'.length);
          if (method === 'GET' && sub === '/events') return applyHub.subscribe(res);
          if (method === 'POST' && sub === '/start') {
            const r = applyHub.start();
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

  return { server, commentsPath };
}
