# Inline Comment Indicators + Interactive Apply Review — EARS Specifications

Requirements are grouped by unit of work. Keywords: `THE SYSTEM SHALL` (always-on), `WHEN` (event), `WHILE` (continuous state), `IF` (conditional/gate), `WHERE` (context-scoped).

---

## Unit 1: Inline indicators in View mode

**Why:** Give the reader contextual awareness of pending feedback inside the document, independent of the sidebar.

| ID | EARS statement |
| --- | --- |
| R-1.1 | WHERE a file is displayed in Markdown View mode, THE SYSTEM SHALL render one inline indicator on the element whose `data-vs-loc` line matches the `startLine` of each open comment targeting that file. |
| R-1.2 | WHERE a file is displayed in Code View mode, THE SYSTEM SHALL render one inline indicator on the row whose `data-line` matches the `startLine` of each open comment targeting that file. |
| R-1.3 | THE SYSTEM SHALL render inline indicators only for comments with `status === 'open'` on the currently displayed file. |
| R-1.4 | THE SYSTEM SHALL derive indicator data from the same comment source as the sidebar (`useComments`) and SHALL NOT require the sidebar to be open or focused. |
| R-1.5 | IF two or more open comments resolve to the same line, THE SYSTEM SHALL render a single indicator for that line displaying the count of comments. |
| R-1.6 | WHILE the document layout changes (scroll, reflow, content edit), THE SYSTEM SHALL keep each indicator aligned to its anchor element. |
| R-1.7 | THE SYSTEM SHALL render indicators visually distinct from selection frames and from the transient `flash()` highlight. |
| R-1.8 | WHERE a file is displayed in an Edit mode (WYSIWYG or Source), THE SYSTEM SHALL NOT render inline indicators. |
| R-1.9 | IF an open comment's target cannot be resolved to an element in the current document, THE SYSTEM SHALL omit its inline indicator without error. |
| R-1.10 | WHEN the open-comment set for the displayed file changes, THE SYSTEM SHALL update the rendered indicators to match. |
| R-1.11 | WHILE a review session is active for a comment that is still `open`, THE SYSTEM SHALL continue to render that comment's inline indicator. |
| R-1.12 | WHEN the open-comment set is refetched (including on tab focus or visibility change), THE SYSTEM SHALL keep the indicator layer and the sidebar consistent with the refetched set without desyncing from an active review. |

---

## Unit 2: Indicator → sidebar navigation

**Why:** Let a reader jump from an in-document indicator to the authoritative comment entry, while keeping the sidebar the primary management surface.

| ID | EARS statement |
| --- | --- |
| R-2.1 | WHEN the user clicks an inline indicator, THE SYSTEM SHALL mark the corresponding comment as the active comment in the sidebar. |
| R-2.2 | WHEN a comment becomes the active comment, THE SYSTEM SHALL scroll the sidebar to that comment and apply a visible highlight to it. |
| R-2.3 | IF the indicator represents more than one comment on a line, THE SYSTEM SHALL surface all of those comments in the sidebar for the user to choose among. |
| R-2.4 | THE SYSTEM SHALL keep the sidebar as the surface for viewing, filtering, and managing comments, and the indicator interaction SHALL only navigate/activate, not replace those functions. |
| R-2.5 | THE SYSTEM SHALL preserve the existing sidebar → document navigation (`locate()`) unchanged. |

---

## Unit 3: Interactive review session — start (no immediate edit)

**Why:** Applying a comment must become a reviewable proposal, not an immediate document mutation.

| ID | EARS statement |
| --- | --- |
| R-3.1 | WHEN the user selects Apply Comment on a single comment, THE SYSTEM SHALL start an interactive review session for that comment and SHALL NOT modify any file on disk at that time. |
| R-3.2 | WHILE a review session is in its propose phase, THE SYSTEM SHALL keep the target comment in `status === 'open'`. |
| R-3.3 | THE SYSTEM SHALL run the review session as a persistent Cloud CLI process using stream-json input and output. |
| R-3.4 | WHILE a review session is active, IF the user attempts to start another review session or a bulk apply, THE SYSTEM SHALL reject the new request with a conflict response. |
| R-3.5 | WHILE a review session is active, THE SYSTEM SHALL stream session events to subscribed clients over the review SSE endpoint. |
| R-3.6 | WHEN a client subscribes to the review event stream, THE SYSTEM SHALL first send a snapshot of the current session state and prior events. |
| R-3.7 | WHILE in the propose phase, THE SYSTEM SHALL run the Cloud CLI process in a permission mode that makes file-editing tools unavailable (enforced at the permission layer, not by prompt instruction). |

---

## Unit 4: Proposal content

**Why:** The user needs enough of the model's thinking and a concrete diff to judge the change before approving.

| ID | EARS statement |
| --- | --- |
| R-4.1 | WHILE producing a proposal, THE SYSTEM SHALL present how it interpreted the comment. |
| R-4.2 | WHILE producing a proposal, THE SYSTEM SHALL present the proposed implementation strategy and the reasoning behind it. |
| R-4.3 | WHILE producing a proposal, THE SYSTEM SHALL present any assumptions or ambiguities it identified. |
| R-4.4 | WHERE the model identifies more than one implementation option, THE SYSTEM SHALL present those alternatives to the user (faithful surfacing, not forced generation). |
| R-4.5 | WHILE producing a proposal, THE SYSTEM SHALL present the expected changes as a diff before any changes are applied. |
| R-4.6 | WHILE producing a proposal, THE SYSTEM SHALL present an estimate of the impact on surrounding content or related files. |
| R-4.7 | THE SYSTEM SHALL produce the proposal without writing to any target file. |

---

## Unit 5: Iterative refinement

**Why:** The user must be able to steer the proposal until satisfied.

| ID | EARS statement |
| --- | --- |
| R-5.1 | WHEN the user submits a follow-up message during a review session, THE SYSTEM SHALL deliver it to the running Cloud CLI process as a new turn. |
| R-5.2 | WHEN the model responds to a follow-up, THE SYSTEM SHALL stream an updated proposal reflecting that input. |
| R-5.3 | THE SYSTEM SHALL allow the user to ask questions, refine the request, or redirect the implementation across multiple turns within one session. |
| R-5.4 | WHILE awaiting user input, THE SYSTEM SHALL indicate that the session is waiting and SHALL NOT apply changes. |

---

## Unit 6: Approval and apply

**Why:** Changes reach disk only on an explicit user decision, and the outcome is recorded like any applied comment.

| ID | EARS statement |
| --- | --- |
| R-6.1 | THE SYSTEM SHALL apply changes to disk only after the user explicitly approves the proposal. |
| R-6.2 | WHEN the user approves, THE SYSTEM SHALL apply the change corresponding to the specific proposal the user approved (the latest proposal presented in the session at approval time). |
| R-6.3 | IF the target content has changed since the approved proposal was produced (anchor drift or file modified), THE SYSTEM SHALL surface the drift and require re-approval rather than applying a stale diff. |
| R-6.4 | WHEN an approved change is applied, THE SYSTEM SHALL set the comment `status` to `applied` and write a non-empty `result` summary in the same update. |
| R-6.5 | WHEN an approved change is applied, THE SYSTEM SHALL cause the displayed document and the sidebar to refresh to reflect the change. |
| R-6.6 | WHEN a review session completes (applied or cancelled), THE SYSTEM SHALL end the session and release the shared single-session lock. |

---

## Unit 7: Cancellation, ephemerality, and safety

**Why:** Abandoning a review must be safe and leave no partial state, and sessions must not outlive the process.

| ID | EARS statement |
| --- | --- |
| R-7.1 | WHEN the user cancels a review session, THE SYSTEM SHALL terminate the Cloud CLI process and leave the target file unchanged. |
| R-7.2 | WHEN a review session is cancelled without approval, THE SYSTEM SHALL keep the target comment in `status === 'open'`. |
| R-7.3 | THE SYSTEM SHALL hold review-session state in memory only and SHALL NOT persist an in-progress proposal or transcript across a server restart. |
| R-7.4 | IF the Cloud CLI process exits unexpectedly during a review session, THE SYSTEM SHALL end the session, leave the file and comment unchanged, and report an error to subscribed clients. |
| R-7.5 | WHEN a review endpoint is requested with no active session, THE SYSTEM SHALL respond with a conflict/no-op rather than starting work. |
| R-7.6 | WHILE a review session is active with no subscribed client and no input for a bounded idle period, THE SYSTEM SHALL terminate the process and release the shared single-session lock. |
| R-7.7 | WHEN a `message` or `approve` request arrives after the process has died but before the session slot is released, THE SYSTEM SHALL respond with a status distinguishable from "no active session". |
| R-7.8 | WHEN the process terminates for any reason (cancel, crash, idle timeout, completion), THE SYSTEM SHALL release the shared single-session lock. |

---

## Unit 8: Transport and routes

**Why:** The interactive flow needs an inbound channel the current one-shot design lacks, without breaking the existing apply path.

| ID | EARS statement |
| --- | --- |
| R-8.1 | THE SYSTEM SHALL expose review endpoints under the `/__vs/review` namespace for subscribe (SSE), start, message, approve, and cancel. |
| R-8.2 | THE SYSTEM SHALL register the review routes in both the Vite dev server and the standalone production server. |
| R-8.3 | THE SYSTEM SHALL spawn the review Cloud CLI process with its standard input piped so follow-up turns can be written to it. |
| R-8.4 | THE SYSTEM SHALL leave the existing bulk apply behavior and endpoints unchanged, except for honoring the shared single-session lock. |
| R-8.5 | THE SYSTEM SHALL enforce, via the shared single-session lock, that a review session and a bulk apply cannot run at the same time, rejecting the second with a conflict response that identifies the current holder. |
| R-8.6 | WHERE the review process streams output, THE SYSTEM SHALL parse it with the existing stream-json reader used by the apply flow. |
| R-8.7 | WHEN a follow-up turn is delivered to the process, THE SYSTEM SHALL cause that user turn to appear in the streamed transcript so the client renders a single ordered log. |
