# Comment History — High-Level Design

## Overview

Users leave review comments on documents in the visual-spec browser, and an apply
run edits the files and marks each comment `applied`. Today, once a comment is
applied it disappears from the UI: there is no way to see what was asked for or
what changed. This feature adds a **comment history** — a per-document, separate
list of applied comments, each paired with a short (1–2 line) summary of the
resulting change. The apply agent writes that summary when it marks a comment
applied, so the history builds itself as the document evolves. The history is
reachable from both the document **viewer** and the **editor**, giving users an
audit trail of the document's evolution without manually diffing versions.

## Stakeholders & Impact

- **Document reviewers / authors** (primary): today, once they click "Apply", the
  comment and its outcome vanish. After this ships, they can open a history list
  and read, per document, every comment that was applied and a one-line summary of
  what changed — from either the viewer or the editor.
- **The apply-comments flow** (secondary): the apply run already produces a
  "traceability table" of what changed, but it is streamed and discarded on the
  next run. This feature captures a durable per-comment summary as a byproduct of
  the same run.
- **Other workflow skills** (secondary): comments handed off to a non-`visual-spec`
  workflow are also marked applied; their history entries carry the same summary
  field, so the trail is uniform regardless of who applied the comment.

## Goals

- After a comment is applied, its request text and a short summary of the resulting
  change are **persisted** on the comment record (not lost when the next run starts).
- On the happy path a history entry is **never blank**: the apply agent writes the
  summary, and if it omits one the server stamps a minimal fallback so the entry
  still reads as applied.
- Both the **viewer** and the **editor** expose a **separate list** of applied
  comments for the current document — distinct from the open-comments list.
- A **header entry point** opens the comment history, available in both modes.
- Existing sidecars keep working (a comment with no summary still renders).
- The surface is labelled **"Change history" / "Applied"** — not "all comments" —
  so it does not over-promise completeness (comments deleted before apply are not
  recorded; see Non-Goals).

## Non-Goals

- No change to how comments are authored, targeted, or resolved.
- No change to the `open → applied` status model beyond adding a summary field.
- No version-by-version document diffing or file-content snapshots — the history is
  a list of comment→result summaries, not a diff viewer.
- No soft-delete / "deleted" audit state in this iteration. An open comment deleted
  before it is applied leaves no history entry (unchanged behavior). Applied
  comments remain the durable audit trail and are not deletable from the history.
- No new backing store or database — the existing single JSON sidecar remains the
  source of truth.

## Success Criteria

- Running an apply on an open comment results in that comment appearing in the
  document's history list with its request and a non-empty result summary (agent-
  written, or a server fallback if the agent omitted one).
- The history list is ordered by time (most-recent-first) and, when a document has
  no applied comments, shows a defined empty state rather than a blank area.
- The history list is reachable from the comment panel (as a separate list/tab) and
  from a header entry, in both viewer and editor, and shows only applied comments
  for the current document.
- The open-comments list and the history list never mix: an applied comment leaves
  the open list and appears only in the history list.
- Loading a sidecar written before this feature (records without a summary) renders
  the history without errors, showing the comment with an empty/"—" summary.
