# GitHub PR-Based Collaborative Documents — Tasks

Source of truth: `docs/ears/github-pr-collaborative-documents.md` (acceptance IDs `R-x.y`) and `docs/lld/github-pr-collaborative-documents.md` (architecture, build order). Source paths below are relative to `packages/visual-spec/`.

**Build order.** Phase 0 pins the two invariants everything else assumes (`nodeId` survives a live editor; local mode does not regress). Then the foundation — protocol types and the owned-node layer — because both the store and the renderer depend on `nodeId` existing. The **renderer (Unit 7) is the critical path**: it is the largest single item, nothing about reviewing works without it, and it can start as soon as the node layer lands. The GitHub adapter (Unit 4) is fully independent and can run in parallel from day one.

**Parallel lanes once Phase 1 lands:**
- Lane A — renderer + reviewer UI (7.x, 11.x) ← longest, start first
- Lane B — GitHub adapter + comment projection (4.x, 5.x)
- Lane C — document store + jobs (3.x, 8.x)

**Do not touch** `ui/anchor-resolver.ts`, `ui/markdown-surface.tsx`, or the local comment path. Collaboration uses a separate resolver and a separate renderer by design (R-6.6, R-10.6); sharing them is what puts R-10.1 at risk.

---

## Phase 0: De-risk and safety net

- [x] 0.1 jsdom test harness + `nodeId` identity contract (est: ~1d)
  - why: the whole design rests on `nodeId` surviving a live editor. Probes proved Lexical honours `{replace, with, withKlass}` and that Luthor's provider flat-maps extension `getNodes()` into `initialConfig.nodes` — but nobody has mounted the real preset and typed into it. If this fails, Unit 2 needs a third design and the plan below is void.
  - acceptance: R-12.1 — a node created by a live editor mount retains its `nodeId` through `getJSON()` / `injectJSON()`.
  - verify: add `jsdom` + `@testing-library/react` as devDeps; mount `ExtensiveEditor` with a registered replacement node; type, split a block, merge two blocks, paste, reload from JSON; assert `nodeId` stable per surviving block.
  - landed: `packages/visual-spec/ui/node-identity.contract.test.tsx` (new, 13 tests), `packages/visual-spec/vitest.config.ts` (`.tsx` includes, `resolve.dedupe: ['lexical']`, inline luthor/lexical deps), `packages/visual-spec/package.json` (devDeps `jsdom`, `@testing-library/react`, `@testing-library/dom`). VERDICT: identity contract HOLDS, but **not via the LLD's mechanism** — see the test file header and the LLD §2 amendments below.
  - findings that amend LLD §2 / EARS R-2.2, R-2.3:
    1. **R-2.2 and R-2.3 are mutually exclusive on Lexical 0.40.** `LexicalNode`'s constructor calls `errorOnTypeKlassMismatch` and the node registry is keyed by type string, so a replacement subclass whose `getType()` returns `'paragraph'` throws on every construction; `exportNodeToJSON` additionally rejects an `exportJSON().type` that differs from `getType()`. Node replacement therefore forces a distinct serialized `type` and `MARKDOWN_SUPPORTED_NODE_TYPES` stops matching. This is NOT the missing-`withKlass` failure the LLD predicted (registration verified correct).
    2. **Use Lexical NodeState instead** (`createState` / `$setState` / `$getState`, serialized under `$`). It carries `nodeId`, keeps `type: 'paragraph'`, needs no subclass, and round-trips through `importJSON` for free. Unit 2.1 should be re-scoped to this.
    3. **`markdownSourceOfTruth` makes `getJSON()` lossy** — Luthor implements it as `markdownToJSON(getMarkdown())`, wiping every id. The collaboration mount must not set it (`ui/wysiwyg-editor.tsx:402` does today).
    4. **`injectJSON` does not run node transforms** (`setEditorState` replaces the node map wholesale) and is deferred behind a 100ms `setTimeout`. R-2.8 backfill is load bearing on every load, not only for legacy documents.

- [x] 0.2 Local-mode regression suite (est: ~4h)
  - why: Unit 10 is the "worse than not shipping" risk and nothing currently asserts local mode is unchanged. This has to exist *before* shared UI is touched, not after.
  - acceptance: R-12.5 — regression suite pinning local-mode comment resolution; R-10.1 through R-10.6 — browsing, viewing, commenting, apply, and legacy `{file, anchor}` upgrade all behave as today with no collaboration config present.
  - verify: suite passes on `main` before any collaboration code lands, and stays green at every subsequent story.
  - landed: `core/editing/local-mode.regression.test.ts` — 70 characterization tests covering R-10.1..R-10.6 + R-12.5 (browsing, source/markdown surface, `/__vs/comments` add/edit/delete, sidecar on-disk format, apply-prompt, `resolveMarkdownAnchors` degraded cases, legacy `{file, anchor}` upgrade, GitHub-free assertions, and an inventory of the pre-existing guards). Tests only, no production change. Suite 153 → 223 green. Quirks pinned deliberately (not fixed): PATCH with no `status` blanks the field; `kind:"file"` + `startLine` drops the line; `selection:"range"` writes an empty `endSnippet`; the heading fallback in `resolveMarkdownAnchors` sweeps siblings using the stale `startLine`; the legacy upgrader appends `.md` to any extension.

- [x] 0.3 Bundle guard — no React in Node-reachable output (est: ~2h)
  - why: `@lyfie/luthor-headless` bundled by esbuild inlines `react-dom/server`, producing a 3.8 MB artifact that throws `Dynamic require of "react-dom/server.node.js"` at import. A single stray import from `core/` ships a broken binary.
  - acceptance: R-12.6 — every Node-reachable bundled entrypoint (CLI and Vite plugin host) contains no `react`/`react-dom` references; R-3.3 — no module reachable from the CLI entrypoint imports Luthor.
  - verify: build, then grep `dist/cli.js` and the Vite host bundle for `react`; add `@lyfie/luthor*` to `tsup.config.ts` `external`; assert the check fails when a deliberate import is added.
  - landed: three layers. (1) STATIC — `core/bundle-guard.test.ts` walks the TS import graph from `src/cli.ts`, `core/vite/index.ts`, `core/index.ts` and asserts none reaches `react`/`react-dom`/`@lyfie/luthor`; runs in `npm test`. (2) BUILD — `build.mjs` installs an esbuild `forbid-browser-deps` `onResolve` plugin that *rejects* (does not externalize) those specifiers, so the CLI fails to build rather than deferring to a runtime require; `tsup.config.ts` externalizes `/^@lyfie\/luthor/`. (3) OUTPUT — `npm run check:bundle` (`check-bundle.mjs`) greps `dist/cli.js`, `dist/vite/index.js`, `dist/index.js` plus their tsup chunks; run it after `npm run build` (`dist/ui/**` is deliberately excluded — the browser bundle should contain react). Proof: a deliberate `import '@lyfie/luthor'` in `src/server.ts` + `core/vite/md-plugin.ts` failed all three, then was removed. Baseline had no leak — `dist/cli.js` was and remains 58,235 bytes with 0 react/luthor hits.

---

## Phase 1: Foundation

## Unit 1: Collaboration protocol model

- [x] 1.1 Add `core/collaboration/document-protocol.ts` (deps: 0.1, est: ~4h)
  - why: every later layer needs one typed vocabulary for document, node, anchor and GitHub identity. Inventing these per call-site is how the layers drift.
  - acceptance: R-1.1 — new module, separate from `core/editing/comment-doc.ts`; R-1.2 — document carries `documentId`, `documentPath`, `title`, `frontmatter`, `nodes[]` with frontmatter on the envelope not inside `JsonDocument`; R-1.3 — node carries `id`/`type`/`version`/`content`; R-1.4 — anchor carries `nodeId`, `nodeVersion`, `github`; R-1.5 — GitHub binding carries `owner`, `repo`, `branch`, `pullNumber`, `headSha`, `issueCommentId`, `replyToId`, `resolved`; R-1.6 — collaborative target carries `documentId` + `nodeId`.
  - verify: type-level tests; assert `CommentTarget` is byte-identical to today (R-1.7); assert unknown fields survive a read/write round-trip (R-1.8).
  - landed: `packages/visual-spec/core/collaboration/document-protocol.ts` + `document-protocol.test.ts` (12 tests). Types only plus `parseCollaborationDocument` / `serializeCollaborationDocument` (R-1.8) and `resolveDocumentTitle`. No runtime imports — `JsonDocument` is a local structural `{ root }` type, so nothing on the CLI path pulls in Luthor or react (R-3.3 / R-12.6). Title precedence decided: `frontmatter.title` wins; the envelope `title` is a derived cache refreshed on write (LLD Open Questions updated).

## Unit 2: Owned node layer

- [ ] 2.1 Owned block node classes carrying `nodeId` (deps: 0.1, 1.1, est: ~1w)
  - why: serialized Lexical nodes have no stable key, and `getJSON()` emits only what the class declares. Node replacement is the only interception point that covers nodes created *inside* the editor — on Enter, on paste, on list toggle.
  - acceptance: R-2.2 — `nodeId` carried via `{replace, with, withKlass}` registration, not a structural path or sidecar map; R-2.3 — `getType()` returns the **base** type string so `MARKDOWN_SUPPORTED_NODE_TYPES` and the transformers keep matching; R-2.4 — every editor-created node gets a document-unique `nodeId`; R-2.5 — `nodeId` survives `exportJSON()`/`importJSON()`.
  - verify: extend the 0.1 harness across every block type in `MARKDOWN_SUPPORTED_NODE_TYPES` (R-12.2). Watch for the failure mode where a replacement without `withKlass` throws `Create node Type paragraph … does not match registered node ParagraphNode`.
  - landed:

- [ ] 2.2 Version bump + backfill (deps: 2.1, est: ~3h)
  - why: `version` is what distinguishes "same block, edited since the comment" so a comment can be flagged outdated. Backfill covers documents authored before this shipped and any node that escapes the replacement.
  - acceptance: R-2.6 — content change bumps `version`, never `nodeId`; R-2.7 — unchanged content does not bump; R-2.8 — missing `nodeId` backfilled on first write and recorded; R-2.12 — a write that cannot produce unique ids fails rather than persisting a partially identified document.
  - verify: property test over random edit scripts (insert/delete/move/edit) asserting id stability and version monotonicity.
  - landed:

- [ ] 2.3 Publish payload generator (deps: 2.1, est: ~4h)
  - why: `json` and `markdown` must come from **one** object at **one** instant. The server treats the Markdown as opaque, so no server-side check can catch a client that serialized the two from different states — this invariant is the only thing preventing a silent mismatch.
  - acceptance: R-2.9 — uses `jsonToMarkdown(doc, { metadataMode: 'none' })`; R-2.10 — generated Markdown is write-only, never parsed back; R-2.11 — editor driven through `getJSON()`/`injectJSON()`, not a Markdown string buffer.
  - verify: R-12.8 — test asserts both artifacts derive from the same document object via a single call. Explicitly **not** reusing `normalizeForStore(getMarkdown())` (`ui/wysiwyg-editor.tsx:135`), which reads live editor state and applies local-viewer image rewriting.
  - landed:

- [ ] 2.4 Import-boundary lint for the collaboration path (deps: 2.3, est: ~2h)
  - why: `markdownToInjectable` does not throw on an id-less tree — it returns a structurally valid document with every `nodeId` gone. Silent identity loss is the worst failure mode in the design, so convention is not enough.
  - acceptance: R-2.13 — no collaboration module imports `markdownToInjectable()` or `canonicalizeMarkdown()`, asserted by a test.
  - verify: lint rule fails when a deliberate import is added to a collab module.
  - landed:

---

## Phase 2: Parallel lanes

## Unit 3: Document store — Lane C

- [x] 3.1 `DocumentStore` interface + local implementation (deps: 1.1, est: ~3d)
  - why: structured JSON does not fit `SurfaceStore`, whose read/write/list contract assumes text. Keeping Markdown *out* of this interface is deliberate — generation happens in the browser, so the server never needs a serializer.
  - acceptance: R-2.1 — canonical document persisted as a Luthor `JsonDocument`, no bespoke node schema; R-3.1 — read/write/list; R-3.2 — **does not** render or generate Markdown; R-3.4 — resolve `nodeId` → JSON location; R-3.5 — local file-backed impl at `documents/<documentId>.json`; R-3.7 — collaboration JSON never routed through `SurfaceStore`; R-3.8 — unresolved `nodeId` reported, not thrown.
  - verify: unit tests; assert the interface has no Markdown surface.
  - landed: `core/collaboration/document-store.ts`, `core/collaboration/document-store.test.ts` (14 tests). `read()` resolves `null` for an absent document, mirroring `GitHubAdapter.getFile`, so 3.2 maps cleanly. `resolveNode` returns a discriminated `NodeResolution` — `{ found: false }` or `{ found: true, path, node }` — where `path` is the child-index route from `doc.root` (R-3.4); the pure `resolveNodeIn(doc, nodeId)` is exported for 6.1 so anchor resolution needs no re-read. Persistence goes through 1.1's `parseCollaborationDocument` / `serializeCollaborationDocument`, so unknown fields survive the store (R-2.1 / R-1.8). Suite 263 → 277.

- [x] 3.2 GitHub-backed `DocumentStore` (deps: 3.1, 4.1, est: ~4d)
  - why: the same operations mapped onto a PR branch, so the routes are backend-agnostic.
  - acceptance: R-3.6 — GitHub impl maps read/write/list onto a PR branch.
  - verify: exercised against the recorded-response executor from 4.1; no live repo needed.
  - landed: `core/collaboration/github-document-store.ts` — `githubDocumentStore(adapter, { repo, branch, documentsDir? })`, same `<documentsDir>/<documentId>.json` layout as 3.1 so a document is portable between backends. Resolution reuses 3.1's `resolveNodeIn` / `DOCUMENT_ID_RE`; persistence reuses 1.1's parse/serialize. **Backend-agnosticism is proved, not asserted**: `core/collaboration/document-store.contract.test.ts` runs one 11-test suite against *both* stores (22 tests), the GitHub one driven by a fake `gh` executor holding an in-memory branch. `core/collaboration/github-document-store.test.ts` (20 tests) covers the GitHub-specific half from recorded fixtures. **Adapter gap closed** with a minimal additive `listFiles(repo, path, ref)` on `GitHubAdapter` — the Contents API returns an array for a directory path, so `list()` is the same endpoint as `read()`; no manifest file, which would be derived state able to drift from the branch that is the system of record. **Write is read-before-write**: `getFile` on the branch supplies the blob sha, present ⇒ PUT with `sha` (update), absent ⇒ PUT without (create). The read/PUT pair is not atomic and cannot be over this API; a lost race surfaces as a typed `DocumentWriteConflictError` (409 stale sha, or 422 `"sha" wasn't supplied` on the create side) carrying `documentId`/`path`/`branch`/`expectedSha`/`cause` — the `DocumentStore` shape is unchanged, since `write()` returns `void` and offers no return channel. The store detects and refuses; it never retries — resolution is R-8.x's. Suite 277 → 319.

## Unit 4: GitHub adapter — Lane B (independent, start day 1)

- [x] 4.1 REST adapter with injectable executor (deps: none, est: ~4d)
  - why: shelling out to `gh` avoids reimplementing auth, pagination and rate limiting, and lets the Claude CLI drive the same operations. The injectable executor is what makes any of it testable — mirror the `spawnClaude` seam at `core/vite/routes/apply.ts:158`.
  - acceptance: R-4.1 — single adapter over `gh`/MCP; R-4.2 — no bespoke HTTP/GraphQL client; R-4.3 — branch, commit, open PR; R-4.4 — list/create/update/delete **issue** comments; R-4.5 — paginate the full comment list; R-4.6 — REST only, no GraphQL dependency; R-4.7 — merge; R-4.8 / R-12.3 — injectable process-spawn or request executor, mirroring `spawnClaude`; R-4.9 — structured errors carrying no credential material.
  - verify: recorded `gh api` fixtures replayed through the executor. Commit via the Contents API only — a shell-out to `git commit` applies `.gitattributes` CRLF normalization and breaks publish verification permanently.
  - landed: `core/collaboration/github-adapter.ts`, `core/collaboration/github-executor.ts`, `core/collaboration/github-adapter.test.ts` (24 tests), `core/collaboration/fixtures/*.json` (11 recorded responses). Pagination is an explicit `page=` loop, not `Link`-following: the executor is buffered and exposes stdout only, so response headers are not observable. Suite 153 → 177.

- [x] 4.2 Credential + scope preflight (deps: 4.1, est: ~4h)
  - why: the real credential on a dev machine is a keyring OAuth token, not a PAT in an env var, and it may lack scopes. Today the first symptom would be a raw 403 mid-publish.
  - acceptance: R-9.1 — read credential server-side from env or `gh` auth state; R-9.2 — credential never reaches the browser, a response body, an SSE event, or the client bundle; R-9.3 — credential never written to logs, job status, or error messages; R-9.4 — accepts owner/repo/base-branch configuration; R-9.12 — verify required scopes on enable and name the specific missing scope; R-4.10 — unavailable execution path reported as unavailable, with no partially-functional fallback; R-9.19 — no credential ⇒ collaboration disabled, local mode unaffected.
  - verify: simulate missing scope and assert the message names it.
  - landed: `core/collaboration/credentials.ts` (`preflightCollaboration`), `core/collaboration/credentials.test.ts` (17 tests), `core/collaboration/fixtures/user-inclusive-*.txt` (3 recorded responses), plus `collaboration` owner/repo/baseBranch config in `core/config.ts`. Scopes and identity come from one `gh api -i /user` call: `-i` puts `X-OAuth-Scopes` on stdout as machine-readable text, which the buffered executor can see, whereas `gh auth status` prints a human-formatted table whose stream and wording have moved across `gh` releases and which cannot resolve the identity in the same call. The module never reads a token *value* — env vars are probed for presence only — so the success shape carries identity + scopes + availability and no secret. Suite 263 → 280.

## Unit 5: Comment projection — Lane B

- [x] 5.1 Issue-comment projection into `CommentDoc` (deps: 4.1, est: ~4d)
  - why: `/__vs/comments` and the apply hub already depend on the `CommentDocStore` interface rather than on files, so projecting through it keeps both working. But `write(doc)` is a whole-document snapshot swap returning `void` — there is no channel for the created comment's id, so the seam needs intent-based methods.
  - acceptance: R-5.1 — projection of PR issue comments into `CommentDoc`; R-5.2 — GitHub is the system of record; R-5.3 — sidecar is a non-authoritative cache; R-5.4 — created comment carries a machine-readable `documentId`+`nodeId` trailer and persists the returned id; R-5.5 — **no** review comments created; R-5.6 — comments authored on github.com appear after sync, including ones with no `nodeId`; R-5.7 — comments without a `nodeId` land in a document-level discussion view.
  - verify: fixture-replayed round-trip; assert `addComment` returns the GitHub id.
  - landed: `core/collaboration/comment-projection.ts` + `comment-projection.test.ts` (22 tests) + `fixtures/projection-comments.json`. **Trailer format (parsed by 5.2 / 5.3 / 6.1 / 8.x):** the body is the author's text, a blank line, then a single-line HTML comment as the last line — `<!-- visual-spec: documentId=doc-1 nodeId=n-7 -->`. Keys are `[A-Za-z][A-Za-z0-9]*`, values `encodeURIComponent`-encoded so no space/newline/`-->` can appear inside one; unknown keys survive a parse/format round-trip, so 5.2 can add `resolved=`/`replyTo=` and 5.3 a `key=` with no format change. `nodeId` is omitted for document-level comments; a body with no trailer (authored on github.com) is preserved verbatim. **Seam:** `CommentDocStore` gains three OPTIONAL intent methods — `addComment?`, `updateComment?`, `deleteComment?` — plus a `CommentPatch` type; `fileCommentStore` implements all three via its existing snapshot read/modify/write (the PATCH "status blanks when absent" quirk is preserved deliberately), and `handleCommentsRequest` uses them when present and falls back to the snapshot path when not, so the in-memory stores in the existing suites stay valid unchanged. Record ids are derived from the GitHub comment id (`c-<hex>`, reversible) so a sync holds no local id map and PATCH/DELETE route matching is unchanged. `read()` always hits GitHub and never the cache (R-5.2/R-5.9); `write(doc)` only mirrors into the optional non-authoritative cache and never touches GitHub (R-5.3). Status/resolution is deliberately NOT projected to GitHub here — that is 5.2. Suite 263 → 285.

- [ ] 5.2 Resolution-state convention (deps: 5.1, est: ~2d)
  - why: issue comments have no native resolve, and reviewers cannot push — so resolution has to be expressible as a comment or it cannot exist at all.
  - acceptance: R-5.12 — resolution is a reply comment carrying a machine-readable resolved marker; R-5.13 — posted as the acting user's own identity; R-5.14 — state derived from the latest marker in replies, never from the local cache; R-5.15 — legible on github.com without visual-spec.
  - verify: resolve/unresolve round-trip through fixtures; assert cache is not consulted.
  - landed:

- [ ] 5.3 Cache lifecycle + apply-flow target (deps: 5.1, est: ~1d)
  - why: `apply-prompt.ts:16` currently hardcodes the sidecar as source of truth, which contradicts R-5.3. And R-5.8 deletes the cache on merge — so anything living only in the cache is destroyed exactly when the changelog needs it.
  - acceptance: R-5.8 — cache deleted on merge; R-5.9 — GitHub wins on disagreement; R-5.10 — apply flow takes a mode parameter selecting the canonical JSON as edit target and never edits generated Markdown; R-5.11 — comment creation retry is idempotent.
  - verify: assert the apply prompt names the JSON document in collab mode and the sidecar in local mode.
  - landed:

## Unit 7: Renderer + collaboration UI — Lane A (critical path, start first)

- [ ] 7.1 JSON → DOM renderer stamping node identity (deps: 2.1, est: ~3w)
  - why: **this does not exist and reviewers depend on it entirely.** The current render path is Markdown → react-markdown (`ui/markdown-surface.tsx:41`), which stamps `data-vs-loc` from mdast positions — but Markdown is `nodeId`-stripped, so ids cannot be stamped there. Without this component there is no review surface.
  - acceptance: R-7.3 — rendered blocks carry `data-vs-document-id`, `data-vs-node-id`, `data-vs-node-version`.
  - verify: render a fixture document; assert every block node has a `data-vs-node-id` matching the JSON; visual parity with the published Markdown (SC-10).
  - landed:

- [ ] 7.2 Collaboration routes (deps: 3.1, 5.1, est: ~3d)
  - why: an explicit route family keeps `/__vs/comments` semantics intact for local mode.
  - acceptance: R-7.1 — the `/__vs/collab/*` family incl. `POST /open`; R-7.2 — `/__vs/comments` unchanged; R-7.7 — no GitHub calls from the browser; R-7.8 — no collaboration controls without configuration.
  - verify: route tests; assert local comment routes are untouched.
  - landed:

- [ ] 7.3 Wire comment panel + indicators to `nodeId` (deps: 7.1, 7.2, est: ~1w)
  - why: `ui/indicator-layer.tsx:20` and `core/app/lib/use-comments.ts:36` are **path-keyed**, and collaborative comments have no path. This is where R-10.1 is genuinely at risk — the change is to shared components local mode also uses.
  - acceptance: R-7.4 — existing `CommentPanel`/`IndicatorLayer` reused, not duplicated; R-7.5 — comments persisted against `nodeId` as primary identity.
  - verify: 0.2 regression suite stays green; collab indicators resolve by `nodeId`.
  - landed:

- [ ] 7.4 Editor port to `JsonDocument` (deps: 2.1, 2.3, est: ~2w)
  - why: `ui/wysiwyg-editor.tsx` keys dirty-detection on Markdown **string equality** (`md === lastSynced.current`, `:136`) — roughly 120 lines of interaction heuristics with no test coverage today. Markdown is a lossy, normalizing projection, which is exactly why that comparison is stable; `getJSON()` is lossless and carries churn, so a naive port produces false-dirty on caret movement.
  - acceptance: R-2.11 — editor driven from structured state, not a Markdown string buffer.
  - verify: new dirty-detection tests written **before** the port; assert no false-dirty on selection change, arrow keys, or clicking a comment pill.
  - landed:

- [ ] 7.5 Both hosts expose collaboration mode (deps: 7.2, est: ~2h)
  - why: shipping it in the shared UI + route layer is what keeps the two hosts from forking.
  - acceptance: R-7.6 — standalone CLI and Vite plugin both expose it with no host-specific code.
  - verify: smoke both hosts.
  - landed:

## Unit 6: Anchor resolution — Lane A

- [ ] 6.1 `nodeId` lookup resolver + orphan handling (deps: 7.1, est: ~2d)
  - why: with identity in the JSON and no diff position, resolution is a direct lookup — about five lines. The value here is in the *degraded* states, which are the ones users actually live in.
  - acceptance: R-6.1 — resolve by `documentId`+`nodeId` only, never line/snippet/heading; R-6.2 — exact anchor on version match; R-6.3 — version mismatch still anchors, flagged outdated; R-6.4 — unresolvable `nodeId` shown as orphaned, never discarded; R-6.5 — orphans appear in the document-level view with last-known target text and manual re-anchoring; R-6.7 — no line/snippet fields required on collaborative comments.
  - verify: table-driven tests per state. R-6.6 — assert `resolveMarkdownAnchors` is untouched and `anchor-resolver.test.ts` stays green.
  - landed:

## Unit 8: Jobs, sync, publish — Lane C

- [x] 8.1 Per-document job hub registry (deps: 3.1, est: ~1w)
  - why: `createApplyHub` (`core/vite/routes/apply.ts:251`) is a module-level singleton — `let events`, `let running`, one `subs` Set — so one run at a time, globally. Collaboration needs concurrent per-document jobs. This is new code, not reuse.
  - acceptance: R-8.1 — registry keyed by `documentId`, no shared state; R-8.2 — SSE fan-out at `GET /__vs/collab/:id/events`; R-8.3 — jobs for create, commit, sync, re-resolve, publish; R-8.4 — late subscriber can recover current state.
  - verify: two documents running jobs concurrently without interference.
  - landed: `core/collaboration/job-hub.ts` + `job-hub.test.ts` (26 tests). `createJobHubRegistry({ maxEvents?, now? })` → `hub(documentId)` lazily creates a `DocumentJobHub` owning its own `state` / `job` / `events` / `subs` — nothing module-level, so two documents run jobs at the same instant with disjoint logs and subscribers (the isolation test asserts no `jobId` from one document appears in the other's frames). Job *bodies* are injected (`start({ kind, run, idempotencyKey? })` where `run: (ctx: JobContext) => Promise<void>`), so 8.2 / 8.3 supply real GitHub work without reshaping the hub; the seven `JobKind`s of R-8.3 are declared here. `LifecycleState` (the LLD §7 diagram) is declared here too and *held*, not enforced — the Ready gate and merge re-verification stay in 8.4; the only transition the hub owns is `failed` on an uncaught rejection. Decisions: a second job for a busy document is **rejected 409, never queued** (a queued publish could land after a sync that invalidated it, and the caller cannot see what it is behind); the event log is bounded at **500 frames**, dropping oldest and counting them in `droppedEvents`, which does not weaken R-8.4 because `state` / `running` / `job` are tracked outside the log; `dispose(documentId)` / `disposeAll()` abort the running job, end subscribers and drop the map entry. Bodies are invoked synchronously (as `runApply` is) so a start-then-cancel in one turn still reaches an abort listener. `SseSink` is a structural subset of `ServerResponse`, so 7.2 mounts `GET /__vs/collab/:id/events` → `hub(id).subscribe(res)` and `GET /__vs/collab/:id` → `hub(id).status()` with no HTTP in the unit tests. Suite 277 → 303.

- [ ] 8.2 Document creation + sync (deps: 4.1, 8.1, est: ~3d)
  - why: sync must run through one entrypoint so a webhook receiver could later drive it unchanged.
  - acceptance: R-8.5 — `start` creates branch, commits JSON, opens PR, returns `pullNumber`+`headSha`; R-8.6 — interval polling and explicit sync; R-8.7 — both through one entrypoint; R-8.8 — no webhook receiver required.
  - verify: fixture-replayed; assert both sync paths call the same function.
  - landed:

- [ ] 8.3 Publish: commit then verify, no merge (deps: 2.3, 8.1, est: ~4d)
  - why: ordering is load-bearing. Verifying *after* merge would discover bad bytes only once they are in the base branch, in a state that by rule must not self-heal. Merge is deliberately not part of publish — that removes the irreversible half of the write primitive from the localhost endpoint.
  - acceptance: R-8.9 — payload of `json`+`markdown` required, incomplete rejected; R-8.10 — commit, verify committed blob against payload bytes, **do not merge**; R-8.11 — expected hash computed server-side, not trusted from the client; R-8.12 — Markdown treated as opaque; R-8.13 — committed Markdown readable from the branch for the agent's summary; R-8.14 — publish completes if the client disconnects after the payload is accepted.
  - verify: R-12.7 — publish rejects a payload missing `json` or `markdown`; R-12.4 — publishing a document with no unsupported nodes reproduces byte-identical Markdown for the same input; assert no merge call is made.
  - landed:

- [ ] 8.4 Failure states + idempotency (deps: 8.3, est: ~3d)
  - why: R-8.24's "leave it reconcilable" is a wish, not a specification. A double-clicked publish must not produce two branches and two PRs.
  - acceptance: R-8.15 — Ready gate; R-8.16 — new comment returns a Ready document to PR-open; R-8.17 — merge-time re-verification (closes the poll-window TOCTOU); R-8.18 — no orphaned branch on partial create; R-8.19 — externally closed PR reaches a closed state; R-8.20 — base-branch conflict reported, no auto-resolution; R-8.21 — verification failure aborts before merging; R-8.22 — base divergence is a **distinct** state from verification failure; R-8.23 — idempotency tokens; R-8.24 — failures reported over SSE.
  - verify: inject failure at each step and assert the recorded state and that retry does not duplicate.
  - landed:

## Unit 9: Authorization — Lane B

- [x] 9.1 Shared request guard for both hosts (est: ~4h)
  - why: `/__vs` had no origin checking and `readJsonBody` never inspected `content-type`, so a cross-origin `text/plain` POST was a CORS simple request — putting `comments/add` and `apply/start` in reach of any page in the user's browser, and the apply run splices comment text into a prompt for an agent running with `acceptEdits`. Publish would escalate that to a remote write with the author's credential.
  - acceptance: R-9.13 — `Sec-Fetch-Site` cross-site/same-site rejected and non-loopback `Host` rejected on every `/__vs` route in both hosts; R-9.14 — absent `Sec-Fetch-Site` allowed (non-browser clients carry no ambient authority); R-9.15 — one shared implementation, registered ahead of every handler.
  - verify: 11 unit tests in `core/vite/request-guard.test.ts`; full suite green (153).
  - landed: _uncommitted_ — `core/vite/request-guard.ts`, `core/vite/request-guard.test.ts`, `src/server.ts:176`, `core/vite/md-plugin.ts:147`

- [ ] 9.2 Role classification + author-only enforcement (deps: 4.2, 7.2, est: ~3d)
  - why: gating on "PAT owner == PR author" would lock reviewers out entirely. The valuable property is that GitHub itself enforces the boundary — a reviewer's credential cannot push — so single-writer holds even if a server check is wrong.
  - acceptance: R-9.5 — identity resolved from the credential; R-9.6 — comments attributed to the acting user's own account, identity never encoded in bodies; R-9.7 — author vs reviewer classification; R-9.8 — reviewer can read/comment/reply with no write access; R-9.9 — edit/commit/mark-ready/publish/merge author-only server-side; R-9.10 — reviewer request rejected server-side even when the UI control is hidden; R-9.11 — UI hiding never satisfies an authz requirement.
  - verify: reviewer-token fixture attempting each author-only operation.
  - landed:

- [ ] 9.3 Publish gating + cross-origin readability test (deps: 8.3, 9.1, est: ~1d)
  - why: publish accepts client bytes and commits them, so the guard is a precondition for exposing it — not later hardening. And Vite's dev server has historically applied permissive CORS defaults; if those reach `/__vs`, a blind write primitive becomes read-plus-write.
  - acceptance: R-9.16 — publish route not exposed until the guard is in place; R-9.17 — merge (if offered in-app) requires an out-of-band terminal confirmation; R-9.18 — `/__vs` responses not readable cross-origin in **either** host.
  - verify: cross-origin fetch test against both hosts; assert `server.allowedHosts` is not `true`/`all`.
  - landed:

## Unit 11: Reviewer onboarding — Lane A

- [ ] 11.1 Open-from-PR path (deps: 7.1, 7.2, est: ~1w)
  - why: the branch artifact is JSON, so a reviewer who only opens the PR sees a payload. Getting them from a PR link to rendered prose is not a convenience — it is the only way the feature works.
  - acceptance: R-11.1 — PR body carries repo/branch/document and the command to open it; R-11.2 — opening by PR reference fetches canonical JSON and renders it with no prior local copy; R-11.3 — works with read-only credentials; R-11.4 — missing read access reported specifically; R-11.5 — the reviewer's own GitHub identity shown so attribution is never a surprise.
  - verify: SC-4 — two machines, two credentials, one read-only; the read-only participant completes open → read → comment.
  - landed:

---

## Notes

- **`title` vs `frontmatter.title` precedence** is undecided (LLD Open Questions). Pick a winner during 1.1 or the two will disagree within a week.
- **Publish cannot run headlessly.** The apply agent must end with "ready to publish" and hand back — 7.3 should surface that affordance, or documents will silently sit unpublished.
- **The ~400-line in-repo Markdown emitter stays unbuilt.** It is the escape hatch if unattended/CI publish is ever required. If built, it must never sit on the publish path (a byte-equality veto turns every Luthor upgrade into an outage) — CI differential test only, using `canonicalizeMarkdown` (`ui/luthor-bridge.ts:44`) as the oracle.
- **Rate limits** (~80 content-creating requests/min) are not addressed by any story above. Bulk comment sync should batch; revisit if 5.1 shows throttling.
