/**
 * upload.ts — persist an image uploaded from the WYSIWYG toolbar ("Upload File" /
 * "Upload GIF") into the spec directory, so the inserted markdown references a
 * durable relative file instead of an ephemeral `blob:` URL that dies on reload.
 *
 * Bytes land under <root>/assets/<name>; the returned posix path (relative to
 * root) is what the client turns into a /__vs/raw display URL and, on save,
 * relativizes against the edited .md file — the same round-trip as any other
 * image already in the tree.
 */
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

/** Default folder (relative to the spec root) for uploaded assets. */
export const DEFAULT_ASSETS_DIR = 'assets';

/**
 * Normalize a configured assets dir to a safe posix subpath of the root:
 * strips leading/trailing slashes and any `.`/`..` segments so an upload can
 * never escape the spec directory. Empty/invalid input falls back to the default.
 */
export function normalizeAssetsDir(dir?: string): string {
  const parts = (dir ?? '').split(/[\\/]+/).filter((s) => s && s !== '.' && s !== '..');
  return parts.length ? parts.join('/') : DEFAULT_ASSETS_DIR;
}

/** Cap on a single upload — generous enough for screenshots and short GIFs. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Fallback extension when the uploaded filename carries none. */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
};

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a file in `dir` whose bytes are identical to `bytes`, so a re-upload of
 * the same image reuses it instead of writing a duplicate. Compares size first
 * (cheap) and only hashes same-size candidates. Returns the basename, or null.
 */
async function findIdentical(dir: string, bytes: Buffer): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null; // no assets dir yet
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  for (const name of names) {
    const p = join(dir, name);
    try {
      const st = await stat(p);
      if (!st.isFile() || st.size !== bytes.length) continue;
      if (createHash('sha256').update(await readFile(p)).digest('hex') === hash) return name;
    } catch {
      /* unreadable entry — skip */
    }
  }
  return null;
}

/**
 * Save `bytes` under <root>/<assetsDir>, picking a collision-free name derived
 * from the original filename. Returns the posix path relative to `root`
 * (e.g. "assets/diagram-1.png"). `assetsDir` is normalized to a safe subpath.
 */
export async function saveUploadedAsset(root: string, name: string, bytes: Buffer, mime?: string, assetsDir?: string): Promise<string> {
  // basename() strips any directory parts; the char filter kills traversal and
  // shell-hostile names, so an upload can only ever land inside the assets dir.
  let clean = basename(name).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '') || 'image';
  if (!extname(clean)) clean += EXT_BY_MIME[mime ?? ''] ?? '';
  const ext = extname(clean);
  const stem = ext ? clean.slice(0, -ext.length) : clean;

  const rel = normalizeAssetsDir(assetsDir);
  const dir = join(root, rel);
  await mkdir(dir, { recursive: true });

  // Reuse an existing identical file rather than saving a duplicate.
  const dup = await findIdentical(dir, bytes);
  if (dup) return `${rel}/${dup}`;

  let file = clean;
  for (let n = 1; await exists(join(dir, file)); n++) file = `${stem}-${n}${ext}`;
  await writeFile(join(dir, file), bytes);
  return `${rel}/${file}`;
}
