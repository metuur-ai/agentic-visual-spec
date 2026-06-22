import { describe, expect, it } from 'vitest';
import {
  assertParses,
  b64urlDecode,
  b64urlEncode,
  findInsertion,
  lineToOffset,
  offsetToLine,
  spliceFirstChild,
} from './marker-core';

describe('b64url', () => {
  it('round-trips arbitrary JSON, including padding-sensitive lengths', () => {
    for (const value of ['', 'a', 'ab', 'abc', JSON.stringify({ note: 'héllo “quote”', n: 1 })]) {
      expect(b64urlDecode(b64urlEncode(value))).toBe(value);
    }
  });

  it('produces url-safe output (no + / =)', () => {
    const enc = b64urlEncode('???>>>???');
    expect(enc).not.toMatch(/[+/=]/);
  });
});

describe('line/column <-> offset', () => {
  const src = 'line1\nline2\nthird line\n';
  it('round-trips', () => {
    for (let offset = 0; offset <= src.length; offset++) {
      const { line, column } = offsetToLine(src, offset);
      expect(lineToOffset(src, line, column)).toBe(offset);
    }
  });

  it('matches a known position (line 3, col 0 = "third")', () => {
    const off = lineToOffset(src, 3, 0);
    expect(src.slice(off, off + 5)).toBe('third');
  });
});

const SURFACE = `export default [
  function Page() {
    return (
      <section>
        <h1>Q2 Roadmap</h1>
        <img src="/x.png" />
      </section>
    );
  },
];
`;

describe('findInsertion', () => {
  it('targets the clicked element itself when it is a non-self-closing container', () => {
    // <h1> opening tag start
    const h1Line = SURFACE.split('\n').findIndex((l) => l.includes('<h1>')) + 1;
    const col = SURFACE.split('\n')[h1Line - 1]!.indexOf('<h1>');
    const { offset } = findInsertion(SURFACE, h1Line, col);
    // offset is just after the `>` of `<h1>` → next char is "Q"
    expect(SURFACE[offset]).toBe('Q');
  });

  it('hoists a self-closing <img/> marker to the nearest non-self-closing ancestor', () => {
    const imgLine = SURFACE.split('\n').findIndex((l) => l.includes('<img')) + 1;
    const col = SURFACE.split('\n')[imgLine - 1]!.indexOf('<img');
    const { offset } = findInsertion(SURFACE, imgLine, col);
    const { line } = offsetToLine(SURFACE, offset);
    // must NOT land inside the <img/> line; hoisted up to <section>'s opening tag
    expect(line).toBeLessThan(imgLine);
    expect(SURFACE.slice(0, offset)).toMatch(/<section>$/);
  });

  it('computes an indent one level deeper than the container', () => {
    const h1Line = SURFACE.split('\n').findIndex((l) => l.includes('<h1>')) + 1;
    const col = SURFACE.split('\n')[h1Line - 1]!.indexOf('<h1>');
    const { indent } = findInsertion(SURFACE, h1Line, col);
    expect(indent).toBe('          '); // <h1> indented 8 → marker one level deeper at 10
  });
});

describe('spliceFirstChild', () => {
  it('inserts a marker as first child and the result still parses', () => {
    const h1Line = SURFACE.split('\n').findIndex((l) => l.includes('<h1>')) + 1;
    const col = SURFACE.split('\n')[h1Line - 1]!.indexOf('<h1>');
    const marker = '{/* @vs-spec id="s-deadbeef" ts="t" text="e30" */}';
    const next = spliceFirstChild(SURFACE, h1Line, col, marker);
    expect(next).toContain(marker);
    expect(next).toMatch(/<h1>\n\s+\{\/\* @vs-spec/);
    expect(() => assertParses(next)).not.toThrow();
  });
});
