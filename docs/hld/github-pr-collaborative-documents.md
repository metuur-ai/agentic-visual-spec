# GitHub PR-Based Collaborative Documents — High-Level Design

## Overview

`visual-spec` today is a local, file-backed markdown browser and commenting tool. Documents are `.md` files read and written through `/__vs/source`, comments live in a flat `visual-spec-comments.json` sidecar, and a comment is anchored by file path plus line/snippet/heading. Nothing leaves the machine.

This change adds a **collaboration mode** in which a document's conversation lives on GitHub. A document is authored as a structured JSON document, committed to a branch, and opened as a Pull Request. Comments become GitHub comments. Publishing writes the final Markdown to the branch; approval and merge happen on GitHub.

**The JSON document is canonical and Markdown is derived.** Markdown is generated for publication and for the agent's PR summary and changelog. It is never read back to reconstruct a document, because the round-trip through Markdown destroys block identity. Every editing and review surface is driven from the JSON.

**Reviewers read and comment in `visual-spec`, not on github.com.** The file in the PR is a JSON document; `visual-spec` renders it as prose and is the surface where block-level review happens. github.com remains the place for general, whole-document discussion — and is where every comment is durably stored — but it is not where the document is read.

The existing local mode is not replaced. Collaboration mode is added behind the same `/__vs` route shape, as alternate store implementations plus a new `/__vs/collab/*` route family — the seams (`SurfaceStore`, `CommentDocStore`, `createApplyHub`) are already storage-agnostic enough for this to be an additive change.

The single largest gap being closed is **durable document identity**. A comment must stay attached to the block it was written about, even after the document is edited and the line numbers move. Today no such identity exists.

## Stakeholders & Impact

### Document author

The person who creates a document and owns it through to publication.

- **Today:** edits a markdown file locally, collects comments in a JSON sidecar, and runs the apply agent. There is no way to circulate the document for review without sending the file.
- **After:** creates a document, gets a branch and PR, shares a link, watches comments arrive from real reviewers, resolves threads, and publishes. The apply agent still works, now against GitHub-backed comments.

### Collaborator / reviewer

Someone invited to review the document.

- **Today:** cannot participate at all unless they have the same working copy.
- **After:** opens the PR in their own `visual-spec`, reads the document as rendered prose, and comments on individual blocks. General discussion still happens on github.com.

Every participant runs `visual-spec` **on their own machine with their own GitHub PAT**. There is no shared server and no multi-tenant deployment. This keeps GitHub attribution native — each person's comments are authored by their own GitHub account — and it means the tool never handles a credential belonging to someone else.

Participants hold one of **two roles**, enforced by GitHub repository permissions rather than by convention:

| Role | GitHub permission | Can do |
| ---- | ----------------- | ------ |
| Author | write | edit the document, commit, publish, mark ready |
| Reviewer | read + comment | comment, reply, resolve — **no push** |

Because reviewers cannot push, the single-writer model is enforced by the platform, and no reviewer action may require a commit. Every reviewer-originated state change must be expressible as a GitHub comment.

Requiring reviewers to install `visual-spec` is a real adoption cost and makes **reviewer onboarding a first-class product surface**, not an afterthought — a reviewer's first experience is a PR containing a JSON file they cannot read in the browser.

### Secondary consumers

- **The Claude CLI apply agent** — already consumes open comments via `createApplyHub`. In collaboration mode it consumes GitHub-backed comments through the same interface, and reads the published Markdown from the branch to produce a PR summary and changelog. It cannot publish on its own: publishing needs the app open in a browser, so an agent run ends by handing back.
- **The two host workflows** — the standalone CLI (`packages/visual-spec/src/server.ts`) and the Vite plugin. Collaboration mode ships in the shared UI and route layer, so both hosts get it without host-specific code.
- **GitHub itself** — the durable system of record for the conversation. Every comment lives there, so the conversation survives cache deletion, machine loss, and the tool itself. A reviewer who never installs `visual-spec` can still follow and join the general discussion on the PR, but cannot read the document or comment on a specific block.

## Goals

When this ships, the following must be observably true.

1. An author can turn a document into a GitHub branch + commit + open Pull Request from the `visual-spec` UI, without leaving it.
2. A comment written on a document block is created as a GitHub comment carrying that block's `nodeId`, and reappears — attached to the same block — after the document is edited and re-read from GitHub.
3. Comment identity survives editing. A comment anchored to a block resolves by `documentId + nodeId` first, and falls back to node version only to mark the comment outdated. There is no line-position or snippet ladder: identity is carried in the canonical JSON, not inferred from text.
4. Comments made on github.com appear in the `visual-spec` UI after a sync, and comments made in `visual-spec` appear on github.com.
5. A reviewer with read-only repository access can open the PR in `visual-spec`, read the document as rendered prose, and comment on a block — without any write permission on the repository.
6. Publishing produces final Markdown from the open editor, commits it to the PR branch, and verifies what GitHub stored. Merging is a separate act performed on github.com. Publish requires the app to be open in a browser; it is not an unattended operation.
7. Author-only operations (edit, commit, mark ready, merge, publish) are refused by the server for non-authors, not merely hidden in the UI.
8. Both the standalone CLI and the Vite plugin expose collaboration mode from the same shared UI code.

## Non-Goals

- **Replacing local mode.** Existing local file browsing, `visual-spec-comments.json` commenting, and the apply flow keep working unchanged for non-collaborative documents.
- **Real-time co-editing.** The editing model is single-writer: the author edits, collaborators comment. There is no CRDT, no operational transform, and no live cursor presence. A PR branch has no merge layer and this change does not add one.
- **A bespoke document schema.** The canonical structured format is the Luthor `JsonDocument` from `@lyfie/luthor`, which the WYSIWYG editor already depends on. visual-spec's only addition is a `nodeId` field, carried by a small set of registered node classes that replace their Lexical base types.
- **Markdown as an input format.** Markdown is generated, never parsed back into a collaboration document. Reading a collaboration document from Markdown is explicitly unsupported, because block identity does not survive that round trip.
- **Native GitHub thread resolution.** Resolvable-thread state belongs to PR *review* threads, and the comment channel used here has none. Resolution is a reply-comment convention instead — reviewer-writable without push access, and legible on github.com.
- **Webhook infrastructure.** Sync ships as polling plus manual refresh. The sync entrypoint is designed so a webhook receiver could later drive the same path, but no receiver, tunnel, or public endpoint is built.
- **Browser-side GitHub access.** The PAT never reaches the browser. No GitHub call originates from the client.
- **Remote repository browsing.** The file tree stays local; only collaboration documents are GitHub-backed.
- **Changing `CommentTarget` for local comments.** The existing target shape is preserved for local markdown and code comments.

## Success Criteria

| # | Outcome | How it is observed |
| - | ------- | ------------------ |
| SC-1 | Create → Share → Comment → Resolve → Approve → Publish completes end to end | An author drives the full lifecycle in the UI against a real repository and the PR ends up merged with final Markdown in the base branch |
| SC-2 | Comments survive document edits | Comment a block, insert several blocks above it, commit, re-read from GitHub — the comment is on the same block and is not marked orphaned |
| SC-3 | Bidirectional conversation | A comment posted on github.com appears in the UI after sync; a comment posted in the UI appears on the PR |
| SC-4 | Correct attribution and reviewer onboarding | Two participants on two machines with two PATs — one with write access, one read-only — produce two distinct GitHub comment authors, and the read-only participant completes open → read → comment without write permission |
| SC-5 | Backend authorization | A non-author's edit/commit/merge/publish request is rejected by the server with the UI control removed as well |
| SC-11 | Local server is not drivable cross-origin | A page on another origin cannot cause any `/__vs` route to mutate state or return a readable response, verified in both the standalone and Vite hosts |
| SC-6 | No credential leakage | No GitHub token appears in any response body, SSE event, client bundle, or browser-visible state |
| SC-7 | Local mode intact | The existing local commenting and apply flows pass unchanged with no collaboration configuration present |
| SC-8 | Lossless publish | A document containing nodes Markdown cannot express publishes without those nodes being silently dropped from the generated artifact |
| SC-9 | `nodeId` survives the editor | Type a paragraph, split it, merge it, paste into it, save, reload from the canonical JSON — every surviving block keeps its original `nodeId`, verified by an automated test |
| SC-10 | Readable review surface | A reviewer opening the PR's JSON file in `visual-spec` sees prose indistinguishable from the published Markdown, with block-level comment indicators in place |
