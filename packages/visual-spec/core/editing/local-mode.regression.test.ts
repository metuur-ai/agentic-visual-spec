/**
 * local-mode.regression.test.ts — GUARD TESTS. DO NOT RELAX.
 *
 * WHAT THIS PINS
 * --------------
 * The behaviour of visual-spec with **no collaboration configuration present**:
 * browsing files and folders, viewing a file, adding/editing/deleting comments
 * against a `CommentTarget`, building the apply prompt from the sidecar, and
 * resolving a comment anchor back to the rendered markdown. These are the
 * shipped product. Collaboration (GitHub PR-based documents) is additive; a
 * regression here is a worse outcome than collaboration never shipping.
 *
 * REQUIREMENT IDs (docs/ears/github-pr-collaborative-documents.md)
 * ---------------------------------------------------------------
 *   R-12.5 — a regression suite asserting local-mode comment resolution is
 *            unchanged by the collaboration feature.
 *   R-10.1 — directory browsing, markdown viewing, commenting and apply behave
 *            exactly as they do today when no collaboration config is present.
 *   R-10.2 — `/__vs/tree`, `/__vs/dir`, `/__vs/raw`, `/__vs/source`,
 *            `/__vs/upload`, `/__vs/apply` keep operating against local stores.
 *   R-10.3 — the on-disk format of `visual-spec-comments.json` is unchanged for
 *            local, non-collaborative documents.
 *   R-10.4 — legacy `{ file, anchor }` records are still upgraded on read.
 *   R-10.5 — no local-mode operation requires GitHub connectivity.
 *   R-10.6 — the collaboration document view is not the renderer for local
 *            markdown files.
 *
 * CONTRACT FOR FUTURE WORK
 * ------------------------
 * This file MUST stay green at every subsequent collaboration story (0.3, 1.x,
 * 2.x, 3.x, 4.x, 5.x, 6.1, 7.x, 8.x, 9.x, 11.x). If a collaboration change makes
 * one of these fail, the change is wrong — not the test. Story 7.3 (wiring the
 * shared `CommentPanel`/`IndicatorLayer` to `nodeId`) is the point of highest
 * risk: those components are shared with local mode.
 *
 * These are CHARACTERIZATION tests: they pin what the code does **today**, not
 * what it arguably should do. Cases marked `QUIRK` record behaviour that looks
 * like a latent bug; they are pinned deliberately and must not be "fixed" here.
 *
 * Convention: pure-function + source assertions, no jsdom (package convention —
 * see ui/anchor-resolver.test.ts). DOM-dependent resolution is exercised against
 * a minimal fake `ParentNode`, which is all `resolveMarkdownAnchors` requires.
 *
 * NOT DUPLICATED HERE (already covered, asserted below as an inventory):
 *   ui/anchor-resolver.test.ts        — rangeLines + resolver-delegation
 *   core/editing/comment-doc.test.ts  — doc CRUD, status/result round-trip
 *   core/vite/routes/comments.test.ts — the happy-path route lifecycle
 *   core/vite/tree-store.test.ts      — tree walk, ignores, kinds, traversal
 *   ui/indicator-layer.test.ts        — groupByStartLine + View-mode-only render
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApplyPrompt } from './apply-prompt';
import {
  type CommentDoc,
  type CommentRecord,
  DEFAULT_WORKFLOW,
  anchorLabelOf,
  openByPath,
  openByWorkflow,
  parseDoc,
  serializeDoc,
} from './comment-doc';
import { type CommentDocStore, handleCommentsRequest } from '../vite/routes/comments';
import { SURFACE_ID_RE, memorySurfaceStore } from '../vite/surface-store';
import { detectKind } from '../vite/tree-store';
import { groupByStartLine } from '../../ui/indicator-model';
import { resolveCodeAnchors, resolveMarkdownAnchors } from '../../ui/anchor-resolver';

function src(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');
}

function memoryStore(seed: CommentDoc = { version: 1, comments: [] }): CommentDocStore {
  let doc = seed;
  return {
    async read() {
      return doc;
    },
    async write(d) {
      doc = d;
    },
  };
}

const rec = (over: Partial<CommentRecord> = {}): CommentRecord => ({
  id: 'c-00000001',
  workflow: DEFAULT_WORKFLOW,
  target: { path: 'docs/a.md', kind: 'file' },
  comment: 'do the thing',
  status: 'open',
  ts: '2026-01-01T00:00:00.000Z',
  ...over,
});

/* ------------------------------------------------------------------ *
 * Minimal fake ParentNode — enough for resolveMarkdownAnchors /
 * resolveCodeAnchors. No jsdom (package convention).
 * ------------------------------------------------------------------ */
type FakeSpec = { loc?: string; line?: number; tag?: string; text?: string; id?: string };

function fakeEl(spec: FakeSpec) {
  return {
    id: spec.id ?? spec.loc ?? spec.text ?? String(spec.line ?? ''),
    tag: spec.tag ?? 'p',
    loc: spec.loc,
    line: spec.line,
    textContent: spec.text ?? '',
    getAttribute(name: string): string | null {
      if (name === 'data-vs-loc') return this.loc ?? null;
      if (name === 'data-line') return this.line != null ? String(this.line) : null;
      return null;
    },
  };
}

type FakeEl = ReturnType<typeof fakeEl>;

/** `withChildren: false` models a root that is not an Element (no `children`). */
function fakeRoot(specs: FakeSpec[], opts: { withChildren?: boolean } = {}) {
  const els = specs.map(fakeEl);
  const root: Record<string, unknown> = {
    querySelector(sel: string): FakeEl | null {
      const loc = /^\[data-vs-loc\^="(.*)"\]$/.exec(sel);
      if (loc) return els.find((e) => (e.loc ?? '').startsWith(loc[1]!)) ?? null;
      const line = /^\[data-line="(\d+)"\]$/.exec(sel);
      if (line) return els.find((e) => e.line === Number(line[1])) ?? null;
      return null;
    },
    querySelectorAll(sel: string): FakeEl[] {
      const tags = sel.split(',');
      return els.filter((e) => tags.includes(e.tag));
    },
  };
  if (opts.withChildren !== false) root.children = els;
  return root as unknown as ParentNode;
}

const idsOf = (els: unknown[]) => (els as unknown as FakeEl[]).map((e) => e.id);

/* ================================================================== *
 * R-10.1 / R-10.2 — browsing files and folders
 * ================================================================== */
describe('R-10.1/R-10.2 — browsing files and folders (local stores only)', () => {
  const serverSrc = src('../../src/server.ts');
  const pluginSrc = src('../vite/md-plugin.ts');

  it('both hosts route every local browsing endpoint', () => {
    for (const route of ['/__vs/tree', '/__vs/dir', '/__vs/raw', '/__vs/source', '/__vs/upload', '/__vs/apply', '/__vs/comments']) {
      expect(serverSrc, `server.ts must keep ${route}`).toContain(route);
      expect(pluginSrc, `md-plugin.ts must keep ${route}`).toContain(route);
    }
  });

  it('browsing is served by the local treeStore, not a document store', () => {
    expect(serverSrc).toMatch(/treeStore\(/);
    expect(pluginSrc).toMatch(/treeStore\(/);
    // The tree/raw handlers take a TreeStore; nothing else may be substituted.
    expect(serverSrc).toContain('handleTree(');
    expect(pluginSrc).toContain('handleTree(');
  });

  it('the tree API shape is unchanged: dirs have no kind, files carry a kind', () => {
    // detectKind is the only classifier the tree walk uses (tree-store.test.ts
    // pins the walk itself; this pins the classification contract it depends on).
    expect(detectKind('spec.md')).toBe('markdown');
    expect(detectKind('spec.markdown')).toBe('markdown');
    expect(detectKind('app.tsx')).toBe('code');
    expect(detectKind('photo.jpeg')).toBe('image');
    expect(detectKind('blob.wasm')).toBe('binary');
  });

  it('folder targets are addressable by path with kind "folder"', () => {
    const doc: CommentDoc = { version: 1, comments: [rec({ id: 'c-f1', target: { path: 'docs/ears', kind: 'folder' } })] };
    expect(openByPath(doc)['docs/ears']).toHaveLength(1);
    expect(anchorLabelOf(doc.comments[0]!)).toBe('docs/ears');
  });
});

/* ================================================================== *
 * R-10.2 / R-10.6 — viewing a file
 * ================================================================== */
describe('R-10.2/R-10.6 — viewing a file (source route + markdown surface)', () => {
  const surfaceStoreSrc = src('../vite/surface-store.ts');
  const markdownSurfaceSrc = src('../../ui/markdown-surface.tsx');

  it('a surface id is a single path segment — traversal is rejected', () => {
    expect(SURFACE_ID_RE.test('post-it_notes1')).toBe(true);
    expect(SURFACE_ID_RE.test('../etc/passwd')).toBe(false);
    expect(SURFACE_ID_RE.test('a/b')).toBe(false);
    expect(SURFACE_ID_RE.test('')).toBe(false);
    expect(SURFACE_ID_RE.test('-leading-dash')).toBe(false);
  });

  it('SurfaceStore keeps its read/write/list text contract', async () => {
    const store = memorySurfaceStore({ intro: '# hello' });
    expect(await store.read('intro')).toBe('# hello');
    await store.write('intro', '# hi');
    expect(await store.read('intro')).toBe('# hi');
    expect(await store.list()).toEqual(['intro']);
    await expect(store.read('nope')).rejects.toThrow(/surface not found/);
  });

  it('the surface store is text-only — it has no document/JSON node surface', () => {
    expect(surfaceStoreSrc).not.toMatch(/JsonDocument|documentId|nodeId/);
  });

  it('R-10.6 — local markdown is rendered by react-markdown with data-vs-loc, not a collaboration renderer', () => {
    expect(markdownSurfaceSrc).toContain("from 'react-markdown'");
    expect(markdownSurfaceSrc).toContain('data-inspector-root');
    expect(markdownSurfaceSrc).toContain('data-vs-loc');
    // A collaboration renderer stamps data-vs-node-id / data-vs-document-id (R-7.3).
    // Those must never appear on the local markdown surface.
    expect(markdownSurfaceSrc).not.toContain('data-vs-node-id');
    expect(markdownSurfaceSrc).not.toContain('data-vs-document-id');
  });
});

/* ================================================================== *
 * R-10.1 / R-10.3 — commenting through /__vs/comments
 * ================================================================== */
describe('R-10.1/R-10.3 — add / edit / delete against CommentTarget', () => {
  it('add: a file target (no line) is kind "file"', async () => {
    const store = memoryStore();
    const res = await handleCommentsRequest(store, 'POST', '/add', {}, { path: 'src/app.ts', comment: 'rename this' }, () => 'T0');
    expect(res.status).toBe(200);
    const [c] = (await store.read()).comments;
    expect(c!.target).toEqual({ path: 'src/app.ts', kind: 'file' });
    expect(c!.workflow).toBe(DEFAULT_WORKFLOW);
    expect(c!.status).toBe('open');
    expect(c!.ts).toBe('T0');
    expect(c!.id).toMatch(/^c-[a-f0-9]{8}$/);
  });

  it('add: a startLine with no explicit kind becomes kind "range"', async () => {
    const store = memoryStore();
    await handleCommentsRequest(store, 'POST', '/add', {}, { path: 'a.md', startLine: 7, snippet: 'x', heading: 'H', comment: 'c' });
    expect((await store.read()).comments[0]!.target).toEqual({
      path: 'a.md',
      kind: 'range',
      startLine: 7,
      snippet: 'x',
      heading: 'H',
    });
  });

  it('add: a folder target drops every line field', async () => {
    const store = memoryStore();
    await handleCommentsRequest(store, 'POST', '/add', {}, { path: 'docs', kind: 'folder', startLine: 3, snippet: 's', comment: 'c' });
    expect((await store.read()).comments[0]!.target).toEqual({ path: 'docs', kind: 'folder' });
  });

  it('add: snippet and endSnippet are truncated at 160 chars', async () => {
    const store = memoryStore();
    const long = 'z'.repeat(400);
    await handleCommentsRequest(store, 'POST', '/add', {}, { path: 'a.md', startLine: 1, endLine: 4, snippet: long, endSnippet: long, comment: 'c' });
    const t = (await store.read()).comments[0]!.target;
    expect(t.snippet).toHaveLength(160);
    expect(t.endSnippet).toHaveLength(160);
  });

  it('add: legacy `selection: "range"` with no endSnippet yields an EMPTY endSnippet', async () => {
    // QUIRK (pinned, not a fix): `req.endSnippet ?? ''` writes an empty string
    // rather than omitting the field. Downstream (apply-prompt) treats "" as
    // falsy, so it is inert — but it does land in visual-spec-comments.json.
    const store = memoryStore();
    await handleCommentsRequest(store, 'POST', '/add', {}, { path: 'a.md', startLine: 1, selection: 'range', comment: 'c' });
    expect((await store.read()).comments[0]!.target.endSnippet).toBe('');
  });

  it('add: an explicit kind "file" DISCARDS a supplied startLine', async () => {
    // QUIRK (pinned): buildTarget short-circuits for any non-range kind, so line
    // anchoring is silently dropped when the client sends kind:"file" + startLine.
    const store = memoryStore();
    await handleCommentsRequest(store, 'POST', '/add', {}, { path: 'a.md', kind: 'file', startLine: 9, comment: 'c' });
    expect((await store.read()).comments[0]!.target).toEqual({ path: 'a.md', kind: 'file' });
  });

  it('add: a missing target path is a 400, not a throw', async () => {
    const store = memoryStore();
    const res = await handleCommentsRequest(store, 'POST', '/add', {}, { comment: 'c' });
    expect(res).toEqual({ status: 400, json: { error: 'missing target path' } });
    expect((await store.read()).comments).toHaveLength(0);
  });

  it('list: `path` wins over the legacy `file` query param', async () => {
    const store = memoryStore({
      version: 1,
      comments: [rec({ id: 'c-a', target: { path: 'a.md', kind: 'file' } }), rec({ id: 'c-b', target: { path: 'b.md', kind: 'file' } })],
    });
    const byPath = await handleCommentsRequest(store, 'GET', '', { path: 'b.md', file: 'a.md' }, {});
    expect((byPath.json as CommentRecord[]).map((c) => c.id)).toEqual(['c-b']);
    const all = await handleCommentsRequest(store, 'GET', '', {}, {});
    expect((all.json as CommentRecord[])).toHaveLength(2);
    const whole = await handleCommentsRequest(store, 'GET', '/all', {}, {});
    expect(whole.json).toMatchObject({ version: 1 });
  });

  it('edit: PATCH sets status and result; DELETE removes by id', async () => {
    const store = memoryStore({ version: 1, comments: [rec({ id: 'c-abc12345' })] });
    await handleCommentsRequest(store, 'PATCH', '/c-abc12345', {}, { status: 'applied', result: 'done' });
    expect((await store.read()).comments[0]).toMatchObject({ status: 'applied', result: 'done' });
    const del = await handleCommentsRequest(store, 'DELETE', '/c-abc12345', {}, {});
    expect(del.json).toEqual({ ok: true });
    expect((await store.read()).comments).toHaveLength(0);
  });

  it('edit/delete: only `c-<hex>` ids are routed; anything else is a 404', async () => {
    const store = memoryStore();
    const res = await handleCommentsRequest(store, 'DELETE', '/not-an-id', {}, {});
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'no route: DELETE /__vs/comments/not-an-id' });
  });

  it('delete of an unknown id is a silent no-op success', async () => {
    const store = memoryStore({ version: 1, comments: [rec({ id: 'c-aaaaaaaa' })] });
    const res = await handleCommentsRequest(store, 'DELETE', '/c-bbbbbbbb', {}, {});
    expect(res).toEqual({ status: 200, json: { ok: true } });
    expect((await store.read()).comments).toHaveLength(1);
  });

  it('PATCH with no status writes an UNDEFINED status onto the record', async () => {
    // QUIRK (pinned, suspected bug): `body.status as CommentStatus` is unchecked,
    // so a PATCH without a status blanks the field. The record then serializes
    // with no `status` key and parseDoc reads it back as undefined, so it is
    // neither "open" nor "applied" and disappears from every grouping.
    const store = memoryStore({ version: 1, comments: [rec({ id: 'c-abc12345' })] });
    await handleCommentsRequest(store, 'PATCH', '/c-abc12345', {}, {});
    const after = await store.read();
    expect(after.comments[0]!.status).toBeUndefined();
    expect(serializeDoc(after)).not.toContain('"status"');
    expect(openByPath(after)).toEqual({});
  });

  it('R-10.3 — the on-disk format is `{ version: 1, comments: [...] }`, 2-space JSON, trailing newline', () => {
    const doc: CommentDoc = { version: 1, comments: [rec({ target: { path: 'a.md', kind: 'range', startLine: 3, snippet: 's', heading: 'H' } })] };
    const text = serializeDoc(doc);
    expect(text.startsWith('{\n  "version": 1,\n  "comments": [\n')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    expect(parseDoc(text)).toEqual(doc);
    // The record keys a local sidecar may carry — no collaboration fields.
    expect(Object.keys(JSON.parse(text).comments[0])).toEqual(['id', 'workflow', 'target', 'comment', 'status', 'ts']);
    expect(text).not.toMatch(/documentId|nodeId|nodeVersion|github/);
  });

  it('R-10.3 — unknown fields on a new-shape record survive a read/write round-trip', () => {
    const raw = JSON.stringify({ version: 1, comments: [{ ...rec(), somethingNew: 42 }] });
    const parsed = parseDoc(raw) as unknown as { comments: Array<Record<string, unknown>> };
    expect(parsed.comments[0]!.somethingNew).toBe(42);
  });

  it('grouping by path and by workflow ignores non-open comments', () => {
    const doc: CommentDoc = {
      version: 1,
      comments: [
        rec({ id: 'c-1', target: { path: 'a.md', kind: 'file' } }),
        rec({ id: 'c-2', target: { path: 'a.md', kind: 'file' }, workflow: 'research' }),
        rec({ id: 'c-3', target: { path: 'a.md', kind: 'file' }, status: 'applied' }),
      ],
    };
    expect(openByPath(doc)['a.md']!.map((c) => c.id)).toEqual(['c-1', 'c-2']);
    expect(Object.keys(openByWorkflow(doc)).sort()).toEqual(['research', 'visual-spec']);
  });
});

/* ================================================================== *
 * R-10.1 / R-10.4 — the apply flow
 * ================================================================== */
describe('R-10.1/R-10.4(apply) — buildApplyPrompt reads the sidecar', () => {
  const applyRouteSrc = src('../vite/routes/apply.ts');

  it('names visual-spec-comments.json as the source of truth', () => {
    expect(buildApplyPrompt([rec()])).toContain('Source of truth is visual-spec-comments.json.');
  });

  it('the prompt never references GitHub, a PR, or a collaboration document', () => {
    const prompt = buildApplyPrompt([
      rec({ target: { path: 'a.md', kind: 'range', startLine: 3, endLine: 9, snippet: 'from', endSnippet: 'through', heading: 'H' } }),
      rec({ id: 'c-2', target: { path: 'docs', kind: 'folder' }, workflow: 'research' }),
    ]);
    expect(prompt).not.toMatch(/github|pull request|\bPR\b|documentId|nodeId/i);
  });

  it('renders a folder target as "Folder:" with no Where/Context lines', () => {
    const prompt = buildApplyPrompt([rec({ target: { path: 'docs/ears', kind: 'folder' }, workflow: 'research' })]);
    expect(prompt).toContain('1. [research] Folder: docs/ears');
    expect(prompt).not.toContain('Where:');
  });

  it('renders a whole-file target as "whole file"', () => {
    expect(buildApplyPrompt([rec()])).toContain('Where: whole file');
  });

  it('renders a single-line target as "line N" with a Context snippet', () => {
    const prompt = buildApplyPrompt([rec({ target: { path: 'a.md', kind: 'range', startLine: 12, snippet: 'the line', heading: 'Intro' } })]);
    expect(prompt).toContain('Where: Intro · line 12');
    expect(prompt).toContain('Context: "the line"');
  });

  it('renders a multi-line target as "lines A–B" with From/Through snippets', () => {
    const prompt = buildApplyPrompt([
      rec({ target: { path: 'a.md', kind: 'range', startLine: 12, endLine: 20, snippet: 'start', endSnippet: 'end' } }),
    ]);
    expect(prompt).toContain('Where: lines 12–20');
    expect(prompt).toContain('From: "start"');
    expect(prompt).toContain('Through: "end"');
  });

  it('an endLine equal to startLine is NOT treated as a range', () => {
    const prompt = buildApplyPrompt([rec({ target: { path: 'a.md', kind: 'range', startLine: 5, endLine: 5, snippet: 's' } })]);
    expect(prompt).toContain('Where: line 5');
    expect(prompt).toContain('Context: "s"');
  });

  it('the comment count in the header matches the manifest', () => {
    const prompt = buildApplyPrompt([rec({ id: 'c-1' }), rec({ id: 'c-2' })]);
    expect(prompt).toContain('Apply 2 review comment(s)');
    expect(prompt).toContain('Comments (2):');
  });

  it('the apply run feeds buildApplyPrompt from open sidecar comments only', () => {
    expect(applyRouteSrc).toContain("import { buildApplyPrompt } from '../../editing/apply-prompt'");
    expect(applyRouteSrc).toMatch(/c\.status === 'open'/);
    expect(applyRouteSrc).toMatch(/spawnClaude\(buildApplyPrompt\(open\), deps\.cwd\)/);
  });
});

/* ================================================================== *
 * R-10.5 — comment resolution (resolveMarkdownAnchors), incl. degraded cases
 * ================================================================== */
describe('R-10.5 — resolveMarkdownAnchors: file / folder / range anchors', () => {
  it('a file-kind anchor (no startLine) resolves to nothing', () => {
    expect(resolveMarkdownAnchors({}, fakeRoot([{ loc: '1:0' }]))).toEqual([]);
    expect(resolveMarkdownAnchors({ heading: 'H' }, fakeRoot([{ loc: '1:0', tag: 'h2', text: 'H' }]))).toEqual([]);
  });

  it('a folder-kind anchor (no startLine, no heading) resolves to nothing', () => {
    expect(resolveMarkdownAnchors({ heading: null }, fakeRoot([{ loc: '1:0' }]))).toEqual([]);
  });

  it('a null root resolves to nothing rather than throwing', () => {
    expect(resolveMarkdownAnchors({ startLine: 3 }, null)).toEqual([]);
  });

  it('an exact start line resolves to that block', () => {
    const root = fakeRoot([{ loc: '1:0' }, { loc: '12:0' }, { loc: '30:0' }]);
    expect(idsOf(resolveMarkdownAnchors({ startLine: 12 }, root))).toEqual(['12:0']);
  });

  it('line matching is prefix-on-"N:" — line 1 does not match block 12', () => {
    const root = fakeRoot([{ loc: '12:0' }]);
    expect(resolveMarkdownAnchors({ startLine: 1 }, root)).toEqual([]);
  });

  it('DEGRADED: a drifted line falls back to a heading-text match', () => {
    const root = fakeRoot([
      { loc: '5:0', tag: 'h2', text: 'Acceptance Criteria' },
      { loc: '9:0', tag: 'p', text: 'body' },
    ]);
    expect(idsOf(resolveMarkdownAnchors({ startLine: 42, heading: 'Acceptance Criteria' }, root))).toEqual(['5:0']);
  });

  it('DEGRADED: heading matching trims whitespace and is exact (not substring)', () => {
    const root = fakeRoot([{ loc: '5:0', tag: 'h3', text: '  Acceptance Criteria  ' }]);
    expect(idsOf(resolveMarkdownAnchors({ startLine: 42, heading: 'Acceptance Criteria' }, root))).toEqual(['5:0']);
    expect(resolveMarkdownAnchors({ startLine: 42, heading: 'Acceptance' }, root)).toEqual([]);
  });

  it('UNRESOLVABLE: a drifted line with no heading resolves to nothing', () => {
    expect(resolveMarkdownAnchors({ startLine: 42 }, fakeRoot([{ loc: '5:0' }]))).toEqual([]);
  });

  it('UNRESOLVABLE: a drifted line whose heading is gone resolves to nothing', () => {
    const root = fakeRoot([{ loc: '5:0', tag: 'h2', text: 'Something Else' }]);
    expect(resolveMarkdownAnchors({ startLine: 42, heading: 'Acceptance Criteria' }, root)).toEqual([]);
  });

  it('a range extends across sibling blocks within (startLine, endLine]', () => {
    const root = fakeRoot([{ loc: '3:0' }, { loc: '10:0' }, { loc: '12:0' }, { loc: '20:0' }, { loc: '25:0' }]);
    expect(idsOf(resolveMarkdownAnchors({ startLine: 10, endLine: 20 }, root))).toEqual(['10:0', '12:0', '20:0']);
  });

  it('an endLine not greater than startLine collapses to a single block', () => {
    const root = fakeRoot([{ loc: '10:0' }, { loc: '12:0' }]);
    expect(idsOf(resolveMarkdownAnchors({ startLine: 10, endLine: 10 }, root))).toEqual(['10:0']);
    expect(idsOf(resolveMarkdownAnchors({ startLine: 10, endLine: 4 }, root))).toEqual(['10:0']);
  });

  it('siblings with an absent or non-numeric data-vs-loc are skipped, not thrown on', () => {
    const root = fakeRoot([{ loc: '10:0' }, { id: 'no-loc' }, { loc: 'bogus', id: 'bogus' }, { loc: '15:0' }]);
    expect(idsOf(resolveMarkdownAnchors({ startLine: 10, endLine: 20 }, root))).toEqual(['10:0', '15:0']);
  });

  it('a root without `children` yields only the start block, even for a range', () => {
    const root = fakeRoot([{ loc: '10:0' }, { loc: '12:0' }], { withChildren: false });
    expect(idsOf(resolveMarkdownAnchors({ startLine: 10, endLine: 20 }, root))).toEqual(['10:0']);
  });

  it('DEGRADED: after a heading fallback, range extension still uses the STALE startLine', () => {
    // QUIRK (pinned, not a fix): the heading fallback recovers the start element
    // but not its real line, so the sibling sweep filters on the drifted
    // startLine/endLine window. Here the heading really sits at line 5 but the
    // sweep only admits blocks in (42, 50] — the intervening prose is dropped.
    const root = fakeRoot([
      { loc: '5:0', tag: 'h2', text: 'H' },
      { loc: '7:0' },
      { loc: '45:0' },
    ]);
    expect(idsOf(resolveMarkdownAnchors({ startLine: 42, endLine: 50, heading: 'H' }, root))).toEqual(['5:0', '45:0']);
  });

  it('resolveCodeAnchors returns one row per line and skips missing rows', () => {
    const root = fakeRoot([{ line: 4 }, { line: 6 }]);
    expect(idsOf(resolveCodeAnchors(4, 6, root))).toEqual(['4', '6']);
    expect(resolveCodeAnchors(4, 6, null)).toEqual([]);
    expect(resolveCodeAnchors(99, undefined, root)).toEqual([]);
  });

  it('inline indicators group only line-anchored comments (file/folder targets have no anchor)', () => {
    const groups = groupByStartLine([
      rec({ id: 'c-1', target: { path: 'a.md', kind: 'range', startLine: 5, heading: 'H' } }),
      rec({ id: 'c-2', target: { path: 'a.md', kind: 'file' } }),
      rec({ id: 'c-3', target: { path: 'docs', kind: 'folder' } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ line: 5, heading: 'H' });
  });
});

/* ================================================================== *
 * R-10.4 — legacy { file, anchor } upgrade on read
 * ================================================================== */
describe('R-10.4 — legacy { file, anchor } upgrades to CommentTarget', () => {
  const legacy = (over: Record<string, unknown> = {}) =>
    parseDoc(JSON.stringify({ version: 1, comments: [{ id: 'c-legacy1', file: 'tasks/notes', comment: 'c', status: 'open', ts: 'T', ...over }] }))
      .comments[0]!;

  it('a surface id (no extension) gains a .md suffix', () => {
    expect(legacy().target).toEqual({ path: 'tasks/notes.md', kind: 'file' });
  });

  it('a file that already ends in .md is left alone', () => {
    expect(legacy({ file: 'tasks/notes.md' }).target.path).toBe('tasks/notes.md');
  });

  it('a non-markdown legacy path also gains .md', () => {
    // QUIRK (pinned): the upgrader assumes every legacy record is a markdown
    // surface id, so "src/app.ts" becomes "src/app.ts.md". Legacy records only
    // ever came from the markdown viewer, so this is inert in practice.
    expect(legacy({ file: 'src/app.ts' }).target.path).toBe('src/app.ts.md');
  });

  it('an empty/missing file yields an empty path with kind "file"', () => {
    expect(legacy({ file: undefined }).target).toEqual({ path: '', kind: 'file' });
  });

  it('an anchor with a line becomes kind "range" + startLine + snippet + heading', () => {
    expect(legacy({ anchor: { line: 42, snippet: 'The user can pin', heading: 'Acceptance' } }).target).toEqual({
      path: 'tasks/notes.md',
      kind: 'range',
      startLine: 42,
      snippet: 'The user can pin',
      heading: 'Acceptance',
    });
  });

  it('`selection: "range"` carries endLine + endSnippet across', () => {
    expect(legacy({ anchor: { line: 3, selection: 'range', endLine: 9, endSnippet: 'tail' } }).target).toMatchObject({
      kind: 'range',
      startLine: 3,
      endLine: 9,
      endSnippet: 'tail',
    });
  });

  it('a null heading is preserved (it is meaningful: "no heading above")', () => {
    expect(legacy({ anchor: { line: 3, heading: null } }).target.heading).toBeNull();
  });

  it('an anchor with no line stays kind "file" and keeps its heading', () => {
    expect(legacy({ anchor: { heading: 'Intro' } }).target).toEqual({ path: 'tasks/notes.md', kind: 'file', heading: 'Intro' });
  });

  it('a legacy record with no workflow gets the default workflow', () => {
    expect(legacy().workflow).toBe(DEFAULT_WORKFLOW);
    expect(legacy({ workflow: 'research' }).workflow).toBe('research');
  });

  it('optional fields are only emitted when present', () => {
    expect(Object.keys(legacy())).toEqual(['id', 'workflow', 'target', 'comment', 'status', 'ts']);
    expect(Object.keys(legacy({ selectedContent: 'sel', spec: 'EARS', result: 'r' }))).toContain('selectedContent');
  });

  it('a missing status defaults to "open" and a missing ts to ""', () => {
    const r = legacy({ status: undefined, ts: undefined });
    expect(r.status).toBe('open');
    expect(r.ts).toBe('');
  });

  it('a new-shape record is passed through untouched apart from a default workflow', () => {
    const doc = parseDoc(JSON.stringify({ version: 1, comments: [{ id: 'c-1', target: { path: 'a.md', kind: 'file' }, comment: 'c', status: 'open', ts: 'T' }] }));
    expect(doc.comments[0]).toEqual({ id: 'c-1', workflow: DEFAULT_WORKFLOW, target: { path: 'a.md', kind: 'file' }, comment: 'c', status: 'open', ts: 'T' });
  });

  it('a legacy sidecar upgraded on read is written back in the current shape', () => {
    const upgraded = parseDoc(JSON.stringify({ version: 1, comments: [{ id: 'c-1', file: 'a', anchor: { line: 2 }, comment: 'c', status: 'open', ts: 'T' }] }));
    expect(parseDoc(serializeDoc(upgraded))).toEqual(upgraded);
  });
});

/* ================================================================== *
 * R-10.5 — no GitHub connectivity on any local path
 * ================================================================== */
describe('R-10.5 — local mode requires no GitHub connectivity', () => {
  const localModules = [
    'comment-doc.ts',
    'apply-prompt.ts',
    '../vite/routes/comments.ts',
    '../vite/routes/apply.ts',
    '../vite/tree-store.ts',
    '../vite/surface-store.ts',
    '../app/lib/use-comments.ts',
    '../../ui/anchor-resolver.ts',
    '../../ui/indicator-model.ts',
    '../../ui/indicator-layer.tsx',
  ];

  it('no module on the local path mentions GitHub, `gh`, or a collaboration identity', () => {
    for (const mod of localModules) {
      const text = src(`./${mod}`);
      expect(text, `${mod} must stay GitHub-free`).not.toMatch(/github|octokit|pullNumber|headSha|issueCommentId/i);
      expect(text, `${mod} must stay collaboration-free`).not.toMatch(/documentId|nodeVersion/);
    }
  });

  it('the local comment path keys off `target.path`, never a nodeId', () => {
    expect(src('../app/lib/use-comments.ts')).toMatch(/\?path=\$\{encodeURIComponent\(path\)\}/);
    expect(src('./comment-doc.ts')).toMatch(/c\.target\.path === path/);
    expect(src('../../ui/indicator-model.ts')).toMatch(/c\.target\.startLine/);
  });

  it('the local comment API surface is exactly the four /__vs/comments calls', () => {
    const hook = src('../app/lib/use-comments.ts');
    expect(hook).toContain('fetch(`/__vs/comments${q}`)');
    expect(hook).toContain("fetch('/__vs/comments/add'");
    expect(hook).toContain('fetch(`/__vs/comments/${id}`, { method: \'DELETE\' })');
    expect(hook).not.toContain('/__vs/collab');
  });
});

/* ================================================================== *
 * R-12.5 — coverage inventory: the pre-existing guards must not vanish
 * ================================================================== */
describe('R-12.5 — pre-existing local-mode coverage still exists', () => {
  const files: Array<[string, RegExp[]]> = [
    ['../../ui/anchor-resolver.test.ts', [/rangeLines/, /resolveMarkdownAnchors/, /resolveCodeAnchors/]],
    ['./comment-doc.test.ts', [/upgrades legacy \{file, anchor\} records on read/, /round-trips through serialize/]],
    ['../vite/routes/comments.test.ts', [/add \(legacy md body\)/, /folder \+ range targets/]],
    ['../vite/tree-store.test.ts', [/walks the tree/, /rejects path traversal/]],
    ['../../ui/indicator-layer.test.ts', [/groupByStartLine/, /View mode only/]],
    ['./apply-prompt.test.ts', [/buildApplyPrompt/]],
  ];

  it.each(files)('%s still carries its local-mode assertions', (file, patterns) => {
    const text = src(`./${file}`);
    for (const p of patterns) expect(text).toMatch(p);
  });
});
