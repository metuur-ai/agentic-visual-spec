# Local File Creation and Rename — Tasks

> Source specs: `docs/ears/local-file-creation.md`, `docs/lld/local-file-creation.md`,
> `docs/hld/local-file-creation.md`. Build order: transport foundation (Unit 4) →
> write guard + create (Unit 1) → tree freshness (Unit 3) → rename (Unit 2) →
> parity tests (Unit 4 tail) → UI (Unit 5).
>
> Unit 4 goes first on purpose. Two of its stories fix defects that already exist
> in the hosts (`/__vs/*` falling through to the SPA shell, and the standalone host
> not parsing a request body on `/__vs/tree`). Building the routes on top of either
> one produces a feature that works under Vite and fails on the CLI.

## Unit 4: Host parity and transport — foundation

- [x] 4.1 Answer 404 JSON for unmatched `/__vs/*` on both hosts (est: ~20m)
  - why: `src/server.ts:340` falls through to `serveStatic`, which SPA-falls-back to `index.html`, so any unimplemented `/__vs` path answers 200 with HTML. A client newer than its server gets `res.ok === true` and a JSON parse error instead of a reportable 404. Fixing it once covers both new routes and every future one.
  - acceptance: R-4.5 — a request to a `/__vs/` path no route handles answers 404 with a JSON body and does not serve the SPA shell, on the standalone host and the Vite host alike.
  - verify: request `/__vs/does-not-exist` against both hosts; assert status 404 and `content-type: application/json`. Assert a non-`/__vs` unknown path still SPA-falls-back to `index.html`.
  - landed: eb30bf8 — src/server.ts, core/vite/md-plugin.ts, core/vite/host-transport.test.ts

- [x] 4.2 Parse a JSON body for non-GET methods on `/__vs/tree` in the standalone host (est: ~15m)
  - why: `src/server.ts:214-218` calls `handleTree` with no body while the Vite host's `middleware` helper always calls `readJsonBody` (`md-plugin.ts:79`). Left alone, every create/rename POST returns 400 "missing path" on the CLI and works under Vite — R-4.1 violated before either route is written. The unread request stream can also stall a keep-alive connection.
  - acceptance: R-4.2 — the standalone host reads and parses a JSON request body for non-GET methods on `/__vs/tree` before dispatching.
  - verify: POST a JSON body to `/__vs/tree/<anything>` on the standalone host and assert the handler received it (a 400 naming a *field*, not a missing body). Assert GET is unaffected.
  - landed: eb30bf8 — src/server.ts, core/vite/md-plugin.ts, core/vite/host-transport.test.ts

- [x] 4.3 Freeze `core/vite/routes/` as host-agnostic with an import-graph test (est: ~20m)
  - why: the directory is already the shared route layer — `src/server.ts` imports five modules from it and none of them import `vite` — but nothing enforces that. The new write routes go there, and a `vite` import creeping in would break the standalone host at build time, not at review time. `core/import-graph.ts` already exists for this class of assertion.
  - acceptance: R-4.6 — no module under `core/vite/routes/` imports `vite`.
  - verify: walk the import graph from each file under `core/vite/routes/` and assert `'vite'` is unreachable. Confirm the test fails when a `vite` import is added temporarily.
  - landed: b8bf0a8 — core/vite/routes/routes-host-agnostic.test.ts

## Unit 1: Creating a file

- [x] 1.1 Add `resolveForWrite` to `TreeStore` — string guard plus symlink guard (deps: none, est: ~40m)
  - why: `resolve` (`tree-store.ts:139-140`) validates with `resolve()` + `startsWith`, which is string-level only. A symlink inside the served directory pointing outside passes it, and for a route that runs `mkdir -p` that is arbitrary directory creation outside the workspace. `realpath(target)` cannot fix it — the target does not exist yet — and calling it after `mkdir` is too late, because `mkdir` already followed the link. This must live beside `resolve`, not in the handler: two answers to "what may this server write" is what the shared-module rule exists to prevent.
  - acceptance: R-1.5 — a target resolving outside the served directory by traversal, by being absolute, or through a symlink that leaves it, is refused; R-1.6 — the check resolves the deepest *existing* ancestor of the target to its real path and compares against the real path of the served directory, before any directory is created.
  - verify: unit tests in `tree-store.test.ts` — `../escape.md`, `/etc/passwd`, and a path under a symlink pointing at a temp dir outside base all throw; a legitimate nested path returns a guarded absolute path. Assert the symlink case creates nothing on disk.
  - landed: eb30bf8 — core/vite/tree-store.ts, core/vite/tree-store.test.ts

- [x] 1.2 Create `core/vite/routes/files.ts` with `POST /__vs/tree/create` validation (deps: 1.1, est: ~35m)
  - why: the validation half decides the entire set of paths a browser can cause to be written. Splitting it from the write half keeps the refusals testable without touching the filesystem.
  - acceptance: R-1.1 — the route exists and accepts `{ path: string }`; R-1.2 — missing or empty `path` answers 400 with no disk write; R-1.3 — a path with no extension gets `.md` appended; R-1.4 — a non-`.md` extension answers 400 naming the extension it refused, without rewriting it.
  - verify: handler unit tests over a temp directory for each refusal; assert the directory is byte-identical afterwards. Assert `notes/kickoff` becomes `notes/kickoff.md` and `notes/kickoff.txt` is refused with `.txt` in the message.
  - landed: b8bf0a8 — core/vite/routes/files.ts, core/vite/routes/files.test.ts

- [x] 1.3 Complete create: collision, atomic write, seed (deps: 1.2, est: ~35m)
  - why: `stat` alone is a TOCTOU — two tabs, or a tab and a terminal, can both see ENOENT and both write, and R-1.7's promise that the existing bytes are unchanged breaks. `stat` produces the human-readable message and `wx` closes the window; both are needed, and `wx` sits after every refusal so the read-before-write ordering is intact.
  - acceptance: R-1.7 — an existing file answers 409 naming the collision, bytes unchanged; R-1.8 — concurrent requests for the same path let at most one create it and answer the other 409; R-1.9 — on success, missing parents are created, the file is written, and 200 carries the created posix path and the root; R-1.10 — the file is seeded `# <basename without extension>` plus a blank line; R-1.11 — a write failure after `mkdir` is reported and may leave the directories.
  - verify: create `notes/2026/kickoff.md` in an empty temp dir → both directories exist, content is `# kickoff\n\n`, and `titleFromMarkdown` on it returns `kickoff`. Fire two creates for one path concurrently and assert exactly one 200 and one 409. Re-create an existing file and assert its bytes are untouched.
  - landed: b8bf0a8 — core/vite/routes/files.ts, core/vite/routes/files.test.ts

- [x] 1.4 Wire the create route into both hosts (deps: 1.3, 4.1, 4.2, est: ~20m)
  - why: a shared handler that only one host reaches is the same drift the shared module was meant to prevent, and nothing in the suite would fail.
  - acceptance: R-4.1 (create half) — an identical request to either host against an identical directory produces identical status, identical body and identical on-disk result.
  - verify: run the same create against both hosts over the same temp directory fixture; diff status, body and the resulting file bytes.
  - landed: c352139 — src/server.ts, core/vite/md-plugin.ts, core/vite/host-parity.test.ts

## Unit 3: Freshness of the tree

- [x] 3.1 Add optional `invalidate()` to `TreeStore` and call it after a successful write (deps: 1.3, est: ~30m)
  - why: `tree-store.ts:125` caches the walk for 3000ms and drops it only when the store is rebuilt. Without this, a successful create clears the *client* cache, refetches immediately, and the server answers with the stale walk — the new file is missing from the tree for up to three seconds, non-deterministically. That is "I created it and it vanished" arriving by a different door. The member is optional because `TreeStore` is published via `core/vite/index.ts` and a required addition breaks external implementations; `CommentDocStore` in `routes/comments.ts` set this precedent.
  - acceptance: R-3.1 — a successful create or rename discards the store's cached walk; R-3.2 — a tree read immediately after a create includes the created file.
  - verify: create a file, then read the tree with no delay, and assert the file is present. Assert the same test fails when the `invalidate()` call is removed — the guard is worthless if it passes either way.
  - landed: eb30bf8 — core/vite/tree-store.ts, core/vite/tree-store.test.ts; wired in b8bf0a8 (routes/files.ts)

- [x] 3.2 Confirm rename freshness through the same invalidation (deps: 3.1, 2.2, est: ~10m)
  - why: rename changes two tree entries at once; a stale walk shows the file under both names or neither.
  - acceptance: R-3.3 — a tree read immediately after a rename includes the new path and does not include the old one.
  - verify: rename, read the tree with no delay, assert new path present and old path absent.
  - landed: b8bf0a8 — core/vite/routes/files.ts, core/vite/routes/files.test.ts

## Unit 2: Renaming a file

- [x] 2.1 Add `POST /__vs/tree/rename` validation (deps: 1.2, est: ~30m)
  - why: rename exists so a mistyped name does not send the author back to the terminal this whole feature was built to avoid. Its validation reuses create's, so it is a thin layer rather than a second set of rules.
  - acceptance: R-2.1 — the route accepts `{ from, to }`; R-2.2 — R-1.4/R-1.5/R-1.6 apply to `to`, and R-1.5/R-1.6 to `from`; R-2.3 — a missing `from` answers 404 and a non-regular-file `from` answers 400, neither modifying the filesystem; R-2.10 — a directory `from` is refused.
  - verify: handler tests for each refusal over a temp directory; assert the directory is unchanged afterwards in every case.
  - landed: b8bf0a8 — core/vite/routes/files.ts, core/vite/routes/files.test.ts

- [x] 2.2 Move the file non-destructively (deps: 2.1, est: ~25m)
  - why: `fs.rename` **overwrites the destination silently**. This feature's guarantee is that it cannot destroy a file, and `rename` cannot provide it. `link` fails `EEXIST` atomically, then `unlink` removes the source.
  - acceptance: R-2.4 — an existing `to` answers 409 with both files unchanged; R-2.5 — the move uses an operation that fails when the destination exists and never one that overwrites silently; R-2.8 — success answers 200 with the new posix path.
  - verify: rename `a.md`→`b.md` and assert `b.md` holds the original bytes and `a.md` is gone. Rename onto an existing `c.md` and assert 409 with both files byte-identical to before. Assert no code path in the module calls `fs.rename`/`fs.promises.rename`.
  - landed: b8bf0a8 — core/vite/routes/files.ts, core/vite/routes/files.test.ts

- [x] 2.3 Carry the review across the rename (deps: 2.2, est: ~35m, mutex: comment-doc)
  - why: comments are pinned to `target.path`. A rename that does not rewrite the sidecar orphans the entire review of that document — the records survive pointing at a path that no longer exists, and the apply run cannot resolve them. This is why the handler takes the comment store as an argument.
  - acceptance: R-2.6 — every record whose `target.path` equals `from` is rewritten to `to` with every other field preserved; R-2.7 — every record whose path does not equal `from` is preserved untouched.
  - verify: sidecar with comments on `a.md` (open and applied, with `result` set) plus comments on an unrelated file; rename `a.md`→`b.md`; assert the `a.md` records now read `b.md` with `id`, `status`, `comment`, `result` and `target` sub-fields intact, and the unrelated records are byte-identical.
  - landed: b8bf0a8 — core/vite/routes/files.ts, core/vite/routes/files.test.ts

- [x] 2.4 Assert no delete operation is reachable (deps: 2.2, est: ~10m)
  - why: delete is an explicit Non-Goal with an Open Question behind it. A guard makes that a property of the code rather than a note in a document someone stops reading.
  - acceptance: R-2.9 — no exposed operation deletes a file.
  - verify: assert `handleFilesRequest` exposes only `create` and `rename`, and that the module's only `unlink` call is the source-removal half of rename.
  - landed: b8bf0a8 — core/vite/routes/files.test.ts

## Unit 4: Host parity and transport — guards

- [x] 4.4 Assert host parity for both write routes (deps: 1.4, 2.2, est: ~25m)
  - why: `core/bundle-guard.test.ts:66-77` already asserts cross-host invariants by reading both hosts' source, so this extends a convention the team chose rather than inventing one. Without it, wiring only one host passes the suite.
  - acceptance: R-4.1 — identical requests to either host produce identical status, body and on-disk result, for create and rename.
  - verify: extend the existing `HOSTS` block to assert each host imports the shared handler and declares no local create/rename implementation, plus a live parity run of both routes against both hosts.
  - landed: c352139 — core/bundle-guard.test.ts, core/vite/host-parity.test.ts

- [x] 4.5 Put both write routes behind the cross-origin guard and its attestation (deps: 1.4, 2.2, est: ~30m)
  - why: `/__vs` is an unauthenticated localhost server, and these routes write to a path the caller chooses. The guard is inherited by middleware registration order, and the collaboration dispatch already refuses outright unless it can *prove* the guard ran (`src/server.ts:323`, `md-plugin.ts:311`) rather than trusting that ordering never breaks. The same reasoning applies here.
  - acceptance: R-4.3 — `Sec-Fetch-Site` of `cross-site` or `same-site`, or a non-loopback `Host`, is rejected before the handler runs with no filesystem access; R-4.4 — a request that cannot prove the guard ran is refused, as the collaboration dispatch does.
  - verify: raw requests to both routes with each rejected header shape; assert the refusal and that the temp directory is unchanged. Assert the attestation check refuses when the guard is bypassed. Note `same-site` is rejected too (`request-guard.ts:48`), not only `cross-site`.
  - landed: c352139 — src/server.ts, core/vite/md-plugin.ts, core/vite/host-parity.test.ts

## Unit 5: The file-tree controls

- [x] 5.1 Add the "New file" control and its inline input (deps: 1.4, est: ~35m)
  - why: the tree is the only place the user sees the workspace, so it is where a file is added. An inline input rather than a modal because it is one field, and the tree column is already the right width for a path.
  - acceptance: R-5.1 (create half) — the tree presents a "New file" control; R-5.2 — activating it presents an inline single-line path input in the tree column; R-5.3 — submitting a non-empty path issues the create request.
  - verify: component test — activate, type `notes/kickoff.md`, submit, assert `POST /__vs/tree/create` with that path. Note the filter input lives in `ui/App.tsx:269` and `FileTree` receives `filter` as a prop, so "beside the filter" is a layout question for `App.tsx`.
  - landed: d807f65 — ui/file-tree.tsx, ui/App.tsx, ui/file-tree-write.test.tsx

- [x] 5.2 Close the loop on a successful create (deps: 5.1, 3.1, est: ~25m)
  - why: a created file the user must reload to see has not removed the terminal round trip this feature exists to remove. Landing in edit mode is what "ready to edit" in the HLD means.
  - acceptance: R-5.4 — success invalidates the client tree, opens the created path in the main pane, and puts that pane in edit mode; R-5.6 — success dismisses the inline input and clears its value.
  - verify: component test with a stubbed 200 — assert `invalidateTree()` ran, the pane navigated to the new path, the mode is `edit`, and the input is gone.
  - landed: d807f65 — ui/App.tsx, ui/use-tree.ts, ui/file-tree-write-app.test.tsx

- [x] 5.3 Add the per-row rename control and close its loop (deps: 5.1, 2.2, est: ~35m)
  - why: rename is only useful where the file is — on its row — and prefilling the current path means fixing a typo is an edit, not a retype.
  - acceptance: R-5.1 (rename half) — each file row presents a rename control; R-5.2 — the inline input is prefilled with the current path; R-5.5 — success invalidates the client tree and keeps the pane on the renamed document under its new path; R-5.6 — the input is dismissed and cleared.
  - verify: component test — activate rename on a row, assert the input holds that row's path, submit a new path, assert `POST /__vs/tree/rename` with `{from,to}` and that the pane follows the document to `to`.
  - landed: d807f65 — ui/file-tree.tsx, ui/App.tsx, ui/file-tree-write.test.tsx, ui/file-tree-write-app.test.tsx

- [x] 5.4 Report failures in the server's own words, and block double submits (deps: 5.1, 5.3, est: ~25m)
  - why: every refusal in Units 1 and 2 is written to be read by a human — naming the extension, the collision, the escape. Flattening them into "could not create file" throws all of that away, and keeping the typed path means the user corrects rather than retypes.
  - acceptance: R-5.7 — a failure renders the server's message verbatim beneath the input, keeps the typed path, and substitutes no generic message; R-5.8 — the submit control is disabled while a request is in flight; R-5.9 — dismissing the input without submitting issues no request.
  - verify: component tests with stubbed 400/409 responses — assert the exact server string appears and the input still holds what was typed. Assert a second submit during flight issues no second request. Assert dismissal issues none.
  - landed: d807f65 — ui/file-tree.tsx, ui/file-tree-write.test.tsx

- [x] 5.5 Confirm a created file is a first-class citizen (deps: 5.2, est: ~20m)
  - why: the HLD names the apply flow as a stakeholder — a comment can target a document that did not exist yet. A create that produces a file the rest of the tool treats as second-class would satisfy every other requirement and still fail the point.
  - acceptance: R-5.10 — comments are accepted against a created file's path on the same terms as any pre-existing file.
  - verify: end-to-end over a temp directory — create a file, add a comment against it via `POST /__vs/comments/add`, read it back scoped to that path, and confirm it appears in the open set the apply prompt is built from.
  - landed: d807f65 — core/vite/routes/created-file-citizenship.test.ts
