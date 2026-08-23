# Inline Comment Indicators + Interactive Apply Review — High-Level Design

## Overview

Visual Spec lets a user browse files in a viewer, pin review comments to files/lines/folders, and then apply those comments with the Cloud CLI (`claude`). This change upgrades two parts of that loop. First, it surfaces **inline indicators** inside the document (in View mode) so a reader sees, in context, exactly where pending comments live — without depending on the right-hand sidebar. Second, it replaces the one-click, fire-and-forget "Apply" for a single comment with an **interactive review session**: the model proposes how it interprets the comment, shows an expected diff, answers follow-ups, and only writes to disk after the user explicitly approves.

Grounded in the current architecture documented in `.devlocal/research/2026-07-14-inline-indicators-interactive-apply.md`, and re-checked against `.devlocal/research/2026-08-22-apply-preview-proposal.md`, which re-surveyed the apply pipeline and added the collaborative/PR-sourced half of the picture.

## Stakeholders & Impact

- **Comment author (primary user).** Today they leave comments, then click Apply and watch an activity feed while `claude` edits files under `--permission-mode acceptEdits` — no diff preview, no chance to correct course, and no in-document reminder of where open comments are. After this ships: open comments are visible inline while reading; applying one opens a conversation where they see the plan and diff, refine it, and approve before anything changes on disk.
- **The model / `apply-comments` skill (system consumer).** Currently invoked once per bulk apply via `claude -p` with the whole prompt as an argument and stdin ignored. After this ships: for interactive review it runs as a persistent multi-turn session that can receive follow-up input and is not permitted to write files until approval.
- **Reviewer on a collaborative document (PR-sourced comments).** Their comments live on the review conversation, not the sidecar, and the edit target is the canonical JSON document on the branch. Today their only path is a "Copy prompt" button that puts a collab-mode instruction on the clipboard to run by hand — no server route, no stream, and no preview. After this ships they get the same propose → refine → approve session as a local commenter, with approval ending in the existing publish handoff rather than a status write.
- **Secondary consumers.** The comment sidecar (`visual-spec-comments.json`), the SSE activity stream, and the existing bulk "Apply all" flow. The interactive path is additive and per-comment. The bulk flow's *behavior* is retained, with one runtime coupling: interactive review and bulk apply share a single-active-session lock and become mutually exclusive (a review cannot run while a bulk apply runs, and vice versa). See LLD "single active session."

## Goals

- In **View mode only** (Markdown View and Code View), render a subtle inline indicator on every element that has an open comment for the currently displayed file, driven independently of the sidebar.
- Clicking an inline indicator navigates to and highlights the corresponding comment in the sidebar (document → sidebar), complementing today's sidebar → document `locate()`.
- Selecting **Apply Comment** on a single comment starts an interactive review session instead of immediately editing the document.
- During review the model explains its interpretation, proposed strategy, reasoning, assumptions/ambiguities, alternatives when appropriate, an expected diff, and estimated impact on surrounding/related content.
- The user can send follow-up messages to refine or redirect the proposal, iterating until satisfied.
- Files are written **only** after the user explicitly approves; the propose phase is read-only.
- The same review session serves both comment origins. On a **local** comment it edits the file the comment points at and flips the comment to `applied`. On a **collaborative (PR-sourced)** comment it edits the canonical JSON document by node id, writes no status or result to disk, and ends by signalling readiness to publish — publishing stays human-initiated.
- Reuse existing substrates: the `data-vs-loc` / `data-line` anchors, `locate()`/`flash()`, the `useComments` hook, the SSE `ApplyHub` streaming pattern, and the `stream-json` output parser.

## Non-Goals

- Inline indicators in **Edit modes** (WYSIWYG/Lexical and Source/CodeMirror). Deferred — those are separate anchoring substrates with no current precedent.
- Persisting an in-progress proposal or transcript across a page reload or server restart. Review sessions are ephemeral and server-held.
- Changing the `CommentTarget` anchoring semantics (line/snippet/heading), the comment id format, or the sidecar file shape (beyond what a review session needs transiently).
- Modifying the existing bulk "Apply all / Apply selected" flow or its `acceptEdits` one-shot behavior. Bulk apply stays fire-and-forget; the preview/approval gate is a single-comment affordance only. The one coupling is the shared lock.
- Widening `CommentStatus` beyond `open | applied`. The enum is persisted to `visual-spec-comments.json` and, for PR comments, encoded into GitHub comment bodies through the comment trailer — a third value is a wire-format change on two stores. A review session in flight is held in memory instead.
- Automating publish. Approval on a collaborative document produces the ready-to-publish signal; a person still presses publish.
- Adding authentication/authorization to `/__vs/*` routes (localhost-only assumption unchanged).
- Multi-user / concurrent review sessions. A single active review session at a time (mirrors the single-run `ApplyHub`).

## Success Criteria

- Opening a file in View mode that has N open comments shows N inline indicators anchored to the correct lines/blocks, with no sidebar interaction required.
- Clicking an indicator scrolls the sidebar to and visibly highlights that comment.
- Clicking Apply Comment on a single comment opens a review view and streams a proposal (interpretation + strategy + diff) **without modifying any file on disk**.
- Sending a follow-up message produces an updated proposal in the same session.
- Approving applies the change to disk, flips the comment to `applied` with a `result`, and closes the session; the file and sidebar reflect the change.
- Cancelling (or not approving) leaves the file untouched and the comment `open`.
- On a collaborative document, approving edits the canonical JSON node, leaves `visual-spec-comments.json` untouched, and surfaces the ready-to-publish signal; nothing publishes on its own.
- Starting a review while a bulk apply runs (or the reverse) is refused with a message naming which one is holding the slot.
