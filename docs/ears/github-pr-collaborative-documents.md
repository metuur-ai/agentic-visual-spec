# GitHub PR-Based Collaborative Documents — EARS Specifications

> Collaboration mode is **additive**. Every requirement below applies only when a
> document is a collaboration document; local file-backed browsing and commenting
> keep their current behavior (Unit 10).

> **Revision — Markdown-native collaboration.** This document was originally
> specified around a canonical JSON document format with `nodeId` block identity,
> and comments smuggled through PR *issue* comments. That premise is retired.
> Markdown is now the only document format and the single source of truth, and the
> conversation is native **PR review comments** anchored to `path` + `line`.
>
> Units 1, 2 and 3 are **retired** and kept as stubs so their requirement ids stay
> resolvable. Unit 0 states the new premise. Units 4, 5, 6, 7, 8, 11 and 12 are
> rewritten in place; surviving requirements keep their original ids. Units 9 and 10
> are unchanged. Requirement ids are never reused for a different meaning.
>
> Resolution state is **read** from GitHub and never written by this system
> (Unit 5). Resolving a thread happens on github.com.

## Unit 0: Document format and source of truth

**Why:** Every requirement that follows depends on one answer: what *is* the
document. Making Markdown canonical is what lets a reviewer read and comment on the
artifact from github.com with nothing installed, keeps the PR diff legible, and
collapses two parallel comment stacks into one. It also gives up a real capability —
identity that survives an edit — and that trade is stated here rather than implied.

| ID | EARS statement |
| --- | --- |
| R-0.1 | THE SYSTEM SHALL treat the Markdown file (`.md`) as the only document format and the single source of truth for a collaboration document. |
| R-0.2 | THE SYSTEM SHALL NOT persist a parallel structured representation of a collaboration document, and SHALL NOT define a document envelope, node list, or block identity scheme of its own. |
| R-0.3 | THE SYSTEM SHALL anchor a collaborative comment by file path and line, and SHALL accept that such an anchor can be reported outdated by GitHub when the underlying text changes. |
| R-0.4 | THE SYSTEM SHALL NOT convert an existing JSON-format collaboration document into the Markdown format, and SHALL NOT provide a migration path for one. |
| R-0.5 | WHERE a Pull Request opened under the retired JSON format is still open, THE SYSTEM SHALL leave its branch artifacts untouched. |
| R-0.6 | THE SYSTEM SHALL NOT create new documents in the retired JSON format. |

## Unit 1: Collaboration protocol model — **RETIRED**

**Retired** with the JSON document format (Unit 0). The typed vocabulary this unit
defined — collaboration document, node, anchor, collaborative comment target — has no
counterpart under Markdown-native collaboration: comments project onto the existing
`CommentRecord` / `CommentTarget` types instead.

R-1.1 … R-1.6 and R-1.8 are withdrawn. **R-1.7 is salvaged and restated as R-5.16**,
where it is now the central contract rather than a side-constraint.

## Unit 2: Canonical format and `nodeId` identity — **RETIRED**

**Retired.** `nodeId` was the mechanism by which a comment survived an edit that moved
every line number. Under Unit 0 there is no canonical JSON to carry it, and GitHub's
own outdated-comment semantics take its place. R-2.1 … R-2.13 are withdrawn.

Two consequences that must not be lost:

- R-2.13 forbade Markdown from being parsed back into the canonical format. With
  Markdown canonical, that prohibition is not weakened — it is **meaningless**, and
  its test is deleted rather than relaxed (R-12.9).
- The capability withdrawn here is real: a comment can now go outdated. R-6.3 and
  R-6.4 state what the system does about it.

## Unit 3: Document store — **RETIRED**

**Retired.** A Markdown document is a file in the tree and on the branch; it needs no
dedicated store. R-3.1, R-3.2, R-3.4 … R-3.8 are withdrawn.

**R-3.3 is salvaged and restated as R-12.6a** — the prohibition on importing Luthor
from any CLI-reachable module is a live build guard and outlives the store it was
written for.

## Unit 4: GitHub execution layer

**Why:** Delegating to `gh` and GitHub MCP means the Claude CLI can drive the same
operations in both host workflows, and avoids reimplementing auth, pagination, and
rate limiting. The three conversation operations — list, create, reply — are all REST
endpoints. Reading **resolution** state is not: it exists only on GraphQL's
`reviewThreads`. The adapter therefore carries one REST surface and one narrow
GraphQL read, and nothing else.

| ID | EARS statement |
| --- | --- |
| R-4.1 | THE SYSTEM SHALL perform all GitHub operations through a single adapter that delegates to the `gh` CLI or the GitHub MCP server. |
| R-4.2 | THE SYSTEM SHALL NOT implement a bespoke GitHub HTTP or GraphQL client. |
| R-4.3 | THE adapter SHALL support creating a branch, committing document content, and opening a Pull Request. |
| R-4.4 | THE adapter SHALL support listing PR review comments, creating a review comment on a `path` and `line`, replying to an existing review comment, and updating a review comment's body. It SHALL also retain listing and creating PR issue comments, which the Pull Request body flow still uses. |
| R-4.5 | THE adapter SHALL support paginating a PR's full review-comment list, and SHALL return the accumulated list rather than a page. |
| R-4.6 | THE adapter SHALL use REST for every conversation operation, and SHALL use GraphQL only to read review-thread resolution state. |
| R-4.7 | THE adapter SHALL support merging a Pull Request. |
| R-4.8 | THE adapter SHALL accept an injectable executor so that its behaviour can be exercised against recorded responses. |
| R-4.9 | IF a GitHub operation fails, THE adapter SHALL surface a structured error identifying the operation and SHALL NOT include credential material in the error. |
| R-4.10 | IF the configured GitHub execution path is unavailable, THE SYSTEM SHALL report collaboration mode as unavailable with an actionable message and SHALL NOT fall back to a partially-functional state. |
| R-4.11 | THE adapter SHALL treat a GraphQL response carrying an `errors` array as a failure **even when it also carries usable `data`**, and SHALL NOT route a GraphQL failure through the REST HTTP-status classifier. *(Verified: GraphQL returns HTTP 200 for both schema and runtime errors, but `gh` exits non-zero whenever `errors` is present — including a partial error where valid `data` is still written to stdout. The exit code therefore does catch the failure; what is absent is any `(HTTP nnn)` marker for the REST classifier to read, so a GraphQL error would otherwise be surfaced unclassified.)* |
| R-4.12 | IF the GraphQL resolution read fails, THE SYSTEM SHALL still serve the conversation from REST, and SHALL report resolution state as unknown rather than as unresolved. |
| R-4.13 | WHEN creating a review comment, THE adapter SHALL send the Pull Request's current head SHA as `commit_id`, re-read at creation time, and SHALL NOT reuse a SHA cached from an earlier operation. |
| R-4.14 | THE adapter SHALL support creating a review comment with `subject_type: file` and no line, as the fallback for a line the Pull Request's diff does not cover. |
| R-4.15 | THE SYSTEM SHALL join GitHub's review-thread resolution state onto the projected conversation by the thread comments' `databaseId`, which is the same REST integer id the projection already carries. |

## Unit 5: Comment projection and sidecar cache

**Why:** `CommentDocStore` is the narrowest seam in the codebase — `/__vs/comments`
and the apply hub already depend on the interface, not on files. Projecting GitHub
review threads through it means the apply agent, the comment panel, and the indicator
layer work in collaboration mode with no change. The sidecar stays a cache so it can
never become a competing source of truth.

**Observed invariant this unit rests on:** GitHub flattens reply chains server-side —
`in_reply_to_id` always names a thread *root*, never another reply. Verified against
`microsoft/vscode#280236` (100 comments, 28 replies, 0 nested) and
`facebook/react#20915` (10 comments, 8 replies, 0 nested). Threading is therefore a
single-level grouping, not a chain walk. If this invariant ever fails, R-5.17's
grouping is wrong.

| ID | EARS statement |
| --- | --- |
| R-5.1 | THE SYSTEM SHALL provide a `CommentDocStore` implementation that projects GitHub PR review comments into `CommentDoc` shape, grouped into threads by `in_reply_to_id`. |
| R-5.2 | WHILE a document is in collaboration mode, THE SYSTEM SHALL treat GitHub as the system of record for the conversation. |
| R-5.3 | WHILE a document is in collaboration mode, THE SYSTEM SHALL treat `visual-spec-comments.json` as a non-authoritative local cache of GitHub comments. |
| R-5.4 | WHEN a comment is created in the UI, THE SYSTEM SHALL create a GitHub PR review comment on the document's path at the selected line range, and SHALL persist the returned comment id on the record. It SHALL NOT write a machine-readable reference into the comment body. |
| R-5.5 | THE SYSTEM SHALL create GitHub review comments as the mechanism for collaborative comments, so that a reviewer reading the Pull Request on github.com sees them inline against the Markdown. |
| R-5.6 | WHEN a sync completes, THE SYSTEM SHALL reflect comments authored on github.com in the local projection, including comments that cannot be anchored to a line in the current file. |
| R-5.7 | WHEN a comment cannot be anchored to a line in the current file, THE SYSTEM SHALL present it in a document-level discussion view and SHALL NOT discard it. |
| R-5.8 | WHEN a Pull Request is merged, THE SYSTEM SHALL delete the local comment cache for that document. |
| R-5.9 | IF the local cache disagrees with GitHub, THE SYSTEM SHALL take GitHub's state as correct. |
| R-5.10 | THE SYSTEM SHALL provide the apply flow with the Markdown file as its edit target, and SHALL instruct the agent to locate the target by snippet and heading rather than by line number. |
| R-5.11 | WHEN a comment creation request is retried after a timeout, THE SYSTEM SHALL supply an idempotency key such that no duplicate GitHub comment is created. |
| R-5.12 | THE SYSTEM SHALL read each thread's resolution state from GitHub's review-thread `isResolved`, and SHALL NOT derive it from comment bodies, reply markers, or the local cache. |
| R-5.13 | THE SYSTEM SHALL NOT write resolution state to GitHub, and SHALL NOT present a control that resolves or unresolves a thread. |
| R-5.14 | THE SYSTEM SHALL present, for each unresolved thread, a link that opens that thread on github.com, because resolving happens there. |
| R-5.15 | IF resolution state could not be read, THE SYSTEM SHALL say so, and SHALL NOT render a thread as resolved or unresolved on a guess. |
| R-5.16 | THE SYSTEM SHALL NOT alter the existing `CommentTarget` shape (`path` + `kind: 'file' \| 'range' \| 'folder'`), which continues to serve local markdown and code comments, and SHALL project GitHub review threads onto it without adding a field. *(Salvaged from R-1.7.)* |
| R-5.17 | WHEN grouping review comments into threads, THE SYSTEM SHALL group over the complete accumulated list across all pages, and SHALL NOT group a partial page, because a root on one page and its reply on the next would otherwise project as an orphan. |
| R-5.18 | IF a reply names a root comment that no longer exists, THE SYSTEM SHALL present the reply as a thread of its own and SHALL NOT discard it. |
| R-5.19 | THE SYSTEM SHALL identify a comment by its REST integer id, and SHALL NOT use the GraphQL node id as the identity carried through the projection, because `in_reply_to_id` and the reply endpoint are both keyed on the integer. |
| R-5.20 | THE SYSTEM SHALL represent a thread's replies on its record, and SHALL NOT project a reply as an independent comment. |
| R-5.21 | THE SYSTEM SHALL treat `status` (`open` / `applied`) as a record of whether the local apply agent has acted on a comment, SHALL NOT derive it from GitHub state, and SHALL NOT write it back to GitHub. |
| R-5.22 | THE SYSTEM SHALL NOT delete a GitHub review comment authored by another participant. |

## Unit 6: Anchor resolution

**Why:** A review comment names a `path` and a `line`. The viewer already stamps
every rendered block with its source line (`data-vs-loc`) and already resolves a line
range to a block with a heading fallback. Collaboration now uses that one resolver
instead of a second one. What is genuinely hard is the outdated case: GitHub reports
`line: null` and only `original_line` against a dead commit, so there is no current
position to trust — and guessing one attaches a reviewer's words to the wrong
paragraph, which is worse than showing the comment unanchored.

| ID | EARS statement |
| --- | --- |
| R-6.1 | WHEN locating a collaborative comment, THE SYSTEM SHALL resolve it by `path` and line range against the rendered Markdown. |
| R-6.2 | WHEN a comment carries a current line, THE SYSTEM SHALL anchor it to the rendered block whose source range contains that line. |
| R-6.3 | IF a comment reports no current line and its captured snippet occurs **exactly once** in the current file, THE SYSTEM SHALL anchor it to that occurrence and SHALL mark it outdated. |
| R-6.4 | IF a comment reports no current line and its captured snippet occurs zero times or more than once, THE SYSTEM SHALL present it as unanchored in the document-level view together with its captured text, and SHALL NOT anchor it. |
| R-6.5 | THE SYSTEM SHALL NOT use `original_line` as a current position, because it is a line number in a different commit. |
| R-6.6 | THE SYSTEM SHALL resolve collaborative and local comments through the same Markdown anchor resolver, and SHALL NOT maintain a second resolver for collaboration. *(Inverted from the retired requirement, which forbade sharing.)* |
| R-6.7 | WHEN a comment goes outdated, THE SYSTEM SHALL capture the text at its original line from the blob at its original commit, clamped to a bounded length, and SHALL store it as the comment's snippet. |
| R-6.8 | THE SYSTEM SHALL NOT re-anchor an outdated comment by fuzzy match, similarity score, or heading proximity, because each of those produces a confident and wrong anchor. |
| R-6.9 | THE SYSTEM SHALL NOT hide an outdated or unanchored comment. |
| R-6.10 | THE SYSTEM SHALL render an outdated comment as visually distinct from a current one, wherever it appears. |
| R-6.11 | THE SYSTEM SHALL NOT offer to re-anchor a comment to a different block, because GitHub has no operation that moves a review comment. |
| R-6.12 | THE SYSTEM SHALL treat a file-level thread as anchored to the document rather than to a line, and SHALL NOT report it outdated. *(Verified: a `subject_type: file` thread survived an edit that outdated every line-anchored thread on the same file, keeping a usable position and advancing its `commit_id`.)* |
| R-6.13 | WHEN every comment in a thread reports no current line, THE SYSTEM SHALL treat the whole thread as outdated, and SHALL NOT resolve its replies independently of its root. |

## Unit 7: Collaboration routes and UI mode

**Why:** Making GitHub concepts explicit in their own route family keeps
`/__vs/comments` semantics intact for local mode. The UI reuses the existing
inspector, comment panel, and indicator layer. The one new rule is about *which*
document the review surface renders — see R-7.9, which exists to prevent a class of
silent, invisible error.

| ID | EARS statement |
| --- | --- |
| R-7.1 | THE SYSTEM SHALL expose `POST /__vs/collab/start`, `POST /__vs/collab/open`, `GET /__vs/collab/:id`, `POST /__vs/collab/:id/sync`, `POST /__vs/collab/:id/comments`, `POST /__vs/collab/:id/comments/:commentId/reply`, `PATCH /__vs/collab/:id/comments/:commentId`, `POST /__vs/collab/:id/publish`, and `GET /__vs/collab/:id/events`. |
| R-7.2 | THE SYSTEM SHALL keep `/__vs/comments` serving local comments with unchanged semantics. |
| R-7.3 | THE collaboration document view SHALL render Markdown through the existing Markdown surface and SHALL identify blocks by their source position (`data-vs-loc`). |
| R-7.4 | THE collaboration mode SHALL reuse the existing `CommentPanel` and `IndicatorLayer` rather than introducing parallel components. |
| R-7.5 | WHEN a user selects a block and comments in collaboration mode, THE SYSTEM SHALL persist the comment against that block's `path` and source line range as its primary identity. |
| R-7.6 | THE collaboration UI SHALL be implemented in the shared UI and `/__vs` route layer such that the standalone CLI and the Vite plugin both expose it without host-specific code. |
| R-7.7 | THE SYSTEM SHALL NOT issue GitHub API calls from the browser. |
| R-7.8 | WHERE no collaboration configuration is present, THE SYSTEM SHALL NOT surface collaboration controls in the UI. |
| R-7.9 | WHILE a document is being reviewed, THE SYSTEM SHALL render the Markdown as it stands on the Pull Request branch, and SHALL NOT derive comment line numbers from a local working copy, because a local copy holding unpublished work would post comments against lines that mean something else on the branch. |
| R-7.10 | THE SYSTEM SHALL indicate, before the user writes a comment, whether the selected text is covered by the Pull Request's diff. |
| R-7.11 | WHEN the user selects text the Pull Request's diff does not cover, THE SYSTEM SHALL state that the comment will be posted against the file rather than the line, before the user submits it. |
| R-7.12 | WHEN a comment is posted against the file rather than a line, THE SYSTEM SHALL include the selected text and its line number in the comment body, so the reference survives for a reader on github.com. |
| R-7.13 | IF a comment creation is refused because the line is not in the diff, THE SYSTEM SHALL retry once as a file-level comment, SHALL tell the user it did so and why, and SHALL NOT discard the text the user typed. |
| R-7.14 | IF a comment creation fails for any other reason, THE SYSTEM SHALL preserve the text the user typed and SHALL report the cause. |
| R-7.15 | WHEN a user replies to a thread, THE SYSTEM SHALL post the reply against that thread's root comment, and the reply SHALL inherit the thread's anchor rather than being anchored separately. |
| R-7.16 | WHERE the open document is not part of a Pull Request, THE SYSTEM SHALL present local commenting and SHALL NOT surface Pull Request comment controls. |
| R-7.17 | WHERE a document under Pull Request review has pre-existing local sidecar comments, THE SYSTEM SHALL keep them visible and labelled as local, SHALL NOT delete or hide them, and SHALL NOT post them to the Pull Request without an explicit request. |
| R-7.18 | IF the conversation cannot be loaded from GitHub, THE SYSTEM SHALL still render the document and SHALL state the cause, and the document SHALL NOT fail to render because collaboration failed. |

## Unit 8: Lifecycle jobs and sync

**Why:** `createApplyHub` already solves "one server-owned operation, many browser
subscribers, replayable status". Every collaboration transition has that shape. Sync
must run through a single entrypoint so a webhook receiver can later drive it without
redesigning the path. Publish now commits one artifact rather than two, and the Ready
gate reads GitHub's own resolution state rather than a marker protocol of our own.

| ID | EARS statement |
| --- | --- |
| R-8.1 | THE SYSTEM SHALL run each collaboration lifecycle transition as one server-owned job, and SHALL hold those jobs in a registry keyed by `documentId` so that concurrent per-document jobs do not share state. |
| R-8.2 | THE SYSTEM SHALL fan out job progress to browser subscribers over SSE at `GET /__vs/collab/:id/events`. |
| R-8.3 | THE SYSTEM SHALL support jobs for: create branch and PR, commit the Markdown document, sync comments, publish, and merge the PR. |
| R-8.4 | THE SYSTEM SHALL provide job status that a late-subscribing client can read to recover current state. |
| R-8.5 | WHEN `POST /__vs/collab/start` succeeds, THE SYSTEM SHALL have created a branch, committed the Markdown document, and opened a Pull Request, and SHALL return `pullNumber` and `headSha`. |
| R-8.6 | THE SYSTEM SHALL synchronize with GitHub by interval polling and by an explicit user-initiated sync action. |
| R-8.7 | THE SYSTEM SHALL route interval polling and user-initiated sync through a single sync entrypoint that a future webhook receiver can invoke unchanged. |
| R-8.8 | THE SYSTEM SHALL NOT require a webhook receiver, tunnel, or publicly reachable endpoint. |
| R-8.9 | WHEN publish is requested, THE SYSTEM SHALL require a client-supplied `markdown` payload and SHALL reject a publish request that omits it. |
| R-8.10 | WHEN publish runs, THE SYSTEM SHALL commit the client-supplied payload to the PR branch and verify the committed blob against the payload bytes, and SHALL NOT merge the Pull Request as part of publish. |
| R-8.11 | THE SYSTEM SHALL compute the expected blob hash server-side from the received bytes, and SHALL NOT depend on a client-supplied hash for correctness. |
| R-8.12 | THE SYSTEM SHALL treat client-supplied Markdown as opaque bytes and SHALL NOT parse, re-render, or validate its content, because the publishing author already holds write access to the branch. |
| R-8.13 | WHEN publish completes, THE SYSTEM SHALL make the committed Markdown readable from the branch so an agent can produce a PR summary and changelog entry. |
| R-8.14 | WHEN the publishing client disconnects after the publish payload has been accepted, THE SYSTEM SHALL continue the commit, verify, and merge steps to completion. |
| R-8.15 | THE SYSTEM SHALL permit the transition to Ready only when every review thread on the document reports resolved. |
| R-8.16 | WHEN a new comment arrives on a document in Ready state, THE SYSTEM SHALL return the document to PR-open state. |
| R-8.17 | WHEN merge is requested, THE SYSTEM SHALL re-verify at merge time that no unresolved thread exists, and IF one exists, SHALL refuse the merge rather than relying on the state observed at the last poll. |
| R-8.18 | IF branch or Pull Request creation fails partway, THE SYSTEM SHALL report the failure over SSE and SHALL leave no orphaned branch behind. |
| R-8.19 | WHEN the Pull Request is closed without merging, THE SYSTEM SHALL move the document to a closed state that a subsequent sync reports, and SHALL NOT leave it indefinitely in PR-open. |
| R-8.20 | WHEN the base branch has moved such that the Pull Request cannot merge, THE SYSTEM SHALL report a conflicted state and SHALL NOT attempt an automatic resolution. |
| R-8.21 | IF the committed blob does not match the payload bytes, THE SYSTEM SHALL abort publish before merging and SHALL report a verification-failure state, and SHALL NOT attempt to regenerate or overwrite the branch content. |
| R-8.22 | IF the target path has changed on the base branch since the branch point, THE SYSTEM SHALL report a distinct base-diverged state, separate from verification failure. |
| R-8.23 | WHEN a lifecycle request is retried, THE SYSTEM SHALL key it with an idempotency token such that no duplicate branch, Pull Request, or comment is created. |
| R-8.24 | IF a job fails partway, THE SYSTEM SHALL report the failure over SSE and SHALL leave the document in a state a subsequent sync can reconcile. |
| R-8.25 | IF resolution state is unknown because the GraphQL read failed, THE SYSTEM SHALL NOT report the document as Ready, and SHALL name the unknown state as the reason. |
| R-8.26 | THE SYSTEM SHALL NOT mark a document Ready on the basis of local state alone. |

### Starting a collaboration on more than one file

**Why:** R-8.5 creates a Pull Request from exactly one file, because `POST
/__vs/collab/start` accepts one `documentPath` and one `markdown`. Authors do not work
that way. A change to a specification is usually a change to several documents that only
make sense reviewed together, and the single-file contract forces either one Pull Request
per file — which splits one conversation across several review threads — or a manual
commit outside the tool, which loses the document/Pull Request link that resume (R-7.4,
R-7.7) depends on.

The constraint these preserve is that **a collaboration still has exactly one document
id**. Resume resolves a single `documentId` from the Pull Request body, and the review
surface mounts a single document; making a collaboration a set of equals would change
both. So a multi-file start is one *named* document travelling with companion files, not
a set without a head.

| ID | EARS statement |
| --- | --- |
| R-8.27 | THE SYSTEM SHALL accept at `POST /__vs/collab/start` one or more files, each carrying its own repository-relative path and its own Markdown bytes. |
| R-8.28 | WHERE exactly one file is supplied, THE SYSTEM SHALL behave as R-8.5 requires, so that a single-file caller observes no change. |
| R-8.29 | WHEN more than one file is supplied, THE SYSTEM SHALL commit every supplied file to the same branch, each at its own path, within the same create job, and SHALL open exactly one Pull Request covering all of them. |
| R-8.30 | THE SYSTEM SHALL designate exactly one supplied file as the collaboration document that `documentId` names in the Pull Request body, so that resume continues to resolve a single document (R-7.4, R-7.7). |
| R-8.31 | IF two supplied files declare the same path, THE SYSTEM SHALL reject the request before creating a branch and SHALL name the duplicated path. |
| R-8.32 | IF any supplied path fails the containment rule a single path must already satisfy, THE SYSTEM SHALL reject the whole request and SHALL commit none of the supplied files. |
| R-8.33 | IF the create job fails after committing some but not all supplied files, THE SYSTEM SHALL report the failure and SHALL leave no orphaned branch behind, as R-8.18 already requires of the single-file case. |
| R-8.34 | WHEN offering the author a multi-file start, THE SYSTEM SHALL default the selection to the open file alone, and SHALL offer as candidates only local files that carry notes. |
| R-8.35 | THE SYSTEM SHALL include in the request only the files the author selected, and SHALL NOT add a file to a Pull Request because it was merely offered. |

## Unit 9: Authentication and authorization

**Why:** The proposal explicitly requires backend enforcement, not UI-only hiding.
Because the credential is a PAT held server-side, the tool's entire security posture
rests on that token never reaching the browser, on the local server refusing requests
it did not originate, and on role separation being checked where it cannot be
bypassed. Unchanged by the Markdown revision — R-9.8 already scopes the reviewer role
to exactly the operations this design needs.

| ID | EARS statement |
| --- | --- |
| R-9.1 | THE SYSTEM SHALL read the GitHub PAT server-side from the environment or `gh` authentication state. |
| R-9.2 | THE SYSTEM SHALL NOT transmit the PAT to the browser, include it in any response body or SSE event, or embed it in the client bundle. |
| R-9.3 | THE SYSTEM SHALL NOT write the PAT to logs, job status, or error messages. |
| R-9.4 | THE SYSTEM SHALL accept configuration for repository owner, repository name, and base branch. |
| R-9.5 | THE SYSTEM SHALL resolve the local user's identity from the authenticated PAT. |
| R-9.6 | THE SYSTEM SHALL attribute GitHub comments to the PAT owner's own GitHub account and SHALL NOT encode participant identity into comment bodies. |
| R-9.7 | THE SYSTEM SHALL classify each session as **author** when the PAT identity matches the Pull Request author and the PAT carries write access to the repository, and as **reviewer** otherwise. |
| R-9.8 | THE SYSTEM SHALL permit a reviewer session to read the document and to create, reply to, and react to comments, and SHALL NOT require write access for any of those operations. |
| R-9.9 | THE SYSTEM SHALL enforce server-side that document edit, commit, mark-ready, publish, and merge are available only to an author session. |
| R-9.10 | IF a reviewer session requests an author-only operation, THE SYSTEM SHALL reject the request server-side even when the corresponding UI control is hidden. |
| R-9.11 | THE SYSTEM SHALL treat hiding a UI control as insufficient to satisfy any authorization requirement. |
| R-9.12 | WHEN collaboration mode is enabled, THE SYSTEM SHALL verify that the configured credential carries the scopes required for its role, and IF a required scope is absent, SHALL report the specific missing scope before any collaboration operation is attempted. |
| R-9.13 | THE SYSTEM SHALL apply a request guard to every `/__vs` route in both hosts that rejects a request whose `Sec-Fetch-Site` is `cross-site` or `same-site`, and whose `Host` is not on a loopback allow-list. |
| R-9.14 | WHERE `Sec-Fetch-Site` is absent, THE SYSTEM SHALL allow the request, because a client that does not send it is not a browser and therefore carries no ambient authority. |
| R-9.15 | THE request guard SHALL be a single shared implementation used by both the standalone server and the Vite plugin host, and SHALL be registered ahead of every `/__vs` handler. |
| R-9.16 | THE SYSTEM SHALL NOT expose the publish route until the request guard is in place, because publish commits client-supplied bytes to a remote repository. |
| R-9.17 | WHEN a merge is requested, THE SYSTEM SHALL require an out-of-band confirmation value that is displayed only on the server's terminal, so that a browser-based attacker cannot complete an irreversible remote write. |
| R-9.18 | THE SYSTEM SHALL verify that the Vite host does not serve `/__vs` responses with permissive CORS headers, and a test SHALL assert that `/__vs` responses are not readable cross-origin in either host. |
| R-9.19 | IF no GitHub credential is configured, THE SYSTEM SHALL keep collaboration mode disabled and SHALL continue to serve local mode normally. |

## Unit 10: Local-mode preservation

**Why:** Collaboration is additive. The existing local browsing, commenting, and apply
flows are the shipped product; a regression there is a worse outcome than
collaboration not shipping at all. Unchanged by the Markdown revision, except that
R-10.6's subject no longer exists.

| ID | EARS statement |
| --- | --- |
| R-10.1 | WHERE no collaboration configuration is present, THE SYSTEM SHALL behave exactly as it does today for directory browsing, markdown viewing, commenting, and apply. |
| R-10.2 | THE SYSTEM SHALL keep `/__vs/tree`, `/__vs/dir`, `/__vs/raw`, `/__vs/source`, `/__vs/upload`, and `/__vs/apply` operating against local stores. |
| R-10.3 | THE SYSTEM SHALL NOT change the on-disk format of `visual-spec-comments.json` for local, non-collaborative documents. |
| R-10.4 | THE SYSTEM SHALL continue to upgrade legacy `{ file, anchor }` comment records on read. |
| R-10.5 | THE SYSTEM SHALL NOT require GitHub connectivity for any local-mode operation. |
| R-10.6 | *(Withdrawn — there is no separate collaboration document renderer to keep away from local markdown files. Superseded by R-7.3.)* |
| R-10.7 | THE SYSTEM SHALL keep local commenting available on every browsed file and folder — not only on documents under Pull Request review — and SHALL keep those comments in the local sidecar. |
| R-10.8 | THE SYSTEM SHALL keep handing local comments to the Claude apply agent through `createApplyHub` and `/__vs/apply`, with the comment text, its target, and its workflow tag unchanged, and SHALL NOT require GitHub configuration, connectivity, or a Pull Request for that handoff. |
| R-10.9 | THE SYSTEM SHALL keep the `workflow` routing tag on local comments, so a comment can continue to be handed to a skill other than `visual-spec`. |
| R-10.10 | THE SYSTEM SHALL keep the comment history — the applied comments and their result summaries — working in local mode. |

## Unit 11: Reviewer onboarding

**Why:** With Markdown on the branch, a reviewer can read and comment on the document
on github.com with nothing installed. That removes the original justification for this
unit — visual-spec is no longer *required* to participate — but not the unit itself: a
reviewer who does open the document locally still needs to get there from a PR link,
and the unpublished-work protection in R-11.6 … R-11.9 is what stops a refresh from
destroying an agent's applied changes.

| ID | EARS statement |
| --- | --- |
| R-11.1 | WHEN a collaboration Pull Request is opened, THE SYSTEM SHALL include in the PR body an instruction that renders the document in a local visual-spec instance, identifying the repository, branch, and document. |
| R-11.2 | WHEN a reviewer opens a collaboration document by Pull Request reference, THE SYSTEM SHALL fetch the Markdown from the branch and render it without requiring a prior local copy of the document. |
| R-11.3 | THE SYSTEM SHALL render a collaboration document for a reviewer whose credential has read access only, and SHALL NOT require write access to view or comment. |
| R-11.4 | IF a reviewer's credential lacks read access to the repository, THE SYSTEM SHALL report that specific cause rather than a generic failure. |
| R-11.5 | THE SYSTEM SHALL present the reviewer's own GitHub identity in the UI so the reviewer can confirm which account their comments will be attributed to. |
| R-11.6 | THE SYSTEM SHALL record, on a document's GitHub binding, a content hash of the document as it stood at the last point the local copy and the branch provably agreed, and SHALL update it when the document is created, opened, or published. |
| R-11.7 | WHEN opening a collaboration document whose local copy no longer matches that recorded hash, THE SYSTEM SHALL refuse the open with a cause naming the unpublished local work, and SHALL NOT overwrite the local copy, so that work an agent applied but nobody has published yet cannot be destroyed by a refresh. |
| R-11.8 | THE SYSTEM SHALL provide an explicit way to open such a document by discarding the local copy, and SHALL require that discard to be requested rather than assumed. |
| R-11.9 | THE SYSTEM SHALL NOT refuse reading, reloading or publishing a document that holds unpublished local work, since those are the paths by which that work is inspected and preserved. |

## Unit 12: Testability

**Why:** The high-risk claims have moved. `nodeId` survival is gone with the format
that carried it. What can now silently invalidate the design is the threading
invariant, the outdated-comment path, and the diff-line constraint on creation — all
three are GitHub behaviours we do not control, so each needs a recorded-response test
that fails loudly when GitHub changes.

| ID | EARS statement |
| --- | --- |
| R-12.1 | *(Withdrawn with Unit 2 — `nodeId` no longer exists.)* |
| R-12.2 | *(Withdrawn with Unit 2.)* |
| R-12.3 | THE GitHub execution layer SHALL accept an injectable process-spawn or request executor, mirroring the injectable `spawnClaude` seam in the apply flow, so that its behaviour can be tested against recorded responses. |
| R-12.4 | THE SYSTEM SHALL include a test asserting that a recorded review-comment list containing roots and replies projects into the expected threads, including a reply whose root is absent. |
| R-12.5 | THE SYSTEM SHALL include a regression suite asserting that local-mode comment resolution behaviour is unchanged by the collaboration feature. |
| R-12.6 | THE build SHALL assert that every Node-reachable bundled entrypoint — the CLI and the Vite plugin host — contains no `react` or `react-dom` references, so that a Luthor import reaching `core/` fails the build rather than shipping a broken binary. |
| R-12.6a | THE SYSTEM SHALL NOT import Luthor from any module reachable by the CLI entrypoint. *(Salvaged from R-3.3.)* |
| R-12.7 | THE SYSTEM SHALL include a test asserting that publish rejects a payload missing `markdown`. |
| R-12.8 | *(Withdrawn — there is no second artifact to generate from the same source, so there is nothing to hold to a single generation function.)* |
| R-12.9 | THE SYSTEM SHALL delete the import-boundary test that forbade Markdown parsing on the collaboration path, rather than weakening it, because its premise — that Markdown is derived and never canonical — is now false. |
| R-12.10 | THE SYSTEM SHALL include a test asserting that a comment reporting no current line, whose snippet matches exactly once, anchors to that line and is marked outdated, and that one matching zero or many times is presented unanchored. |
| R-12.11 | THE SYSTEM SHALL include a test asserting that a review-comment list spanning multiple pages is accumulated before threads are grouped. |
| R-12.12 | THE SYSTEM SHALL include a test asserting that a GraphQL response carrying an `errors` array is classified as a failure and not as success. |

## Unit 13: Reviewing a pull request's code

**Why:** Units 1–12 make *one document* reviewable. They do not let a reviewer see
which pull requests exist, and they read a single file through the GitHub API — the
right shape for one document and the wrong one for a pull request, where the reviewer
needs the changed files, the files around them, and no round trip per path. This unit
adds pull-request discovery and a local checkout of the pull request's tree, kept
outside the directory the user is currently serving so that unsaved local work is never
disturbed. The checkout is a review surface, not a workspace: nothing here commits,
pushes, or merges, and Unit 7's "merging is not part of visual-spec" is unchanged.

**Scope.** Every requirement in this unit that names a checkout describes the
checkout-backed review source, which is used wherever the served directory is a git working
tree with an origin. Where it is not, no checkout exists and `collaboration-workspace.md`
supplies the review instead; the requirements below that presuppose one do not apply to it.
R-13.1, R-13.2, R-13.11, R-13.12 and R-13.13–R-13.20 hold for both sources.

| ID | EARS statement |
| --- | --- |
| R-13.1 | THE SYSTEM SHALL list the pull requests of the configured repository, carrying at least number, title, state, author, head branch and head commit, so that a reviewer can choose one without leaving the application. |
| R-13.2 | THE SYSTEM SHALL treat listing pull requests as a read, requiring no write access to the repository. |
| R-13.3 | WHEN a reviewer selects a pull request, THE SYSTEM SHALL materialise that pull request's tree on the local filesystem at a path derived from its number, without changing the commit or the working copy of the directory being served. |
| R-13.4 | THE SYSTEM SHALL fetch the pull request head through a reference that GitHub serves for pull requests opened from forks, so that a fork-based pull request is reviewable on the same path as a same-repository one. |
| R-13.5 | THE SYSTEM SHALL place every such checkout under a single directory inside the git working tree hosting it, and SHALL ensure that directory is ignored by git before creating the first checkout, so that a checkout never appears as untracked content of the repository hosting it. |
| R-13.6 | THE SYSTEM SHALL check out the pull request head in a detached state, so that no edit made inside the checkout can be committed to a branch by accident. |
| R-13.7 | WHEN a pull request that is already checked out is selected again, THE SYSTEM SHALL move the existing checkout to the current head rather than recreating it, so that the path stays stable across a force-push. |
| R-13.8 | THE SYSTEM SHALL report the same filesystem path for a given checkout from every operation that names one, so that a caller can determine whether a pull request is already checked out by comparing paths. |
| R-13.9 | IF a checkout cannot be created because the pull request reference could not be fetched, or because git refused the checkout, THE SYSTEM SHALL report which of the two occurred rather than a generic failure. |
| R-13.9a | WHERE the served directory is not a git working tree, or has no origin remote, THE SYSTEM SHALL NOT attempt a checkout and SHALL supply the review from the source named in `collaboration-workspace.md` Unit 1, so that neither condition is a failure. |
| R-13.10 | THE SYSTEM SHALL reject a pull request identifier that is not a positive integer before it reaches a filesystem path or a git reference. |
| R-13.11 | THE SYSTEM SHALL present the pull request's changed files as the entry point to a review, and SHALL allow opening any other file in the checkout, so that a reviewer can read the context surrounding a change. |
| R-13.12 | WHEN the pull request head moves while a checkout is mounted, THE SYSTEM SHALL refresh the set of changed files together with the checkout, so that the two cannot disagree about which commit is under review. |
| R-13.13 | THE SYSTEM SHALL allow a comment to be written against a file and line of a checked-out pull request and held locally, in the ignored directory of R-13.5, without contacting GitHub. |
| R-13.14 | THE SYSTEM SHALL record, on each such held comment, the pull request head it was written against. |
| R-13.15 | THE SYSTEM SHALL publish a held comment to the pull request only when publication is explicitly requested, and SHALL NOT publish as a side effect of writing, saving, or refreshing. |
| R-13.16 | THE SYSTEM SHALL ensure that requesting publication twice for the same held comment results in at most one comment on the pull request. |
| R-13.17 | THE SYSTEM SHALL retain a published comment in its local record, marked as published and carrying the identifier GitHub returned, rather than deleting it. |
| R-13.18 | THE SYSTEM SHALL distinguish, in the reviewing interface, a comment held locally from one that exists on the pull request, so that a reviewer is never left inferring a comment's origin from the absence of a control. |
| R-13.19 | THE SYSTEM SHALL NOT commit, push, or merge from a pull request checkout. |
| R-13.20 | THE SYSTEM SHALL include tests that drive the checkout operations against real git repositories, since the behaviours being relied on — the fork reference, the detached checkout, and the path git reports — are git's, not this system's. |
| R-13.21 | THE SYSTEM SHALL allow a reviewer to reply, from the reviewing interface of a checked-out pull request, to a comment that is on that pull request, and SHALL post the reply to that comment's thread rather than holding it locally. |
| R-13.22 | THE SYSTEM SHALL offer the reply affordance only on comments that are on the pull request, since a comment held locally has no thread on GitHub to answer. |
| R-13.23 | WHEN a reply has been posted, THE SYSTEM SHALL re-read the pull request's comments so that the reply is shown from GitHub's record of the thread rather than from what this machine remembers sending. |
