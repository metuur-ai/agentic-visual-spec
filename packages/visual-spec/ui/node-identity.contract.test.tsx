// @vitest-environment jsdom
/**
 * node-identity.contract.test.tsx — the load-bearing probe for collaborative
 * documents (R-12.1, R-12.2). The whole design rests on one claim: a `nodeId`
 * attached to a block survives a LIVE editor mount, real editing operations, and
 * a `getJSON()` / `injectJSON()` round trip. This file proves that end to end
 * against the real `ExtensiveEditor` preset, not a hand-built `createEditor()`.
 *
 * WHAT THIS FILE CHANGED ABOUT THE DESIGN (LLD §2)
 * ------------------------------------------------
 * The LLD prescribes carrying `nodeId` on an owned subclass registered via
 * `{ replace, with, withKlass }`, with `static getType()` still returning the
 * BASE type string (`'paragraph'`) so `MARKDOWN_SUPPORTED_NODE_TYPES` and the
 * markdown transformers keep matching. **Those two requirements are mutually
 * exclusive on Lexical 0.40**, which is what Luthor 2.9 ships:
 *
 *   1. `LexicalNode`'s constructor calls `errorOnTypeKlassMismatch(this.__type,
 *      this.constructor)` (Lexical.dev.mjs:3388). The registry is keyed by type
 *      string, so a subclass whose `getType()` returns `'paragraph'` resolves to
 *      the registered `ParagraphNode` and every construction throws
 *      "Create node: Type paragraph in node IdParagraphNode does not match
 *      registered node ParagraphNode with the same type" — the exact failure the
 *      LLD attributes to a missing `withKlass`. It is not `withKlass`: the
 *      registration is correct (verified: `klass=ParagraphNode`,
 *      `replaceWithKlass=IdParagraphNode`). The subclass simply must own a
 *      distinct type and be registered under it.
 *   2. `exportNodeToJSON` (Lexical.dev.mjs:9806) then rejects any node whose
 *      `exportJSON().type` differs from its `getType()`, so the subclass cannot
 *      serialize itself back under the base type string either.
 *
 * So node replacement can carry identity, but only at the cost of the serialized
 * `type`. Lexical's own **NodeState** API (`createState` / `$setState` /
 * `$getState`, serialized under the `$` key) carries `nodeId` with no subclass at
 * all, keeps `type: 'paragraph'`, and is honoured by `importJSON` for every node
 * class automatically. That is the mechanism the main suite below pins; the
 * replacement shape is pinned separately at the bottom so Unit 2 can see exactly
 * what each option costs.
 *
 * TWO MORE LUTHOR FACTS THIS PROBE ESTABLISHED
 * --------------------------------------------
 *   - `markdownSourceOfTruth` makes `getJSON()` LOSSY. Under that flag Luthor
 *     implements `getJSON()` as `markdownToJSON(getMarkdown())`
 *     (`luthor/dist/chunk-EY24FLBB.js`), so the returned JSON is re-parsed from
 *     Markdown and every `nodeId` is gone. `ui/wysiwyg-editor.tsx:402` sets that
 *     flag today; the collaboration mount must NOT (consistent with R-2.11).
 *   - `injectJSON()` is deferred behind a 100ms `setTimeout`, so the injected
 *     state is not readable on the next line.
 *
 * HOW OPERATIONS ARE DRIVEN
 * -------------------------
 * Through the live `LexicalEditor` handed over by the extension's `initialize`
 * hook, not synthesized keystrokes: jsdom has no layout and no real
 * contentEditable, so `beforeinput`/`keydown` never reach Lexical's reconciler
 * and a selection does not survive from one update into the next. Every mutation
 * still goes through the same selection APIs the keyboard handlers call
 * (`insertText`, `insertParagraph`, `deleteCharacter`,
 * `$insertDataTransferForRichText`), so the node-creation paths under test are
 * the production ones.
 */
import './prism-global'; // must precede @lyfie/luthor — sets the global Prism
import { $insertDataTransferForRichText } from '@lexical/clipboard';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ExtensiveEditor, headless, type ExtensiveEditorRef } from '@lyfie/luthor';
import { act, render } from '@testing-library/react';
import {
  $getRoot,
  $getSelection,
  $getState,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setState,
  createState,
  ElementNode,
  ParagraphNode,
  type LexicalEditor,
  type RangeSelection,
  type SerializedParagraphNode,
} from 'lexical';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------- jsdom gaps

beforeAll(() => {
  // Luthor's toolbar and draggable-block extensions observe layout; jsdom has
  // neither observer, and no matchMedia.
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

// ------------------------------------------------------------ id assignment

let idCounter = 0;
const nextNodeId = () => `n${++idCounter}`;

/** Serialized under `"$": { "nodeId": … }`, alongside an untouched `type`. */
const nodeIdState = createState('nodeId', {
  parse: (value: unknown) => (typeof value === 'string' ? value : ''),
});

/**
 * Every node the editor creates — on Enter, on paste, on list toggle — passes
 * through a node transform before the update commits, so this is the hook that
 * covers editor-created nodes. It does NOT cover injected ones: `injectJSON`
 * goes through `EditorState.fromJSON` / `setEditorState`, which replaces the
 * node map wholesale and never runs transforms. Injected documents therefore
 * need the explicit backfill below — which is why R-2.8's backfill is load
 * bearing for every load, not only for legacy documents.
 */
function registerNodeIds(editor: LexicalEditor): () => void {
  const assign = (node: ElementNode) => {
    if (!$getState(node, nodeIdState)) $setState(node, nodeIdState, nextNodeId());
  };
  // One registration per concrete class: `registerNodeTransform` rejects an
  // abstract base like `ElementNode` ("does not implement .getType()").
  const unregister = [
    editor.registerNodeTransform(ParagraphNode, assign),
    editor.registerNodeTransform(HeadingNode, assign),
    editor.registerNodeTransform(QuoteNode, assign),
  ];
  return () => unregister.forEach((fn) => fn());
}

// --------------------------------------------------------------- harness

type Harness = { api: ExtensiveEditorRef; editor: LexicalEditor };

async function mountEditor(): Promise<Harness> {
  let editor: LexicalEditor | null = null;
  const nodeIdExtension = headless.createExtension({
    name: 'vs-node-id',
    initialize: (ed: LexicalEditor) => {
      editor = ed;
      return registerNodeIds(ed);
    },
  });
  // `onReady` is the documented hand-off (`ui/wysiwyg-editor.tsx:379` uses it):
  // the ref object is populated before the editor can accept `injectJSON`.
  let api: ExtensiveEditorRef | null = null;
  await act(async () => {
    render(
      <ExtensiveEditor
        onReady={(methods) => {
          api = methods;
        }}
        extraExtensions={[nodeIdExtension]}
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

type SerializedBlock = { type: string; children?: unknown[]; $?: { nodeId?: string } };

/** `{ nodeId, type, text }` per top-level block, in document order. */
function blocks(api: ExtensiveEditorRef): Array<{ nodeId?: string; type: string; text: string }> {
  const doc = JSON.parse(api.getJSON()) as { root: { children: SerializedBlock[] } };
  const text = (n: { text?: string; children?: unknown[] }): string =>
    typeof n.text === 'string'
      ? n.text
      : ((n.children ?? []) as Array<{ text?: string; children?: unknown[] }>).map(text).join('');
  return doc.root.children.map((c) => ({ nodeId: c.$?.nodeId, type: c.type, text: text(c) }));
}

/**
 * Luthor's `injectJSON` defers the parse behind a 100ms `setTimeout`
 * (`luthor/dist/chunk-EY24FLBB.js`), so the new state is not readable on the
 * next line — every caller has to wait it out.
 */
async function injectJSON(h: Harness, json: string): Promise<void> {
  await act(async () => {
    h.api.injectJSON(json);
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

/** Load markdown, then backfill — the "import a plain .md once" path (LLD §2). */
async function inject(h: Harness, markdown: string): Promise<void> {
  await injectJSON(h, JSON.stringify(headless.markdownToJSON(markdown)));
  backfill(h.editor);
}

function update(editor: LexicalEditor, fn: () => void): void {
  act(() => {
    editor.update(fn, { discrete: true });
  });
}

/**
 * Place the caret in top-level block `index` at `offset` and run `fn` against
 * that selection — in ONE update. jsdom never gives the editor real DOM focus,
 * so a selection set in one update does not survive into the next; the keyboard
 * handlers Lexical ships have the same requirement (they run inside the update
 * that reads the selection).
 */
function atCaret(editor: LexicalEditor, index: number, offset: number, fn: (sel: RangeSelection) => void): void {
  update(editor, () => {
    const block = $getRoot().getChildAtIndex(index);
    if (!$isElementNode(block)) throw new Error(`block ${index} is not an element`);
    // `ElementNode.select` counts CHILDREN, not characters — anchor on the text
    // node so `offset` means what a caret position means.
    const text = block.getFirstDescendant();
    if ($isTextNode(text)) text.select(offset, offset);
    else block.select(offset, offset);
    fn($selection());
  });
}

/** Assign a nodeId to every top-level block that lacks one (R-2.8). */
function backfill(editor: LexicalEditor): void {
  update(editor, () => {
    for (const child of $getRoot().getChildren()) {
      if ($isElementNode(child) && !$getState(child, nodeIdState)) {
        $setState(child, nodeIdState, nextNodeId());
      }
    }
  });
}

function $selection(): RangeSelection {
  const sel = $getSelection();
  if (!$isRangeSelection(sel)) throw new Error('expected a range selection');
  return sel;
}

/** jsdom has no DataTransfer; Lexical only reads `types` and `getData`. */
function fakeDataTransfer(type: string, data: string): DataTransfer {
  return { types: [type], getData: (t: string) => (t === type ? data : '') } as unknown as DataTransfer;
}

let harness: Harness;

beforeEach(async () => {
  idCounter = 0;
  harness = await mountEditor();
});

// ----------------------------------------------------------------- tests

describe('nodeId identity contract — live ExtensiveEditor mount (R-12.1)', () => {
  it('gives every block a nodeId once a markdown import is backfilled', async () => {
    await inject(harness, '# Title\n\nFirst paragraph.\n\n> quoted');
    const out = blocks(harness.api);
    expect(out.map((b) => b.type)).toEqual(['heading', 'paragraph', 'quote']);
    for (const b of out) expect(b.nodeId).toMatch(/^n\d+$/);
  });

  it('does NOT run node transforms on injectJSON, so backfill is mandatory (R-2.8)', async () => {
    await injectJSON(harness, JSON.stringify(headless.markdownToJSON('alpha\n\nbravo')));
    expect(blocks(harness.api).map((b) => b.nodeId)).toEqual([undefined, undefined]);
    backfill(harness.editor);
    expect(blocks(harness.api).every((b) => Boolean(b.nodeId))).toBe(true);
  });

  it('leaves the serialized block `type` on the base string (R-2.3)', async () => {
    await inject(harness, '# Title\n\nbody\n\n> quoted');
    for (const b of blocks(harness.api)) {
      expect(headless.MARKDOWN_SUPPORTED_NODE_TYPES.has(b.type)).toBe(true);
    }
  });

  it('gives every editor-created node a document-unique nodeId (R-2.4)', async () => {
    await inject(harness, 'alpha\n\nbravo\n\ncharlie');
    atCaret(harness.editor, 2, 7, (sel) => {
      for (let i = 0; i < 5; i++) sel.insertParagraph();
    });
    const ids = blocks(harness.api).map((b) => b.nodeId);
    expect(ids).toHaveLength(8);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps nodeId stable while text is typed into a block', async () => {
    await inject(harness, 'alpha\n\nbravo');
    const before = blocks(harness.api);
    atCaret(harness.editor, 0, 5, (sel) => sel.insertText(' typed'));
    const after = blocks(harness.api);
    expect(after[0].text).toBe('alpha typed');
    expect(after.map((b) => b.nodeId)).toEqual(before.map((b) => b.nodeId));
  });

  it('keeps the original nodeId on the surviving half when a block is split (Enter)', async () => {
    await inject(harness, 'alpha bravo\n\ntail');
    const before = blocks(harness.api);
    atCaret(harness.editor, 0, 5, (sel) => sel.insertParagraph());
    const after = blocks(harness.api);
    expect(after.map((b) => b.text)).toEqual(['alpha', ' bravo', 'tail']);
    expect(after[0].nodeId).toBe(before[0].nodeId);
    expect(after[2].nodeId).toBe(before[1].nodeId);
    expect(after[1].nodeId).not.toBe(before[0].nodeId);
    expect(new Set(after.map((b) => b.nodeId)).size).toBe(3);
  });

  it('keeps the surviving block nodeId when two blocks merge (Backspace at start)', async () => {
    await inject(harness, 'alpha\n\nbravo\n\ncharlie');
    const before = blocks(harness.api);
    atCaret(harness.editor, 1, 0, (sel) => sel.deleteCharacter(true));
    const after = blocks(harness.api);
    expect(after.map((b) => b.text)).toEqual(['alphabravo', 'charlie']);
    expect(after[0].nodeId).toBe(before[0].nodeId);
    expect(after[1].nodeId).toBe(before[2].nodeId);
  });

  it('assigns fresh unique nodeIds to pasted blocks without disturbing existing ones', async () => {
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

  it('survives a getJSON() → injectJSON() round trip (R-12.1, R-2.5)', async () => {
    await inject(harness, '# Title\n\nalpha\n\n> quoted');
    atCaret(harness.editor, 1, 5, (sel) => sel.insertText(' edited'));
    const before = blocks(harness.api);
    const json = harness.api.getJSON();

    await injectJSON(harness, json);

    expect(blocks(harness.api)).toEqual(before);
  });

  it('survives a reload into a second editor mount (stored JSON → new session)', async () => {
    await inject(harness, '# Title\n\nalpha\n\n> quoted');
    const before = blocks(harness.api);
    const json = harness.api.getJSON();

    const second = await mountEditor();
    await injectJSON(second, json);

    expect(blocks(second.api)).toEqual(before);
  });
});

/**
 * The LLD's `{ replace, with, withKlass }` shape, pinned so Unit 2 knows exactly
 * what it buys and what it costs. It DOES carry identity through a live editor,
 * but Lexical 0.40 forces the subclass to own a distinct `getType()` — see the
 * file header — so the serialized `type` is no longer the base string and
 * `MARKDOWN_SUPPORTED_NODE_TYPES` stops matching. R-2.2 and R-2.3 cannot both
 * hold.
 */
describe('LLD §2 alternative — node replacement subclass', () => {
  type SerializedIdParagraph = SerializedParagraphNode & { nodeId?: string };

  class IdParagraphNode extends ParagraphNode {
    __nodeId = nextNodeId();

    // NOT 'paragraph': the registry is keyed by type and LexicalNode's
    // constructor rejects a subclass registered under the base type.
    static getType() {
      return 'vs-paragraph';
    }

    static clone(node: IdParagraphNode): IdParagraphNode {
      const out = new IdParagraphNode(node.__key);
      out.__nodeId = node.__nodeId;
      return out;
    }

    static importJSON(json: SerializedIdParagraph): IdParagraphNode {
      return new IdParagraphNode().updateFromJSON(json);
    }

    updateFromJSON(json: SerializedIdParagraph): this {
      const self = super.updateFromJSON(json);
      if (json.nodeId) self.__nodeId = json.nodeId;
      return self;
    }

    exportJSON(): SerializedIdParagraph {
      return { ...super.exportJSON(), nodeId: this.__nodeId };
    }
  }

  /** The registration shape that actually loads. Both entries are required. */
  const registrations = [
    IdParagraphNode,
    { replace: ParagraphNode, with: () => new IdParagraphNode(), withKlass: IdParagraphNode },
  ];

  async function mountWithReplacement(): Promise<Harness> {
    let editor: LexicalEditor | null = null;
    const ext = headless.createExtension({
      name: 'vs-node-replacement',
      nodes: registrations,
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
          extraExtensions={[ext]}
          showDefaultContent={false}
            sourceMetadataMode="none"
          defaultEditorView="visual"
          isEditorViewTabsVisible={false}
          isToolbarEnabled={false}
        />,
      );
    });
    return { api: api!, editor: editor! };
  }

  function replacementBlocks(api: ExtensiveEditorRef) {
    const doc = JSON.parse(api.getJSON()) as { root: { children: Array<{ type: string; nodeId?: string }> } };
    return doc.root.children;
  }

  it('constructs editor-created nodes as the owned subclass and carries nodeId (R-2.2)', async () => {
    const h = await mountWithReplacement();
    await inject(h, 'alpha\n\nbravo');
    atCaret(h.editor, 1, 5, (sel) => sel.insertParagraph());
    h.editor.getEditorState().read(() => {
      for (const child of $getRoot().getChildren()) expect(child).toBeInstanceOf(IdParagraphNode);
    });
    const ids = replacementBlocks(h.api).map((b) => b.nodeId);
    expect(ids).toHaveLength(3);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });

  it('round-trips nodeId through getJSON() / injectJSON() (R-2.5)', async () => {
    const h = await mountWithReplacement();
    await inject(h, 'alpha\n\nbravo');
    const before = replacementBlocks(h.api).map((b) => b.nodeId);
    const json = h.api.getJSON();
    await injectJSON(h, json);
    expect(replacementBlocks(h.api).map((b) => b.nodeId)).toEqual(before);
  });

  it('COSTS the base type string — R-2.2 and R-2.3 are mutually exclusive', async () => {
    expect(IdParagraphNode.getType()).not.toBe('paragraph');
    const h = await mountWithReplacement();
    await inject(h, 'alpha');
    const types = replacementBlocks(h.api).map((b) => b.type);
    expect(types).toEqual(['vs-paragraph']);
    for (const t of types) expect(headless.MARKDOWN_SUPPORTED_NODE_TYPES.has(t)).toBe(false);
  });
});
