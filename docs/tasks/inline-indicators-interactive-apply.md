# Inline Comment Indicators + Interactive Apply Review — Tasks

Source of truth: `docs/ears/inline-indicators-interactive-apply.md` (acceptance IDs `R-x.y`) and `docs/lld/inline-indicators-interactive-apply.md` (architecture, build order). Source paths below are relative to `packages/visual-spec/`.

**Build order:** Subsystem A (indicators) is independent frontend and can ship on its own. Subsystem B (interactive review) builds the **proven fallback write path first**; the single-session in-place write is an optimization gated behind the transport spike (0.1). The shared `RunLock` (B1.1) is the one edit to existing bulk-apply code.

---

## Phase 0: De-risk

- [ ] 0.1 Transport spike — persistent stream-json multi-turn + plan-mode no-write (est: ~4h)
  - why: The single-session write path rests on two behaviors that are documented-but-unverified against the bare CLI; proving them (or not) before building B decides whether the optimization is viable and whether the Agent-SDK rejection stands (LLD Key Decisions).
  - acceptance: throwaway script spawns `claude --print --input-format stream-json --output-format stream-json --permission-mode plan`, writes two user messages, and confirms (a) the process survives its first `result` frame, (b) the second message is answered, (c) no file is written.
  - verify: record the three outcomes in the LLD Key Decisions block; if any fail, mark story 6.4 (single-session optimization) out of scope and keep the fallback as the only write path.

---

## Subsystem A — Inline indicators (View mode)

- [x] A1.1 Extract shared target→element resolver (est: ~40m)
  - why: `locate()` and `locateLine()` already resolve a `CommentTarget` to a DOM element/range; the indicator layer needs the same resolution, so factor it out once instead of duplicating drift-prone selector logic.
  - acceptance: a single resolver returns the anchor element(s) for a `CommentTarget` in markdown (`[data-vs-loc^="line:"]` + snippet/heading fallback) and code (`[data-line]`) views; `locate()`/`locateLine()` call it with behavior unchanged.
  - verify: existing `comment-history.integration.test` and locate behavior still pass; unit test the resolver for markdown line, markdown heading-fallback, and code-line cases.

- [x] A1.2 Indicator layer — Markdown View (deps: A1.1, est: ~1.5h)
  - why: give the reader in-context awareness of pending feedback in markdown without touching the sidebar (HLD goal 1).
  - acceptance: R-1.1, R-1.3, R-1.4, R-1.7, R-1.9 — render one indicator per open comment on the current file, anchored via `data-vs-loc`, sourced from `useComments(path)`, visually distinct from `flash()`/selection frames, omitting unresolvable targets without error.
  - verify: open a markdown file with several open comments; indicators appear on the right blocks with the sidebar closed; a deliberately drifted comment renders no indicator and throws nothing.

- [x] A1.3 Indicator layer — Code View (deps: A1.1, est: ~1h)
  - why: same contextual awareness for non-markdown/code files, which use a different anchor (`data-line`).
  - acceptance: R-1.2 — render indicators on code rows whose `data-line` matches each open comment's `startLine`.
  - verify: open a code file with open comments; indicators sit on the correct rows/gutter.

- [x] A1.4 Per-line aggregation + count (deps: A1.2, A1.3, est: ~30m)
  - why: multiple comments on one line must not stack into visual noise.
  - acceptance: R-1.5 — collapse multiple open comments on the same line into one indicator showing the count.
  - verify: two comments on the same line render one indicator badged "2".

- [x] A1.5 Position tracking + performance (deps: A1.2, A1.3, est: ~1h)
  - why: indicators must stay glued through scroll/reflow/edits without the per-indicator rAF jank the overlay's few-frame approach would cause at scale (LLD note).
  - acceptance: R-1.6 — a single shared rAF loop (and/or `IntersectionObserver` for on-screen anchors) keeps all indicators aligned as layout shifts.
  - verify: scroll/resize a large file with many open comments; indicators track smoothly; profile shows one batched loop, not N.

- [x] A1.6 Edit-mode suppression (est: ~20m)
  - why: WYSIWYG/CodeMirror have no loc anchors and are explicitly out of scope; indicators must not attempt to render there.
  - acceptance: R-1.8 — no inline indicators in WYSIWYG or Source edit modes.
  - verify: switch a markdown file to each Edit engine; no indicators render.

- [x] A1.7 Reactivity — set change, active review, refetch consistency (deps: A1.2, A1.3, est: ~40m)
  - why: the indicator set must stay truthful as comments change, including while a review is mid-flight and when `use-comments` refetches on tab focus/visibility.
  - acceptance: R-1.10, R-1.11, R-1.12 — indicators update when the open set changes, remain for an in-review-but-still-`open` comment, and stay consistent with the sidebar across focus/visibility refetches.
  - verify: add/remove a comment and confirm live update; start a review and confirm the indicator persists; trigger a refetch (tab blur/focus) and confirm no desync.

## Subsystem A — Reverse navigation (document → sidebar)

- [x] A2.1 Active-comment state + indicator→sidebar navigation (deps: A1.2, A1.3, est: ~1.5h)
  - why: today navigation only goes sidebar→document (`locate()`); clicking an indicator needs the inverse so the sidebar remains the management surface while the document points into it (HLD goal 2).
  - acceptance: R-2.1, R-2.2, R-2.3, R-2.4, R-2.5 — clicking an indicator sets the active comment, scrolls+highlights it in the sidebar, surfaces all comments for a multi-comment line, keeps sidebar management intact, and leaves `locate()` unchanged.
  - verify: click an indicator → sidebar scrolls to and highlights the comment; click a "2" indicator → both comments are reachable; existing `locate()` still works.

---

## Subsystem B — Session infrastructure

- [ ] B1.1 Shared RunLock + wire into ApplyHub (est: ~1h) (mutex: apply-hub)
  - why: the two hubs otherwise hold independent private `running` flags and could run concurrently, racing the sidecar; one shared lock is what actually makes review⇄apply mutual exclusion true (LLD; blocking issue #3).
  - acceptance: R-8.4, R-8.5, R-3.4 — a shared `RunLock` module both hubs consult; `ApplyHub.start` acquires it and 409s if held, with a body naming the holder; existing bulk-apply behavior otherwise unchanged.
  - verify: acquire the lock manually, then `POST /apply/start` → 409 identifying the holder; release → apply proceeds; existing apply tests pass.

- [ ] B1.2 ReviewHub + `/__vs/review/*` routes + SSE (deps: B1.1, est: ~2h) (mutex: server-routes)
  - why: the interactive flow needs the ephemeral session container and the transport surface the one-shot apply lacks (LLD Subsystem B).
  - acceptance: R-3.5, R-3.6, R-8.1, R-8.2, R-8.6 — a single-session in-memory hub; routes `events`(SSE, sync-replay first frame)/`start`/`message`/`approve`/`cancel` registered in **both** `md-plugin.ts` and `server.ts`; output parsed by the shared `summarize()` reader.
  - verify: subscribe to `/__vs/review/events` in dev and prod builds; first frame is a `sync` snapshot; routes resolve in both servers.

- [ ] B1.3 Spawn persistent stream-json session (plan mode, stdin piped, replay) (deps: B1.2, est: ~1.5h)
  - why: propose must be a multi-turn, read-only-enforced process — the piped stdin is the missing in-channel and plan mode is the real edit gate (LLD; blocking issue #1).
  - acceptance: R-3.3, R-3.7, R-8.3, R-8.7, R-4.7 — spawn `claude --print --input-format stream-json --output-format stream-json --replay-user-messages --permission-mode plan` with `stdio:['pipe','pipe','pipe']`; edit tools unavailable at the permission layer; user turns echo into the transcript; no file written during propose.
  - verify: start a session, observe the transcript stream; attempt/observe that no edit tool is available; confirm zero disk writes in propose.

## Subsystem B — Propose phase

- [ ] B2.1 `buildReviewPrompt` + structured proposal envelope (deps: B1.3, est: ~1.5h)
  - why: the proposal fields must be populated deterministically (not prose-parsed) so R-4.1–R-4.6 are testable (LLD; review rec #6).
  - acceptance: R-4.1, R-4.2, R-4.3, R-4.4, R-4.5, R-4.6 — prompt resolves the comment by snippet+heading and elicits interpretation/strategy/reasoning/assumptions/alternatives(when identified)/expected diff/impact, emitted against a pinned `--json-schema` envelope surfaced as a `proposal` event.
  - verify: unit-test that a session produces a `proposal` frame with all fields populated and a diff block; alternatives appear only when the model identifies them.

- [ ] B2.2 Start propose — no disk write, comment stays open (deps: B2.1, est: ~40m)
  - why: selecting Apply Comment must open a reviewable proposal, not mutate the document (HLD goal 3).
  - acceptance: R-3.1, R-3.2 — `POST /review/start {commentId}` begins propose, writes nothing to disk, keeps the comment `open`.
  - verify: click Apply Comment → proposal streams; the target file's bytes and the comment's `status` are unchanged.

## Subsystem B — Refine

- [ ] B3.1 Follow-up turns / iterative refinement (deps: B2.2, est: ~1h)
  - why: the user must be able to steer the proposal until satisfied (HLD goal; Unit 5).
  - acceptance: R-5.1, R-5.2, R-5.3, R-5.4 — `POST /review/message {text}` delivers a turn to the child; an updated proposal streams back; multiple turns supported; while awaiting input the session indicates waiting and applies nothing.
  - verify: send a refinement message → an updated `proposal` frame arrives; no disk write between turns.

## Subsystem B — Approve & write

- [ ] B4.1 Approve → write via scoped apply pass (fallback path) (deps: B3.1, B1.1, est: ~1.5h)
  - why: this is the **proven primary write path** — reuse the tested `/apply/start {ids:[id]}` mechanics so approval reliably lands the change and records it like any applied comment (LLD build-order; review rec #1).
  - acceptance: R-6.1, R-6.2, R-6.4, R-6.5, R-6.6 — write only after explicit approval; apply the specific approved proposal; flip `status→applied` with a non-empty `result` in one update; refresh document + sidebar; release the shared lock on completion.
  - verify: approve → file changes on disk; comment shows `applied` + result; document and sidebar refetch; lock released (next apply/review can start).

- [ ] B4.2 Stale-diff reconciliation / drift gate (deps: B4.1, est: ~1h)
  - why: the file can change between propose and approve (sidecar mutated out-of-band; fallback regenerates), so a stale diff must not be applied silently (LLD; blocking issue #2).
  - acceptance: R-6.3 — before writing, re-resolve the target by snippet+heading; if it drifted or content changed since the approved proposal, emit a `drift` event and require re-approval instead of applying.
  - verify: modify the target between propose and approve → approval surfaces drift and does not write until re-approved.

- [ ] B4.3 Single-session in-place write (optimization) (deps: 0.1, B4.1, est: ~1.5h)
  - why: if the spike proved it viable, writing within the same session on approval avoids a re-invocation and preserves session/tool state.
  - acceptance: R-6.1, R-6.2 satisfied via in-session write authorized on approval; subject to the same drift gate (B4.2). **Out of scope if spike 0.1 failed.**
  - verify: approve within one session → change written without a second `claude` spawn; drift gate still enforced.

## Subsystem B — Lifecycle & safety

- [ ] B5.1 Cancel, ephemerality, slot release on all exit paths (deps: B1.3, est: ~1.5h)
  - why: abandoning or crashing a review must be safe and must never wedge the single slot until restart (LLD; blocking issue #4).
  - acceptance: R-7.1, R-7.2, R-7.3, R-7.4, R-7.5, R-7.6, R-7.7, R-7.8 — cancel SIGKILLs and leaves file+comment unchanged; state is memory-only; unexpected exit reports an error and changes nothing; idle/abandoned session (no subscriber, no input for N min) is terminated; `message`/`approve` after child death returns a status distinct from "no session"; the lock releases on every terminal path.
  - verify: cancel mid-propose → no write, lock free; close the only tab → session self-terminates after the idle bound; kill the child and send `message` → distinct dead-session status; no persisted proposal survives a server restart.

---

## Subsystem B — Review UI

- [ ] B6.1 Review view — stream proposal/diff, follow-up input, approve/cancel (deps: B2.2, B3.1, B4.1, B5.1, est: ~2.5h)
  - why: the collaborative review needs a surface to read the proposal + diff, iterate, and explicitly approve — the user-facing half of Subsystem B (HLD goals 4–6).
  - acceptance: R-4.1–R-4.6 rendered (proposal + streamed diff), R-5.x follow-up input wired to `POST /message`, R-6.1 approval gated behind an explicit action, R-6.5 refresh via `vs:comments-changed`/`vs:source-changed`, drift (R-6.3) surfaced for re-approval.
  - verify: end-to-end — Apply Comment → read proposal/diff → refine → approve → file + sidebar update; cancel path leaves everything untouched.

---

## Dependency summary

- **Independent track (ships alone):** A1.1 → {A1.2, A1.3} → {A1.4, A1.5, A1.7, A2.1}; A1.6 standalone.
- **Backend track:** 0.1 (spike) ‖ B1.1 → B1.2 → B1.3 → B2.1 → B2.2 → B3.1 → B4.1 → {B4.2, B4.3(needs 0.1)} ; B5.1 after B1.3.
- **UI track:** B6.1 last (needs B2.2, B3.1, B4.1, B5.1).
- **Mutex `apply-hub`:** B1.1 (edits existing `apply.ts`). **Mutex `server-routes`:** B1.2 (edits `md-plugin.ts` + `server.ts`).
- Private technical scratch: `.devlocal/<user>/<story-id>/scratchpad.md`.
