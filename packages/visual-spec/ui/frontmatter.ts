/**
 * frontmatter.ts — split/recombine a leading YAML frontmatter block so the Rich
 * editor can edit it separately (byte-exact) while Lexical handles only the body.
 */

export type SplitDoc = { inner: string | null; body: string };

// Frontmatter: a `---` fence at the very top, its YAML, and a closing `---`.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?/;

/** Separate a leading frontmatter block (its inner YAML) from the body. */
export function splitFrontmatter(source: string): SplitDoc {
  const m = source.match(FRONTMATTER);
  if (!m) return { inner: null, body: source };
  // Drop a single blank line between the fence and the body so recombine is exact.
  return { inner: m[1] ?? '', body: source.slice(m[0].length).replace(/^\r?\n/, '') };
}

/** Recombine an (optional) frontmatter inner block with the body. */
export function combineFrontmatter(inner: string | null, body: string): string {
  if (inner == null) return body;
  return `---\n${inner}\n---\n\n${body}`;
}
