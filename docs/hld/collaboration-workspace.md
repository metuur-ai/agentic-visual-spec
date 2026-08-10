# Reviewing a Pull Request Without a Clone — High-Level Design

> **Revision — the managed workspace is retired before implementation.** This document was
> originally specified around a managed root at `~/.visualspec/`, on-demand `blob:none`
> clones, a workspace registry with a recents list, and a removal lifecycle. That premise
> is withdrawn in full. Review of a pull request whose repository is not on disk is served
> from the GitHub API instead, which needs no root, no provisioning, no registry, and no
> eviction policy. The file keeps its `collaboration-workspace` slug so existing references
> resolve; the workspace is gone from the design.

## Overview

`visual-spec` reviews a pull request by mounting its tree as a git worktree next to the
directory being served. When the served directory is not a git working tree, or has no
origin, the review refuses and tells the reviewer to go clone the repository first.

This change removes that precondition without acquiring a repository store. The review
surface gains a **second source**: where a checkout is available it is used exactly as
today, and where one is not, the pull request's tree and file contents are read through
the GitHub API — the same `gh` credential, the same adapter, the same server-side rules
that already govern every other GitHub call.

**The primitive already exists on this path.** `adapter.getFile(repo, path, ref)` is called
today, during review, to anchor comments against the head commit. The changed-files pane —
the review's entry point — is already built from API data. The checkout currently supplies
two things: file bytes when a file is opened, and the secondary browse of files the pull
request did not touch. Both have API equivalents that are one call each.

**The checkout keeps winning where it earns its keep.** When the reviewer is serving a git
repository, objects are mostly local, one fetch completes the picture, and they get real
files on disk. Nothing about that path changes.

What this design gives up, stated plainly: **a review served from the API needs the network
for every file opened, and cannot be done offline.** A checkout-backed review, once
mounted, can. That is the honest cost, and it is smaller than it looks — the surface
already fetches file contents one at a time, on click.

## Stakeholders & Impact

### Invited reviewer without a clone

The person this change exists for.

- **Today:** receives a pull request link, opens `visual-spec`, and is refused with "Serve
  a directory inside the repository this pull request belongs to." Their route back in is
  to find the repository, clone it, restart pointed at it, and try again.
- **After:** pastes the link and reviews. Nothing is cloned, nothing is written outside the
  directory they were already serving.

### Reviewer who is serving a git repository

- **Today:** reviews pull requests through a worktree under that directory — including pull
  requests of *other* repositories, since the fetch source is derived per repository.
- **After:** unchanged. This is the case the worktree exists for and it is not touched.

### Author

Unaffected. Creating, editing and publishing act on the served directory and the configured
repository.

### Secondary consumers

- **The two hosts** — the standalone CLI and the Vite plugin. Source selection ships in the
  shared route layer, so both get it without host-specific code.
- **The Claude apply agent** — unaffected.
- **The user's disk** — explicitly *not* a new consumer. That is the point of the revision.

## Goals

1. A reviewer serving a directory that is not a git working tree can open and review a pull
   request, with no manual git operation and nothing written outside that directory.
2. Where a checkout is available, the review is served from it, and behaves exactly as it
   does today.
3. Pull requests of more than one repository can be reviewed in a session, with each
   request naming its own repository rather than inheriting the server's.
4. A pasted pull request URL carries its repository, so a pull request of a repository the
   server was never configured with can be opened.
5. Reviewing never disturbs the served directory: no re-root, no checkout, no change to its
   working copy.
6. Authorization for a review is decided against the repository being reviewed, not against
   the repository the server was configured with.
7. With no collaboration configured, local mode behaves exactly as it does today.

## Non-Goals

- **A managed repository store.** No root in the user's home, no provisioning, no clone
  performed on the user's behalf, no layout to maintain, no eviction policy, no disk
  accounting. Withdrawn wholesale.
- **A workspace registry or recents list.** Reopening past projects is a separate wish and
  is not part of this problem. It also introduced a serve-this-path route whose allowlist
  was a file in the user's home; that is not being traded for convenience here.
- **Cross-repository pull request discovery.** A reviewer holding a link has the repository
  in the link. Search-based listing brings a different rate limit, eventual consistency, and
  a surface that enumerates every repository the credential can read.
- **Offline review of a repository not on disk.** The API source needs the network.
- **Replacing the worktree.** It stays the source wherever a checkout is available.
- **Commit, push, branch or merge from a review.** Unchanged: merging happens on github.com.
- **Browser-side GitHub access.** Unchanged: the credential never leaves the server.

## Success Criteria

| # | Outcome | How it is observed |
| - | ------- | ------------------ |
| SC-1 | The refusal is gone | Serve an empty directory, open a pull request from a real repository, read its changed files and open files it did not change — with nothing cloned |
| SC-2 | The checkout path is untouched | Serve a git repository, review a pull request, and observe the same worktree, the same path, and the same behaviour as before this change |
| SC-3 | Many repositories, one session | Review pull requests of two different repositories without restarting or reconfiguring |
| SC-4 | A pasted URL carries its repository | A URL from a repository the server was not configured with opens that pull request, not a same-numbered one elsewhere |
| SC-5 | Nothing is written outside the served directory | Complete a full review from the API source; no file is created outside the served directory and no directory is created in the user's home |
| SC-6 | Authorization follows the reviewed repository | A credential with write access to the configured repository does not carry author-level permission into a repository it can only read |
| SC-7 | The served directory is undisturbed | With unsaved local edits present, complete a review of a foreign repository; the edits, branch and working copy are unchanged |
| SC-8 | Failures are legible | With no network, no credential, and an unreadable repository in turn, each produces a distinct message naming what the user must fix |
| SC-9 | Nothing regresses | Local commenting, the apply flow, and existing checkout-backed review pass unchanged |
| SC-10 | No credential leakage | No token appears in any response body, SSE event, or browser-visible state |
