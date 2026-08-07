// @vitest-environment jsdom
/**
 * collab-editor.test.tsx — task 7.4 (R-2.11).
 *
 * **Written before `ui/collab-editor.tsx` existed**, because the risk this task
 * carries is not "can the editor be driven from JSON" — it obviously can — but
 * "does driving it from JSON report edits nobody made". `ui/wysiwyg-editor.tsx`
 * compares Markdown STRINGS (`md === lastSynced.current`, :136) and Markdown is a
 * lossy, normalizing projection, which is exactly what makes that comparison
 * stable: caret position, node keys and selection cannot survive into it.
 * `getJSON()` is lossless, so the naive port ("compare the whole `getJSON()`
 * output") produces false-dirty on things a reviewer does constantly — clicking
 * into a paragraph, arrowing through it, clicking the Comment pill.
 *
 * These tests therefore pin the *negative* space first: mount, select, arrow,
 * click — and assert nothing was reported as an edit. Then a real edit, to prove
 * the check is not vacuously "never dirty".
 *
 * Operations are driven through the live `LexicalEditor` (via the handle) rather
 * than synthesized keystrokes, for the reason task 0.1 recorded: jsdom has no
 * layout and no real contentEditable, so `beforeinput`/`keydown` never reach
 * Lexical's reconciler. DOM events are *also* dispatched where the point is that
 * the collaboration editor does not listen to them at all — that is the whole
 * difference from local mode's `keydown`/`pointerdown`-driven heuristics.
 */
import './prism-global'; // must precede @lyfie/luthor — sets the global Prism
import { headless } from '@lyfie/luthor';
import { act, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { $getRoot, $getSelection, $isElementNode, $isRangeSelection, $isTextNode, type RangeSelection } from 'lexical';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CollaborationDocument, JsonDocument } from '../core/collaboration/document-protocol';
import { reconcileDocumentIdentity } from '../core/collaboration/node-identity';
import { CollabEditor, INJECT_SETTLE_MS, collabDocumentSignature, type CollabEditorHandle } from './collab-editor';

// ---------------------------------------------------------------- jsdom gaps
// Same set the 0.1 harness installs: Luthor's toolbar and draggable-block
// extensions observe layout, and jsdom has neither observer nor matchMedia.
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
  // Arrow keys reach Lexical's own key handlers, which call `Selection.modify`
  // and measure the range; jsdom has neither, and Luthor's floating toolbar
  // measures the selection too.
  const zeroRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
  (Selection.prototype as unknown as { modify?: () => void }).modify ??= () => {};
  (Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect ??=
    zeroRect as unknown as () => DOMRect;
  (Range.prototype as unknown as { getClientRects?: () => DOMRect[] }).getClientRects ??= () => [];
  (Node.prototype as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect ??=
    zeroRect as unknown as () => DOMRect;
});

// --------------------------------------------------------------- fixtures

const MARKDOWN = '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\n> quoted';

/** A collaboration document whose blocks already carry stable, readable ids. */
function makeDocument(markdown = MARKDOWN): CollaborationDocument {
  let n = 0;
  return reconcileDocumentIdentity(
    {
      documentId: 'doc-1',
      documentPath: 'docs/fixture.md',
      title: 'Fixture',
      frontmatter: {},
      nodes: [],
      doc: headless.markdownToJSON(markdown) as JsonDocument,
    },
    { generateNodeId: () => `f${++n}` },
  ).document;
}

// --------------------------------------------------------------- harness

type Recorder = {
  handle: CollabEditorHandle;
  changes: JsonDocument[];
  dirtyEvents: boolean[];
  root: HTMLElement;
};

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/**
 * The load cannot be waited out with a fixed sleep: Luthor initializes the preset
 * asynchronously and does not call `onReady` for ~300 ms under jsdom, and only
 * then does the component's own inject (deferred one macrotask) and Luthor's
 * internal 100 ms defer start counting. Poll for the document instead.
 */
async function waitFor(predicate: () => boolean, label: string, deadlineMs = 8000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > deadlineMs) throw new Error(`timed out waiting for ${label}`);
    await tick(25);
  }
}

/** The injected document has landed once its first block carries its persisted id. */
function loaded(handle: CollabEditorHandle | null): boolean {
  if (!handle) return false;
  try {
    const first = (handle.readDocument().root as { children?: SerializedBlock[] }).children?.[0];
    return Boolean(first?.$?.nodeId);
  } catch {
    return false;
  }
}

/** Mount the collaboration editor and wait out the load and the baseline capture. */
async function mount(collabDoc: CollaborationDocument, options: { generateNodeId?: () => string } = {}): Promise<Recorder> {
  let handle: CollabEditorHandle | null = null;
  const changes: JsonDocument[] = [];
  const dirtyEvents: boolean[] = [];
  let container: HTMLElement | null = null;
  await act(async () => {
    const rendered = render(
      <CollabEditor
        document={collabDoc}
        generateNodeId={options.generateNodeId}
        onEditorReady={(h) => {
          handle = h;
        }}
        onDocumentChange={(doc) => changes.push(doc)}
        onDirtyChange={(d) => dirtyEvents.push(d)}
      />,
    );
    container = rendered.container as HTMLElement;
  });
  await waitFor(() => loaded(handle), 'the injected document to land');
  await tick(INJECT_SETTLE_MS + 50); // the baseline is taken INJECT_SETTLE_MS after the inject
  if (!handle) throw new Error('CollabEditor never called onEditorReady');
  if (!container) throw new Error('CollabEditor rendered nothing');
  return { handle, changes, dirtyEvents, root: container };
}

function update(rec: Recorder, fn: () => void): void {
  act(() => {
    rec.handle.editor.update(fn, { discrete: true });
  });
}

/**
 * Place the caret in top-level block `index` at `offset` and act on that
 * selection — in ONE update, since jsdom never gives the editor real DOM focus
 * and a selection set in one update does not survive into the next (0.1).
 */
function atCaret(rec: Recorder, index: number, offset: number, fn: (sel: RangeSelection) => void): void {
  update(rec, () => {
    const block = $getRoot().getChildAtIndex(index);
    if (!$isElementNode(block)) throw new Error(`block ${index} is not an element`);
    const text = block.getFirstDescendant();
    if ($isTextNode(text)) text.select(offset, offset);
    else block.select(offset, offset);
    const sel = $getSelection();
    if (!$isRangeSelection(sel)) throw new Error('expected a range selection');
    fn(sel);
  });
}

/** Select `from`–`to` inside top-level block `index` and act on that selection. */
function selectRange(rec: Recorder, index: number, from: number, to: number, fn: (sel: RangeSelection) => void): void {
  update(rec, () => {
    const block = $getRoot().getChildAtIndex(index);
    if (!$isElementNode(block)) throw new Error(`block ${index} is not an element`);
    const text = block.getFirstDescendant();
    if (!$isTextNode(text)) throw new Error(`block ${index} has no text`);
    text.select(from, to);
    const sel = $getSelection();
    if (!$isRangeSelection(sel)) throw new Error('expected a range selection');
    fn(sel);
  });
}

type SerializedBlock = { type: string; children?: unknown[]; $?: { nodeId?: string } };

/** `{ nodeId, type, text }` per top-level block of the LIVE editor state. */
function blocks(rec: Recorder): Array<{ nodeId?: string; type: string; text: string }> {
  const doc = rec.handle.readDocument() as unknown as { root: { children: SerializedBlock[] } };
  const text = (n: { text?: string; children?: unknown[] }): string =>
    typeof n.text === 'string'
      ? n.text
      : ((n.children ?? []) as Array<{ text?: string; children?: unknown[] }>).map(text).join('');
  return doc.root.children.map((c) => ({ nodeId: c.$?.nodeId, type: c.type, text: text(c) }));
}

/** Nothing was reported as an edit. */
function expectClean(rec: Recorder): void {
  expect(rec.handle.isDirty()).toBe(false);
  expect(rec.changes).toEqual([]);
  expect(rec.dirtyEvents.filter(Boolean)).toEqual([]);
}

let rec: Recorder;

beforeEach(async () => {
  rec = await mount(makeDocument());
});

// ----------------------------------------------------- the signature itself

describe('collabDocumentSignature — what dirty-detection compares (7.4)', () => {
  it('ignores the `$` NodeState key, so identity assignment is never an edit', () => {
    const a: JsonDocument = { root: { type: 'root', children: [{ type: 'paragraph', $: { nodeId: 'a' } }] } };
    const b: JsonDocument = { root: { type: 'root', children: [{ type: 'paragraph', $: { nodeId: 'b' } }] } };
    expect(collabDocumentSignature(a)).toBe(collabDocumentSignature(b));
  });

  it('ignores `direction`, which the reconciler derives from the text', () => {
    const a: JsonDocument = { root: { type: 'root', children: [{ type: 'paragraph', direction: null }] } };
    const b: JsonDocument = { root: { type: 'root', children: [{ type: 'paragraph', direction: 'ltr' }] } };
    expect(collabDocumentSignature(a)).toBe(collabDocumentSignature(b));
  });

  it('ignores key order', () => {
    const a: JsonDocument = { root: { type: 'root', children: [{ type: 'paragraph', format: '', indent: 0 }] } };
    const b: JsonDocument = { root: { type: 'root', children: [{ indent: 0, format: '', type: 'paragraph' }] } };
    expect(collabDocumentSignature(a)).toBe(collabDocumentSignature(b));
  });

  it('does NOT ignore text or formatting — a real edit changes the signature', () => {
    const a: JsonDocument = { root: { type: 'root', children: [{ type: 'text', text: 'hi', format: 0 }] } };
    const b: JsonDocument = { root: { type: 'root', children: [{ type: 'text', text: 'hi', format: 1 }] } };
    const c: JsonDocument = { root: { type: 'root', children: [{ type: 'text', text: 'ho', format: 0 }] } };
    expect(collabDocumentSignature(a)).not.toBe(collabDocumentSignature(b));
    expect(collabDocumentSignature(a)).not.toBe(collabDocumentSignature(c));
  });
});

// ------------------------------------------------------------- no false dirty

describe('no false-dirty (7.4 — the failure mode a naive getJSON() port produces)', () => {
  it('a load is not an edit', () => {
    expectClean(rec);
  });

  it('reports nothing during the deferred injectJSON window', async () => {
    const fresh = makeDocument();
    let handle: CollabEditorHandle | null = null;
    const changes: JsonDocument[] = [];
    await act(async () => {
      render(
        <CollabEditor
          document={fresh}
          onEditorReady={(h) => {
            handle = h;
          }}
          onDocumentChange={(doc) => changes.push(doc)}
        />,
      );
    });
    // Sample continuously from mount until the load has landed — at no point in
    // the window (editor created, inject issued, inject applied) is anything
    // reported as an edit.
    for (let i = 0; i < 400 && !loaded(handle); i++) {
      expect((handle as CollabEditorHandle | null)?.isDirty() ?? false).toBe(false);
      expect(changes).toEqual([]);
      await tick(5);
    }
    expect(handle).not.toBeNull();
    expect(loaded(handle)).toBe(true);
    // …and it is still clean once the baseline capture lands.
    await tick(INJECT_SETTLE_MS + 50);
    expect(handle!.isDirty()).toBe(false);
    expect(changes).toEqual([]);
  });

  it('a selection change is not an edit', () => {
    update(rec, () => {
      const block = $getRoot().getChildAtIndex(1);
      if (!$isElementNode(block)) throw new Error('expected an element');
      const text = block.getFirstDescendant();
      if ($isTextNode(text)) text.select(2, 8);
    });
    expectClean(rec);
  });

  it('moving the caret (arrow keys) is not an edit', () => {
    const content = rec.root.querySelector('.luthor-content-editable') as HTMLElement | null;
    expect(content).not.toBeNull();
    for (const key of ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowLeft']) {
      act(() => {
        content!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
      // …and the caret move the key would have produced, driven through Lexical.
      update(rec, () => {
        const block = $getRoot().getChildAtIndex(1);
        if (!$isElementNode(block)) throw new Error('expected an element');
        const text = block.getFirstDescendant();
        if ($isTextNode(text)) text.select(3, 3);
      });
    }
    expectClean(rec);
  });

  it('clicking the comment pill is not an edit', () => {
    const content = rec.root.querySelector('.luthor-content-editable') as HTMLElement | null;
    expect(content).not.toBeNull();
    // A live selection, as the pill requires (it preventDefaults mousedown to keep it).
    update(rec, () => {
      const block = $getRoot().getChildAtIndex(1);
      if (!$isElementNode(block)) throw new Error('expected an element');
      const text = block.getFirstDescendant();
      if ($isTextNode(text)) text.select(0, 5);
    });
    const pill = window.document.createElement('button');
    rec.root.appendChild(pill);
    act(() => {
      for (const type of ['pointerdown', 'mousedown', 'click', 'pointerup']) {
        pill.dispatchEvent(new MouseEvent(type, { bubbles: true }));
        content!.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }
      window.document.dispatchEvent(new Event('selectionchange'));
    });
    expectClean(rec);
  });

  it('re-applying the same content is not an edit (the signature, not the update count)', () => {
    atCaret(rec, 1, 5, (sel) => sel.insertText('X'));
    expect(rec.handle.isDirty()).toBe(true);
    // Remove the character again — back to the loaded content, so back to clean,
    // even though the editor has run two more updates since the baseline.
    selectRange(rec, 1, 5, 6, (sel) => sel.removeText());
    expect(blocks(rec)[1].text).toBe('First paragraph.');
    expect(rec.handle.isDirty()).toBe(false);
    expect(rec.dirtyEvents).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------- real edits

describe('real edits are reported (7.4 — the check is not vacuous)', () => {
  it('typing dirties the buffer and emits structured state, not a Markdown string', () => {
    atCaret(rec, 1, 16, (sel) => sel.insertText(' typed'));
    expect(rec.handle.isDirty()).toBe(true);
    expect(rec.dirtyEvents).toEqual([true]);
    expect(rec.changes.length).toBeGreaterThan(0);
    const last = rec.changes[rec.changes.length - 1];
    expect(typeof last).toBe('object');
    expect(last.root).toBeTypeOf('object');
    expect(blocks(rec)[1].text).toBe('First paragraph. typed');
  });

  it('markClean adopts the current state as the baseline (post-publish)', () => {
    atCaret(rec, 1, 16, (sel) => sel.insertText(' typed'));
    expect(rec.handle.isDirty()).toBe(true);
    act(() => rec.handle.markClean());
    expect(rec.handle.isDirty()).toBe(false);
    // …and the adopted state is the edited one: editing again dirties, and
    // restoring the ORIGINAL loaded content does not clean.
    atCaret(rec, 1, 22, (sel) => sel.insertText('!'));
    expect(rec.handle.isDirty()).toBe(true);
    selectRange(rec, 1, 16, 23, (sel) => sel.removeText());
    expect(blocks(rec)[1].text).toBe('First paragraph.');
    expect(rec.handle.isDirty()).toBe(true);
  });
});

// -------------------------------------------------------------- node identity

describe('nodeId survives a real mount → edit → getJSON() cycle (R-2.11, R-2.4)', () => {
  it('preserves the persisted ids through the mount', () => {
    const out = blocks(rec);
    expect(out.map((b) => b.type)).toEqual(['heading', 'paragraph', 'paragraph', 'quote']);
    expect(out.map((b) => b.nodeId)).toEqual(['f1', 'f2', 'f3', 'f4']);
  });

  it('gives an editor-created block a fresh, unique id and leaves the others alone', async () => {
    let n = 0;
    const fresh = await mount(makeDocument(), { generateNodeId: () => `new-${++n}` });
    atCaret(fresh, 1, 5, (sel) => sel.insertParagraph());
    const out = blocks(fresh);
    expect(out.map((b) => b.text)).toEqual(['Title', 'First', ' paragraph.', 'Second paragraph.', 'quoted']);
    const ids = out.map((b) => b.nodeId);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    // The surviving half keeps its id; the new block gets a generated one.
    expect(ids[1]).toBe('f2');
    expect(ids[2]).toMatch(/^new-\d+$/);
    expect(ids[3]).toBe('f3');
  });

  it('backfills a document that arrives with no ids at all (R-2.8)', async () => {
    let n = 0;
    const idless: CollaborationDocument = {
      documentId: 'doc-2',
      documentPath: 'docs/idless.md',
      title: '',
      frontmatter: {},
      nodes: [],
      doc: headless.markdownToJSON('alpha\n\nbravo') as JsonDocument,
    };
    const fresh = await mount(idless, { generateNodeId: () => `bf-${++n}` });
    expect(blocks(fresh).every((b) => Boolean(b.nodeId))).toBe(true);
    expect(fresh.handle.isDirty()).toBe(false); // a backfill is not an edit
  });
});

// ------------------------------------------------------- markdownSourceOfTruth

describe('the collaboration mount does not set markdownSourceOfTruth (0.1 finding 3)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (file: string) => readFileSync(resolve(here, file), 'utf8');

  it('never passes the flag', () => {
    // Comments are stripped so the prose above (which names the flag) cannot pass this.
    const source = read('collab-editor.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');
    expect(source).not.toContain('markdownSourceOfTruth');
  });

  it('detects the flag where it genuinely is set (local mode), so the check is not vacuous', () => {
    expect(read('wysiwyg-editor.tsx')).toContain('markdownSourceOfTruth');
  });

  it('proves it behaviourally: under the flag getJSON() re-parses Markdown and drops every id', () => {
    // markdownToJSON(getMarkdown()) is what Luthor substitutes for getJSON() under
    // the flag. Feeding it the live document shows exactly what would be lost.
    const live = rec.handle.readDocument();
    const reparsed = headless.markdownToJSON(headless.jsonToMarkdown(live, { metadataMode: 'none' })) as {
      root: { children: SerializedBlock[] };
    };
    expect(reparsed.root.children.every((c) => c.$?.nodeId === undefined)).toBe(true);
    expect(blocks(rec).every((b) => Boolean(b.nodeId))).toBe(true);
  });
});

// ------------------------------------------------------------------- publish

describe('publish payload comes from one read of live editor state (R-12.8)', () => {
  it('derives both artifacts from the live editor state at the moment of publish', () => {
    atCaret(rec, 1, 16, (sel) => sel.insertText(' typed'));
    const payload = rec.handle.publish();
    expect(payload.markdown).toContain('First paragraph. typed');
    expect(payload.json.root).toBeTypeOf('object');
    // The JSON artifact keeps identity; the Markdown one is write-only (R-2.10).
    const children = (payload.json as unknown as { root: { children: SerializedBlock[] } }).root.children;
    expect(children.every((c) => Boolean(c.$?.nodeId))).toBe(true);
  });

  it("carries the mounted document's frontmatter into the Markdown artifact", async () => {
    const doc = makeDocument();
    const withFrontmatter = await mount({ ...doc, frontmatter: { title: 'Fixture', tags: ['spec'] } });
    const payload = withFrontmatter.handle.publish();

    expect(payload.markdown.startsWith('---\ntitle: "Fixture"\ntags: ["spec"]\n---\n\n')).toBe(true);
    expect(payload.losses).toEqual([]);
    // The JSON artifact is unchanged by this — frontmatter lives in the envelope.
    expect(JSON.stringify(payload.json)).not.toContain('frontmatter');
  });

  it('emits no frontmatter fence for a document that has none', () => {
    // `rec` is mounted from `makeDocument()`, whose frontmatter is `{}`.
    expect(rec.handle.publish().markdown.startsWith('---')).toBe(false);
  });
});
