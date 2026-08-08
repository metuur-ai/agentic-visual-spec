# `.mdj` Markdown-JSON Documents — EARS Specifications

> **RETIRED — never implemented. Do not build from this document.**
>
> This specified `.mdj` as a routing convention over the JSON document envelope.
> That envelope is itself retired: Markdown is now the only document format and the
> single source of truth. See `docs/ears/github-pr-collaborative-documents.md`,
> Unit 0. Kept only as a record of a rejected design.

> Terminology: a **document** is the envelope defined in
> `core/collaboration/document-protocol.ts` (`documentId`, `documentPath`, `title`,
> `frontmatter`, `nodes`, `doc.root`). An **`.mdj` file** is a file holding one.
> **Rendered document** means the block-level rendering produced by
> `ui/collab-document-view.tsx`, not Markdown text.

## Unit 1: File classification

**Why:** The viewer must be able to tell "JSON that is a document" from "JSON that is
data" cheaply, without reading every file in the tree, and without reclassifying the
`package.json` and fixture files that fill an ordinary repository.

| ID    | EARS statement |
| ----- | -------------- |
| R-1.1 | THE `FileKind` union SHALL include `document`, alongside `markdown`, `code`, `text`, `image` and `binary`, in both `core/vite/tree-store.ts` and `ui/use-tree.ts`. |
| R-1.2 | WHEN `detectKind` is given a name ending in `.mdj`, THE SYSTEM SHALL return `document`. |
| R-1.3 | WHEN `detectKind` is given a name ending in `.json`, THE SYSTEM SHALL return `code`. |
| R-1.4 | THE tree walk SHALL classify entries by name only and SHALL NOT read file contents to determine a kind. |
| R-1.5 | WHEN a file's contents are read and the file has a `.json` extension, IF the parsed body is an object carrying a non-empty string `documentId` AND an object at `doc.root`, THE SYSTEM SHALL serve it with `kind: 'document'`. |
| R-1.6 | IF a `.json` file's contents fail to parse, or parse without both `documentId` and `doc.root`, THE SYSTEM SHALL serve it with `kind: 'code'`. |
| R-1.7 | IF an `.mdj` file's contents fail to parse as a document envelope, THE SYSTEM SHALL serve the file with its raw content and a kind that renders as code, and SHALL NOT fail the request. |
| R-1.8 | THE `FileContent` union SHALL carry `content` for `kind: 'document'`, so a document is readable by any consumer that already handles text kinds. |
| R-1.9 | THE SYSTEM SHALL NOT change how `.md`, `.markdown`, image, text, or binary files are classified. |

## Unit 2: Rendering and reading a document

**Why:** The JSON is an implementation detail. What the user opened the file to read
is the document, and the rendering must carry the block identity that comments
anchor on.

| ID    | EARS statement |
| ----- | -------------- |
| R-2.1 | WHEN a file of kind `document` is opened, THE SYSTEM SHALL render it as a rendered document and SHALL NOT render its JSON source. |
| R-2.2 | THE rendered document SHALL stamp `data-vs-document-id`, `data-vs-node-id` and `data-vs-node-version` on each addressable block, as the review surface already does. |
| R-2.3 | WHERE a `.json` file is served with `kind: 'document'` by the content fallback, THE SYSTEM SHALL render it exactly as it renders an `.mdj` file. |
| R-2.4 | THE SYSTEM SHALL continue to render `.md` files through the existing Markdown surface with its `data-vs-loc` source positions, and the document renderer SHALL NOT be used for `.md` files (R-10.6). |
| R-2.5 | THE document renderer and the Markdown renderer SHALL NOT import one another. |
| R-2.6 | WHEN a file of kind `code` is opened, THE SYSTEM SHALL render it in the line-numbered code view, unchanged. |
| R-2.7 | THE header SHALL identify an open document as a document rather than as `code`. |
| R-2.8 | THE SYSTEM SHALL NOT parse Markdown into document JSON on any path reachable from the document surface (R-2.13, `import-boundary.test.ts`). |

## Unit 3: Commenting on a document block

**Why:** A comment on a rendered document must pin to the block the user is looking
at. A line number into a formatted JSON envelope is not a stable or meaningful
anchor, and the collaboration model already solved this with `nodeId`.

| ID    | EARS statement |
| ----- | -------------- |
| R-3.1 | THE `CommentTarget` type SHALL support `kind: 'node'` with a `nodeId`, alongside the existing `file`, `range` and `folder` kinds. |
| R-3.2 | WHEN a user comments on a block of a document, THE SYSTEM SHALL record the target as `{ path, kind: 'node', nodeId }` and SHALL record the block's `nodeVersion` at authoring time. |
| R-3.3 | THE SYSTEM SHALL locate a `node` comment by `nodeId` only, using `resolveNodeIn`, and SHALL NOT relocate it by line, offset, or snippet match. |
| R-3.4 | IF a `node` comment's `nodeId` no longer resolves in the document, THE SYSTEM SHALL report the comment as orphaned and SHALL NOT throw, drop it, or re-anchor it. |
| R-3.5 | IF a `node` comment's recorded `nodeVersion` differs from the block's current version, THE SYSTEM SHALL mark the anchor outdated while still locating the block. |
| R-3.6 | WHEN a comment is created on a document, THE SYSTEM SHALL persist it in the local sidecar (`visual-spec-comments.json`) and SHALL NOT post it to GitHub. |
| R-3.7 | WHEN `parseDoc` reads a sidecar containing `node` targets, THE SYSTEM SHALL preserve `nodeId`, `nodeVersion` and every other field across a read/serialize round trip. |
| R-3.8 | WHEN `buildApplyPrompt` builds instructions for a `node` target, THE SYSTEM SHALL name the document file and the `nodeId`, and SHALL instruct the agent to preserve every other node's identity. |
| R-3.9 | THE apply prompt for a `node` target SHALL NOT instruct an agent to edit the file by line number. |
| R-3.10 | THE SYSTEM SHALL NOT change how `file`, `range` or `folder` comments are authored, stored, resolved, or applied. |
| R-3.11 | Every code path that branches on `CommentTarget.kind` SHALL handle `node` explicitly, and SHALL NOT fall through to a line-based branch. |
| R-3.12 | THE apply prompt for a `node` target SHALL be self-describing — it SHALL carry the file, the `nodeId`, and the preservation rule in its own text — so an apply skill that has not been updated for this change can still act on it. |

## Unit 4: Editing and saving a document

**Why:** Editing must give the Markdown authoring experience while writing the JSON
form back. The one thing an edit must never do is disturb the identity of blocks the
user did not touch, because every comment anchor and every review reply depends on
it.

| ID    | EARS statement |
| ----- | -------------- |
| R-4.1 | WHEN a document is opened in Edit mode, THE SYSTEM SHALL mount the WYSIWYG editor over the document's `doc` value. |
| R-4.2 | THE SYSTEM SHALL offer Edit mode for files whose name ends in `.mdj`. |
| R-4.2a | WHERE a file was classified as a document by the `.json` content fallback, THE SYSTEM SHALL render it read-only and SHALL NOT offer Edit mode for it. |
| R-4.3 | WHEN a document edit is saved, THE SYSTEM SHALL write a valid document envelope to the same path via `serializeCollaborationDocument`. |
| R-4.4 | WHEN a document edit is saved, THE SYSTEM SHALL preserve the `nodeId` of every block whose content was not edited. |
| R-4.5 | WHEN a document edit is saved, THE SYSTEM SHALL preserve `documentId` and every unrecognized field on the envelope and on its nodes (R-1.8). |
| R-4.6 | WHEN a document edit is saved, THE SYSTEM SHALL re-project the envelope's `nodes` list from `doc.root` server-side, and SHALL NOT trust a `nodes` list supplied by the client. |
| R-4.7 | THE save path SHALL resolve the target path relative to the served base directory and SHALL reject any path escaping it. |
| R-4.8 | IF a save fails, THE SYSTEM SHALL report the failure to the user and SHALL leave the file on disk unchanged. |
| R-4.9 | WHEN a user navigates away from a document with unsaved edits, THE SYSTEM SHALL prompt to save or discard, as it already does for Markdown. |
| R-4.10 | THE SYSTEM SHALL NOT present the comment panel and the live editor as one surface for the same document, because the live editor does not stamp `data-vs-node-id` into the DOM. |
| R-4.11 | THE SYSTEM SHALL NOT generate Markdown server-side; `DocumentStore` and its path-addressed sibling SHALL expose no `render`/`toMarkdown` surface (R-3.2). |
| R-4.12 | IF the requested save path is one the collaboration document store manages (it resolves to `localDocumentPath` for a known `documentId` while collaboration is configured), THE SYSTEM SHALL refuse the local save and SHALL state that the document is edited through the collaboration surface. |
| R-4.13 | WHEN a save would drop the `nodeId` of a block that still exists in the edited document, THE SYSTEM SHALL report that loss to the user before writing, naming the affected blocks. |
| R-4.14 | WHEN a document is saved with no edits made, THE SYSTEM SHALL write bytes identical to what was read, so a no-op save produces an empty diff. |

## Unit 5: Creating a document

**Why:** "New document" must mean `.mdj`, and a new document must be usable
immediately — which means a valid envelope with a real addressable block, seeded from
the protocol types rather than by parsing Markdown.

| ID    | EARS statement |
| ----- | -------------- |
| R-5.1 | WHEN a user creates a document from the local sidebar, THE SYSTEM SHALL create a file with the `.mdj` extension. |
| R-5.2 | WHEN a document is created, THE SYSTEM SHALL seed a valid envelope containing a generated `documentId`, a `documentPath` equal to the created path, the given title in `frontmatter.title`, and a `doc.root` holding one empty block carrying a fresh `nodeId`. |
| R-5.3 | THE SYSTEM SHALL seed a new document from the protocol types and SHALL NOT produce it by parsing Markdown. |
| R-5.4 | IF the requested path already exists, THE SYSTEM SHALL refuse the creation and SHALL NOT overwrite the file. |
| R-5.5 | WHEN a document is created from the local sidebar, THE SYSTEM SHALL open it in Edit mode and SHALL make it visible in the file tree. |
| R-5.6 | A locally created document SHALL have no GitHub binding, and THE SYSTEM SHALL NOT open a branch, a pull request, or a publish flow for it. |
| R-5.7 | WHEN a document is created through the collaboration panel, THE SYSTEM SHALL send a `documentPath` of `documents/<id>.mdj`. |

## Unit 6: Collaboration path migration

**Why:** The collaboration path stores documents at a derived location. Moving that
location to `.mdj` keeps one convention across the product — but it must not break a
pull request that was opened while the convention was `.json`.

| ID    | EARS statement |
| ----- | -------------- |
| R-6.1 | `localDocumentPath(documentId, documentsDir)` SHALL return `<documentsDir>/<documentId>.mdj`. |
| R-6.2 | `markdownPathFor(documentPath)` SHALL replace a trailing `.mdj` with `.md`. |
| R-6.3 | `markdownPathFor(documentPath)` SHALL also replace a trailing `.json` with `.md`, so a document created before this change keeps publishing to the Markdown path it already has. |
| R-6.4 | WHEN a document whose stored `documentPath` ends in `.json` is opened, read, published, or reconciled, THE SYSTEM SHALL operate on that stored path and SHALL NOT re-derive a `.mdj` path for it. |
| R-6.5 | THE SYSTEM SHALL NOT rename, move, or rewrite any existing `.json` document, locally or on a branch. |
| R-6.6 | THE SYSTEM SHALL NOT change what publish commits, the order in which it commits and verifies, the read-back byte and blob-sha verification, or the absence of merge. |
| R-6.7 | THE prompt handed to an agent for a collaboration document SHALL name the local path that actually holds the document: the document's stored `documentPath` when it names a file in the configured documents directory, and `localDocumentPath` only when it does not. |
| R-6.8 | THE SYSTEM SHALL NOT send an agent to a `.mdj` path for a document that exists on disk as `.json`. |

## Unit 7: Boundaries that must not regress

**Why:** These are structural guarantees the existing test suite enforces. This
change adds modules on both sides of every one of them, so each is restated as a
requirement rather than left to review.

| ID    | EARS statement |
| ----- | -------------- |
| R-7.1 | Luthor and React SHALL NOT become reachable from the CLI or Vite-plugin entrypoints (`core/bundle-guard.test.ts`). |
| R-7.2 | Node builtins SHALL NOT become reachable from the browser app (`ui/browser-safety.test.ts`). |
| R-7.3 | The document surface and its save path SHALL be covered by the import-boundary rule forbidding `markdownToInjectable`, `canonicalizeMarkdown` and `markdownToJSON` (R-2.13). |
| R-7.4 | The path-addressed document store SHALL NOT import `core/vite/surface-store.ts`, preserving the separation `document-store.test.ts` asserts (R-3.7). |
| R-7.5 | THE SYSTEM SHALL keep the existing local Markdown viewer, its anchor resolver, and its comment flow unchanged (R-6.6, R-1.7). |
