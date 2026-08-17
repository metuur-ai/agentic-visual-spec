# Comment History — Tasks

> Source specs: `docs/ears/comment-history.md`, `docs/lld/comment-history.md`,
> `docs/hld/comment-history.md`. Build order: data layer (Unit 2) → write path
> (Unit 1) → UI (Units 3, 4) → availability (Unit 5).

## Unit 2: Data model & persistence

- [x] 2.1 Add `result` field to `CommentRecord` and preserve it across parse/serialize (est: ~20m)
  - why: the summary must be a durable, backward-compatible part of the record; the LLD found `upgrade()`'s legacy `{file, anchor}` branch would silently drop it.
  - acceptance: R-2.1 — `CommentRecord` includes optional `result: string`; R-2.2 — `result` survives parse→serialize for both `target`-shaped and legacy records (legacy branch at `comment-doc.ts:77-87` copies `result`); R-2.3 — a record without `result` parses without error; R-2.7 — no write drops/corrupts other records.
  - verify: unit test in `comment-doc.test.ts` round-trips a new-shape and a legacy record each with/without `result`; assert `result` preserved and absent-case parses clean.

- [x] 2.2 Extend `setStatus` to write `result` atomically with the status flip (deps: 2.1, est: ~10m, mutex: comment-doc)
  - why: applying a comment must record the outcome in the same operation that marks it applied — no second write, no partial state.
  - acceptance: R-2.4 — `setStatus(doc, id, status, result?)` writes `result` onto the record when provided (current `comment-doc.ts:114-118` spreads only `{ ...c, status }`).
  - verify: unit test — `setStatus(doc, id, 'applied', 'summary')` yields a record with `status:'applied'` and `result:'summary'`; omitting `result` leaves any existing value untouched.

- [x] 2.3 Forward `result` through the `PATCH /__vs/comments/{id}` route (deps: 2.2, est: ~10m)
  - why: gives the server fallback and any programmatic/manual correction a safe API channel to set the summary without editing the JSON by hand.
  - acceptance: R-2.5 — a PATCH body containing `result` is forwarded to `setStatus` and persisted (today `comments.ts:122` passes no result).
  - verify: route test in `comments.test.ts` — PATCH `{status:'applied', result:'x'}` then GET the doc shows `result:'x'` on that id.

- [ ] 2.4 Confirm applied records are never deleted by a history operation (deps: 2.1, est: ~10m)
  - why: the applied set IS the audit trail; the history feature must not introduce a delete path over it.
  - acceptance: R-2.6 — no history read/render path calls `removeComment` on an applied record.
  - verify: test asserts the history read path is pure (no mutation); grep confirms `removeComment` is only reachable from the existing open-comment Delete affordance.

## Unit 1: Result capture on apply

- [ ] 1.1 Extend `buildApplyPrompt` with the `result` write-contract instruction (deps: 2.1, est: ~15m)
  - why: the agent authoring the summary is the primary source; the write must be pinned so it can't reshape the record or corrupt the sidecar (LLD data-integrity risk).
  - acceptance: R-1.1/R-1.2 — prompt tells the agent to write a non-empty 1–2 line `result` summarizing request + change; R-1.3 — write `result` as a string on the same record, same edit as `status`, preserve all other fields, keep JSON valid; R-1.4 — hand-offs to another workflow still record a `result`.
  - verify: `apply-prompt` unit test asserts the generated prompt contains the `result` field name, the "same edit / preserve fields / valid JSON" contract, and the hand-off clause.

- [ ] 1.2 Add server fallback in `runApply` to stamp a minimal `result` when the agent omits one (deps: 2.3, est: ~25m)
  - why: guarantees a history entry is never blank without trusting the LLM alone — the reliability net behind the agent write.
  - acceptance: R-1.5 — after a run, any comment that flipped to `applied` but has no `result` gets a minimal server-stamped summary (e.g. "Applied (no summary recorded)") via the PATCH/`setStatus` path; the run does not fail.
  - verify: `apply` test with a fake spawn that flips status but writes no `result`; assert the post-run sidecar has a non-empty `result` on that comment.

## Unit 3: History list in the comment panel (per-document)

- [ ] 3.1 Add a separate applied-history list to `CommentPanel`, kept distinct from the open list (deps: 2.1, est: ~25m)
  - why: reviewers work in the panel; a separate applied list gives per-document history in-flow without mixing states (the user's "different list").
  - acceptance: R-3.1 — applied comments render as a list separate from the open list; R-3.2 — history includes only `target.path === current && status === 'applied'`; R-3.3 — open list stays `status === 'open'` only; R-3.9 — an applied comment leaves the open list and appears in history on next refresh.
  - verify: component/DOM test with a fixture doc (mixed open/applied on this + other paths) asserts each comment lands in exactly one list and other-path comments are excluded.

- [ ] 3.2 Render history entries with ordering, summary, anchor fallback, placeholders, and empty state (deps: 3.1, est: ~30m)
  - why: an audit trail is only readable if it's ordered and every entry renders even when data is partial (legacy anchors, missing summaries, empty docs).
  - acceptance: R-3.4 — ordered by `ts`, most-recent-first; R-3.5 — each entry shows anchor (heading/line) + `comment` + `result`; R-3.6 — missing `result` renders "—"; R-3.7 — missing/unresolvable anchor falls back to `path`; R-3.8 — empty document shows a defined empty state.
  - verify: render test covers newest-first order, a "—" summary, a folder/legacy entry showing `path`, and the empty-state string.

## Unit 4: History entry point in the header

- [ ] 4.1 Add a labelled header control opening the document-scoped history view (deps: 2.1, 3.2, est: ~30m)
  - why: the editor doesn't mount `CommentPanel` (`App.tsx:116`), so the shared header (`App.tsx:107`, both modes) is the guaranteed entry point; reuses the list component from 3.2.
  - acceptance: R-4.1 — a labelled header control present in viewer and editor modes opens the history; R-4.2 — it shows applied comments for the current document only, filtered by the current `file`/`path` (header's `useComments()` is no-arg / all-files at `main-header.tsx:651`), each with request + result, newest-first.
  - verify: render test — header control mounts in both modes; opening it with a multi-file fixture shows only current-document applied comments in order.

- [ ] 4.2 Share the data source and empty state between header and panel views (deps: 4.1, est: ~15m)
  - why: two entry points must not drift or double-build; one source keeps them consistent.
  - acceptance: R-4.3 — header view and panel list source the same comment data (same applied set for a document); R-4.4 — empty document shows a defined empty state in the header view.
  - verify: test asserts identical applied sets rendered by both surfaces for the same fixture; empty-state string present when no applied comments.

## Unit 5: Availability in viewer and editor

- [ ] 5.1 Verify history reachability across viewer and editor (deps: 3.2, 4.1, est: ~15m)
  - why: the trail is only useful where users read/edit; both modes must reach it.
  - acceptance: R-5.1 — in view mode, reachable via panel list AND header control; R-5.2 — in edit mode, reachable via the header control.
  - verify: mode-switch test confirms the panel history list renders in view mode and the header control opens history in both view and edit modes.

- [ ] 5.2 Confirm cross-tab refresh and read-only behavior of the history views (deps: 3.1, 4.1, est: ~15m)
  - why: history must stay current without manual reload and must never mutate comments (it's an audit view).
  - acceptance: R-5.3 — history refreshes via the existing `vs:comments-changed` / window-focus mechanism (`use-comments.ts`) with no manual reload; R-5.4 — history views are read-only (no create/edit/delete).
  - verify: test dispatches `vs:comments-changed` and asserts the history list refetches; assert no mutation handlers (add/remove/patch) are wired into the history views.
