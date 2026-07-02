/**
 * md-fidelity.ts — detect markdown constructs the Lexical (Rich) round-trip does
 * not preserve yet, so the editor can steer those files to Source mode and warn
 * before a save silently reformats or drops content.
 */

export type FidelityRisk = { frontmatter: boolean; tables: boolean; alignedTables: boolean; images: boolean; any: boolean };

// A GFM table separator row, e.g. `| --- | :--: |` — the line that makes a
// pipe block an actual table. Anchored per-line (no /m) so it can be tested
// against individual lines.
const TABLE_SEPARATOR = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/;
// An image: ![alt](src) — inline or on its own line.
const IMAGE = /!\[[^\]]*\]\([^)]*\)/;
// YAML frontmatter fenced at the very top of the file.
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

export function detectFidelityRisk(source: string): FidelityRisk {
  const frontmatter = FRONTMATTER.test(source);
  // A separator row makes a pipe block a table; a colon in that row (`:---`,
  // `:--:`, `---:`) is explicit column alignment — the only table construct the
  // Lexical round-trip can still degrade, so only that warrants the banner.
  const separators = source.split(/\r?\n/).filter((line) => TABLE_SEPARATOR.test(line));
  const tables = separators.length > 0;
  const alignedTables = separators.some((line) => line.includes(':'));
  const images = IMAGE.test(source);
  return { frontmatter, tables, alignedTables, images, any: frontmatter || tables || images };
}

/** Human-readable list of the risky constructs found, for the warning banner. */
export function riskLabels(risk: FidelityRisk): string[] {
  const out: string[] = [];
  if (risk.tables) out.push('tables');
  if (risk.images) out.push('images');
  if (risk.frontmatter) out.push('frontmatter');
  return out;
}
