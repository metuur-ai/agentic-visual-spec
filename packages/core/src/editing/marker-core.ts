/**
 * marker-core.ts — the deterministic source-mutation primitive shared by every
 * marker tag (@vs-note, @vs-spec). No React, no Vite. Pure + unit-testable.
 *
 * The one job: given a DOM-resolved (line, column) for a JSX element, find the
 * exact byte offset at which to splice an inert JSX comment as the element's
 * FIRST CHILD — through the AST, never a regex patch of arbitrary code.
 */
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { Node } from '@babel/types';

// @babel/traverse is CJS; normalize the default export under ESM/vitest.
const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

// ---------------------------------------------------------------------------
// base64url (payload encoding for marker `text="…"`)
// ---------------------------------------------------------------------------

export function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function b64urlDecode(s: string): string {
  const padLen = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  return Buffer.from(padded, 'base64').toString('utf8');
}

// ---------------------------------------------------------------------------
// line/column <-> absolute offset (line 1-indexed, column 0-indexed: Babel loc)
// ---------------------------------------------------------------------------

export function lineToOffset(src: string, line: number, column: number): number {
  let offset = 0;
  let currentLine = 1;
  while (currentLine < line) {
    const nl = src.indexOf('\n', offset);
    if (nl === -1) return src.length; // line past EOF
    offset = nl + 1;
    currentLine++;
  }
  return offset + column;
}

export function offsetToLine(src: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, src.length);
  for (let i = 0; i < end; i++) {
    if (src[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart };
}

// ---------------------------------------------------------------------------
// findInsertion — the linchpin write-back primitive
// ---------------------------------------------------------------------------

export type Insertion = { offset: number; indent: string };

function parseModule(src: string) {
  return parse(src, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });
}

function spanContains(node: Node, target: number): boolean {
  return node.start != null && node.end != null && node.start <= target && target <= node.end;
}

/**
 * Resolve (line, column) — the position data-vs-loc points at, i.e. the start of
 * a JSX element's opening tag — to the splice point for a first-child marker.
 *
 *  1. Collect every JSXElement / JSXFragment whose source span brackets the click.
 *  2. Sort innermost-first (smallest span).
 *  3. Pick the first NON-self-closing container; a self-closing <img/> hoists the
 *     marker to its nearest non-self-closing ancestor.
 *  4. Return the offset just after that container's opening `>`, plus the indent
 *     to render the marker one level deeper than the container.
 */
export function findInsertion(src: string, line: number, column: number): Insertion {
  const ast = parseModule(src);
  const target = lineToOffset(src, line, column);
  const candidates: Node[] = [];

  traverse(ast, {
    JSXElement(path) {
      if (spanContains(path.node, target)) candidates.push(path.node);
    },
    JSXFragment(path) {
      if (spanContains(path.node, target)) candidates.push(path.node);
    },
  });

  candidates.sort((a, b) => (a.end! - a.start!) - (b.end! - b.start!));

  for (const node of candidates) {
    if (node.type === 'JSXElement') {
      if (node.openingElement.selfClosing) continue;
      return { offset: node.openingElement.end!, indent: indentForNode(src, node.start!) + '  ' };
    }
    if (node.type === 'JSXFragment') {
      return { offset: node.openingFragment.end!, indent: indentForNode(src, node.start!) + '  ' };
    }
  }

  throw new Error(`findInsertion: no non-self-closing JSX container brackets ${line}:${column}`);
}

function indentForNode(src: string, nodeStart: number): string {
  const { line } = offsetToLine(src, nodeStart);
  const lineStart = lineToOffset(src, line, 0);
  const lineText = src.slice(lineStart).split('\n', 1)[0] ?? '';
  return /^\s*/.exec(lineText)?.[0] ?? '';
}

/**
 * Splice an already-built marker string as the first child at (line, column).
 * Returns the new source. Re-parse the result before writing to disk.
 */
export function spliceFirstChild(src: string, line: number, column: number, marker: string): string {
  const { offset, indent } = findInsertion(src, line, column);
  const insertion = `\n${indent}${marker}`;
  return src.slice(0, offset) + insertion + src.slice(offset);
}

/** Validate that a candidate source still parses (guard before fs.writeFile). */
export function assertParses(src: string): void {
  parseModule(src);
}

/** 8 hex chars for marker ids (prefix supplied by caller: `n-` / `s-`). */
export { randomHex8 } from './id';
