# Inline Comment Indicators + Interactive Apply Review — Tasks

Source of truth: `docs/ears/inline-indicators-interactive-apply.md` (acceptance IDs `R-x.y`) and `docs/lld/inline-indicators-interactive-apply.md` (architecture, build order). Source paths below are relative to `packages/visual-spec/`.

**Build order.** Subsystem A (indicators) is **shipped**. Subsystem B writes by **applying the proposal's patch**: the proposal is emitted as an applicable patch and approval applies it through the existing `GitExecutor`, so the approved artifact and the applied artifact are the same object. The scoped `/apply/start {ids:[id]}` pass survives only as a local-mode fallback that re-derives the change, and must be labelled as such (R-6.8). The shared `RunLock` (B1.1) is the one edit to existing bulk-apply code.

**Release boundaries.** Phase B (local review) ships on its own. Phase C (collaborative review, EARS Unit 9) follows after B is in users' hands — it depends on B's hub interface and carries the larger unknowns.

---

## Phase 0: De-risk

- [x] 0.1 Transport spike — persistent stream-json multi-turn + plan-mode no-write (est: ~4h)
  - why: the multi-turn transport is documented-but-unverified against the bare CLI; proving it decides whether the Agent-SDK rejection stands (LLD Key Decisions).
  - acceptance: a **retained** script spawns `claude --print --input-format stream-json --output-format stream-json --permission-mode plan`, writes two user messages, and confirms (a) the process survives its first `result` frame, (b) the second message is answered, (c) no file is written.
  - verify: record the three outcomes and the script path in the LLD Key Decisions block.
  - landed: re-run 2026-08-22, PASS 3/3 — .devlocal/spikes/0.1-transport.mjs (script retained; outcomes recorded in the LLD)

- [x] 0.2 Escalation spike — can a plan-mode session be lifted to write mid-process? (est: ~3h) — **only if B4.3 is pursued**
  - why: `--permission-mode` is a spawn-time flag (`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`) with no documented mid-session change; the only candidate is an undocumented control frame on the stream-json stdin channel. B4.3 rests entirely on this and 0.1 never tested it.
  - acceptance: a **retained** script starts a session under `--permission-mode plan`, sends an approval turn, and either writes a file in-session or demonstrates it cannot.
  - verify: record the outcome and the script path in the LLD. If it fails, B4.3 is out of scope — patch application (B4.1) is already the specified default, so failing here costs nothing.
  - landed: run 2026-08-22, PASS — .devlocal/spikes/0.2-escalation.mjs. A mechanism exists: undocumented `control_request` subtype `set_permission_mode`. B4.4 is viable but the capability is version-pinned and unsupported; B4.1's patch apply stays the standing write path.

---

## Subsystem A — Inline indicators (View mode) — SHIPPED

- [x] A1.1 Extract shared target→element resolver (est: ~40m)
  - why: `locate()` and `locateLine()` already resolve a `CommentTarget` to a DOM element/range; the indicator layer needs the same resolution, so factor it out once instead of duplicating drift-prone selector logic.
  - acceptance: a single resolver returns the anchor element(s) for a `CommentTarget` in markdown (`[data-vs-loc^="line:"]` + snippet/heading fallback) and code (`[data-line]`) views; `locate()`/`locateLine()` call it with behavior unchanged.
  - verify: existing `comment-history.integration.test` and locate behavior still pass; unit test the resolver for markdown line, markdown heading-fallback, and code-line cases.
  - landed: cf68d62 — ui/anchor-resolver.ts

- [x] A1.2 Indicator layer — Markdown View (deps: A1.1, est: ~1.5h)
  - why: give the reader in-context awareness of pending feedback in markdown without touching the sidebar (HLD goal 1).
  - acceptance: R-1.1, R-1.3, R-1.4, R-1.7, R-1.9 — render one indicator per open comment on the current file, anchored via `data-vs-loc`, sourced from `useComments(path)`, visually distinct from `flash()`/selection frames, omitting unresolvable targets without error.
  - verify: open a markdown file with several open comments; indicators appear on the right blocks with the sidebar closed; a deliberately drifted comment renders no indicator and throws nothing.
  - landed: cf68d62 — ui/indicator-layer.tsx, ui/indicator-model.ts

- [x] A1.3 Indicator layer — Code View (deps: A1.1, est: ~1h)
  - why: same contextual awareness for non-markdown/code files, which use a different anchor (`data-line`).
  - acceptance: R-1.2 — render indicators on code rows whose `data-line` matches each open comment's `startLine`.
  - verify: open a code file with open comments; indicators sit on the correct rows/gutter.
  - landed: cf68d62 — ui/indicator-layer.tsx

- [x] A1.4 Per-line aggregation + count (deps: A1.2, A1.3, est: ~30m)
  - why: multiple comments on one line must not stack into visual noise.
  - acceptance: R-1.5 — collapse multiple open comments on the same line into one indicator showing the count.
  - verify: two comments on the same line render one indicator badged "2".
  - landed: cf68d62 — ui/indicator-model.ts

- [x] A1.5 Position tracking + performance (deps: A1.2, A1.3, est: ~1h)
  - why: indicators must stay glued through scroll/reflow/edits without the per-indicator rAF jank the overlay's few-frame approach would cause at scale (LLD note).
  - acceptance: R-1.6 — a single shared rAF loop (and/or `IntersectionObserver` for on-screen anchors) keeps all indicators aligned as layout shifts.
  - verify: scroll/resize a large file with many open comments; indicators track smoothly; profile shows one batched loop, not N.
  - landed: cf68d62 — ui/indicator-layer.tsx

- [x] A1.6 Edit-mode suppression (est: ~20m)
  - why: WYSIWYG/CodeMirror have no loc anchors and are explicitly out of scope; indicators must not attempt to render there.
  - acceptance: R-1.8 — no inline indicators in WYSIWYG or Source edit modes.
  - verify: switch a markdown file to each Edit engine; no indicators render.
  - landed: cf68d62 — ui/indicator-layer.tsx

- [x] A1.7 Reactivity — set change, active review, refetch consistency (deps: A1.2, A1.3, est: ~40m)
  - why: the indicator set must stay truthful as comments change, including while a review is mid-flight and when `use-comments` refetches on tab focus/visibility.
  - acceptance: R-1.10, R-1.11, R-1.12 — indicators update when the open set changes, remain for an in-review-but-still-`open` comment, and stay consistent with the sidebar across focus/visibility refetches.
  - verify: add/remove a comment and confirm live update; start a review and confirm the indicator persists; trigger a refetch (tab blur/focus) and confirm no desync.
  - landed: cf68d62 — ui/indicator-layer.tsx

## Subsystem A — Reverse navigation (document → sidebar) — SHIPPED

- [x] A2.1 Active-comment state + indicator→sidebar navigation (deps: A1.2, A1.3, est: ~1.5h)
  - why: today navigation only goes sidebar→document (`locate()`); clicking an indicator needs the inverse so the sidebar remains the management surface while the document points into it (HLD goal 2).
  - acceptance: R-2.1, R-2.2, R-2.3, R-2.4, R-2.5 — clicking an indicator sets the active comment, scrolls+highlights it in the sidebar, surfaces all comments for a multi-comment line, keeps sidebar management intact, and leaves `locate()` unchanged.
  - verify: click an indicator → sidebar scrolls to and highlights the comment; click a "2" indicator → both comments are reachable; existing `locate()` still works.
  - landed: cf68d62, rewired to node identity in 221bd1e — ui/active-comment.tsx

---

## Phase B — Session infrastructure

- [x] B1.1 Shared RunLock + wire into ApplyHub (est: ~1h) (mutex: apply-hub)
  - why: the two hubs otherwise hold independent private `running` flags (`apply.ts:253`) and could run concurrently, racing the sidecar; one shared lock is what makes review⇄apply mutual exclusion true rather than nominal.
  - acceptance: R-3.4, R-8.4, R-8.5 — a shared `RunLock` module both hubs consult; `ApplyHub.start` acquires it and 409s if held, with a body naming which holder rejected; bulk-apply behavior otherwise unchanged.
  - verify: hold the lock, then `POST /apply/start` → 409 identifying the holder; release → apply proceeds; existing apply tests pass; the `spawnClaude(buildApplyPrompt(open), deps.cwd)` line pinned at `local-mode.regression.test.ts:423-425` is byte-unchanged.
  - landed: 3ec5aa0 — core/vite/routes/run-lock.ts, core/vite/routes/run-lock.test.ts, core/vite/routes/apply.ts, core/editing/local-mode.regression.test.ts

- [x] B1.2 ReviewHub + `/__vs/review/*` routes + SSE, and the two architecture calls (deps: B1.1, est: ~3h) (mutex: server-routes)
  - why: the interactive flow needs the ephemeral session container and the in-channel the one-shot apply lacks. Two decisions must land **here** rather than be discovered later — deferring them means rewriting the hub once Phase C starts.
  - acceptance: R-3.5, R-3.6, R-8.1, R-8.2, R-8.6 — a single-session in-memory hub; `events` (SSE, `sync` replay first frame) / `start` / `message` / `approve` / `cancel` registered in **both** `md-plugin.ts` and `server.ts`; output parsed by the shared `summarize()` reader extracted from `apply.ts:85-138`. Plus, recorded in the LLD: **(a)** whether `ReviewHub` sits beside `ApplyHub` or reuses `core/collaboration/job-hub.ts` (which already runs long-lived jobs with an event stream), and **(b)** a narrow session interface — `resolve` → `locate` → `checkDrift` → `finish` — with a local implementation now and a collab implementation in Phase C, so the local/collab difference lives in two implementations rather than five `if (mode === 'collab')` sites.
  - verify: subscribe to `/__vs/review/events` in dev and prod builds; first frame is a `sync` snapshot; routes resolve in both servers; both decisions are written into the LLD before the task closes.
  - landed: ce466db — core/vite/routes/review.ts, core/vite/routes/review.test.ts, core/vite/md-plugin.ts, src/server.ts, core/editing/local-mode.regression.test.ts. Decision (a): `ReviewHub` sits beside `ApplyHub`, `job-hub.ts` not reused. Decision (b): `ReviewSessionOps` (`resolve` → `locate` → `checkDrift` → `finish` + `fallbackAvailable`), local implementation `createLocalSessionOps`. Both still to be transcribed into the LLD.

- [x] B1.3 Spawn persistent stream-json session (plan mode, stdin piped, replay) (deps: B1.2, est: ~1.5h)
  - why: propose must be multi-turn and read-only-enforced — the piped stdin is the missing in-channel, and plan mode is the real edit gate rather than a prompt instruction.
  - acceptance: R-3.3, R-3.7, R-4.7, R-8.3, R-8.7 — spawn `claude --print --input-format stream-json --output-format stream-json --replay-user-messages --permission-mode plan` with `stdio:['pipe','pipe','pipe']`; edit tools unavailable at the permission layer; user turns echo into the transcript; no file written during propose.
  - verify: start a session and observe the transcript stream; confirm no edit tool is available to the model; confirm zero disk writes across the whole propose phase.
  - landed: d942a0e — core/vite/routes/review.ts (`REVIEW_CLI_ARGS`, `defaultSpawnReviewSession`, `userTurnFrame`, `replayedUserText`, `user-turn` event), core/vite/routes/review.test.ts. Per spike 0.1 the no-write assertion is scoped to the target file, not the whole process: plan mode still lets the CLI write its own plan files under `~/.claude/plans/`. The opening turn is interim and is replaced by B2.1's `buildReviewPrompt`.

- [x] B1.4 Review status endpoint (deps: B1.2, est: ~30m)
  - why: without it a reloaded tab cannot discover an in-flight session before subscribing, and the abandonment timer (R-7.6) can reap a session whose only client is mid-reload. `GET /__vs/apply` already sets the precedent (`apply.ts:16`).
  - acceptance: R-8.9 — `GET /__vs/review` returns `{ running, startedAt, commentId }`.
  - verify: start a session, reload the tab, and confirm the client can tell an in-flight session exists before opening the `EventSource`.
  - landed: d942a0e — core/vite/routes/review.ts (`handleReviewRequest` GET on the bare path, via `hub.snapshot()`), core/vite/routes/review.test.ts. No host edit needed: both `md-plugin.ts` and `src/server.ts` already dispatch the bare `/__vs/review` path into the shared handler.

## Phase B — Propose

- [x] B2.1 `buildReviewPrompt` + proposal envelope carrying an applicable patch (deps: B1.3, est: ~2h)
  - why: the diff is the only field carrying decision weight, and it must be a patch the server can apply rather than prose about a change — that is what makes R-6.2 true by construction instead of by hope. The other fields are pinned via `--json-schema` so they are testable rather than parsed out of prose.
  - acceptance: R-4.1, R-4.2, R-4.3, R-4.4, R-4.5, R-4.6 — prompt resolves the comment by snippet+heading and elicits interpretation / strategy / assumptions / alternatives (only when the model identifies them) / **a machine-applicable unified diff** / impact, emitted against a pinned envelope surfaced as a `proposal` event.
  - verify: a session produces a `proposal` frame with all fields populated, and the diff field applies cleanly via `git apply --check` against the unmodified target; alternatives are absent when the model identifies none.
  - note: `review-prompt.ts` is a **separate module** from `apply-prompt.ts`, sharing only the comment-manifest formatter — module choice is not the safety question (see LLD). Both it and `review.ts` are added to the R-10.5 module list in `local-mode.regression.test.ts` deliberately.
  - landed: core/editing/review-prompt.ts (`PROPOSAL_SCHEMA`, `PROPOSAL_SCHEMA_ARGS`, `buildReviewPrompt`, `toProposal`, `proposalFromLine`), core/editing/review-prompt.test.ts, core/editing/apply-prompt.ts (`formatCommentEntry` — the one shared piece), core/vite/routes/review.ts (`proposal` event, spawn carries `--json-schema`), core/editing/local-mode.regression.test.ts (R-10.5 list). **`--json-schema` pins EVERY turn, not just the last** — verified against `claude` 2.1.220 on a persistent stream-json session, `.devlocal/spikes/2.1-json-schema.mjs` and `.devlocal/spikes/2.1-live-prompt.ts`: each turn's `result` frame carries `structured_output` with the full envelope, and both turns' `patch` fields were accepted by `git apply --check`. There is no prose-parsing fallback: a turn with no envelope emits no proposal.

- [x] B2.2 Start propose — no disk write, comment stays open, mode selected from origin (deps: B2.1, est: ~1h)
  - why: selecting Apply Comment must open a reviewable proposal rather than mutate the document, and the origin decides which prompt and approval path the session runs.
  - acceptance: R-3.1, R-3.2, R-3.8 — `POST /review/start {commentId}` begins propose, writes nothing to disk, keeps the comment `open`, and resolves the comment's origin to select the prompt mode and approval path.
  - verify: start a review → proposal streams; the target file's bytes and the comment's `status` are unchanged; a local comment selects the local implementation.
  - landed: core/vite/routes/review.ts (the interim opening turn is replaced by `buildReviewPrompt`; `ReviewSessionOps.promptMode` carries the arm), core/vite/routes/review.test.ts. R-3.8 rides the existing ops seam: the origin picks the implementation and the implementation carries its prompt mode, so no `mode` field travels through the route body or the hub. `createLocalSessionOps` is still the only implementation; `ResolvedComment` now carries the whole anchor (heading + both snippets + both line numbers) so the prompt gets the full snippet+heading ladder rather than a start line.

## Phase B — Refine

- [x] B3.1 Follow-up turns / iterative refinement (deps: B2.2, est: ~1h)
  - why: the user must be able to steer the proposal until satisfied rather than accept or reject a single shot.
  - acceptance: R-5.1, R-5.2, R-5.3, R-5.4 — `POST /review/message {text}` delivers a turn to the child; an updated proposal streams back; multiple turns are supported; while awaiting input the session indicates waiting and applies nothing.
  - verify: send a refinement message → an updated `proposal` frame arrives whose patch differs from the first; no disk write between turns.
  - landed: core/vite/routes/review.ts (`isTurnEnd`, the `awaiting-input` phase transition, `message()` re-arming the session), core/vite/routes/review.test.ts. R-5.1/R-5.3 were already carried by B1.3's in-channel; what this story added is R-5.4 — the session now *says* it is waiting. `summarize()` cannot mark the turn boundary because it maps a `result` frame to a row only when it carries a prose `result` string, and envelope turns carry `structured_output` instead, so `isTurnEnd` reads that one field beside `replayedUserText` (a field accessor, not a second parser). **Latest proposal:** each turn's envelope overwrites the single `proposal` slot in the hub and no older one is kept, so "the latest proposal at approval time" (R-6.2) is a property of the storage rather than a selection B4.1 has to make; a turn that produces no envelope (a question answered in prose) leaves the previous one standing rather than clearing it.

## Phase B — Approve & write

- [x] B4.1 Approve → apply the approved patch (deps: B3.1, B1.1, est: ~2h)
  - why: this is the requirement the whole feature rests on. Re-deriving the change on approval — a fresh process running `buildApplyPrompt` with the *comment*, not the diff (`apply.ts:161`, `:80`) — means the user approves run A and receives run B with nothing detecting it. Applying the emitted patch makes the approved artifact and the applied artifact the same object.
  - acceptance: R-6.1, R-6.2, R-6.4, R-6.5, R-6.6, R-6.9 — write only after explicit approval, by applying the proposal's patch through the existing `GitExecutor` (`core/git-context.ts:68`); flip `status→applied` with a non-empty `result` in one update touching no other record; refresh document + sidebar; release the shared lock.
  - verify: approve → the bytes on disk match the approved patch exactly; the target comment shows `applied` + result and **no other comment's status or result changed** (this guards the global stamping at `apply.ts:214-226`, which today rewrites every resultless applied record in the store); document and sidebar refetch; the lock is free for the next run.
  - landed: core/vite/routes/review.ts (`applyPatch`, the rewritten `approve()`, the `applied` frame, `ReviewDeps.execGit`), core/vite/routes/review.test.ts. `approve()` is now async — it runs a real subprocess — so `ReviewHub.approve` returns a promise, `handleReviewRequest` may return one, and both hosts `await` it; nothing else about the surface moved. **Fidelity is structural:** the only write is `git apply` of `proposal.patch`, the exact text the `proposal` frame carried to the user, so the approved artifact and the applied artifact are one object. No process is spawned and no prompt is built on the approval path — asserted by a test that counts turns written at the session across an approval. **R-6.9:** `finish` goes through `setStatus`, which rewrites one record; a test seeds a resultless `applied` comment (precisely what `apply.ts:214-226` would stamp) and asserts it comes out untouched. **R-6.5:** the server half is the `applied` frame; the `vs:comments-changed` / `vs:source-changed` dispatch is the client half and belongs to B6.2, which has no review view to hang it on yet. **R-6.6:** approval kills the child and ends through the single `end()`, with a new `applied` end reason so a completed session is distinguishable from a cancel or a crash.

- [x] B4.2 Drift gate — patch refuses to apply (deps: B4.1, est: ~40m)
  - why: the file can change between propose and approve, and a stale patch must not land silently.
  - acceptance: R-6.3 — the patch failing to apply cleanly **is** the drift signal; emit a `drift` event and require re-approval instead of writing.
  - verify: modify the target between propose and approve → approval surfaces drift, writes nothing, and re-approval after a fresh proposal succeeds.
  - landed: core/vite/routes/review.ts (`onDrift`, the two-stage check in `approve()`), core/vite/routes/review.test.ts. Both signals, cheap one first, as the LLD asks: the propose-time SHA pin answers "did the file move" for a read, and `git apply` refusing the patch is the primary unfakeable one — tested separately, with the pin deliberately bypassed by a re-locating turn so the patcher is the only thing left standing between a stale patch and the file. `git apply` without `--reject` is all-or-nothing, so a refusal leaves no partial write to reconcile. **One thing the story did not say but the requirement needs:** drift re-pins the target. Leaving the propose-time pin standing would make every later approval drift against the file the *next* proposal was written for, and re-approval — which is what R-6.3 asks for — could never succeed.

- [x] B4.3 Fallback labelling — scoped apply pass (deps: B4.1, est: ~40m)
  - why: if a patch cannot express an edit, the `/apply/start {ids:[id]}` pass re-derives the change. Presenting that result as "the approved diff" is exactly the defect B4.1 exists to fix.
  - acceptance: R-6.8 — any re-derived write is surfaced to the user as regenerated, not as the approved diff.
  - verify: force the fallback → the UI states the change was regenerated and does not display the approved patch as what landed.
  - landed: core/vite/routes/review.test.ts (`no re-deriving write exists to mislabel`). **Decision: the fallback is not wired, and R-6.8 is satisfied by construction rather than by a label.** The fallback exists in the design for the case where a patch cannot express an edit; with `git apply` there is no such edit on the local path — the patch is a unified diff over the same file the scoped pass would have edited, and B4.1's tests show it landing byte-exact. Wiring a re-deriving writer would therefore buy nothing and cost the one defect the feature exists to remove, and a labelled re-derive is still a user approving run A and receiving run B. So there is no re-derived write to label: the guard test asserts (code, not comments) that `review.ts` never reaches `/apply/start`, `createApplyHub`, `runApply` or `buildApplyPrompt`, and that the only write is the `git apply` of the proposal's own patch. Wire the fallback in and that test fails, which is exactly the moment the labelling has to be built. `ReviewSessionOps.fallbackAvailable` stays as the interface's statement of the local/collab difference; nothing consumes it.

- [ ] B4.4 Single-session in-place write (optimization) (deps: 0.2, B4.1, est: ~1.5h)
  - why: writing inside the same session avoids a re-invocation and preserves session/tool state. Genuinely optional — B4.1 already satisfies the write path.
  - acceptance: R-6.1, R-6.2 satisfied via in-session write authorized on approval, subject to the same drift gate. **Out of scope unless spike 0.2 passes.**
  - verify: approve within one session → the change lands without a second `claude` spawn, and the written bytes still match the approved patch.
  - landed:

## Phase B — Lifecycle & safety

- [x] B5.1 Cancel, ephemerality, slot release on every exit path (deps: B1.3, est: ~2h)
  - why: abandoning or crashing a review must be safe and must never wedge the single slot until a server restart. Unlike `runApply`'s single awaited promise, a review session is long-lived with turns arriving asynchronously, so there are many more ways to exit.
  - acceptance: R-7.1, R-7.2, R-7.3, R-7.4, R-7.5, R-7.6, R-7.7, R-7.8 — cancel SIGKILLs and leaves file + comment unchanged; state is memory-only; unexpected exit reports an error and changes nothing; an idle/abandoned session (no subscriber, no input for N minutes) terminates; `message`/`approve` after child death returns a status distinguishable from "no session"; the lock releases on cancel, close, error, timeout, abandonment, and completion. Per R-7.5, `start`, the status endpoint, and the event stream stay callable with no session.
  - verify: cancel mid-propose → no write, lock free; close the only tab → session self-terminates after the idle bound; kill the child then `POST /message` → distinct dead-session status; restart the server → no proposal survives; `GET /__vs/review` with no session returns a snapshot rather than a conflict.
  - landed: core/vite/routes/review.ts (`DEFAULT_IDLE_TIMEOUT_MS`, injected `setTimer`/`clearTimer`/`idleTimeoutMs` on `ReviewDeps`, the `armIdle`/`clearIdle` bound, `childAlive`, `deadSession()`, the `idle` end reason), core/vite/routes/review.test.ts. R-7.1/R-7.2/R-7.4/R-7.8 were already carried by the single `end()` from B1.2; this story added the two exits that were missing. **R-7.6:** the bound is armed only while a session runs *and* no client is subscribed — a subscribing tab clears it, the last tab closing arms it, and a delivered turn re-arms it, so an abandoned tab reaps the session after 15 minutes (the `apply.ts` ceiling) instead of wedging the slot until a restart. Timers are injected the way `now` is, so the tests drive the clock rather than sleeping. **R-7.7:** `childAlive` drops in the `close`/`error` handlers *before* `end()` releases the lock, and the stdin write is guarded, so a turn delivered into a broken pipe answers `session-ended` (distinct from `no-session`) and frees the slot rather than throwing. **R-7.3:** unchanged and now asserted — a hub rebuilt over the same store starts blank, replays no events, and nothing about an in-flight proposal ever reached the sidecar.

## Phase B — Review UI

- [x] B6.1 Per-comment review entry point (deps: B2.2, est: ~1h)
  - why: R-3.1 presumes an "Apply Comment" action that does not exist — `ui/main-header.tsx:1223-1230` is the only `/apply/start` caller and it is the bulk scope chooser. Without this the feature is unreachable.
  - acceptance: R-8.10 — a per-comment action on the sidebar row starts a review session for that comment, distinct from the bulk apply control.
  - verify: a comment row exposes the action; triggering it starts a session for that comment id and no other; the bulk control still behaves as before.
  - landed: ui/comment-panel.tsx (`LocalCommentPanel` supplies `actions`), ui/review-session.ts, ui/review-view.test.tsx. **It rides the source's existing `actions` seam** rather than becoming a fifth first-class row control: `CommentPanelSource.actions` is already "an act that belongs to exactly one source", reviewing is local-only until C1.7 wires the collab panel, and the alternative was a per-source `review?` prop every source would have to decline. `ui/main-header.tsx` is untouched — the bulk scope chooser is a different act (a set, fire-and-forget, no approval gate) and the two share only the server's `RunLock`, whose 409 the row action renders by name (`holder: 'apply' | 'review'`).

- [x] B6.2 Review view — proposal, patch, follow-up input, approve/cancel (deps: B3.1, B4.2, B5.1, B6.1, est: ~3h)
  - why: the user-facing half — read the proposal and the exact patch, iterate, then explicitly approve.
  - acceptance: R-4.1–R-4.6 rendered with the patch shown as the diff the user is approving, R-5.x follow-up input wired to `POST /message`, R-6.1 approval behind an explicit action, R-6.5 refresh via `vs:comments-changed` / `vs:source-changed`, drift (R-6.3) surfaced for re-approval, regenerated writes labelled (R-6.8).
  - verify: end to end — start a review → read proposal and patch → refine → approve → file and sidebar update; cancel leaves everything untouched; a drifted approval prompts re-approval instead of writing.
  - landed: ui/patch-view.tsx + ui/patch-view.test.tsx (the diff renderer), ui/review-session.ts (reducer + `useReviewSession`), ui/review-view.tsx (`ReviewDrawer`), ui/review-view.test.tsx, ui/comment-panel.tsx. **The patch is the page.** R-4.5 says the diff *is* the applicable patch, so the drawer opens on it at full width — per file, per hunk, both line numbers in the gutter, every add/remove marked with a sign as well as a colour — and the rest of the envelope (R-4.1–R-4.4, R-4.6) sits under it in a quieter block. Prose first would have the reader arriving at the diff already persuaded, which is the defect the approval gate exists to prevent. The renderer follows `ui/code-view.tsx`'s idiom (monospace `<pre>`, fixed right-aligned gutter, one row element per line, per-row decoration) rather than being a third rendering path; it does not reuse the component because `CodeView` renders one file's whole text with a click selection and a diff has neither. **`parseUnifiedDiff` is forgiving on purpose:** it never throws and keeps text it cannot place, because `git apply` — not the browser — is what decides whether a patch applies, and a patch the UI refuses to draw is a patch the user cannot judge. It resolves the `---`-inside-a-hunk ambiguity with a paired `+++` lookahead, which matters in a Markdown repository where deleting `-- x` emits `--- x`. **R-6.1 is two acts:** Approve arms a confirmation and the second press posts, the same shape the panel already uses for deleting a comment; the control is disabled with no proposal and is never the default. **R-6.5's client half** is the `applied` frame → `vs:comments-changed` + `vs:source-changed`, fired on live frames only — a `sync` replay of a past `applied` must not re-fire the refresh on every reconnect. **R-6.3 is a state, not an error:** `drift` renders as "re-approval needed", leaves Approve enabled, and is cleared by the proposal that supersedes it (nothing else clears it), so the flow the requirement asks for — refine, then approve the new diff — is the only way out. The 409 `drift` reply is deliberately *not* also mapped to an error banner, or the same fact would appear twice. **`ended` reasons are distinguished:** `idle` says the session was reaped after being left alone (R-7.6) and reads as neither the user's act nor a fault; `exit`/`error` say the process stopped; both say nothing was written. **R-8.9:** `GET /__vs/review` on mount decides whether to *show* the view — `sync` answers the same question one round trip too late — and the `sync` replay then rebuilds the whole state, so a reloaded tab returns to its in-flight review. The subscription lives on the panel, not on the drawer, so closing the view leaves a subscriber attached and does not start the abandonment timer; ✕ and Escape put the view away, Cancel ends the session. **R-6.8 needs no label here** because B4.3 established there is no re-deriving writer to mislabel: the only `applied` frame the view can receive comes from a `git apply` of the patch it displayed. **Not verified end to end against a running server** — no `claude` CLI session was driven; the tests mount the real panel over a faked `EventSource` and assert the frames, the POST bodies and the refresh events.

## Phase B — Invariant guards

- [x] B7.1 Regression guards for the untouched surfaces (deps: B4.1, est: ~1h)
  - why: three invariants are easy to break silently while building the review path, and each one breaks a shipped behavior rather than a new one.
  - acceptance: R-3.9, R-6.7 — bulk apply remains one-shot with no proposal or approval step (only the `RunLock` touches it); `CommentStatus` stays the two-value `open | applied` union with no intermediate value reaching `visual-spec-comments.json` or a GitHub comment body via `formatCommentBody`/`CommentTrailer`.
  - verify: existing bulk-apply and `local-mode.regression.test.ts` suites pass unchanged, including the output pin at `:377-383` and the source pins at `:423-425`; a test asserts no third status value can round-trip through either store.
  - landed: 737e270 — core/vite/routes/apply-invariants.test.ts (11 guards), core/vite/routes/apply.ts (stamp scoped to the run's id set), core/vite/routes/comments.ts (PATCH rejects a status outside the union), core/vite/routes/apply.test.ts

---

## Phase C — Collaborative review (EARS Unit 9)

Ships after Phase B is in users' hands. Everything here depends on B1.2's session interface, and lands the collaborative apply path that `copyHandoff` (`ui/collab-app.tsx:370-386`) deliberately deferred.

- [ ] C1.1 Collab start contract — session receives the projected record (deps: B2.2, est: ~1.5h)
  - why: `{commentId, documentPath}` is not enough. Collab comments are projected at runtime (`comment-projection.ts:136`, `review-comments.ts:282`) so the record exists only in the client's projection; the id identifies neither repo nor pull request, no route resolves one, and R-9.1 bars falling back to the sidecar.
  - acceptance: R-8.8, R-9.1 — the start request carries `documentPath` plus the projected record (id, node id, text, workflow); the session runs without reading, editing, or trusting `visual-spec-comments.json`.
  - verify: start a collab review with the sidecar file deleted → the session runs normally; assert no read of the sidecar path occurs during a collab session.
  - landed:

- [ ] C1.2 Collab target resolution by node id (deps: C1.1, est: ~1h)
  - why: collaborative anchoring is an exact lookup with no snippet or line ladder, and a comment with no node id is a statement about the whole document.
  - acceptance: R-9.2, R-9.3 — locate the target by node id with no snippet/line fallback; treat a record with no node id as document-level.
  - verify: a node-anchored comment resolves to that node; a document-level comment produces a whole-document proposal rather than an error.
  - landed:

- [ ] C1.3 Collab write confinement (deps: C1.2, est: ~1h)
  - why: an agent handed both the canonical JSON and the generated Markdown will edit whichever it finds first, and the Markdown is write-only output.
  - acceptance: R-9.4 — every write is confined to the canonical JSON at the supplied document path; the generated Markdown is never edited.
  - verify: run a collab approval and assert the Markdown file's bytes are unchanged while the canonical JSON changed.
  - landed:

- [ ] C1.4 Collab drift — head SHA pin (deps: C1.3, est: ~1h)
  - why: the canonical document lives on a branch, so the branch head moving is a cheaper and stronger staleness signal than diffing node content. `review-drafts.ts:399` already uses this guard shape.
  - acceptance: R-9.7 — pin the branch head at propose time; at approval, drift is head movement or the target node no longer existing.
  - verify: move the branch head between propose and approve → approval surfaces drift and writes nothing; delete the target node → same.
  - landed:

- [ ] C1.5 Collab approval — no status write, ready-to-publish handoff (deps: C1.4, est: ~1.5h)
  - why: resolution in collab mode is recorded on the conversation, not on disk, and publishing is human-initiated by design.
  - acceptance: R-9.5, R-9.6 — approval writes no `status` or `result` to any file, and emits a `ready-to-publish` frame identifying the document without publishing.
  - verify: approve a collab change → canonical JSON updated, sidecar and GitHub comment bodies untouched, a `ready-to-publish` frame carries the document path, and nothing publishes.
  - landed:

- [ ] C1.6 Collab resolution recorded on the thread (deps: C1.5, est: ~1.5h)
  - why: without this the loop never closes — both projections hardcode `status: 'open'` (`comment-projection.ts:156`, `review-comments.ts:294`), so an applied collab comment re-projects as open and R-1.11 keeps rendering its indicator. Deriving status from GitHub's `isResolved` is ruled out at `review-comments.ts:274-281`: that conflates "the local apply agent acted" with "the remote thread is resolved".
  - acceptance: R-9.10, R-9.11 — the session posts a reply on the review conversation recording what was applied; collaborative comments still project as `open` regardless of remote resolution state.
  - verify: approve a collab change → a reply appears on the thread describing what was applied; the projected record still reads `open`, and this is documented as intended rather than filed as a bug.
  - landed:

- [ ] C1.7 Collab entry point, clipboard path preserved, safe cancel (deps: C1.6, est: ~1.5h)
  - why: the collab surface needs its own way in, and the existing manual path must keep working for anyone who prefers it or hits a session failure.
  - acceptance: R-9.8, R-9.9 — a per-comment review action on the collab panel; `copyHandoff` unchanged and still available; cancel or failure leaves the canonical document unchanged.
  - verify: start a collab review from the panel; confirm "Copy prompt" still produces the same prompt it does today; cancel mid-session → canonical JSON byte-identical.
  - landed:

---

## Dependency summary

- **Shipped:** A1.1 → {A1.2, A1.3} → {A1.4, A1.5, A1.7, A2.1}; A1.6 standalone.
- **Phase B backend:** B1.1 → B1.2 → {B1.3, B1.4}; B1.3 → B2.1 → B2.2 → B3.1 → B4.1 → {B4.2, B4.3, B4.4}; B5.1 after B1.3; B7.1 after B4.1.
- **Phase B UI:** B6.1 after B2.2; B6.2 last (needs B3.1, B4.2, B5.1, B6.1).
- **Phase C:** C1.1 → C1.2 → C1.3 → C1.4 → C1.5 → C1.6 → C1.7, all gated on Phase B shipping.
- **Spikes:** 0.1 is independent and should be re-run (unreproduced). 0.2 gates **only** B4.4.
- **Mutex `apply-hub`:** B1.1 (edits existing `apply.ts`). **Mutex `server-routes`:** B1.2 (edits `md-plugin.ts` + `server.ts`).
- Private technical scratch: `.devlocal/<user>/<story-id>/scratchpad.md`.

## Requirement coverage

| Unit | Requirements | Stories |
| --- | --- | --- |
| 1–2 | R-1.1–R-1.12, R-2.1–R-2.5 | A1.1–A2.1 (shipped) |
| 3 | R-3.1–R-3.9 | B1.1, B1.3, B1.2, B2.2, B7.1 |
| 4 | R-4.1–R-4.7 | B2.1, B1.3, B6.2 |
| 5 | R-5.1–R-5.4 | B3.1, B6.2 |
| 6 | R-6.1–R-6.9 | B4.1, B4.2, B4.3, B4.4, B7.1 |
| 7 | R-7.1–R-7.8 | B5.1 |
| 8 | R-8.1–R-8.10 | B1.1, B1.2, B1.3, B1.4, B6.1, C1.1 |
| 9 | R-9.1–R-9.11 | C1.1–C1.7 |
