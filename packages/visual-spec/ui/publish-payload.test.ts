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
import { generatePublishPayload } from './publish-payload';
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
