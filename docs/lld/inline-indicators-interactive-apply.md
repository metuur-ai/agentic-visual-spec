# Inline Comment Indicators + Interactive Apply Review — Low-Level Design

Source paths are relative to `packages/visual-spec/`. (These spec docs live at the **repo root** `docs/`, not `packages/visual-spec/docs/`.) Line references reflect the state captured in `.devlocal/research/2026-07-14-inline-indicators-interactive-apply.md`.

## Architecture

Two additive subsystems: **(A) inline indicators + reverse navigation** (frontend only) and **(B) interactive review session** (new backend hub + routes + prompt, new frontend review UI). The existing bulk apply path is untouched.

### A. Inline indicators (View mode) + reverse navigation

- **Data source.** Reuse `useComments(path)` (`core/app/lib/use-comments.ts:36-88`), filtering to `status === 'open'` for the current file. No new fetch.
- **Anchoring.** An `IndicatorLayer` renders one marker per open comment, positioned against the existing DOM anchors:
  - Markdown View: `[data-vs-loc^="${startLine}:"]` inside `[data-inspector-root]` (`ui/markdown-surface.tsx:41-51,108`).
  - Code View: `[data-line="${startLine}"]` and its gutter span (`ui/code-view.tsx:57,61`).
  - The marker is an overlay/gutter affordance keyed to the anchor element, kept glued as layout shifts. `InspectOverlay` tracks 1–few frames per `requestAnimationFrame` (`inspect-overlay.tsx:88-101`); for potentially many indicators, use a **single shared rAF loop batching all indicator positions** and/or an `IntersectionObserver` so only on-screen anchors are tracked — avoids per-indicator rAF jank on large files. Indicators are visually distinct from the transient `flash()` highlight and from selection frames.
  - Multiple open comments on the same line collapse into one indicator carrying a count.
- **Marker resolution reuse.** Indicator placement uses the same target→element resolution already implemented in `locate()` (`ui/comment-history-list.tsx:28-47`) and `locateLine()` (`ui/generic-panel.tsx:157-172`); extract the resolver so both `locate()` and `IndicatorLayer` share it (no behavioral change to `locate()`).
- **Reverse navigation (document → sidebar).** Introduce an **active-comment** state (a small context or lifted state consumed by `CommentPanel`/`GenericPanel`). Clicking an indicator sets the active comment id; the sidebar scrolls that row into view and applies a highlight. This is the inverse of today's sidebar → document `locate()`, which has no counterpart yet. The sidebar remains the primary surface for viewing/filtering/managing comments — the indicator only points into it.

### B. Interactive review session

- **ReviewHub (new), `core/vite/routes/review.ts`.** Mirrors `ApplyHub` (`core/vite/routes/apply.ts:237-305`): a single-session, in-memory, ephemeral hub holding `{ session, events[], phase, startedAt, abort, subs }`.
- **Shared single-session lock (`RunLock`).** `ApplyHub` holds a *private* `running` flag in its closure (`apply.ts:253`); a second hub built "mirroring" it would get its **own** flag, so review and bulk apply could run concurrently and race on the sidecar. To make mutual exclusion real, introduce a small shared `RunLock` module both hubs consult (injected via the same `getDeps` thunk they already use). `ApplyHub.start` and `ReviewHub.start` both acquire it and both return 409 if held; the 409 body names *which* holder rejected (review-running vs apply-running) so the UI can message correctly. This is a one-line addition to the existing `applyHub.start` path — the bulk flow's behavior is otherwise unchanged.
- **Session lifecycle & slot release on all exit paths.** Unlike `runApply` (a single awaited promise releasing the lock in `.finally()`, `apply.ts:290`), a review session is long-lived with turns arriving asynchronously via `POST /message`. The `RunLock` must therefore release on **every** terminal path: explicit cancel (SIGKILL), child `close`/`error`, an idle/lifetime timeout (reuse the 15-min SIGKILL precedent at `apply.ts:187`), and **abandonment** — no subscribed client and no input for N minutes (a dropped browser tab must not wedge the slot until restart).
- **Transport.** A persistent `claude` child spawned with `--print --input-format stream-json --output-format stream-json --replay-user-messages` and `stdio: ['pipe','pipe','pipe']` (stdin **piped**, unlike today's `'ignore'` at `apply.ts:81`). Output is parsed by the existing `summarize()` stream-json reader (`apply.ts:85-138`, extract/share it). Follow-up turns are written to the child's stdin as stream-json user messages; `--replay-user-messages` echoes them on the out-channel so the transcript is a single ordered log. A cost guardrail (e.g. `--max-budget-usd`) bounds an open-ended session, complementing the wall-clock timeout.
- **Read-only enforcement — at the permission layer, not the prompt.** The propose phase runs with `--permission-mode plan`, which makes file-editing tools *unavailable* (the model routes through `ExitPlanMode` rather than writing). "Started without `acceptEdits`" is **not** sufficient — default mode still permits edits and merely prompts, which is undefined in headless. For defense in depth, `--allowedTools` may additionally exclude Write/Edit. The prompt is not a security boundary; it only shapes proposal content.
- **Two-phase — build the fallback first (guaranteed), spike the single-session write.**
  - **Primary build target (fallback path, proven): propose read-only in plan mode; on approve, run a scoped write pass via the existing, already-tested `POST /apply/start { ids:[commentId] }` (`apply.ts:279-294`, `acceptEdits`)** with the session's refined instruction appended to the prompt. This reuses fully-working code and sidesteps both transport unknowns.
  - **Optimization (single-session in-place write), gated behind a spike:** authorize the same persistent session to write on approval, avoiding a re-invocation. This depends on two behaviors that are documented-but-unverified against the bare CLI: (a) the process survives past its first `result` frame to accept a second stdin turn, and (b) a plan-mode session can be lifted to write mid-process on approval. **A ½-day spike (see Key Decisions) must confirm (a)+(b) with no file written before this path is built.**
  - Both paths must reconcile the stale-diff risk (below).
- **Stale-diff reconciliation.** The diff shown in propose is computed against file state at propose time; between propose and approve the file may change (the sidecar is treated as mutated out-of-band, research §2.4) and the fallback's fresh write pass may regenerate a *different* change. Before writing, THE apply step re-resolves the target by snippet+heading; if the anchor has drifted or the target content changed since the proposal, it **surfaces the drift and requires re-approval** rather than applying a stale diff.
- **Prompt, `core/editing/review-prompt.ts` (new).** `buildReviewPrompt(comment)` instructs the model, for one comment resolved by snippet+heading (same locating rules as `apply-prompt.ts:15-17`), to: state its interpretation, strategy, reasoning, assumptions/ambiguities, alternatives when appropriate, an expected unified diff, and estimated impact. Because plan mode already blocks edits, the prompt focuses on proposal *content*, not on asking the model not to write. The proposal is emitted against a pinned structure (via `--json-schema` for the proposal envelope) so the structured `proposal` frame fields are populated deterministically rather than parsed from prose. Shares the comment-manifest formatting with `buildApplyPrompt` where practical.
- **Routes (new), registered in BOTH `core/vite/md-plugin.ts` and `src/server.ts`** (dual-server rule):
  - `GET  /__vs/review/events` — SSE subscribe; first frame a `sync` replay (as `apply.ts:275`).
  - `POST /__vs/review/start   { commentId }` — begin propose phase. On lock contention returns 409 with a body naming the holder (review-running vs apply-running).
  - `POST /__vs/review/message { text }` — inbound follow-up → child stdin (the missing in-channel).
  - `POST /__vs/review/approve` — authorize write; produce diff-applied result (subject to stale-diff reconciliation).
  - `POST /__vs/review/cancel`  — SIGKILL child, release lock, discard session, comment stays `open`.
  - **Dead-child race:** if a `message`/`approve` arrives after the child died but before the slot released, respond with a distinct status the UI can tell apart from "no session" (`R-7.7`).
- **Event types.** Extend the streamed union with review-specific frames: `proposal` (structured envelope pinned via `--json-schema`: interpretation/strategy/assumptions/alternatives/diff/impact), `awaiting-input`, `applied`, `drift` (stale-diff → re-approval), alongside reused `log`/`error`/`done` shapes (`apply.ts:24-37`), so `summarize()`'s output type stays exhaustive.
- **Frontend review UI (new).** A review view (in or beside `CommentPanel`) that: subscribes to `/__vs/review/events` via `EventSource` (as `main-header.tsx:255-280`), renders the proposal and streamed diff, offers a follow-up input (`POST /message`), and Approve/Cancel buttons. On `applied`/`done` it dispatches `vs:comments-changed` + `vs:source-changed` (as `main-header.tsx:270-272`) so the doc and sidebar refetch.
- **Status/result.** On approval+apply, the comment flips `open → applied` with a `result` via the existing `PATCH /__vs/comments/:id { status, result }` (`comments.ts:121-124`); no new comment field is persisted (session is ephemeral).

## Constraints

- **Dual server.** Every route must be registered in both `core/vite/md-plugin.ts` (dev) and `src/server.ts` (prod); handlers should be shared like `handleCommentsRequest`.
- **Streaming = SSE only, out-direction.** Inbound turns use a separate `POST /message` writing to child stdin; there is no bidirectional socket. Headers follow the existing SSE pattern (`apply.ts:269-274`).
- **`claude` CLI dependency.** Interactive review requires a `claude` binary that supports `--input-format stream-json` multi-turn on stdin. Auth rides on the CLI (no API key), matching today (`apply.ts:75`).
- **Indicators are View-mode only.** WYSIWYG/CodeMirror anchoring is out of scope; the code must not assume `data-vs-loc`/`data-line` exist in Edit modes.
- **No auth** on `/__vs/*`; localhost assumption unchanged.
- **Single active session** for both bulk apply and review — a review must not run while a bulk apply runs, and vice versa (shared guard or mutual 409).

## Key Decisions

- **Indicator scope = View mode only.** Reuses ready anchors and `locate()`; avoids the two greenfield Edit-mode substrates. Rejected: all-modes (largest risk, no precedent) and View+Source (adds CodeMirror gutter decorations now) — both deferrable.
- **Transport = persistent `claude` with `--input-format/--output-format stream-json`, stdin piped.** Reuses the existing `stream-json` parser and keeps auth on the CLI. Rejected: Agent SDK (new dependency + auth path) and stateless per-turn `claude -p` re-invocation (resends full transcript each turn, loses session/tool state). **Caveat:** the persistent-multi-turn and in-session write behaviors are documented-but-unverified against the bare CLI (flags `--input-format stream-json`, `--replay-user-messages`, `--permission-mode plan` all confirmed to exist on `claude 2.1.170`; process survival past first `result` and plan→write escalation are not). If the ½-day spike fails, the Agent SDK rejection is reconsidered — the SDK's `query()` async-iterable is the documented multi-turn path.
- **Build order = fallback first.** The scoped-write-pass path (`/apply/start {ids:[id]}` on approval) is guaranteed by existing tested code and is the primary build target; the single-session in-place write is an optimization gated behind the spike below. This inverts emphasis so the team does not build on the unproven half first.
- **Pre-lock spike (½ day, gates the lock).** Spawn `claude --print --input-format stream-json --output-format stream-json --permission-mode plan`, write two user messages, and confirm: (a) the process survives its first `result` frame, (b) the second message is answered, (c) no file is written. Attach results here before implementation begins.
- **Read-only via `--permission-mode plan`** (not the prompt) — makes edit tools unavailable at the permission layer. Rejected: relying on prompt instructions (not a boundary) and "no acceptEdits" alone (default mode still permits edits).
- **Preview = model-produced diff, read-only until approval.** The propose phase emits a diff without touching disk; approval authorizes the write. Rejected: dry-run-to-scratch/worktree (faithful but many moving parts) and narrated-plan-only (user approves without seeing exact changes).
- **Session persistence = ephemeral, server-held.** Mirrors `ApplyHub`; comment stays `open` until approved. Rejected: persisting proposal/transcript on the comment record (schema + migration cost) for v1.
- **Reverse-nav via new active-comment state.** Minimal lifted state / context consumed by the sidebar; no change to `locate()` semantics.

## Out of Scope

- Edit-mode (WYSIWYG/Source) inline indicators.
- Proposal/transcript persistence and resumable sessions across restart.
- Concurrent/multi-user review sessions.
- Changes to the bulk apply flow, comment data-model anchoring, or route auth.
- A general bidirectional websocket transport (kept to SSE-out + POST-in).
