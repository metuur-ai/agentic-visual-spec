/**
 * tree-store.ts — the generic filesystem boundary for browsing an arbitrary
 * directory (not just .md specs). It walks the whole tree under a base dir,
 * honoring a single `.visualspecignore` at the root (gitignore syntax) plus a few
 * always-excluded built-ins, and detects a coarse "kind" per file so the UI knows
 * how to render it. Paths are posix-relative to the base; everything is guarded
 * against traversal.
 */
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
// stat is still used by file()/resolve() for content gating; the tree walk no
// longer stats every entry (size isn't shown in the UI).
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { DEFAULT_IGNORE } from './default-ignore';

/** How the UI should render a file. `text`/`code`/`markdown` carry content. */
export type FileKind = 'markdown' | 'code' | 'text' | 'image' | 'binary';

export type TreeEntry = {
  path: string; // posix, relative to base ("src/auth/login.ts")
  name: string; // basename
  type: 'dir' | 'file';
  kind?: FileKind; // files only
  size?: number; // files only, bytes
};

export type FileContent =
  | { path: string; kind: 'markdown' | 'code' | 'text'; content: string; size: number }
  | { path: string; kind: 'image'; mime: string; size: number }
  | { path: string; kind: 'binary'; size: number; reason?: 'binary' | 'too-large' };

export interface TreeStore {
  /** Flat, sorted list of every visible dir + file. The UI builds the hierarchy. */
  tree(): Promise<TreeEntry[]>;
  /** Read one file: content for text kinds, metadata for image/binary. */
  file(path: string): Promise<FileContent>;
  /** Guarded absolute path, for streaming raw bytes (images/downloads). */
  resolve(path: string): string;
  /**
   * Guarded absolute path for a target that does **not** exist yet (create/rename).
   * Adds a filesystem-level symlink check on top of `resolve`'s string check.
   *
   * `resolveForWrite` and `invalidate` are **optional** because `TreeStore` is
   * published — `core/vite/index.ts` re-exports this module and package.json ships
   * it as the `"./vite"` entrypoint — so a required addition would break every
   * external implementation. `CommentDocStore` in `routes/comments.ts` set this
   * precedent for the same reason. The store `treeStore()` returns always provides
   * both; callers reaching an arbitrary `TreeStore` must handle their absence.
   */
  resolveForWrite?(path: string): Promise<string>;
  /** Drop the cached walk. Absent → the caller accepts the TTL. */
  invalidate?(): void;
}

/** Always hidden, regardless of .visualspecignore — keeps the tree free of junk. */
const ALWAYS_IGNORE = ['.git/', 'node_modules/', 'visual-spec-comments.json'];

// `default-ignore.ts` (DEFAULT_IGNORE) holds the overridable build/dep/cruft defaults.

/** Files larger than this aren't read as text (served as binary metadata instead). */
const MAX_TEXT_BYTES = 1_000_000;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
};

// prettier-ignore
const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.cc', '.hpp',
  '.cs', '.css', '.scss', '.sass', '.less', '.html', '.htm', '.vue', '.svelte',
  '.sh', '.bash', '.zsh', '.fish', '.rb', '.php', '.sql', '.swift', '.scala',
  '.clj', '.ex', '.exs', '.erl', '.lua', '.r', '.dart', '.toml', '.yaml', '.yml',
  '.xml', '.gradle', '.groovy', '.pl', '.pm', '.proto', '.graphql', '.gql',
]);

// prettier-ignore
const TEXT_EXT = new Set([
  '.txt', '.log', '.csv', '.tsv', '.env', '.ini', '.cfg', '.conf',
  '.properties', '.text', '.rst', '.adoc', '.tex', '.diff', '.patch',
  '.editorconfig', '.gitignore', '.visualspecignore',
]);

/** Tentative kind by name; file() may downgrade text/code/markdown → binary on read. */
export function detectKind(name: string): FileKind {
  const lower = name.toLowerCase();
  const ext = extname(lower);
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (IMAGE_MIME[ext]) return 'image';
  if (CODE_EXT.has(ext)) return 'code';
  if (TEXT_EXT.has(ext)) return 'text';
  if (ext === '') {
    if (lower === 'dockerfile' || lower === 'makefile') return 'code';
    return 'text'; // dotfiles / extensionless — confirmed via NUL sniff on read
  }
  return 'binary';
}

async function loadIgnore(base: string): Promise<Ignore> {
  // Order matters: always-ignores, then overridable defaults, then the user's
  // file last so a project can negate a default (e.g. `!dist/`).
  const ig = ignore().add(ALWAYS_IGNORE).add(DEFAULT_IGNORE);
  try {
    ig.add(await readFile(join(base, '.visualspecignore'), 'utf8'));
  } catch {
    // no .visualspecignore — built-ins + defaults only
  }
  return ig;
}

async function walk(dir: string, base: string, ig: Ignore, acc: TreeEntry[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(base, abs).split(sep).join('/');
    // ignore() matches gitignore semantics; dirs are tested with a trailing slash.
    if (ig.ignores(entry.isDirectory() ? `${rel}/` : rel)) continue;
    if (entry.isDirectory()) {
      acc.push({ path: rel, name: entry.name, type: 'dir' });
      await walk(abs, base, ig, acc);
    } else if (entry.isFile()) {
      // No per-file stat here: size isn't rendered anywhere, and stat()ing every
      // file turned a large tree into thousands of syscalls per request. file()
      // still stats on demand when a file is actually opened.
      acc.push({ path: rel, name: entry.name, type: 'file', kind: detectKind(entry.name) });
    }
  }
}

/** How long a walked tree is reused before the next request re-walks (ms). */
const TREE_CACHE_TTL_MS = 3000;

export function treeStore(baseDir: string): TreeStore {
  const base = resolve(baseDir);

  // A short-lived cache so a burst of tree fetches (the sidebar plus the image
  // modal's folder + workspace pickers all mount at once) shares one walk
  // instead of re-walking the whole directory per request. The store is recreated
  // on a directory switch, so the cache is naturally scoped to one root.
  let cache: { at: number; entries: TreeEntry[] } | null = null;

  /** Resolve a relative path and prove it stays under base. */
  const safe = (rel: string): string => {
    if (!rel || rel.includes('\0')) throw new Error(`invalid path: ${rel}`);
    const abs = resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + sep)) throw new Error(`path escapes base: ${rel}`);
    return abs;
  };

  /**
   * `safe` plus a filesystem check, for paths we are about to *create*.
   *
   * `safe` compares strings: `resolve(base, rel)` then `startsWith(base + sep)`.
   * A symlink *inside* base pointing outside it passes that untouched. For the
   * read routes that is disclosure; for a caller that runs `mkdir -p` it is
   * directory creation anywhere on the disk.
   *
   * Rejected alternative: `realpath(abs)`. The target does not exist yet, so
   * `realpath` throws ENOENT — there is nothing to resolve. Rejected alternative:
   * `realpath` after `mkdir`. Too late; `mkdir` already followed the symlink and
   * created the directories the check was supposed to prevent.
   *
   * So we resolve the deepest ancestor that *does* exist and compare that against
   * the real base, before anything is written. Existence is tested with `lstat`,
   * not `stat`, so a dangling symlink counts as existing rather than being walked
   * past as if it were absent. `realpath` on such a link throws, and that throw is
   * the refusal — this guard fails closed.
   */
  const safeForWrite = async (rel: string): Promise<string> => {
    const abs = safe(rel);
    let dir = dirname(abs);
    for (;;) {
      try {
        await lstat(dir);
        break;
      } catch {
        const parent = dirname(dir);
        if (parent === dir) break; // filesystem root; realpath below still decides
        dir = parent;
      }
    }
    let realAncestor: string;
    let realBase: string;
    try {
      [realAncestor, realBase] = await Promise.all([realpath(dir), realpath(base)]);
    } catch {
      throw new Error(`path escapes base: ${rel}`);
    }
    if (realAncestor !== realBase && !realAncestor.startsWith(realBase + sep)) {
      throw new Error(`path escapes base: ${rel}`);
    }
    return abs;
  };

  return {
    async tree() {
      const now = Date.now();
      if (cache && now - cache.at < TREE_CACHE_TTL_MS) return cache.entries;
      const ig = await loadIgnore(base);
      const acc: TreeEntry[] = [];
      await walk(base, base, ig, acc);
      acc.sort((a, b) => a.path.localeCompare(b.path));
      cache = { at: now, entries: acc };
      return acc;
    },

    async file(path) {
      const abs = safe(path);
      const { size } = await stat(abs);
      const kind = detectKind(basename(path));
      if (kind === 'image') return { path, kind, mime: IMAGE_MIME[extname(path).toLowerCase()]!, size };
      if (kind === 'binary') return { path, kind, size };
      if (size > MAX_TEXT_BYTES) return { path, kind: 'binary', size, reason: 'too-large' };
      const buf = await readFile(abs);
      if (buf.includes(0)) return { path, kind: 'binary', size, reason: 'binary' };
      return { path, kind, content: buf.toString('utf8'), size };
    },

    resolve(path) {
      return safe(path);
    },

    resolveForWrite(path) {
      return safeForWrite(path);
    },

    invalidate() {
      // A successful write makes the cached walk wrong for up to TREE_CACHE_TTL_MS,
      // and the next tree read is the one the user is waiting on. Dropping the
      // entry is enough — `tree()` re-walks whenever there is no entry.
      cache = null;
    },
  };
}

/** Stream a file's raw bytes — used by the /__vs/raw endpoint for image previews. */
export function rawStream(store: TreeStore, path: string) {
  return createReadStream(store.resolve(path));
}
