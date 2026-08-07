# GitHub PR-Based Collaborative Documents — EARS Specifications

> Collaboration mode is **additive**. Every requirement below applies only when a
> document is a collaboration document; local file-backed browsing and commenting
> keep their current behavior (Unit 10).

## Unit 1: Collaboration protocol model

**Why:** Every downstream layer — stores, routes, anchoring, jobs — needs one typed vocabulary for document, node, anchor, and GitHub identity. None of these fields exist in today's `CommentRecord`/`CommentTarget`, and inventing them per-call site is how the layers drift apart.

| ID | EARS statement |
| --- | --- |
| R-1.1 | THE SYSTEM SHALL define the collaboration protocol in a new module `core/collaboration/document-protocol.ts`, separate from `core/editing/comment-doc.ts`. |
| R-1.2 | THE collaboration document type SHALL carry `documentId`, `documentPath`, `title`, `frontmatter`, and `nodes[]`, with `frontmatter` held on the document envelope rather than inside `JsonDocument`. |
| R-1.3 | THE node type SHALL carry `id`, `type`, `version`, and `content`. |
| R-1.4 | THE anchor type SHALL carry `nodeId`, `nodeVersion`, and `github`. |
| R-1.5 | THE GitHub binding type SHALL carry `owner`, `repo`, `branch`, `pullNumber`, `headSha`, `issueCommentId`, `replyToId`, and `resolved`. |
| R-1.6 | A collaborative comment target SHALL include `documentId` and `nodeId`. |
| R-1.7 | THE SYSTEM SHALL NOT alter the existing `CommentTarget` shape (`path` + `kind: 'file' \| 'range' \| 'folder'`), which continues to serve local markdown and code comments. |
| R-1.8 | WHEN a persisted collaboration document is read, THE SYSTEM SHALL preserve unrecognized fields on round-trip rather than dropping them. |

## Unit 2: Canonical format and `nodeId` identity

**Why:** This is the load-bearing unit. A comment must survive an edit that moves every line number. Serialized Lexical nodes carry no stable key, so re-parsing Markdown produces a structurally identical document with zero identity continuity — `nodeId` must be assigned and persisted by visual-spec or the entire collaboration model collapses back to line anchoring.

| ID | EARS statement |
| --- | --- |
| R-2.1 | THE SYSTEM SHALL persist the canonical collaboration document as a Luthor `JsonDocument` from `@lyfie/luthor` and SHALL NOT define a bespoke node schema. |
| R-2.2 | THE SYSTEM SHALL carry `nodeId` on the node itself by registering replacement node classes through Lexical's `{ replace, with, withKlass }` node-replacement mechanism, and SHALL NOT key identity to a structural path or a sidecar map. |
| R-2.3 | THE replacement node classes SHALL return the same `getType()` string as the base classes they replace, so that Markdown transformers, `MARKDOWN_SUPPORTED_NODE_TYPES`, and toolbar behaviour continue to match. |
| R-2.4 | WHEN a node is created by the editor, THE SYSTEM SHALL assign it a `nodeId` that is unique within the document. |
| R-2.5 | WHEN a node is serialized and deserialized through `exportJSON()` / `importJSON()`, THE SYSTEM SHALL preserve its `nodeId` unchanged. |
| R-2.6 | WHEN a node's content changes, THE SYSTEM SHALL increment that node's `version` and SHALL NOT change its `nodeId`. |
| R-2.7 | WHEN a node's content is unchanged, THE SYSTEM SHALL NOT increment its `version`. |
| R-2.8 | WHEN loading a document authored before node ownership existed, THE SYSTEM SHALL backfill missing `nodeId` values on first write and SHALL record that the document was backfilled. |
| R-2.9 | WHEN the client generates Markdown for publication, THE SYSTEM SHALL use `headless.jsonToMarkdown(doc, { metadataMode: 'none' })`, so the published artifact carries no metadata envelopes. |
| R-2.10 | THE SYSTEM SHALL treat generated Markdown as write-only and SHALL NOT parse it back to reconstruct a collaboration document. |
| R-2.11 | THE structured editor SHALL be driven through `ExtensiveEditorRef.getJSON()` / `injectJSON()` rather than through a Markdown string buffer. |
| R-2.12 | IF `nodeId` assignment cannot produce a unique id for every block, THE SYSTEM SHALL fail the write and SHALL NOT persist a partially identified document. |
| R-2.13 | WHERE a collaboration document is open, THE SYSTEM SHALL NOT import `markdownToInjectable()` or `canonicalizeMarkdown()`, and a test SHALL assert this. |

## Unit 3: Document store

**Why:** Structured JSON does not fit `SurfaceStore`, whose read/write/list contract assumes text. A dedicated interface keeps the local and GitHub backends interchangeable. It deliberately does not render or generate Markdown — that happens in the browser, so the server never needs a Markdown serializer.

| ID | EARS statement |
| --- | --- |
| R-3.1 | THE SYSTEM SHALL define a `DocumentStore` interface supporting read, write, and list of collaboration documents. |
| R-3.2 | THE `DocumentStore` SHALL NOT render or generate Markdown. |
| R-3.3 | THE SYSTEM SHALL NOT import Luthor from any module reachable by the CLI entrypoint. |
| R-3.4 | THE `DocumentStore` SHALL support resolving a `nodeId` to a JSON location. |
| R-3.5 | THE SYSTEM SHALL provide a local file-backed `DocumentStore` implementation storing documents at `documents/<documentId>.json`. |
| R-3.6 | THE SYSTEM SHALL provide a GitHub-backed `DocumentStore` implementation mapping the same operations onto a PR branch. |
| R-3.7 | THE SYSTEM SHALL NOT route structured collaboration JSON through `SurfaceStore`. |
| R-3.8 | IF a requested `nodeId` does not exist in the document, THE `DocumentStore` SHALL report the node as unresolved and SHALL NOT throw an unhandled error. |

## Unit 4: GitHub execution layer

**Why:** Delegating to `gh` and GitHub MCP means the Claude CLI can drive the same operations in both host workflows, and avoids reimplementing auth, pagination, and rate limiting. Because collaboration comments are issue comments, every operation the adapter needs is available over REST — the design no longer depends on GraphQL being reachable through the chosen execution path.

| ID | EARS statement |
| --- | --- |
| R-4.1 | THE SYSTEM SHALL perform all GitHub operations through a single adapter that delegates to the `gh` CLI or the GitHub MCP server. |
| R-4.2 | THE SYSTEM SHALL NOT implement a bespoke GitHub HTTP or GraphQL client. |
| R-4.3 | THE adapter SHALL support creating a branch, committing document content, and opening a Pull Request. |
| R-4.4 | THE adapter SHALL support listing, creating, updating, and deleting PR issue comments. |
| R-4.5 | THE adapter SHALL support paginating a PR's full issue-comment list. |
| R-4.6 | THE adapter SHALL require only REST operations, and SHALL NOT depend on GraphQL being reachable through the configured execution path. |
| R-4.7 | THE adapter SHALL support merging a Pull Request. |
| R-4.8 | THE adapter SHALL accept an injectable executor so that its behaviour can be exercised against recorded responses. |
| R-4.9 | IF a GitHub operation fails, THE adapter SHALL surface a structured error identifying the operation and SHALL NOT include credential material in the error. |
| R-4.10 | IF the configured GitHub execution path is unavailable, THE SYSTEM SHALL report collaboration mode as unavailable with an actionable message and SHALL NOT fall back to a partially-functional state. |

## Unit 5: Comment projection and sidecar cache

**Why:** `CommentDocStore` is the narrowest seam in the codebase — `/__vs/comments` and the apply hub already depend on the interface, not on files. Projecting GitHub threads through it means the apply agent works in collaboration mode with no change. The sidecar must be demoted to a cache so it can never become a competing source of truth.

| ID | EARS statement |
| --- | --- |
| R-5.1 | THE SYSTEM SHALL provide a `CommentDocStore` implementation that projects GitHub PR issue comments into `CommentDoc` shape. |
| R-5.2 | WHILE a document is in collaboration mode, THE SYSTEM SHALL treat GitHub as the system of record for the conversation. |
| R-5.3 | WHILE a document is in collaboration mode, THE SYSTEM SHALL treat `visual-spec-comments.json` as a non-authoritative local cache of GitHub comments. |
| R-5.4 | WHEN a comment is created in the UI, THE SYSTEM SHALL create a GitHub PR issue comment carrying a machine-readable `documentId` + `nodeId` reference in its body, and SHALL persist the returned comment id on the record. |
| R-5.5 | THE SYSTEM SHALL NOT create GitHub review comments for collaborative documents, because a canonical JSON document's target lines are not guaranteed to appear in a diff hunk. |
| R-5.6 | WHEN a sync completes, THE SYSTEM SHALL reflect comments authored on github.com in the local projection, including comments that carry no `nodeId` reference. |
| R-5.7 | WHEN a comment carries no `nodeId` reference, THE SYSTEM SHALL present it in a document-level discussion view and SHALL NOT discard it. |
| R-5.8 | WHEN a Pull Request is merged, THE SYSTEM SHALL delete the local comment cache for that document. |
| R-5.9 | IF the local cache disagrees with GitHub, THE SYSTEM SHALL take GitHub's state as correct. |
| R-5.10 | THE SYSTEM SHALL provide the apply flow with a mode parameter selecting the canonical JSON document on the branch as its edit target, and SHALL NOT require the apply flow to edit generated Markdown. |
| R-5.11 | WHEN a comment creation request is retried after a timeout, THE SYSTEM SHALL supply an idempotency key such that no duplicate GitHub comment is created. |
| R-5.12 | THE SYSTEM SHALL express resolution state as a reply issue comment carrying a machine-readable resolved marker, so that resolution is created by the same mechanism as any other comment and requires no push access. |
| R-5.13 | WHEN a reviewer resolves or unresolves a comment in the UI, THE SYSTEM SHALL post that state as the reviewer's own GitHub identity. |
| R-5.14 | WHEN a sync completes, THE SYSTEM SHALL derive each comment's resolution state from the latest resolved marker in its replies, and SHALL NOT read resolution state from the local cache. |
| R-5.15 | THE SYSTEM SHALL make resolution state legible to a reader on github.com without visual-spec installed. |

## Unit 6: Anchor resolution

**Why:** Goal 3 of the HLD. Because identity is carried in the canonical JSON and issue comments have no diff position, collaborative resolution is a direct lookup rather than a ladder. Local mode keeps its existing line-and-snippet resolver untouched, so the durable path and the legacy path never share code.

| ID | EARS statement |
| --- | --- |
| R-6.1 | WHEN locating a collaborative comment, THE SYSTEM SHALL resolve it by `documentId` + `nodeId` against the canonical JSON document, and SHALL NOT consult line position, snippet, or heading. |
| R-6.2 | WHEN `documentId` + `nodeId` resolves and the node version matches, THE SYSTEM SHALL anchor the comment exactly. |
| R-6.3 | IF `documentId` + `nodeId` resolves but the node version does not match, THE SYSTEM SHALL anchor the comment exactly and SHALL flag it as outdated. |
| R-6.4 | IF `nodeId` does not resolve, THE SYSTEM SHALL present the comment as orphaned and unanchored, and SHALL NOT discard it. |
| R-6.5 | WHEN a comment is orphaned, THE SYSTEM SHALL display it in the document-level discussion view with its last known target text and an explicit orphaned marker, and SHALL offer manual re-anchoring to a selected block. |
| R-6.6 | THE SYSTEM SHALL NOT change the resolution behavior of `resolveMarkdownAnchors`, which remains local-mode only. |
| R-6.7 | THE SYSTEM SHALL NOT require `startLine`, `endLine`, `snippet`, `endSnippet`, or `heading` on collaborative comments. |

## Unit 7: Collaboration routes and UI mode

**Why:** Making GitHub concepts explicit in their own route family keeps `/__vs/comments` semantics intact for local mode. The UI must reuse the existing inspector, comment panel, and indicator layer — rebuilding them would double the surface area for no user-visible gain.

| ID | EARS statement |
| --- | --- |
| R-7.1 | THE SYSTEM SHALL expose `POST /__vs/collab/start`, `POST /__vs/collab/open`, `GET /__vs/collab/:id`, `POST /__vs/collab/:id/sync`, `POST /__vs/collab/:id/comments`, `POST /__vs/collab/:id/comments/:commentId/reply`, `PATCH /__vs/collab/:id/comments/:commentId`, `POST /__vs/collab/:id/publish`, and `GET /__vs/collab/:id/events`. |
| R-7.2 | THE SYSTEM SHALL keep `/__vs/comments` serving local comments with unchanged semantics. |
| R-7.3 | THE collaboration document view SHALL stamp rendered blocks with `data-vs-document-id`, `data-vs-node-id`, and `data-vs-node-version`, in addition to the existing optional `data-vs-loc`. |
| R-7.4 | THE collaboration mode SHALL reuse the existing `CommentPanel` and `IndicatorLayer` rather than introducing parallel components. |
| R-7.5 | WHEN a user selects a block and comments in collaboration mode, THE SYSTEM SHALL persist the comment against `nodeId` as its primary identity. |
| R-7.6 | THE collaboration UI SHALL be implemented in the shared UI and `/__vs` route layer such that the standalone CLI and the Vite plugin both expose it without host-specific code. |
| R-7.7 | THE SYSTEM SHALL NOT issue GitHub API calls from the browser. |
| R-7.8 | WHERE no collaboration configuration is present, THE SYSTEM SHALL NOT surface collaboration controls in the UI. |

## Unit 8: Lifecycle jobs and sync

**Why:** `createApplyHub` already solves "one server-owned operation, many browser subscribers, replayable status". Every collaboration transition has that shape. Sync must run through a single entrypoint so a webhook receiver can later drive it without redesigning the path.

| ID | EARS statement |
| --- | --- |
| R-8.1 | THE SYSTEM SHALL run each collaboration lifecycle transition as one server-owned job, and SHALL hold those jobs in a registry keyed by `documentId` so that concurrent per-document jobs do not share state. |
| R-8.2 | THE SYSTEM SHALL fan out job progress to browser subscribers over SSE at `GET /__vs/collab/:id/events`. |
| R-8.3 | THE SYSTEM SHALL support jobs for: create branch and PR, commit structured JSON, sync comments, remap comments after edits, resolve/unresolve threads, publish final Markdown, and merge the PR. |
| R-8.4 | THE SYSTEM SHALL provide job status that a late-subscribing client can read to recover current state. |
| R-8.5 | WHEN `POST /__vs/collab/start` succeeds, THE SYSTEM SHALL have created a branch, committed the structured JSON, and opened a Pull Request, and SHALL return `pullNumber` and `headSha`. |
| R-8.6 | THE SYSTEM SHALL synchronize with GitHub by interval polling and by an explicit user-initiated sync action. |
| R-8.7 | THE SYSTEM SHALL route interval polling and user-initiated sync through a single sync entrypoint that a future webhook receiver can invoke unchanged. |
| R-8.8 | THE SYSTEM SHALL NOT require a webhook receiver, tunnel, or publicly reachable endpoint. |
| R-8.9 | WHEN publish is requested, THE SYSTEM SHALL require a client-supplied payload of `json` and `markdown`, and SHALL reject a publish request that omits either. |
| R-8.10 | WHEN publish runs, THE SYSTEM SHALL commit the client-supplied payload to the PR branch and verify the committed blob against the payload bytes, and SHALL NOT merge the Pull Request as part of publish. |
| R-8.11 | THE SYSTEM SHALL compute the expected blob hash server-side from the received bytes, and SHALL NOT depend on a client-supplied hash for correctness. |
| R-8.12 | THE SYSTEM SHALL treat client-supplied Markdown as opaque bytes and SHALL NOT parse, re-render, or validate its content, because the publishing author already holds write access to the branch. |
| R-8.13 | WHEN publish completes, THE SYSTEM SHALL make the committed Markdown readable from the branch so an agent can produce a PR summary and changelog entry. |
| R-8.14 | WHEN the publishing client disconnects after the publish payload has been accepted, THE SYSTEM SHALL continue the commit, verify, and merge steps to completion. |
| R-8.15 | THE SYSTEM SHALL permit the transition to Ready only when every comment is marked resolved. |
| R-8.16 | WHEN a new comment arrives on a document in Ready state, THE SYSTEM SHALL return the document to PR-open state. |
| R-8.17 | WHEN merge is requested, THE SYSTEM SHALL re-verify at merge time that no unresolved comment exists, and IF one exists, SHALL refuse the merge rather than relying on the state observed at the last poll. |
| R-8.18 | IF branch or Pull Request creation fails partway, THE SYSTEM SHALL report the failure over SSE and SHALL leave no orphaned branch behind. |
| R-8.19 | WHEN the Pull Request is closed without merging, THE SYSTEM SHALL move the document to a closed state that a subsequent sync reports, and SHALL NOT leave it indefinitely in PR-open. |
| R-8.20 | WHEN the base branch has moved such that the Pull Request cannot merge, THE SYSTEM SHALL report a conflicted state and SHALL NOT attempt an automatic resolution. |
| R-8.21 | IF the committed blob does not match the payload bytes, THE SYSTEM SHALL abort publish before merging and SHALL report a verification-failure state, and SHALL NOT attempt to regenerate or overwrite the branch content. |
| R-8.22 | IF the target path has changed on the base branch since the branch point, THE SYSTEM SHALL report a distinct base-diverged state, separate from verification failure. |
| R-8.23 | WHEN a lifecycle request is retried, THE SYSTEM SHALL key it with an idempotency token such that no duplicate branch, Pull Request, or comment is created. |
| R-8.24 | IF a job fails partway, THE SYSTEM SHALL report the failure over SSE and SHALL leave the document in a state a subsequent sync can reconcile. |

## Unit 9: Authentication and authorization

**Why:** The proposal explicitly requires backend enforcement, not UI-only hiding. Because the credential is a PAT held server-side, the tool's entire security posture rests on that token never reaching the browser, on the local server refusing requests it did not originate, and on role separation being checked where it cannot be bypassed.

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

**Why:** Collaboration is additive. The existing local browsing, commenting, and apply flows are the shipped product; a regression there is a worse outcome than collaboration not shipping at all.

| ID | EARS statement |
| --- | --- |
| R-10.1 | WHERE no collaboration configuration is present, THE SYSTEM SHALL behave exactly as it does today for directory browsing, markdown viewing, commenting, and apply. |
| R-10.2 | THE SYSTEM SHALL keep `/__vs/tree`, `/__vs/dir`, `/__vs/raw`, `/__vs/source`, `/__vs/upload`, and `/__vs/apply` operating against local stores. |
| R-10.3 | THE SYSTEM SHALL NOT change the on-disk format of `visual-spec-comments.json` for local, non-collaborative documents. |
| R-10.4 | THE SYSTEM SHALL continue to upgrade legacy `{ file, anchor }` comment records on read. |
| R-10.5 | THE SYSTEM SHALL NOT require GitHub connectivity for any local-mode operation. |
| R-10.6 | THE SYSTEM SHALL NOT make the collaboration document view the renderer for local markdown files. |

## Unit 11: Reviewer onboarding

**Why:** Because the reviewable artifact on the branch is JSON, a reviewer cannot read the document on github.com. Getting a reviewer from a PR link to a rendered document in their own visual-spec instance is therefore not a convenience — it is the only way the feature works at all, and nothing else in the spec covers it.

| ID | EARS statement |
| --- | --- |
| R-11.1 | WHEN a collaboration Pull Request is opened, THE SYSTEM SHALL include in the PR body an instruction that renders the document in a local visual-spec instance, identifying the repository, branch, and document. |
| R-11.2 | WHEN a reviewer opens a collaboration document by Pull Request reference, THE SYSTEM SHALL fetch the canonical JSON from the branch and render it without requiring a prior local copy of the document. |
| R-11.3 | THE SYSTEM SHALL render a collaboration document for a reviewer whose credential has read access only, and SHALL NOT require write access to view or comment. |
| R-11.4 | IF a reviewer's credential lacks read access to the repository, THE SYSTEM SHALL report that specific cause rather than a generic failure. |
| R-11.5 | THE SYSTEM SHALL present the reviewer's own GitHub identity in the UI so the reviewer can confirm which account their comments will be attributed to. |

## Unit 12: Testability

**Why:** The remaining high-risk claim is that `nodeId` survives live editing; it can still invalidate the architecture and needs a test that fails loudly rather than a manual acceptance run. The Luthor-in-Node question is settled — it cannot be bundled — so the guard there is a build assertion, not a spike.

| ID | EARS statement |
| --- | --- |
| R-12.1 | THE SYSTEM SHALL include an automated test asserting that a node created by a live editor mount retains its `nodeId` through `getJSON()` and `injectJSON()`. |
| R-12.2 | THE SYSTEM SHALL include an automated test asserting that every type in `MARKDOWN_SUPPORTED_NODE_TYPES` is matched by the replacement node classes. |
| R-12.3 | THE GitHub execution layer SHALL accept an injectable process-spawn or request executor, mirroring the injectable `spawnClaude` seam in the apply flow, so that its behaviour can be tested against recorded responses. |
| R-12.4 | THE SYSTEM SHALL include a test asserting that publishing a document with no unsupported nodes produces Markdown identical to the previously published output for the same input. |
| R-12.5 | THE SYSTEM SHALL include a regression suite asserting that local-mode comment resolution behaviour is unchanged by the collaboration feature. |
| R-12.6 | THE build SHALL assert that every Node-reachable bundled entrypoint — the CLI and the Vite plugin host — contains no `react` or `react-dom` references, so that a Luthor import reaching `core/` fails the build rather than shipping a broken binary. |
| R-12.7 | THE SYSTEM SHALL include a test asserting that publish rejects a payload missing `json` or `markdown`. |
| R-12.8 | THE SYSTEM SHALL include a test asserting that the `json` and `markdown` in a publish payload are produced from the same document object by a single generation function. |
