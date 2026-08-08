# `.mdj` Markdown-JSON Documents — Low-Level Design

> **RETIRED — never implemented. Do not build from this document.**
>
> Its premise was that `.mdj` holds the JSON document envelope. That envelope is
> retired; Markdown is now the only document format. See
> `docs/ears/github-pr-collaborative-documents.md`, Unit 0.

## Architecture

### The format

`.mdj` is not a new schema. An `.mdj` file holds exactly the envelope
`core/collaboration/document-protocol.ts` already defines and round-trips:

```
{ documentId, documentPath, title, frontmatter, nodes, doc: { root } }
```

Reads and writes go through `parseCollaborationDocument` /
`serializeCollaborationDocument`, so unknown envelope and node fields survive
untouched (R-1.8). The extension is a *routing* signal, nothing more.

### Classification — where the kind is decided

`core/vite/tree-store.ts` grows a sixth `FileKind`: `document`.

- `detectKind(name)` returns `document` for `.mdj`. `.json` keeps returning `code`.
  This is the cheap, name-only answer, and it is what the tree walk serves — no
  file is read to build the sidebar.
- `file(path)` — which reads content anyway — applies the fallback: a `.json` whose
  parsed body has a string `documentId` **and** an object `doc.root` is served as
  `kind: 'document'`. Anything that fails to parse, or parses without that shape,
  stays `code`. This mirrors the existing text→binary downgrade on read, and the
  existing comment on `detectKind` ("tentative kind by name; `file()` may
  downgrade") already describes the contract.

Consequence, stated so nobody treats it as a bug: an unrenamed `documents/*.json`
shows a code icon in the sidebar and renders as a document once opened. Only `.mdj`
is classifiable without a read. The sniff is a compatibility ramp, not the design.

### Viewer routing

`App.tsx` currently branches on `selected.kind === 'markdown'`. It gains a parallel
branch for `kind === 'document'` → the document surface. Because a sniffed `.json`
is not known to be a document until it is read, `GenericEditor` also delegates: when
the `FileContent` it fetched comes back `kind: 'document'`, it renders the document
surface instead of `CodeView`. One component, two entry points.

The document surface is a new `ui/document-editor.tsx` that composes existing parts:

- **view mode** — `CollabDocumentView` (`ui/collab-document-view.tsx`), unchanged. It
  already walks `doc.root` and stamps `data-vs-document-id` / `data-vs-node-id` /
  `data-vs-node-version`, which is exactly what block-level commenting anchors on.
- **edit mode** — `CollabEditor` (`ui/collab-editor.tsx`), unchanged, plus a save.
- The view/edit toggle is the existing `MainHeader` toggle, extended from
  "markdown only" to "markdown or document".

The two modes stay mutually exclusive for the reason `collab-app.tsx` already
documents: the live Lexical tree does not carry `data-vs-node-id` in the DOM, so a
comment panel mounted beside the editor would have anchors that silently fail.

### Persistence — a path-addressed store

The existing `fsDocumentStore(baseDir)` addresses documents by **id**, resolving
`documents/<id>.mdj`. A `.mdj` anywhere in the tree has no id-derived location, so a
sibling is added rather than the existing contract bent:

```ts
// core/collaboration/document-file-store.ts
export interface DocumentFileStore {
  read(path: string): Promise<CollaborationDocument | null>;
  write(path: string, doc: CollaborationDocument): Promise<void>;
  create(path: string, seed: { title?: string }): Promise<CollaborationDocument>;
}
```

Path guarding reuses the same rule `tree-store.resolve()` applies (posix-relative to
the base dir, no traversal, must stay inside). `fsDocumentStore` is left alone; it
keeps serving the id-addressed collaboration path.

New routes, in the same hand-rolled style as the rest of `/__vs`:

| Route                             | Purpose                                             |
| --------------------------------- | --------------------------------------------------- |
| `GET /__vs/document?path=…`       | the envelope (the tree route already serves content, so this exists for the editor's typed read) |
| `PUT /__vs/document?path=…`       | save an edited document                             |
| `POST /__vs/document?path=…`      | create a new empty document; refuses an existing path |

`PUT` is the only write path and owns the invariants: it parses the incoming Lexical
JSON, **re-projects `nodes` from `doc.root`** so the flattened list cannot drift from
the tree, refreshes the derived `title` from `frontmatter.title`, and preserves
`documentId` and every unknown field from the copy on disk.

### Node identity across an edit

`CollabEditor` already loads and re-serializes `$.nodeId` through
`ui/node-id-extension.ts` — that is what makes the review round trip work. Saving a
local `.mdj` uses the same serialization, so an untouched block keeps its id and a
newly typed block gets a fresh one. The save route does not mint, rewrite, or
renumber ids; it only re-projects the `nodes` list from whatever ids the tree
carries. Block types that cannot carry an id (`NODE_ID_UNSERIALIZABLE_TYPES`) behave
as they do on the review surface.

### Comments on a document

Local comments stay in the sidecar (`visual-spec-comments.json`) and gain a fourth
target kind alongside `file` / `range` / `folder`:

```ts
type CommentTarget = {
  path: string;
  kind: 'file' | 'range' | 'folder' | 'node';
  // kind === 'node'
  nodeId?: string;
  nodeVersion?: number;   // flags the anchor as outdated, never relocates it
  snippet?: string;       // block text at authoring time, for display only
  …
};
```

Anchor semantics copy the collaboration model deliberately (LLD §6 of
`github-pr-collaborative-documents`): `nodeId` is the only rung that locates
anything, `nodeVersion` only marks the anchor stale, and an id that no longer
resolves is an **orphan** — reported, never thrown, never silently relocated.
`resolveNodeIn` from `core/collaboration/node-location.ts` is the resolver, and it is
already pure and browser-safe.

`buildApplyPrompt` gains a node branch: for a `node` target it names the `.mdj` file
and the `nodeId`, and instructs the agent to edit that block in the JSON while
preserving every other node's `id`. It must not tell an agent to edit by line — the
line numbers of a formatted JSON envelope mean nothing to the rendered document.

### Creating documents

**Local.** A "New document" action in the sidebar footer asks for a name, posts to
`POST /__vs/document`, and opens the result in edit mode. The seed is a valid empty
envelope: a generated `documentId`, `documentPath` equal to the created path, the
given title in `frontmatter.title`, and a `doc.root` holding one empty paragraph
with a fresh `nodeId`. The seed is built from the protocol types, never by parsing
Markdown.

**Collaboration.** `ui/collab-open-panel.tsx` sends `documents/${id}.mdj`.

### Collaboration path migration

- `localDocumentPath(id, dir)` returns `<dir>/<id>.mdj`.
- `markdownPathFor(documentPath)` swaps a trailing `.mdj` **or** `.json` for `.md`.
  Both, because a PR opened before this change carries `.json` in its stored
  `documentPath`, and publish and failure-states re-derive the Markdown path from
  that stored value. A document already on a branch must keep publishing to the same
  `.md` path it always did.
- `fsDocumentStore` and `githubDocumentStore` follow `localDocumentPath`, so their
  layout changes with it. Everything else about publish — commit, read-back
  verification, blob-sha comparison, no merge — is untouched.
- Reading an existing `.json` document from a branch keeps working, because both
  stores read the path recorded in the document rather than re-deriving it, and
  because `open` fetches by the stored `documentPath`.

## Constraints

- **Bundle boundaries hold.** `core/bundle-guard.test.ts` fails the build if Luthor
  or React become reachable from the CLI or Vite-plugin entrypoints. The new store
  and routes are Node-side and must import protocol types only. The new UI module
  lives under `ui/`.
- **Import boundary holds.** `core/collaboration/import-boundary.test.ts` (R-2.13)
  forbids `markdownToInjectable` / `canonicalizeMarkdown` / `markdownToJSON` from
  anything matching `ui/(node-id|publish|collab)*`. The new document surface renders
  and saves JSON only and must be covered by the same rule.
- **R-10.6 is respected, not bent.** That requirement forbids the collaboration view
  from becoming the renderer for local *Markdown* files. `.mdj` is not Markdown; it
  is the canonical JSON the view was written for. `markdown-surface.tsx` stays the
  only renderer for `.md`, and neither module imports the other.
- **Browser safety.** `ui/browser-safety.test.ts` fails if a node builtin becomes
  reachable from the app; the path-addressed store is server-side only.
- **Server-side Markdown stays absent.** `DocumentStore` deliberately has no
  `render`/`toMarkdown` (R-3.2). Nothing here adds one — the local viewer renders
  from JSON in the browser, and Markdown generation remains publish-only.

## Key Decisions

**Extension over content sniffing as the primary rule.** Classifying by content
would require reading every JSON file during the tree walk, which the walk avoids on
purpose (it no longer even stats entries). The extension answers the question for
free. The sniff exists only so files written before this change keep working.

**Reuse `CollabDocumentView` rather than write a second JSON renderer.** It already
produces the `data-vs-node-id` attributes the comment anchoring needs, and it already
renders the four formats Markdown cannot express. A second renderer would drift.
The trade is that a module named "collab" now serves a non-collab surface; the
rename is deliberately *not* done in this change to keep the diff reviewable.

**A separate path-addressed store instead of generalizing `fsDocumentStore`.**
`fsDocumentStore`'s id-addressing is load-bearing on the collaboration path
(`DOCUMENT_ID_RE` guards traversal, `resolveNode(documentId, …)` is the interface
route handlers depend on). Adding a `path` parameter to it would give every
collaboration caller a second way to name a document. A sibling with a narrow
interface is cheaper to reason about.

**`nodes` is re-projected on every save, not trusted from the client.** The client
could send an envelope whose flattened `nodes` disagrees with `doc.root`; every
downstream anchor read would then be wrong in a way nothing detects. Projection
server-side makes the disagreement unrepresentable.

**`markdownPathFor` accepts both extensions.** The alternative — migrating stored
`documentPath` values — is a data migration on branches this change cannot see.

**Rejected: rendering any `.json` that parses as a document.** Considered and
narrowed to the `documentId` + `doc.root` pair. A looser test (any object with a
`root` key) would capture unrelated fixtures; a stricter one (full schema validation)
would reject envelopes carrying unknown fields, which R-1.8 explicitly permits.

**Only `.mdj` is editable; a sniffed `.json` renders read-only.** The fallback fires
on any JSON carrying `documentId` + `doc.root` — which includes the test fixtures in
`core/collaboration/fixtures/` and `ui/fixtures/`. Rendering those is harmless;
letting a user save over a fixture through the viewer is not. Editing requires the
explicit extension.

**The local save refuses a collaboration-managed path.** Once `documents/<id>.mdj`
renders in the file tree, the same document is reachable from two surfaces with two
different write paths — and the collaboration side tracks `contentSha` precisely to
know whether the local copy holds work the branch has not seen. A local save that
bypassed that would silently invalidate the one signal that protects an agent's
unpublished changes. So the path-addressed store refuses paths the id-addressed store
owns, rather than trying to keep both writers coherent.

**The agent's local path comes from the stored `documentPath` first.**
`node-location.ts` deliberately chose `localDocumentPath` over `documentPath` because
the latter is the path on the *branch*. That reasoning holds for a document created
under one convention, but the extension change breaks its premise: a document created
before this ships exists on disk as `.json`, and `localDocumentPath` would now send
the agent to a `.mdj` file that does not exist — an apply run that edits nothing, or
worse, creates a stray file. The stored path is preferred when it names a file inside
the configured documents directory, which preserves the traversal guarantee that
motivated the original choice.

**Rejected: auto-renaming `documents/*.json` to `.mdj` on open.** Renaming a file
that may be tracked by git, referenced by an open PR, or held by a running agent is
not something a viewer should do as a side effect of displaying it.

## Out of Scope

- Converting existing Markdown to `.mdj`.
- Renaming `collab-document-view.tsx` / `collab-editor.tsx` to neutral names.
- Stamping `data-vs-node-id` from the live editor so edit and comment can share one
  surface.
- Publishing, branching, or PR features for a standalone local `.mdj`.
- A migration command that renames existing `documents/*.json` on disk.
- Diffing or version history beyond the existing comment history.
