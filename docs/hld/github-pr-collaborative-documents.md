# GitHub PR-Based Collaborative Documents — High-Level Design

## Overview

`visual-spec` today is a local, file-backed markdown browser and commenting tool. Documents are `.md` files read and written through `/__vs/source`, comments live in a flat `visual-spec-comments.json` sidecar, and a comment is anchored by file path plus line/snippet/heading. Nothing leaves the machine.

This change adds a **collaboration mode** in which a document's conversation lives on GitHub. A document is a Markdown file, committed to a branch and opened as a Pull Request. Comments become **GitHub PR review comments** anchored to a file and a line. Publishing writes the Markdown to the branch; approval and merge happen on GitHub.

**Markdown is the only document format and the single source of truth.** There is no parallel structured representation, no document envelope, and no block-identity scheme of visual-spec's own. The file a reviewer sees on the branch is the document.

**Reviewers can work in either surface.** The file in the PR is Markdown, so a reviewer can read it and comment on it directly on github.com with nothing installed. `visual-spec` is the better surface — it renders the prose and puts each comment beside the paragraph it is about — but it is no longer a precondition for participating. Every comment is a native review comment, so both surfaces see the same conversation.

**Local mode is untouched, and it is not a lesser mode.** Browsing a directory, commenting on any file or folder, and handing those comments to the Claude apply agent is the shipped product and the primary way a user works with the agent. It requires no GitHub, no network, and no Pull Request. Collaboration is additive: it changes where a comment is stored when a document is under review, and nothing else.

What this design gives up, stated plainly: **a comment can go outdated.** Anchoring is by line, so an edit that moves or rewrites the text can leave a comment without a current position — exactly as it does on any GitHub pull request. The system reports that state rather than guessing a new one.

## Stakeholders & Impact

### Document author

The person who creates a document and owns it through to publication.

- **Today:** edits a markdown file locally, collects comments in a JSON sidecar, and runs the apply agent. There is no way to circulate the document for review without sending the file.
- **After:** creates a document, gets a branch and PR, shares a link, watches comments arrive from real reviewers, and publishes. The apply agent still works, now against the PR's comments, still editing the same Markdown file.

### Collaborator / reviewer

Someone invited to review the document.

- **Today:** cannot participate at all unless they have the same working copy.
- **After:** opens the PR — on github.com, or in their own `visual-spec` for the better reading experience — and comments on individual lines of the document.

Every participant who uses `visual-spec` runs it **on their own machine with their own GitHub PAT**. There is no shared server and no multi-tenant deployment. This keeps GitHub attribution native — each person's comments are authored by their own GitHub account — and it means the tool never handles a credential belonging to someone else.

Participants hold one of **two roles**, enforced by GitHub repository permissions rather than by convention:

| Role | GitHub permission | Can do |
| ---- | ----------------- | ------ |
| Author | write | edit the document, commit, publish, mark ready |
| Reviewer | read + comment | comment, reply — **no push** |

Because reviewers cannot push, the single-writer model is enforced by the platform, and no reviewer action may require a commit. Creating and replying to review comments needs no write access, which is what makes the reviewer role work.

**Resolving a thread happens on github.com.** `visual-spec` reads resolution state and shows it, but does not write it, and offers no resolve control — it links to the thread instead. That keeps one writer of that state and avoids a second, competing resolution model.

### Secondary consumers

- **The Claude CLI apply agent** — consumes open comments via `createApplyHub`. This is unchanged in local mode, which is its main use. In collaboration mode it consumes the PR's review comments through the same interface and edits the same Markdown file, locating the target by snippet and heading rather than by line number.
- **The two host workflows** — the standalone CLI (`packages/visual-spec/src/server.ts`) and the Vite plugin. Collaboration mode ships in the shared UI and route layer, so both hosts get it without host-specific code.
- **GitHub itself** — the durable system of record for the conversation. Every comment lives there, so the conversation survives cache deletion, machine loss, and the tool itself. A reviewer who never installs `visual-spec` can read the document and join the conversation in full.

## Goals

When this ships, the following must be observably true.

1. An author can turn a Markdown document into a GitHub branch + commit + open Pull Request from the `visual-spec` UI, without leaving it.
2. A comment written on a block of the rendered document is created as a GitHub PR review comment on that file and line, and appears inline on the PR diff for anyone reading it on github.com.
3. Comments made on github.com appear in the `visual-spec` UI after a sync, anchored to the block they name, and comments made in `visual-spec` appear on the PR.
4. A reply written in the UI lands inside the existing thread, not as a new one.
5. A comment whose text has moved is reported as outdated rather than silently re-anchored to the wrong paragraph, and is never hidden.
6. A reviewer with read-only repository access can open the PR in `visual-spec`, read the document, comment on a line, and reply — without any write permission on the repository.
7. Publishing commits the Markdown to the PR branch and verifies what GitHub stored. Merging is a separate act performed on github.com.
8. Author-only operations (edit, commit, mark ready, merge, publish) are refused by the server for non-authors, not merely hidden in the UI.
9. Both the standalone CLI and the Vite plugin expose collaboration mode from the same shared UI code.
10. Local commenting and the Claude apply flow behave exactly as they do today when no collaboration configuration is present.

## Non-Goals

- **Replacing local mode.** Existing local file browsing, `visual-spec-comments.json` commenting, and the Claude apply flow keep working unchanged for non-collaborative documents. This is the shipped product and a regression here is worse than collaboration not shipping.
- **A structured document format.** There is no canonical JSON, no document envelope, and no block-identity scheme. Markdown is the document.
- **Migrating documents authored in the retired JSON format.** No converter is built. Pull Requests already open in that format keep their branch artifacts and are finished as they are.
- **Real-time co-editing.** The editing model is single-writer: the author edits, collaborators comment. There is no CRDT, no operational transform, and no live cursor presence.
- **Writing resolution state.** Resolution is read from GitHub and displayed. Resolving happens on github.com.
- **Comments that never go outdated.** Line anchoring drifts. The system reports drift; it does not attempt to defeat it by fuzzy matching.
- **Commenting on arbitrary lines regardless of the diff.** GitHub accepts a line-anchored review comment only on a line inside the Pull Request's diff. Outside it, the comment is posted against the file, with the selected text quoted.
- **Webhook infrastructure.** Sync ships as polling plus manual refresh. The sync entrypoint is designed so a webhook receiver could later drive the same path, but no receiver, tunnel, or public endpoint is built.
- **Browser-side GitHub access.** The PAT never reaches the browser. No GitHub call originates from the client.
- **Remote repository browsing.** The file tree stays local; only the document under review is read from the branch.
- **Changing `CommentTarget` for local comments.** The existing target shape is preserved, and PR review threads project onto it without adding a field.

## Success Criteria

| # | Outcome | How it is observed |
| - | ------- | ------------------ |
| SC-1 | Create → Share → Comment → Reply → Publish completes end to end | An author drives the full lifecycle in the UI against a real repository and the PR ends up merged with the final Markdown in the base branch |
| SC-2 | Comments anchor to the right prose | Comment a block, edit an unrelated part of the document, sync — the comment is still on its block; edit the commented text itself and it is reported outdated, never moved to a different paragraph |
| SC-3 | Bidirectional conversation | A review comment posted on github.com appears in the UI after sync, anchored to its line; a comment posted in the UI appears inline on the PR diff |
| SC-4 | Threads and replies | A reply written in the UI appears inside the same GitHub thread, and a thread with replies renders as one thread rather than several comments |
| SC-5 | Correct attribution and the reviewer role | Two participants on two machines with two PATs — one with write access, one read-only — produce two distinct GitHub comment authors, and the read-only participant completes open → read → comment → reply without write permission |
| SC-6 | Backend authorization | A non-author's edit/commit/merge/publish request is rejected by the server with the UI control removed as well |
| SC-7 | No credential leakage | No GitHub token appears in any response body, SSE event, client bundle, or browser-visible state |
| SC-8 | Local server is not drivable cross-origin | A page on another origin cannot cause any `/__vs` route to mutate state or return a readable response, verified in both the standalone and Vite hosts |
| SC-9 | Local mode and the Claude flow intact | The existing local commenting and apply flows pass unchanged with no collaboration configuration present |
| SC-10 | The reviewer needs nothing installed | A reviewer opens the PR on github.com, reads the document as Markdown, and comments on a line; that comment appears correctly anchored in the author's `visual-spec` after a sync |
| SC-11 | Review anchors against the branch, not a stale buffer | With unpublished local edits present, a comment created in the UI lands on the line of the branch's document that the user was actually looking at |
