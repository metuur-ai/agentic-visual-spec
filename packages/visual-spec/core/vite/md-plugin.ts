/**
 * md-plugin.ts — the Markdown preset for a spec viewer. Renders .md surfaces and
 * records comments to a sidecar JSON file (visual-spec-comments.json). No marker
 * is written into the .md files — they stay pristine while the user comments.
 *
 *   GET  /__vs/source/list                 → surface ids (relative .md paths)
 *   GET  /__vs/source?surfaceId=<id>       → { surfaceId, source }
 *   GET  /__vs/comments[?file=<id>]        → comments (all / by file)
 *   GET  /__vs/comments/all                → the whole CommentDoc
 *   POST /__vs/comments/add                → append { file, heading, line, snippet, comment }
 *   PATCH/DELETE /__vs/comments/:id        → status / remove
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import type { Connect, Plugin } from 'vite';
import { GUARD_NOT_RUN, attestGuardRan, guardRan } from './guard-attestation';
import { checkRequest } from './request-guard';
import { type CommentDocStore, fileCommentStore, handleCommentsRequest } from './routes/comments';
import { handleFilesRequest } from './routes/files';
import { handleGitRequest } from './routes/git';
import { createApplyHub } from './routes/apply';
import { createCollabRoutes } from './routes/collab';
import { createCollabWiring } from './routes/collab-wiring';
import { createJobHubRegistry } from '../collaboration/job-hub';
import { fsCollaborationStore } from '../collaboration/record-store';
import { type VisualSpecConfig, resolveConfig } from '../config';
import { MAX_UPLOAD_BYTES, saveUploadedAsset } from './routes/upload';
import { currentPlugin } from './current-plugin';
import { mdSurfaceStore } from './md-store';
import { pickDirectoryNative } from './native-pick';
import type { SurfaceStore } from './surface-store';
import { type TreeStore, treeStore } from './tree-store';

const RAW_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
};

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'PUT') return {};
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sendJson(res: ServerResponse, status: number, json: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(json));
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

function middleware(fn: (req: IncomingMessage, query: Record<string, string>, pathname: string, body: Record<string, unknown>) => Promise<{ status: number; json: unknown }>): Connect.NextHandleFunction {
  return (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const pathname = url.pathname === '/' ? '' : url.pathname;
        const query = Object.fromEntries(url.searchParams.entries());
        const body = await readJsonBody(req);
        const result = await fn(req, query, pathname, body);
        sendJson(res, result.status, result.json);
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
    })();
  };
}

// `_body` is unread here and read by the write routes that land on this prefix
// next; it is in the signature now so the two hosts hand the handler the same
// four arguments (R-4.1) rather than one of them growing a body later.
async function handleTree(store: TreeStore, method: string, pathname: string, query: Record<string, string>, _body?: Record<string, unknown>) {
  if (method === 'GET' && (pathname === '' || pathname === '/')) return { status: 200, json: await store.tree() };
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

export type MarkdownOptions = {
  contentDir?: string;
  commentsFile?: string;
  assetsDir?: string;
  /** visual-spec.config.ts contents. Omitting `collaboration` keeps collaboration off (R-9.19). */
  config?: VisualSpecConfig;
};

/** `child` is `parent` or sits underneath it. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Where Vite's dep-optimizer cache goes when the Vite root IS the directory we are
 * serving.
 *
 * Vite derives `cacheDir` from `root` — `<root>/.vite`, or `<pkg>/node_modules/.vite`
 * when a package.json is found above it. That default assumes `root` is a project
 * you own. Here it is the user's *content* directory, so the optimizer drops `.vite`
 * (plus its `deps_temp_*` scratch dirs) straight into the workspace being browsed:
 * serve `~/docs` and `~/docs/.vite` appears. `.visualspecignore`/DEFAULT_IGNORE hides
 * it from the tree, which is why it went unnoticed, but hidden is not "not written" —
 * it still churns files in someone else's folder, and it made the on-disk snapshots in
 * host-parity.test.ts diverge between hosts on the optimizer's own schedule.
 *
 * The cache is a rebuildable, root-specific artifact, so it belongs in the OS temp
 * dir, keyed by a hash of the root so two served directories never share one.
 */
function externalCacheDir(root: string): string {
  return join(tmpdir(), 'visual-spec-vite-cache', createHash('sha256').update(root).digest('hex').slice(0, 16));
}

function mdApiPlugin(opts: Required<MarkdownOptions>): Plugin {
  let root = process.cwd();

  return {
    name: 'visual-spec:md-api',
    apply: 'serve',
    // Runs before Vite resolves its defaults — `cacheDir` is read once at resolve
    // time, so redirecting it in `configResolved` would be too late.
    config(userConfig) {
      // An explicit `cacheDir` is the caller's decision; never second-guess it.
      if (userConfig.cacheDir) return null;
      const viteRoot = resolvePath(userConfig.root ?? process.cwd());
      const served = isAbsolute(opts.contentDir) ? resolvePath(opts.contentDir) : resolvePath(viteRoot, opts.contentDir);
      // Every default Vite would pick sits at or above `root`, so the cache can only
      // land in the served tree when `root` itself does. When the content dir is a
      // subfolder of a real project root (the `dev` layout), the default is already
      // outside it and is left alone.
      if (!isInside(served, viteRoot)) return null;
      return { cacheDir: externalCacheDir(viteRoot) };
    },
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      // Absolute paths point at a folder outside the app (e.g. a real docs dir);
      // relative paths resolve under the Vite root.
      const resolve = (p: string) => (isAbsolute(p) ? p : join(root, p));
      // Mutable so the directory can be switched at runtime (POST /__vs/dir/pick),
      // matching the production server. The middleware closures below read these
      // `let`s at request time, so re-rooting takes effect immediately.
      let specsRoot = resolve(opts.contentDir);
      let surfaces = mdSurfaceStore(specsRoot);
      let tree: TreeStore = treeStore(specsRoot);
      let commentsPath = resolve(opts.commentsFile);
      let comments: CommentDocStore = fileCommentStore(commentsPath);
      let watchRoot = specsRoot.replace(/\\/g, '/');

      const setRoot = (dir: string) => {
        specsRoot = dir;
        surfaces = mdSurfaceStore(specsRoot);
        tree = treeStore(specsRoot);
        commentsPath = join(specsRoot, 'visual-spec-comments.json');
        comments = fileCommentStore(commentsPath);
        watchRoot = specsRoot.replace(/\\/g, '/');
        server.watcher.add(specsRoot);
        console.log(`\n  visual-spec (dev) → switched directory: ${specsRoot}\n`);
      };

      // Registered first, so every `/__vs` middleware below is behind it —
      // registration order is the only ordering primitive Connect gives us, and a
      // guard registered after a handler silently does nothing.
      server.middlewares.use('/__vs', (req, res, next) => {
        const verdict = checkRequest(req.headers);
        if (verdict.ok) {
          attestGuardRan(req.headers);
          return next();
        }
        res.statusCode = 403;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: verdict.reason }));
      });

      // Current directory + the native "change directory" picker (matches server.ts).
      server.middlewares.use('/__vs/dir', middleware(async (req, _query, pathname) => {
        const method = req.method ?? 'GET';
        if (method === 'GET' && (pathname === '' || pathname === '/')) {
          return { status: 200, json: { root: specsRoot, comments: commentsPath } };
        }
        if (method === 'POST' && pathname === '/pick') {
          const picked = await pickDirectoryNative(specsRoot);
          if (!picked.ok) {
            if (picked.cancelled) return { status: 200, json: { cancelled: true } };
            return { status: 501, json: { error: picked.error } };
          }
          try {
            if (!(await stat(picked.path)).isDirectory()) return { status: 400, json: { error: `Not a directory: ${picked.path}` } };
          } catch {
            return { status: 400, json: { error: `Directory not found: ${picked.path}` } };
          }
          setRoot(picked.path);
          return { status: 200, json: { root: specsRoot, comments: commentsPath } };
        }
        return { status: 404, json: { error: `no route: ${method} /__vs/dir${pathname}` } };
      }));

      // Generic directory browser API (matches the production server.ts).
      //
      // The write routes branch off *inside* this middleware rather than from a
      // `use('/__vs/tree/create')` of their own, so the two hosts match line for
      // line (R-4.1). A separate mount would also acquire its own body read and its
      // own 404, and this prefix already has both: the `middleware` helper reads the
      // body for every non-GET, and `handleTree`'s trailing 404 is the one fallback
      // for anything on the prefix that no branch claims.
      server.middlewares.use('/__vs/tree', middleware((req, query, pathname, body) => {
        const method = req.method ?? 'GET';
        if (pathname === '/create' || pathname === '/rename') {
          // R-4.4. These routes write to a caller-chosen path on an unauthenticated
          // localhost server, so — exactly as the collaboration dispatch below does —
          // they refuse unless they can *prove* the guard registered above ran on
          // this request, instead of trusting that registration order never breaks.
          if (!guardRan(req.headers)) return Promise.resolve({ status: 500, json: { error: GUARD_NOT_RUN } });
          return handleFilesRequest(tree, comments, method, pathname, body);
        }
        return handleTree(tree, method, pathname, query, body);
      }));

      // R-2.1 (git). Read-only, so it inherits the `/__vs` guard registered above by
      // position and needs no attestation of its own. The root is a getter because
      // `setRoot` reassigns `specsRoot` at runtime; a captured string would report
      // the startup directory forever (R-2.2).
      server.middlewares.use('/__vs/git', middleware((req, _query, pathname) =>
        handleGitRequest(() => specsRoot, req.method ?? 'GET', pathname)));

      // Raw bytes for image previews / downloads. Streams (not JSON), so it's not
      // wrapped in the json `middleware` helper.
      server.middlewares.use('/__vs/raw', (req, res, next) => {
        void (async () => {
          try {
            const url = new URL(req.url ?? '', 'http://localhost');
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
            res.setHeader('content-type', RAW_MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream');
            createReadStream(abs).pipe(res);
          } catch {
            next();
          }
        })();
      });

      // Persist an image uploaded from the WYSIWYG toolbar (raw bytes, not JSON,
      // so it bypasses the json `middleware` helper). Body: the file; query:
      // ?name=<original filename>. Returns { path } relative to the specs root.
      server.middlewares.use('/__vs/upload', (req, res, next) => {
        void (async () => {
          try {
            if (req.method !== 'POST') return next();
            const url = new URL(req.url ?? '', 'http://localhost');
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
            const path = await saveUploadedAsset(specsRoot, name, bytes, req.headers['content-type'], dir);
            sendJson(res, 200, { path });
          } catch (err) {
            sendJson(res, 500, { error: (err as Error).message });
          }
        })();
      });

      server.middlewares.use('/__vs/source', middleware((req, query, pathname, body) =>
        handleSource(surfaces, req.method ?? 'GET', pathname, query, specsRoot, body)));

      server.middlewares.use('/__vs/comments', middleware((req, query, pathname, body) =>
        handleCommentsRequest(comments, req.method ?? 'GET', pathname, query, body)));

      // Apply the open comments via `claude -p` — a shared job any browser can
      // watch (SSE), start, or cancel. The thunk reads the current (mutable)
      // dir + store so a runtime "change directory" re-roots the next run too.
      const applyHub = createApplyHub(() => ({ cwd: specsRoot, comments }));
      server.middlewares.use('/__vs/apply', (req, res, next) => {
        const url = new URL(req.url ?? '', 'http://localhost');
        const sub = url.pathname === '/' ? '' : url.pathname;
        const method = req.method ?? 'GET';
        if (method === 'GET' && sub === '/events') return applyHub.subscribe(res);
        if (method === 'POST' && sub === '/start') {
          const r = applyHub.start();
          return sendJson(res, r.status, r.json);
        }
        if (method === 'POST' && sub === '/cancel') {
          const r = applyHub.cancel();
          return sendJson(res, r.status, r.json);
        }
        if (method === 'GET' && sub === '') {
          const r = applyHub.status();
          return sendJson(res, r.status, r.json);
        }
        return next();
      });

      // Collaboration routes (R-7.1). Same registry discipline as the standalone host —
      // one registry per server, created here and never at module level — and the same
      // shared router, so neither host owns any collaboration logic of its own (R-7.6).
      // Registered after the guard above, like every other `/__vs` handler (R-9.13).
      const collabConfig = resolveConfig(opts.config);
      const collabJobs = createJobHubRegistry();
      // The 8.2 job bodies and the interval poller, built once in shared code so both
      // hosts are identical (R-7.6). With no `collaboration` block this constructs no
      // adapter at all and yields no bodies, so 7.2's honest stubs stay in place (R-9.19).
      const collabWiring = createCollabWiring({
        config: () => collabConfig,
        documents: () => fsCollaborationStore(specsRoot),
        jobs: collabJobs,
        commentCachePath: () => commentsPath,
      });
      const collab = createCollabRoutes({
        jobs: collabJobs,
        config: () => collabConfig,
        documents: () => fsCollaborationStore(specsRoot),
        // Same directory the documents come from, read per request for the same reason.
        baseDir: () => specsRoot,
        bodies: collabWiring.bodies,
        authorize: collabWiring.authorize,
      });
      server.middlewares.use('/__vs/collab', (req, res) => {
        void (async () => {
          try {
            // R-9.16: publish commits client bytes to a remote repo, so the dispatch
            // refuses outright unless the guard above provably ran on this request.
            if (!guardRan(req.headers)) return sendJson(res, 500, { error: GUARD_NOT_RUN });
            const url = new URL(req.url ?? '', 'http://localhost');
            const sub = url.pathname === '/' ? '' : url.pathname;
            const query = Object.fromEntries(url.searchParams.entries());
            const body = await readJsonBody(req);
            const r = await collab.handle({ method: req.method ?? 'GET', pathname: sub, query, body, sse: res });
            if (r.streamed) return; // SSE: the hub already wrote the head and the sync frame
            sendJson(res, r.status, r.json);
          } catch (err) {
            sendJson(res, 500, { error: (err as Error).message });
          }
        })();
      });
      // Stop every poller, abort every in-flight collaboration job and drop every hub.
      server.httpServer?.on('close', () => {
        collabWiring.stopAllPolling();
        collab.dispose();
      });

      // R-4.5. Registered last, so it only ever sees a `/__vs` path none of the
      // handlers above claimed — including the ones that `next()` on a method they
      // do not serve. Without it those fall through to Vite's SPA fallback and
      // answer 200 with index.html, so a client newer than its server reads
      // `res.ok` and then fails parsing JSON, with no status to report. Connect
      // strips the mount prefix from `req.url`, so it is put back for the message.
      server.middlewares.use('/__vs', (req, res) => {
        // Discarded rather than buffered: the bytes are already on the wire and an
        // unread stream costs the client its connection, but a path with no route
        // has no reason to hold an arbitrary upload in memory.
        req.resume();
        const sub = new URL(req.url ?? '', 'http://localhost').pathname;
        sendJson(res, 404, { error: `no route: ${req.method ?? 'GET'} /__vs${sub === '/' ? '' : sub}` });
      });

      // Live-reload: when a .md file under the specs dir changes (it may live
      // outside the Vite root), ping the client to refetch the surface/list.
      // `watchRoot` is updated by setRoot when the directory is switched.
      server.watcher.add(specsRoot);
      const ping = (file: string) => {
        const f = file.replace(/\\/g, '/');
        if (f.startsWith(watchRoot) && f.endsWith('.md')) {
          server.ws.send({ type: 'custom', event: 'visual-spec:surface-changed', data: { file: f } });
        }
      };
      server.watcher.on('change', ping);
      server.watcher.on('add', ping);
      server.watcher.on('unlink', ping);
    },
  };
}

/**
 * The markdown viewer never calls useSurfaceModule, but importing @visual-spec/
 * core/app pulls it in, and it imports the TSX-only virtual module. Stub it so the
 * barrel resolves cleanly in markdown mode.
 */
function virtualSurfacesStubPlugin(): Plugin {
  const ID = 'virtual:visual-spec/surfaces';
  const RESOLVED = `\0${ID}`;
  return {
    name: 'visual-spec:md-virtual-stub',
    resolveId(id) {
      return id === ID ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      return `export const surfaceIds = [];
export const surfaceMeta = {};
export async function loadSurface() { throw new Error('useSurfaceModule is not available in markdown mode'); }`;
    },
  };
}

/** The Markdown viewer preset: render .md, record comments to a sidecar JSON. */
export function visualSpecMarkdown(opts: MarkdownOptions = {}): Plugin[] {
  const resolved = {
    contentDir: opts.contentDir ?? 'content',
    commentsFile: opts.commentsFile ?? 'visual-spec-comments.json',
    assetsDir: opts.assetsDir ?? 'assets',
    config: opts.config ?? {},
  };
  return [virtualSurfacesStubPlugin(), mdApiPlugin(resolved), currentPlugin()];
}
