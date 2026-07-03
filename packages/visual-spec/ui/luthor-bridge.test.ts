/**
 * Contract test for the Luthor markdown round-trip. The WYSIWYG editor keeps the
 * .md file as source of truth by loading markdown into Luthor and pulling it back
 * out via getMarkdown(); dirty-detection compares that output against a baseline.
 * If Luthor's serialization drifts (a Lexical/Luthor upgrade, a flavor change),
 * the baseline moves and edits are either lost or spuriously flagged — silently.
 *
 * These tests pin the two properties the editor relies on:
 *   1. Fidelity  — canonicalizing preserves the meaningful markdown constructs.
 *   2. Idempotency — canonical(canonical(x)) === canonical(x), so a mere load
 *      never looks like an edit. This is the property dirty-detection stands on.
 */
import { describe, expect, it } from 'vitest';
import { canonicalizeMarkdown, mapImages, normalizeForStore } from './luthor-bridge';

/** Representative specs covering the lossy points of most Lexical markdown bridges. */
const SAMPLES: Record<string, string> = {
  heading: '# Title\n\n## Subtitle\n\nBody text.',
  emphasis: 'Some **bold** and *italic* and `code` inline.',
  list: '- one\n- two\n- three',
  ordered: '1. first\n2. second',
  codeBlock: '```ts\nconst x = 1;\nconsole.log(x);\n```',
  relativeImage: '![a diagram](./assets/diagram.png)',
  link: 'See [the docs](https://example.com/docs) for more.',
  blockquote: '> a quoted line',
  mixed: '# Guide\n\nIntro with **bold**.\n\n- bullet with `code`\n- ![img](../img/x.png)\n\n```js\nfn();\n```',
};

describe('canonicalizeMarkdown — fidelity', () => {
  it('preserves heading levels', () => {
    const out = canonicalizeMarkdown(SAMPLES.heading);
    expect(out).toContain('# Title');
    expect(out).toContain('## Subtitle');
  });

  it('preserves inline emphasis and code', () => {
    const out = canonicalizeMarkdown(SAMPLES.emphasis);
    expect(out).toContain('**bold**');
    expect(out).toContain('*italic*');
    expect(out).toContain('`code`');
  });

  it('preserves fenced code blocks with language and body', () => {
    const out = canonicalizeMarkdown(SAMPLES.codeBlock);
    expect(out).toContain('```ts');
    expect(out).toContain('const x = 1;');
    expect(out).toContain('console.log(x);');
  });

  it('preserves relative image srcs verbatim (portable links must survive)', () => {
    const out = canonicalizeMarkdown(SAMPLES.relativeImage);
    expect(out).toContain('![a diagram](./assets/diagram.png)');
  });

  it('preserves links', () => {
    const out = canonicalizeMarkdown(SAMPLES.link);
    expect(out).toContain('[the docs](https://example.com/docs)');
  });
});

describe('canonicalizeMarkdown — idempotency (dirty-detection depends on this)', () => {
  for (const [name, md] of Object.entries(SAMPLES)) {
    it(`is stable on a second pass: ${name}`, () => {
      const once = canonicalizeMarkdown(md);
      const twice = canonicalizeMarkdown(once);
      expect(twice).toBe(once);
    });
  }
});

describe('mapImages', () => {
  it('rewrites every image src via the mapper, leaving alt and surrounding text intact', () => {
    const md = 'a ![one](./x.png) b ![two](../y.jpg) c';
    const out = mapImages(md, (src) => `/__vs/raw?path=${src}`);
    expect(out).toBe('a ![one](/__vs/raw?path=./x.png) b ![two](/__vs/raw?path=../y.jpg) c');
  });

  it('leaves markdown without images unchanged', () => {
    const md = '# Title\n\nNo images here.';
    expect(mapImages(md, (s) => `X${s}`)).toBe(md);
  });
});

describe('normalizeForStore', () => {
  it('relativizes image srcs and forces exactly one trailing newline', () => {
    const raw = '![p](/__vs/raw?path=assets/p.png)\n\n\n';
    const out = normalizeForStore(raw, () => 'assets/p.png');
    expect(out).toBe('![p](assets/p.png)\n');
  });

  it('adds a trailing newline when the source has none', () => {
    expect(normalizeForStore('text', (s) => s)).toBe('text\n');
  });
});
