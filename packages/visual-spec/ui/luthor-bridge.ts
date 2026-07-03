/**
 * luthor-bridge.ts — the single, contracted boundary between visual-spec and
 * Luthor's markdown round-trip. Every `markdownToJSON` / `jsonToMarkdown` call and
 * the image-src rewriting lives here, so the WYSIWYG editor never touches Luthor's
 * bridge API directly.
 *
 * Why a boundary: Luthor's markdown serialization is *normalizing* — loading and
 * re-serializing rebuilds the string from Luthor's node tree, so a Luthor/Lexical
 * upgrade can silently change the canonical form and break our dirty-detection
 * (baseline vs. getMarkdown). `canonicalizeMarkdown` exposes that pure round-trip
 * so a contract test (luthor-bridge.test.ts) can lock the fidelity and turn a
 * silent upgrade break into a red CI check.
 */
import { headless } from '@lyfie/luthor';

/** Rewrite the src of every markdown image via `map` (inline `![alt](src)`). */
export function mapImages(md: string, map: (src: string) => string): string {
  return md.replace(/(!\[[^\]]*\]\()\s*([^)\s]+)([^)]*\))/g, (_m, pre, src, post) => `${pre}${map(src)}${post}`);
}

/**
 * Parse markdown into the Lexical JSON string that `ExtensiveEditorRef.injectJSON`
 * expects. Throws on a parse failure so the caller can decide (we log rather than
 * silently leaving the editor empty).
 */
export function markdownToInjectable(md: string): string {
  return JSON.stringify(headless.markdownToJSON(md));
}

/**
 * Normalize a raw `getMarkdown()` string to the on-disk form: relativize image
 * srcs back to stored paths and collapse to exactly one trailing newline. This is
 * both the export shape and the dirty-detection baseline.
 */
export function normalizeForStore(rawMarkdown: string, toStored: (src: string) => string): string {
  return `${mapImages(rawMarkdown, toStored).replace(/\n+$/, '')}\n`;
}

/**
 * Pure markdown → Lexical JSON → markdown round-trip, no live editor. Mirrors what
 * the editor produces on load+export and exists so tests can assert Luthor's
 * serialization stays faithful and idempotent across upgrades.
 */
export function canonicalizeMarkdown(md: string): string {
  return headless.jsonToMarkdown(headless.markdownToJSON(md));
}
