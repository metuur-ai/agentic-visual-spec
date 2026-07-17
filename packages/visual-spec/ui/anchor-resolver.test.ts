/**
 * anchor-resolver.test.ts
 *
 * Story A1.1 — shared target→element resolver extracted from locate()/locateLine().
 * Convention: pure-function tests + source-assertions (no jsdom), matching
 * comment-history.integration.test.ts.
 *
 * Verifies:
 *   - rangeLines covers single lines, multi-line ranges, and treats a
 *     non-greater endLine as a single line.
 *   - locate() (markdown) and locateLine() (code) both delegate to the shared
 *     resolver rather than re-implementing selector logic.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rangeLines } from './anchor-resolver';

function src(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');
}

const resolverSrc = src('./anchor-resolver.ts');
const historyListSrc = src('./comment-history-list.tsx');
const genericPanelSrc = src('./generic-panel.tsx');

describe('A1.1 — rangeLines (pure)', () => {
  it('a single line yields just that line', () => {
    expect(rangeLines(10)).toEqual([10]);
  });

  it('a multi-line range is inclusive of both ends', () => {
    expect(rangeLines(10, 13)).toEqual([10, 11, 12, 13]);
  });

  it('an endLine equal to startLine collapses to a single line', () => {
    expect(rangeLines(10, 10)).toEqual([10]);
  });

  it('an endLine less than startLine is treated as a single line', () => {
    expect(rangeLines(10, 4)).toEqual([10]);
  });
});

describe('A1.1 — resolver is the single source of anchor resolution', () => {
  it('exports both markdown and code resolvers', () => {
    expect(resolverSrc).toContain('export function resolveMarkdownAnchors');
    expect(resolverSrc).toContain('export function resolveCodeAnchors');
  });

  it('locate() delegates to resolveMarkdownAnchors (markdown, sidebar→document)', () => {
    expect(historyListSrc).toContain("import { resolveMarkdownAnchors } from './anchor-resolver'");
    expect(historyListSrc).toMatch(/flash\(resolveMarkdownAnchors\(target\)\)/);
  });

  it('locate() no longer re-implements the data-vs-loc selector inline', () => {
    // The duplicated query moved into the resolver; locate() must not carry it.
    expect(historyListSrc).not.toMatch(/querySelector\(`\[data-vs-loc/);
  });

  it('locateLine() delegates to resolveCodeAnchors (code, sidebar→document)', () => {
    expect(genericPanelSrc).toContain("import { resolveCodeAnchors } from './anchor-resolver'");
    expect(genericPanelSrc).toMatch(/resolveCodeAnchors\(startLine, endLine\)/);
  });

  it('locateLine() no longer re-implements the data-line selector inline', () => {
    expect(genericPanelSrc).not.toMatch(/querySelector\(`\[data-line/);
  });
});
