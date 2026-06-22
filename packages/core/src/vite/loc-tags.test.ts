import { describe, expect, it } from 'vitest';
import { findInsertion, lineToOffset } from '../editing/marker-core';
import { injectLocTags, isSurfaceModule } from './loc-tags';

const SURFACE = `export default [
  function Page() {
    return (
      <section>
        <h1>Q2 Roadmap</h1>
        <CustomThing />
        <img src="/x.png" />
      </section>
    );
  },
];
`;

describe('injectLocTags', () => {
  const out = injectLocTags(SURFACE);

  it('tags host elements (section, h1, img) but not capitalized components', () => {
    expect(out).toMatch(/<section data-vs-loc="\d+:\d+">/);
    expect(out).toMatch(/<h1 data-vs-loc="\d+:\d+">/);
    expect(out).toMatch(/<img data-vs-loc="\d+:\d+"/);
    expect(out).not.toMatch(/<CustomThing data-vs-loc/);
  });

  it('emits coordinates that resolve against the ORIGINAL on-disk source', () => {
    // Browser reads data-vs-loc from the transformed code, but the server runs
    // findInsertion on the untouched source. The emitted L:C must point at the
    // element start in the original source.
    for (const m of out.matchAll(/<(\w+) data-vs-loc="(\d+):(\d+)"/g)) {
      const [, tag, lineStr, colStr] = m;
      const line = Number(lineStr);
      const col = Number(colStr);
      const offset = lineToOffset(SURFACE, line, col);
      expect(SURFACE.slice(offset, offset + tag!.length + 1)).toBe(`<${tag}`);
      // and findInsertion must succeed for every tagged element
      expect(() => findInsertion(SURFACE, line, col)).not.toThrow();
    }
  });

  it('is idempotent — re-running does not double-tag', () => {
    const twice = injectLocTags(out);
    const single = (twice.match(/data-vs-loc=/g) ?? []).length;
    const original = (out.match(/data-vs-loc=/g) ?? []).length;
    expect(single).toBe(original);
  });
});

describe('isSurfaceModule', () => {
  it('matches surface entry files, ignores d.ts / test / non-surface', () => {
    expect(isSurfaceModule('/abs/surfaces/anatomy/index.tsx')).toBe(true);
    expect(isSurfaceModule('/abs/surfaces/anatomy/parts.jsx')).toBe(true);
    expect(isSurfaceModule('/abs/surfaces/anatomy/index.tsx?t=123')).toBe(true);
    expect(isSurfaceModule('/abs/surfaces/anatomy/index.d.ts')).toBe(false);
    expect(isSurfaceModule('/abs/surfaces/anatomy/index.test.tsx')).toBe(false);
    expect(isSurfaceModule('/abs/src/app/foo.tsx')).toBe(false);
  });
});
