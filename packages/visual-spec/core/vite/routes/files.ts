/**
 * routes/files.ts — the two *write* routes on /__vs/tree: `create` and `rename`.
 * Host-agnostic like every module in this directory: it takes the stores and the
 * already-split request, and answers `{ status, json }`.
 *
 * Two things shape everything below. First, the set of paths a browser can cause
 * to be written must be exactly "a new `.md` file under the served directory", and
 * a request outside that set must cost nothing on disk — so every refusal happens
 * before the first `mkdir`. Second, neither route may destroy an existing file,
 * which is why `rename` is built out of `link` + `unlink` rather than `rename`
 * (see `moveFile`).
 */
import { link, mkdir, lstat, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import type { CommentDocStore } from './comments';

export type RouteResult = { status: number; json: unknown };

/**
 * The slice of `TreeStore` these routes need. Declared structurally rather than
 * imported so a test can stand up a store without a tree walk, exactly as
 * `CommentDocStore` is declared in `comments.ts`.
 *
 * `resolveForWrite` and `invalidate` are optional on `TreeStore` itself — it is a
 * published interface, so the additions could not be required — and that optionality
 * has to be handled here. A store without `resolveForWrite` has no answer to "may I
 * write this path", so it gets no writes at all rather than a weaker check.
 */
export interface FileWriteStore {
  resolve(path: string): string;
  resolveForWrite?(path: string): Promise<string>;
  invalidate?(): void;
}

/** An error that already knows the status it deserves; anything else becomes a 400. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/**
 * Trim, and normalize `\` to `/` so a Windows-style path is judged by the same
 * rules as a posix one — including its traversal segments, which survive the
 * rewrite and are refused downstream by `resolveForWrite`.
 */
function normalizeRequestPath(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/\\/g, '/') : '';
}

/**
 * R-1.3/R-1.4. No extension is a convenience case: `notes/kickoff` is obviously
 * meant to be `notes/kickoff.md`. A *different* extension is not — silently
 * rewriting `notes/kickoff.txt` would discard what the user asked for, so it is a
 * refusal that names the extension it refused and leaves it untouched.
 */
function withMarkdownExtension(rel: string): string {
  const ext = extname(basename(rel));
  if (ext === '') return `${rel}.md`;
  if (ext.toLowerCase() !== '.md') {
    throw new HttpError(400, `refused ${ext}: only .md files can be created here (got ${rel})`);
  }
  return rel;
}

/** The store owns the base directory; `.` is its own name for it. */
function rootOf(store: FileWriteStore): string {
  return store.resolve('.');
}

/** R-1.5/R-1.6 — the guard lives in the store, and its throw *is* the refusal. */
async function guardedAbsolute(store: FileWriteStore, rel: string): Promise<string> {
  if (!store.resolveForWrite) {
    throw new HttpError(500, 'this directory is served by a store that cannot accept writes');
  }
  try {
    return await store.resolveForWrite(rel);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}

async function exists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * R-1.1 through R-1.11. The order is the requirement: every refusal is decided
 * before anything is written.
 */
async function createFile(store: FileWriteStore, body: Record<string, unknown>): Promise<RouteResult> {
  const requested = normalizeRequestPath(body.path);
  if (!requested) throw new HttpError(400, 'create: a path is required');

  const rel = withMarkdownExtension(requested);
  const abs = await guardedAbsolute(store, rel);

  // Steps 4 and 6 are *both* collision checks, deliberately. `stat` is what produces
  // a message a human can act on ("x.md already exists"), but between it and the
  // write there is a window in which two tabs — or a tab and a terminal — both see
  // ENOENT and both write, and R-1.7's promise that the existing bytes survive is
  // broken. `wx` closes that window atomically. An earlier draft dropped `wx` on the
  // grounds that it covers neither traversal nor visibility, which was never the
  // claim: it is the atomicity of the last line, and it sits after every refusal, so
  // the read-before-write ordering is intact.
  if (await exists(abs)) throw new HttpError(409, `create: ${rel} already exists`);

  await mkdir(dirname(abs), { recursive: true });
  try {
    await writeFile(abs, seedFor(rel), { flag: 'wx' });
  } catch (err) {
    if (errno(err) === 'EEXIST') throw new HttpError(409, `create: ${rel} already exists`);
    // R-1.11. The directories from the line above stay: an empty directory is
    // invisible in the tree and harmless, and unwinding it could delete a directory
    // a concurrent request had just started using.
    throw new HttpError(500, `create: could not write ${rel}: ${(err as Error).message}`);
  }

  store.invalidate?.(); // R-3.1 — the walk is cached for seconds; this read is the one the user waits on.
  return { status: 200, json: { path: rel, root: rootOf(store) } };
}

/** R-1.10 — a heading `titleFromMarkdown` can resolve, then the blank line before the body. */
function seedFor(rel: string): string {
  return `# ${basename(rel, extname(rel))}\n\n`;
}

/**
 * R-2.5. `link` then `unlink`, **never** `fs.rename`: `rename` overwrites the
 * destination silently, and the one guarantee this feature makes is that it cannot
 * destroy a file. `link` fails `EEXIST` atomically, which is the entire reason it is
 * used — the `stat` above it is again only there to produce the readable message.
 */
async function moveFile(fromAbs: string, toAbs: string, toRel: string): Promise<void> {
  try {
    await link(fromAbs, toAbs);
  } catch (err) {
    if (errno(err) === 'EEXIST') throw new HttpError(409, `rename: ${toRel} already exists`);
    if (errno(err) === 'ENOENT') {
      // The source was checked moments ago, so this is the destination's parent.
      // Reported rather than created: rename moves a file, it does not build a tree.
      throw new HttpError(400, `rename: the parent directory of ${toRel} does not exist`);
    }
    throw new HttpError(500, `rename: could not link ${toRel}: ${(err as Error).message}`);
  }
  await unlink(fromAbs);
}

/**
 * R-2.6/R-2.7. Comments are pinned to `target.path`, so a rename that stops at the
 * filesystem orphans the whole review of that document — the records survive
 * pointing at a path that no longer exists and the apply run cannot resolve them.
 * Every other field, on matched and unmatched records alike, is carried across
 * untouched; when nothing matches the sidecar is not rewritten at all.
 */
async function retargetComments(comments: CommentDocStore, from: string, to: string): Promise<void> {
  const doc = await comments.read();
  if (!doc.comments.some((c) => c.target.path === from)) return;
  await comments.write({
    ...doc,
    comments: doc.comments.map((c) => (c.target.path === from ? { ...c, target: { ...c.target, path: to } } : c)),
  });
}

/** R-2.1 through R-2.10. */
async function renameFile(
  store: FileWriteStore,
  comments: CommentDocStore,
  body: Record<string, unknown>,
): Promise<RouteResult> {
  const from = normalizeRequestPath(body.from);
  const to = normalizeRequestPath(body.to);
  if (!from) throw new HttpError(400, 'rename: a from path is required');
  if (!to) throw new HttpError(400, 'rename: a to path is required');

  // R-2.2: the extension rule applies to the destination only. `from` names a file
  // that already exists on disk, so coercing or refusing its extension would make
  // an existing non-`.md` file unrenameable for no gain.
  const toRel = withMarkdownExtension(to);
  const fromAbs = await guardedAbsolute(store, from);
  const toAbs = await guardedAbsolute(store, toRel);

  // R-2.3/R-2.10. `lstat`, not `stat`, so a symlink is judged as itself rather than
  // as whatever it points at — following it is how a link inside the served
  // directory would get a file outside it moved.
  let src: Awaited<ReturnType<typeof lstat>>;
  try {
    src = await lstat(fromAbs);
  } catch {
    throw new HttpError(404, `rename: ${from} does not exist`);
  }
  if (src.isDirectory()) throw new HttpError(400, `rename: ${from} is a directory; renaming directories is out of scope`);
  if (!src.isFile()) throw new HttpError(400, `rename: ${from} is not a regular file`);

  if (await exists(toAbs)) throw new HttpError(409, `rename: ${toRel} already exists`);
  await moveFile(fromAbs, toAbs, toRel);

  await retargetComments(comments, from, toRel);
  store.invalidate?.(); // R-3.1/R-3.3 — a stale walk shows the file under both names or neither.
  return { status: 200, json: { path: toRel, root: rootOf(store) } };
}

/**
 * The whole surface of this module. R-2.9: there is no delete route, and the only
 * `unlink` in the file is the source-removal half of a rename.
 */
export async function handleFilesRequest(
  store: FileWriteStore,
  comments: CommentDocStore,
  method: string,
  pathname: string,
  body: Record<string, unknown>,
): Promise<RouteResult> {
  try {
    if (method === 'POST' && pathname === '/create') return await createFile(store, body);
    if (method === 'POST' && pathname === '/rename') return await renameFile(store, comments, body);
    return { status: 404, json: { error: `no route: ${method} /__vs/tree${pathname}` } };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, json: { error: err.message } };
    return { status: 400, json: { error: (err as Error).message } };
  }
}
