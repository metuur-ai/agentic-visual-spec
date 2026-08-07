// @vitest-environment jsdom
/**
 * node-id-extension.contract.test.tsx — task 2.1's acceptance suite.
 *
 * `node-identity.contract.test.tsx` (task 0.1) proved the *mechanism* on three
 * hand-picked block classes. This file pins the shipped module across **every**
 * block type in `MARKDOWN_SUPPORTED_NODE_TYPES` (R-12.2) and through the same live
 * editor operations 0.1 exercises: type, split, merge, paste, reload.
 *
 * Everything is driven through the live `LexicalEditor` handed over by the
 * extension's `initialize` hook rather than synthesized keystrokes — jsdom has no
 * layout and no real contentEditable, so `beforeinput` never reaches Lexical's
 * reconciler. The mutations still go through the selection APIs the keyboard
 * handlers call, so the node-creation paths under test are the production ones.
 */
import './prism-global'; // must precede @lyfie/luthor — sets the global Prism
import { $generateJSONFromSelectedNodes, $insertDataTransferForRichText } from '@lexical/clipboard';
import { ExtensiveEditor, headless, type ExtensiveEditorRef } from '@lyfie/luthor';
import { act, render } from '@testing-library/react';
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  type LexicalEditor,
  type RangeSelection,
} from 'lexical';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  $getNodeId,
  NODE_ID_BLOCK_TYPES,
  NODE_ID_EXCLUDED_TYPES,
  NODE_ID_UNSERIALIZABLE_TYPES,
  createNodeIdExtension,
  createRandomNodeId,
  getSerializedNodeId,
  resolveNodeIdTransformClasses,
} from './node-id-extension';

// ---------------------------------------------------------------- jsdom gaps

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= () => {};
});

// --------------------------------------------------------------- harness

type Harness = { api: ExtensiveEditorRef; editor: LexicalEditor };

async function mountEditor(): Promise<Harness> {
  // A per-mount counter, deliberately restarting at 1 on every mount: that is what
  // a fresh browser session does, and it is the case a naive generator gets wrong
  // when the loaded document already holds `n1`.
  let counter = 0;
  const nextNodeId = () => `n${++counter}`;
  let editor: LexicalEditor | null = null;
  const capture = headless.createExtension({
    name: 'vs-node-id-test-capture',
    initialize: (ed: LexicalEditor) => {
      editor = ed;
    },
  });
  let api: ExtensiveEditorRef | null = null;
  await act(async () => {
    render(
      <ExtensiveEditor
        onReady={(methods) => {
          api = methods;
        }}
        extraExtensions={[capture, createNodeIdExtension({ generateNodeId: nextNodeId })]}
        showDefaultContent={false}
        sourceMetadataMode="none"
        defaultEditorView="visual"
        isEditorViewTabsVisible={false}
        isToolbarEnabled={false}
      />,
    );
  });
  if (!api) throw new Error('ExtensiveEditor never called onReady');
  if (!editor) throw new Error('extension initialize() never ran');
  return { api, editor };
}

type SerializedNode = { type: string; children?: SerializedNode[]; $?: { nodeId?: string } };

function docOf(api: ExtensiveEditorRef): SerializedNode {
  return (JSON.parse(api.getJSON()) as { root: SerializedNode }).root;
}

/** Every serialized node in the document, root included, in document order. */
function allNodes(root: SerializedNode): SerializedNode[] {
  const out: SerializedNode[] = [root];
  for (const child of root.children ?? []) out.push(...allNodes(child));
  return out;
}

/** `{ nodeId, type, text }` per top-level block, in document order. */
function blocks(api: ExtensiveEditorRef): Array<{ nodeId?: string; type: string; text: string }> {
  const text = (n: { text?: string; children?: unknown[] }): string =>
    typeof n.text === 'string'
      ? n.text
      : ((n.children ?? []) as Array<{ text?: string; children?: unknown[] }>).map(text).join('');
  return (docOf(api).children ?? []).map((c) => ({
    nodeId: getSerializedNodeId(c),
    type: c.type,
    text: text(c),
  }));
}

/** Luthor defers `injectJSON` behind a 100ms `setTimeout`. */
async function injectJSON(h: Harness, json: string): Promise<void> {
  await act(async () => {
    h.api.injectJSON(json);
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

function update(editor: LexicalEditor, fn: () => void): void {
  act(() => {
    editor.update(fn, { discrete: true });
  });
}

/**
 * `injectJSON` swaps the node map wholesale and never runs transforms (task 0.1),
 * so a freshly loaded document has to be dirtied for the transforms to see it.
 * This stands in for the R-2.8 backfill that task 2.2 owns.
 */
function touchAll(editor: LexicalEditor): void {
  update(editor, () => {
    const visit = (node: import('lexical').LexicalNode): void => {
      node.markDirty();
      if ($isElementNode(node)) for (const child of node.getChildren()) visit(child);
    };
    for (const child of $getRoot().getChildren()) visit(child);
  });
}

/** Load markdown, then let the transforms run over it. */
async function inject(h: Harness, markdown: string): Promise<void> {
  await injectJSON(h, JSON.stringify(headless.markdownToJSON(markdown)));
  touchAll(h.editor);
}

function $selection(): RangeSelection {
  const sel = $getSelection();
  if (!$isRangeSelection(sel)) throw new Error('expected a range selection');
  return sel;
}

/** Caret into top-level block `index` at `offset`, all inside ONE update. */
function atCaret(editor: LexicalEditor, index: number, offset: number, fn: (sel: RangeSelection) => void): void {
  update(editor, () => {
    const block = $getRoot().getChildAtIndex(index);
    if (!$isElementNode(block)) throw new Error(`block ${index} is not an element`);
    const text = block.getFirstDescendant();
    if ($isTextNode(text)) text.select(offset, offset);
    else block.select(offset, offset);
    fn($selection());
  });
}

/** jsdom has no DataTransfer; Lexical only reads `types` and `getData`. */
function fakeDataTransfer(type: string, data: string): DataTransfer {
  return { types: [type], getData: (t: string) => (t === type ? data : '') } as unknown as DataTransfer;
}

/**
 * One document containing every addressable block type. Markdown reaches all of
 * them except the two embed nodes, which `markdownToJSON` alone does not produce
 * (their `![[iframe:…]]` / `![[youtube:…]]` transformers are supplied by the
 * embed extensions, not the base transformer set), so those two are appended
 * through their own `$create…` factories by `appendEmbeds`.
 */
const KITCHEN_SINK = [
  '# Heading one',
  '',
  'A paragraph with a [link](https://example.com) and `inline code`.',
  '',
  '> a quoted line',
  '',
  '- item one',
  '- item two',
  '',
  '```ts',
  'const x = 1;',
  '```',
  '',
  '---',
  '',
  '![alt text](./img.png)',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
].join('\n');

/** Append the two embed blocks markdown cannot produce, then re-run transforms. */
function appendEmbeds(h: Harness): void {
  update(h.editor, () => {
    $getRoot().append(
      headless.$createIframeEmbedNode({
        src: 'https://example.com/embed',
        width: 560,
        height: 315,
        alignment: 'center',
      }),
      headless.$createYouTubeEmbedNode({
        src: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
        width: 560,
        height: 315,
        alignment: 'center',
      }),
    );
  });
}

/** The full fixture: every addressable block type in one document. */
async function injectKitchenSink(h: Harness): Promise<void> {
  await inject(h, KITCHEN_SINK);
  appendEmbeds(h);
}

let harness: Harness;

beforeEach(async () => {
  harness = await mountEditor();
});

// ------------------------------------------------------------------ R-12.2

describe('transform coverage of MARKDOWN_SUPPORTED_NODE_TYPES (R-12.2)', () => {
  const supported = [...headless.MARKDOWN_SUPPORTED_NODE_TYPES];

  it('partitions the constant into covered block types and explicitly excluded ones', () => {
    const excluded = Object.keys(NODE_ID_EXCLUDED_TYPES);
    // Nothing in the constant is silently skipped, and nothing is claimed twice.
    expect([...NODE_ID_BLOCK_TYPES, ...excluded].sort()).toEqual([...supported].sort());
    expect(NODE_ID_BLOCK_TYPES.filter((t) => excluded.includes(t))).toEqual([]);
    // Every exclusion carries a stated reason.
    for (const type of excluded) expect(NODE_ID_EXCLUDED_TYPES[type]).toBeTruthy();
  });

  it('pins today s block/inline split so a Luthor upgrade that changes it is visible', () => {
    expect([...NODE_ID_BLOCK_TYPES].sort()).toEqual([
      'code',
      'heading',
      'horizontalrule',
      'iframe-embed',
      'image',
      'list',
      'listitem',
      'paragraph',
      'quote',
      'table',
      'tablecell',
      'tablerow',
      'youtube-embed',
    ]);
    expect(Object.keys(NODE_ID_EXCLUDED_TYPES).sort()).toEqual([
      'autolink',
      'code-highlight',
      'linebreak',
      'link',
      'root',
      'tab',
      'text',
    ]);
  });

  it('resolves one concrete node class per block type and registers a transform on each', () => {
    const resolved = resolveNodeIdTransformClasses(harness.editor);
    expect([...resolved.keys()].sort()).toEqual([...NODE_ID_BLOCK_TYPES].sort());
    for (const [type, klass] of resolved) {
      // `registerNodeTransform` rejects abstract bases — each entry must be a
      // concrete class whose own `getType()` is the block type.
      expect(klass.getType()).toBe(type);
      expect(harness.editor._nodes.get(type)?.transforms.size ?? 0).toBeGreaterThan(0);
    }
  });

  it('throws rather than skipping when a block type has no registered class', () => {
    const editor = harness.editor;
    const saved = editor._nodes.get('quote');
    editor._nodes.delete('quote');
    try {
      expect(() => resolveNodeIdTransformClasses(editor)).toThrow(/quote/);
    } finally {
      if (saved) editor._nodes.set('quote', saved);
    }
  });

  it('assigns a nodeId in the live document to every node of every block type', async () => {
    await injectKitchenSink(harness);
    const present = new Set(allNodes(docOf(harness.api)).map((n) => n.type));
    // The fixture really does exercise every covered block type.
    for (const type of NODE_ID_BLOCK_TYPES) expect(present.has(type)).toBe(true);

    const missing: string[] = [];
    const wrongly: string[] = [];
    harness.editor.getEditorState().read(() => {
      const visit = (node: import('lexical').LexicalNode): void => {
        const covered = NODE_ID_BLOCK_TYPES.includes(node.getType());
        if (covered && !$getNodeId(node)) missing.push(node.getType());
        if (!covered && $getNodeId(node)) wrongly.push(node.getType());
        if ($isElementNode(node)) for (const child of node.getChildren()) visit(child);
      };
      for (const child of $getRoot().getChildren()) visit(child);
    });
    expect(missing).toEqual([]);
    expect(wrongly).toEqual([]);
  });

  it('serializes that nodeId for every block type except the three Luthor drops', async () => {
    await injectKitchenSink(harness);
    const unserializable = Object.keys(NODE_ID_UNSERIALIZABLE_TYPES);
    // The gap is a subset of the covered blocks, and each entry states a reason.
    for (const type of unserializable) {
      expect(NODE_ID_BLOCK_TYPES).toContain(type);
      expect(NODE_ID_UNSERIALIZABLE_TYPES[type]).toBeTruthy();
    }

    for (const node of allNodes(docOf(harness.api))) {
      if (unserializable.includes(node.type)) {
        // Pinned deliberately: Luthor's ImageNode/IframeEmbedNode/YouTubeEmbedNode
        // build exportJSON() as a literal and never spread super.exportJSON(), so
        // Lexical's `$` key is dropped. When Luthor fixes that, this fails and
        // NODE_ID_UNSERIALIZABLE_TYPES shrinks.
        expect(getSerializedNodeId(node), `${node.type} unexpectedly round-trips now`).toBeUndefined();
      } else if (NODE_ID_BLOCK_TYPES.includes(node.type)) {
        expect(getSerializedNodeId(node), `${node.type} has no serialized nodeId`).toMatch(/^n\d+$/);
      } else {
        expect(getSerializedNodeId(node), `${node.type} should not carry a nodeId`).toBeUndefined();
      }
    }
  });
});

// ------------------------------------------------------------- R-2.3 / R-2.4

describe('serialized shape and uniqueness', () => {
  it('leaves every serialized `type` on the base string (R-2.3)', async () => {
    await injectKitchenSink(harness);
    for (const node of allNodes(docOf(harness.api))) {
      expect(headless.MARKDOWN_SUPPORTED_NODE_TYPES.has(node.type)).toBe(true);
    }
    expect(blocks(harness.api).map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'quote',
      'list',
      'code',
      'horizontalrule',
      'image',
      'table',
      'iframe-embed',
      'youtube-embed',
    ]);
  });

  it('puts the id under the `$` key, never on a bare `id`/`nodeId` field', async () => {
    await inject(harness, 'alpha');
    const [para] = docOf(harness.api).children ?? [];
    expect(para.$).toEqual({ nodeId: expect.stringMatching(/^n\d+$/) });
    expect((para as Record<string, unknown>).id).toBeUndefined();
    expect((para as Record<string, unknown>).nodeId).toBeUndefined();
  });

  it('gives every node in a document containing all block types a unique id (R-2.4)', async () => {
    await injectKitchenSink(harness);
    const ids = allNodes(docOf(harness.api))
      .map(getSerializedNodeId)
      .filter((id): id is string => Boolean(id));
    expect(ids.length).toBeGreaterThan(15);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every editor-created node a document-unique id (R-2.4)', async () => {
    await inject(harness, 'alpha\n\nbravo\n\ncharlie');
    atCaret(harness.editor, 2, 7, (sel) => {
      for (let i = 0; i < 5; i++) sel.insertParagraph();
    });
    const ids = blocks(harness.api).map((b) => b.nodeId);
    expect(ids).toHaveLength(8);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not hand out an id that a loaded node already holds', async () => {
    // The generator restarts at `n1` in the second mount, exactly as a fresh
    // browser session does, while the loaded document already holds those ids.
    // A generator-only assignment would re-issue one of them to a new block.
    await inject(harness, 'alpha\n\nbravo\n\ncharlie');
    const loaded = harness.api.getJSON();
    const before = blocks(harness.api).map((b) => b.nodeId);

    const second = await mountEditor();
    await injectJSON(second, loaded);
    atCaret(second.editor, 2, 7, (sel) => sel.insertParagraph());

    const ids = blocks(second.api).map((b) => b.nodeId);
    expect(ids.slice(0, 3)).toEqual(before);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('createRandomNodeId produces distinct ids', () => {
    const ids = new Set(Array.from({ length: 200 }, createRandomNodeId));
    expect(ids.size).toBe(200);
  });
});

// -------------------------------------------------------- live edit operations

describe('identity through live editor operations', () => {
  it('keeps nodeId stable while text is typed into a block', async () => {
    await inject(harness, '# alpha\n\n> bravo');
    const before = blocks(harness.api);
    atCaret(harness.editor, 0, 5, (sel) => sel.insertText(' typed'));
    const after = blocks(harness.api);
    expect(after[0].text).toBe('alpha typed');
    expect(after.map((b) => b.nodeId)).toEqual(before.map((b) => b.nodeId));
  });

  it('keeps the original nodeId on the surviving half of a split (Enter)', async () => {
    await inject(harness, '# alpha bravo\n\ntail');
    const before = blocks(harness.api);
    atCaret(harness.editor, 0, 5, (sel) => sel.insertParagraph());
    const after = blocks(harness.api);
    expect(after.map((b) => b.text)).toEqual(['alpha', ' bravo', 'tail']);
    expect(after[0].nodeId).toBe(before[0].nodeId);
    expect(after[2].nodeId).toBe(before[1].nodeId);
    expect(after[1].nodeId).not.toBe(before[0].nodeId);
    expect(new Set(after.map((b) => b.nodeId)).size).toBe(3);
  });

  it('keeps the surviving nodeId when two blocks merge (Backspace at start)', async () => {
    await inject(harness, 'alpha\n\nbravo\n\ncharlie');
    const before = blocks(harness.api);
    atCaret(harness.editor, 1, 0, (sel) => sel.deleteCharacter(true));
    const after = blocks(harness.api);
    expect(after.map((b) => b.text)).toEqual(['alphabravo', 'charlie']);
    expect(after[0].nodeId).toBe(before[0].nodeId);
    expect(after[1].nodeId).toBe(before[2].nodeId);
  });

  it('keeps list item ids stable when a sibling item is added', async () => {
    await inject(harness, '- one\n- two');
    const listBefore = (docOf(harness.api).children ?? [])[0];
    const itemsBefore = (listBefore.children ?? []).map(getSerializedNodeId);
    expect(itemsBefore).toHaveLength(2);

    update(harness.editor, () => {
      const list = $getRoot().getChildAtIndex(0);
      if (!$isElementNode(list)) throw new Error('expected a list');
      const last = list.getLastChild();
      if (!$isElementNode(last)) throw new Error('expected a list item');
      const text = last.getLastDescendant();
      if ($isTextNode(text)) text.select(3, 3);
      $selection().insertParagraph();
    });

    const listAfter = (docOf(harness.api).children ?? [])[0];
    const itemsAfter = (listAfter.children ?? []).map(getSerializedNodeId);
    expect(getSerializedNodeId(listAfter)).toBe(getSerializedNodeId(listBefore));
    expect(itemsAfter.slice(0, 2)).toEqual(itemsBefore);
    expect(itemsAfter.every(Boolean)).toBe(true);
    expect(new Set(itemsAfter).size).toBe(itemsAfter.length);
  });

  it('gives plain-text pasted blocks fresh ids without disturbing existing ones', async () => {
    await inject(harness, 'alpha\n\nomega');
    const before = blocks(harness.api);
    atCaret(harness.editor, 0, 5, (sel) =>
      $insertDataTransferForRichText(fakeDataTransfer('text/plain', 'one\ntwo'), sel, harness.editor),
    );
    const after = blocks(harness.api);
    expect(after.map((b) => b.text).join('|')).toContain('two');
    expect(after[0].nodeId).toBe(before[0].nodeId);
    expect(after[after.length - 1].nodeId).toBe(before[1].nodeId);
    const ids = after.map((b) => b.nodeId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The case an "assign only when absent" transform gets wrong. Lexical's own
   * clipboard payload (`application/x-lexical-editor`) is the serialized nodes,
   * `$` state included, so copying blocks inside a document and pasting them back
   * reintroduces ids that are still live. Two nodes sharing one id would silently
   * mis-anchor every comment on it, so the transform re-issues the **copy** and
   * leaves the node that already held the id alone.
   */
  it('re-issues ids on blocks pasted from the same document, keeping the originals (R-2.4)', async () => {
    await inject(harness, 'alpha\n\nbravo\n\nomega');
    const before = blocks(harness.api);
    let payload = '';
    update(harness.editor, () => {
      const first = $getRoot().getChildAtIndex(0);
      const second = $getRoot().getChildAtIndex(1);
      if (!$isElementNode(first) || !$isElementNode(second)) throw new Error('expected elements');
      const from = first.getFirstDescendant();
      const to = second.getLastDescendant();
      if (!$isTextNode(from) || !$isTextNode(to)) throw new Error('expected text');
      from.select(0, 0);
      $selection().focus.set(to.getKey(), to.getTextContentSize(), 'text');
      payload = JSON.stringify($generateJSONFromSelectedNodes(harness.editor, $selection()));
    });
    // The clipboard really does carry the live ids — this is why the guard exists.
    expect(payload).toContain(`"nodeId":"${before[0].nodeId}"`);
    expect(payload).toContain(`"nodeId":"${before[1].nodeId}"`);

    atCaret(harness.editor, 2, 5, (sel) =>
      $insertDataTransferForRichText(fakeDataTransfer('application/x-lexical-editor', payload), sel, harness.editor),
    );

    const after = blocks(harness.api);
    // The first pasted block merges into the caret's block, the second lands as a
    // new one — a real duplicate of `bravo`, id and all, if nothing guarded it.
    expect(after.map((b) => b.text)).toEqual(['alpha', 'bravo', 'omegaalpha', 'bravo']);
    const ids = after.map((b) => b.nodeId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size, `duplicate nodeId in ${JSON.stringify(ids)}`).toBe(ids.length);
    // The originals kept their ids; comments already anchored to them still resolve.
    expect(ids[0]).toBe(before[0].nodeId);
    expect(ids[1]).toBe(before[1].nodeId);
    expect(ids[2]).toBe(before[2].nodeId);
    // The copy of `bravo` was re-issued rather than left sharing `bravo`'s id.
    expect(ids[3]).not.toBe(before[1].nodeId);
  });
});

// ---------------------------------------------------------------- R-2.5

describe('serialization round trip (R-2.5)', () => {
  it('survives getJSON() → injectJSON() for every block type', async () => {
    await injectKitchenSink(harness);
    const before = allNodes(docOf(harness.api)).map((n) => [n.type, getSerializedNodeId(n)]);
    await injectJSON(harness, harness.api.getJSON());
    expect(allNodes(docOf(harness.api)).map((n) => [n.type, getSerializedNodeId(n)])).toEqual(before);
  });

  it('survives a reload into a second editor mount', async () => {
    await injectKitchenSink(harness);
    const before = allNodes(docOf(harness.api)).map((n) => [n.type, getSerializedNodeId(n)]);
    const json = harness.api.getJSON();

    const second = await mountEditor();
    await injectJSON(second, json);

    expect(allNodes(docOf(second.api)).map((n) => [n.type, getSerializedNodeId(n)])).toEqual(before);
  });

  it('keeps ids across a reload followed by further editing', async () => {
    await inject(harness, '# title\n\nalpha\n\n> quoted');
    const json = harness.api.getJSON();
    const second = await mountEditor();
    await injectJSON(second, json);
    const before = blocks(second.api);
    atCaret(second.editor, 1, 5, (sel) => sel.insertText(' more'));
    const after = blocks(second.api);
    expect(after[1].text).toBe('alpha more');
    expect(after.map((b) => b.nodeId)).toEqual(before.map((b) => b.nodeId));
  });

  it('$getNodeId reads the same value the serialized document carries', async () => {
    await inject(harness, 'alpha\n\nbravo');
    const serialized = (docOf(harness.api).children ?? []).map(getSerializedNodeId);
    const live: string[] = [];
    harness.editor.getEditorState().read(() => {
      for (const child of $getRoot().getChildren()) live.push($getNodeId(child));
    });
    expect(live).toEqual(serialized);
  });
});
