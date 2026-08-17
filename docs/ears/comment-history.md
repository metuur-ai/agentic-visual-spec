# Comment History — EARS Specifications

> User-facing label for the surface: **"Change history" / "Applied"** — not "all
> comments". It lists applied comments for the current document only.

## Unit 1: Result capture on apply

**Why:** The "resulting change" summary the history displays must be produced and
persisted at the moment a comment is applied — otherwise the history has requests
but no outcomes. The apply agent already knows what it changed; a server fallback
guarantees the entry is never blank.

| ID    | EARS statement |
| ----- | -------------- |
| R-1.1 | WHEN the apply run marks a comment `applied`, THE SYSTEM SHALL write a non-empty `result` string on that comment record. |
| R-1.2 | THE apply prompt (`buildApplyPrompt`) SHALL instruct the agent to write `result` as a 1–2 line summary of the user's request and the resulting change (or where it was handed off). |
| R-1.3 | THE apply prompt SHALL require the agent to write `result` as a string on the **same record**, in the **same edit** that sets `status` to `applied`, to **preserve all other existing fields** on that record, and to keep the sidecar JSON valid. |
| R-1.4 | WHERE a comment is handed off to a non-`visual-spec` workflow, THE SYSTEM SHALL still record a `result` summary describing what was handed off. |
| R-1.5 | IF the apply run marks a comment `applied` without a `result` (agent omitted it, or a legacy run), THE SYSTEM SHALL stamp a minimal fallback `result` (e.g. "Applied (no summary recorded)") server-side in `runApply` so the entry is never blank, and SHALL NOT fail. |

## Unit 2: Data model & persistence

**Why:** The summary must be a durable, backward-compatible part of the comment
record so it survives read/serialize, existing sidecars keep working, and a bad
write cannot silently destroy the store.

| ID    | EARS statement |
| ----- | -------------- |
| R-2.1 | THE `CommentRecord` type SHALL include an optional `result: string` field. |
| R-2.2 | WHEN the sidecar is parsed and re-serialized, THE SYSTEM SHALL preserve the `result` field for records that have one — for both the new `target`-shaped records and legacy `{file, anchor}` records (the `upgrade` legacy branch must copy `result`). |
| R-2.3 | WHEN a record without a `result` field is loaded, THE SYSTEM SHALL parse it without error and represent its summary as absent. |
| R-2.4 | THE `setStatus` operation SHALL accept an optional `result` and SHALL write it onto the record when provided, atomically with the status change. |
| R-2.5 | WHEN a `PATCH /__vs/comments/{id}` request includes a `result` value, THE SYSTEM SHALL forward it to `setStatus` and persist it onto that comment record. |
| R-2.6 | THE SYSTEM SHALL NOT delete applied comment records as part of any history operation (the applied set is the audit trail). |
| R-2.7 | THE result-writing path SHALL preserve every other comment record in the sidecar; a write SHALL NOT drop or corrupt existing records. (Guards the `fileCommentStore.read()` empty-doc-on-parse-error failure mode.) |

## Unit 3: History list in the comment panel (per-document)

**Why:** The viewer's comment panel is where reviewers work; a separate applied
list there gives per-document history without leaving the flow.

| ID    | EARS statement |
| ----- | -------------- |
| R-3.1 | THE comment panel SHALL present the document's applied comments as a list separate from the open-comments list. |
| R-3.2 | THE history list SHALL include only comments whose `target.path` matches the current document AND whose `status` is `applied`. |
| R-3.3 | THE open-comments list SHALL continue to show only `status === 'open'` comments, so open and applied comments never appear in the same list. |
| R-3.4 | THE history list SHALL order entries by `ts`, most-recent-first. |
| R-3.5 | For each history entry, THE SYSTEM SHALL display the comment's target anchor (heading/line), the request text (`comment`), and the result summary (`result`). |
| R-3.6 | IF a history entry has no `result`, THE SYSTEM SHALL render a neutral placeholder (e.g. "—") in place of the summary. |
| R-3.7 | IF a history entry has no resolvable anchor (legacy or folder-kind target with no heading/line), THE SYSTEM SHALL still render the entry, falling back to the target `path`. |
| R-3.8 | IF the current document has no applied comments, THE history list SHALL show a defined empty state (e.g. "No applied comments yet"). |
| R-3.9 | WHEN a comment transitions from `open` to `applied`, THE SYSTEM SHALL remove it from the open list and show it in the history list on the next refresh. |

## Unit 4: History entry point in the header

**Why:** The editor may not mount the comment panel; a shared header entry
guarantees the history is reachable in every mode and offers a document-level view.

| ID    | EARS statement |
| ----- | -------------- |
| R-4.1 | THE main header SHALL provide a labelled control, present in both viewer and editor modes, that opens the comment history for the current document. |
| R-4.2 | WHEN the header history control is opened, THE SYSTEM SHALL display the applied comments **for the current document only** (filtered by the current `file`/`path`, since the header otherwise loads all files' comments), each with its request and result summary, ordered most-recent-first. |
| R-4.3 | THE header history view and the panel history list SHALL be sourced from the same comment data, so they show the same applied comments for a given document. |
| R-4.4 | IF the current document has no applied comments, THE header history view SHALL show a defined empty state. |

## Unit 5: Availability in viewer and editor

**Why:** The audit trail is only useful if it is reachable wherever the user reads
or edits the document.

| ID    | EARS statement |
| ----- | -------------- |
| R-5.1 | WHILE viewing a document, THE SYSTEM SHALL make the comment history reachable via both the panel history list and the header control. |
| R-5.2 | WHILE editing a document, THE SYSTEM SHALL make the comment history reachable via the header control. |
| R-5.3 | WHEN the underlying comments change in another tab, THE SYSTEM SHALL refresh the history view using the existing cross-tab refresh mechanism (`vs:comments-changed` / window focus), without a manual reload. |
| R-5.4 | THE history views SHALL be read-only — they display comments and summaries and SHALL NOT create, edit, or delete comments. |
