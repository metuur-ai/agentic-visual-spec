/**
 * publish-payload.test.ts — R-2.9, R-2.10, R-2.11, R-12.8.
 *
 * The headline is R-12.8: `json` and `markdown` must provably come from ONE
 * document object at ONE instant. Asserting that both fields are present proves
 * nothing — a broken implementation that serialized `json` from one editor read
 * and `markdown` from a later one would pass that. So the divergence is *induced*
 * here: the reader is rigged to return a different document on every call, and a
 * second read would show up as `markdown` describing a document `json` does not.
 */
import { describe, expect, it, vi } from 'vitest';
import { headless } from '@lyfie/luthor';
import { NODE_ID_UNSERIALIZABLE_TYPES } from './node-id-extension';
import { generatePublishPayload, serializeFrontmatter } from './publish-payload';
import type { JsonDocument } from '../core/collaboration/document-protocol';

/** A one-paragraph document whose single block carries `text` and a `nodeId`. */
function docWithText(text: string, nodeId = 'n1'): JsonDocument {
  const doc = headless.markdownToJSON(`${text}\n`) as JsonDocument;
  const children = (doc.root as { children: Record<string, unknown>[] }).children;
  children[0].$ = { nodeId };
  return doc;
}

/** A block type the markdown bridge cannot represent, so publishing drops it. */
function calloutNode(nodeId: string) {
  return {
    type: 'callout',
    version: 1,
    variant: 'note',
    direction: null,
    format: '',
    indent: 0,
    children: [{ type: 'text', text: 'note body', detail: 0, format: 0, mode: 'normal', style: '', version: 1 }],
    $: { nodeId },
  };
}

function rootChildren(doc: JsonDocument): Record<string, unknown>[] {
  return (doc.root as { children: Record<string, unknown>[] }).children;
}

describe('generatePublishPayload — single-instant derivation (R-12.8)', () => {
  it('reads the document source exactly once', () => {
    const read = vi.fn(() => docWithText('only read'));

    generatePublishPayload(read);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('derives both artifacts from the first read even when the source keeps changing', () => {
    // Rigged source: every call yields a *different* document. If `json` and
    // `markdown` were produced by separate reads of live editor state, they would
    // describe different documents — the exact silent mismatch the server cannot
    // detect, because it treats the markdown as opaque bytes.
    const reads = [docWithText('read one'), docWithText('read two'), docWithText('read three')];
    let call = 0;
    const payload = generatePublishPayload(() => reads[Math.min(call++, reads.length - 1)]);

    expect(payload.markdown).toContain('read one');
    expect(payload.markdown).not.toContain('read two');
    expect(payload.markdown).not.toContain('read three');
    expect(payload.json).toEqual(reads[0]);
  });

  it('produces markdown that is exactly re-derivable from the payload json', () => {
    // The pairing is verifiable after the fact: the published markdown is what the
    // published json serializes to, byte for byte.
    const payload = generatePublishPayload(() => docWithText('paired'));

    expect(payload.markdown).toBe(headless.jsonToMarkdown(payload.json, { metadataMode: 'none' }));
  });

  it('detaches the snapshot so an edit landing after generation reaches neither artifact', () => {
    const live = docWithText('before the edit');
    const payload = generatePublishPayload(() => live);

    // The editor keeps going after publish is triggered.
    rootChildren(live)[0].children = [
      { type: 'text', text: 'after the edit', detail: 0, format: 0, mode: 'normal', style: '', version: 1 },
    ];

    expect(JSON.stringify(payload.json)).toContain('before the edit');
    expect(payload.markdown).toContain('before the edit');
    expect(payload.markdown).toBe(headless.jsonToMarkdown(payload.json, { metadataMode: 'none' }));
  });

  it('accepts the editor JSON string (getJSON) as the source (R-2.11)', () => {
    const doc = docWithText('from getJSON');
    const payload = generatePublishPayload(() => JSON.stringify(doc));

    expect(payload.json).toEqual(doc);
    expect(payload.markdown).toBe(headless.jsonToMarkdown(doc, { metadataMode: 'none' }));
  });

  it('fails loudly rather than publishing when the source is not a JsonDocument', () => {
    expect(() => generatePublishPayload(() => '{"nope":1}')).toThrow(/JsonDocument/);
  });
});

describe('generatePublishPayload — envelope-free markdown (R-2.9)', () => {
  it('emits no metadata envelopes even when nodes are dropped', () => {
    const doc = docWithText('body');
    rootChildren(doc).push(calloutNode('c1'));

    const payload = generatePublishPayload(() => doc);

    expect(payload.markdown).not.toContain('luthor:meta');
    // `preserve` is the mode that would have appended them — proof the option is
    // load-bearing rather than a no-op on this input.
    expect(headless.jsonToMarkdown(doc, { metadataMode: 'preserve' })).toContain('luthor:meta');
  });
});

describe('generatePublishPayload — dropped-node reporting', () => {
  it('reports each node the markdown drops, with its nodeId, path and fallback', () => {
    const doc = docWithText('body');
    rootChildren(doc).push(calloutNode('c1'));

    const payload = generatePublishPayload(() => doc);

    expect(payload.droppedNodes).toEqual([
      { nodeId: 'c1', type: 'callout', path: [1], fallback: expect.stringContaining('callout') },
    ]);
    // Reported, not silently dropped: the placeholder is in the markdown too.
    expect(payload.markdown).toContain(payload.droppedNodes[0].fallback);
  });

  it('omits nodeId when the dropped node carries none', () => {
    const doc = docWithText('body');
    const callout = calloutNode('c1');
    delete (callout as { $?: unknown }).$;
    rootChildren(doc).push(callout);

    const payload = generatePublishPayload(() => doc);

    expect(payload.droppedNodes).toHaveLength(1);
    expect(payload.droppedNodes[0]).not.toHaveProperty('nodeId');
  });

  it('reports nothing for a fully representable document', () => {
    const payload = generatePublishPayload(() => docWithText('all representable'));

    expect(payload.droppedNodes).toEqual([]);
  });

  it('is unaffected by the types whose nodeId does not survive serialization', () => {
    // `image`, `iframe-embed` and `youtube-embed` lose their `nodeId` on export
    // (Luthor 2.9). That costs them a durable comment anchor, but publishing does
    // not read `nodeId` — and all three are markdown-representable, so they are
    // never dropped and never need to appear in the report.
    for (const type of Object.keys(NODE_ID_UNSERIALIZABLE_TYPES)) {
      expect(headless.MARKDOWN_SUPPORTED_NODE_TYPES.has(type)).toBe(true);
    }

    const doc = headless.markdownToJSON('![alt](img.png)\n') as JsonDocument;
    const payload = generatePublishPayload(() => doc);

    expect(payload.droppedNodes).toEqual([]);
    expect(payload.markdown).toContain('![alt](img.png)');
  });
});

describe('authored frontmatter (option B — scalars and arrays of scalars)', () => {
  it('emits no fence at all when there is no emittable frontmatter', () => {
    // The failure this guards: a bare `---\n---` at the top of every artifact that
    // happens to have no frontmatter. Absence must produce absence.
    for (const frontmatter of [{}, undefined, { nested: { a: 1 } }]) {
      const payload = generatePublishPayload(() => docWithText('body'), frontmatter);
      expect(payload.markdown.startsWith('---')).toBe(false);
      expect(payload.markdown).toBe(headless.jsonToMarkdown(payload.json, { metadataMode: 'none' }));
    }
  });

  it('prepends a fenced block and leaves the body envelope-free (R-2.9)', () => {
    const payload = generatePublishPayload(() => docWithText('body'), {
      title: 'My doc',
      draft: true,
      order: 3,
      tags: ['a', 'b'],
    });

    expect(payload.markdown).toBe(
      '---\ntitle: "My doc"\ndraft: true\norder: 3\ntags: ["a", "b"]\n---\n\n' +
        headless.jsonToMarkdown(payload.json, { metadataMode: 'none' }),
    );
    // The Luthor envelope must not ride along on the back of this change.
    expect(payload.markdown).not.toContain('luthor:meta');
    expect(payload.droppedFrontmatter).toEqual([]);
  });

  it('orders `title` first, then alphabetically, so an unchanged republish is byte-identical', () => {
    const a = serializeFrontmatter({ zeta: 1, alpha: 2, title: 't' }).block;
    const b = serializeFrontmatter({ alpha: 2, title: 't', zeta: 1 }).block;

    expect(a).toBe(b);
    expect(a).toBe('---\ntitle: "t"\nalpha: 2\nzeta: 1\n---\n\n');
  });

  it('reports non-scalar values instead of approximating them', () => {
    const { block, dropped } = serializeFrontmatter({
      title: 'kept',
      nested: { a: 1 },
      matrix: [[1]],
      empty: null,
      notFinite: Number.POSITIVE_INFINITY,
    });

    expect(block).toBe('---\ntitle: "kept"\n---\n\n');
    expect(dropped.map((d) => d.key).sort()).toEqual(['empty', 'matrix', 'nested', 'notFinite']);
    expect(dropped.every((d) => d.reason === 'unsupported-type')).toBe(true);
  });

  it('escapes strings that would otherwise break out of the block', () => {
    // A value holding `\n---\n` is the corruption case: unquoted, it would close the
    // fence early and turn the rest of the frontmatter into document body.
    const { block } = serializeFrontmatter({
      title: 'line\n---\nstill title',
      hash: '# not a comment',
      quote: 'he said "hi"',
      'odd key': 'quoted',
    });

    expect(block).toBe(
      '---\ntitle: "line\\n---\\nstill title"\nhash: "# not a comment"\n"odd key": "quoted"\nquote: "he said \\"hi\\""\n---\n\n',
    );
    // Exactly two fence lines — the value did not open a third.
    expect(block.split('\n').filter((l) => l === '---')).toHaveLength(2);
  });

  it('escapes control and separator characters YAML cannot carry in a quoted scalar', () => {
    // JSON.stringify leaves these raw. C0/DEL/C1 make the block unparseable; U+0085
    // is read as a line break, which silently rewrites the value.
    const { block } = serializeFrontmatter({
      del: 'a\u007fb',
      c1: 'a\u0091b',
      nel: 'a\u0085b',
      sep: 'a\u2028b',
    });

    expect(block).toContain('del: "a\\x7fb"');
    expect(block).toContain('c1: "a\\x91b"');
    expect(block).toContain('nel: "a\\x85b"');
    expect(block).toContain('sep: "a\\u2028b"');
    // No raw character from the forbidden set survived into the artifact.
    expect(/[\u007f\u0080-\u009f\u2028\u2029]/.test(block)).toBe(false);
  });

  it('normalizes exponent notation so YAML 1.1 still reads it as a number', () => {
    // Bare `1e+21` has no `.` in the mantissa, so a YAML 1.1 resolver reads it back
    // as a *string* — the same round-trip hazard NaN/Infinity are excluded for.
    const { block, dropped } = serializeFrontmatter({ big: 1e21, small: 1e-7, fine: 1.5 });

    expect(block).toContain('big: 1.0e+21');
    expect(block).toContain('small: 1.0e-7');
    expect(block).toContain('fine: 1.5');
    expect(dropped).toEqual([]);
  });

  it('quotes keys that YAML 1.1 or JS would reinterpret', () => {
    // `__proto__` must come from JSON.parse — an object literal would set the
    // prototype instead of creating the key, which is the whole hazard.
    const parsed = JSON.parse('{"__proto__":"x","on":"x","no":"x","y":"x"}');
    const { block } = serializeFrontmatter(parsed);

    expect(block).toContain('"on": "x"');
    expect(block).toContain('"no": "x"');
    expect(block).toContain('"y": "x"');
    expect(block).toContain('"__proto__": "x"');
  });
});
