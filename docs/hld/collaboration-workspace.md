# Collaboration Workspace — High-Level Design

## Overview

`visual-spec` reviews a pull request by mounting its tree as a git worktree inside the
directory the user is currently serving. That works when the reviewer already has the
repository cloned and is serving it. When they do not, the review refuses — `not-a-repo`
or `no-origin` — and tells them to go clone the repository and come back.

This change removes that precondition. `visual-spec` gains a **managed workspace root**
under `~/.visualspec/` where it provisions, on demand, the repositories a review needs.
A reviewer handed a pull request link reviews it. No clone, no `cd`, no restart.

**The user's own clone always wins.** When the directory being served is a working tree
of the repository the pull request belongs to, that working tree is used exactly as it is
today — same worktree machinery, same paths, same behaviour. The managed workspace exists
only for the case where there is nothing to reuse. This is not a plan to centralise the
user's repositories; it is a fallback that makes the refusal disappear.

**One workspace root, many repositories.** A reviewer's pull requests do not come from
one repository, so the managed root holds a clone per repository and each review resolves
its own. The single server-wide `owner/repo` that collaboration assumes today stops being
the boundary of what can be reviewed.

**Reviewing is still not a workspace.** A managed clone is a read surface. Nothing in this
change commits, pushes, merges, or opens a branch in it. Checkouts stay detached, and
"merging is not part of visual-spec" is unchanged.

What this design gives up, stated plainly: **`visual-spec` starts writing outside the
directory it was pointed at.** Today every byte it persists lives under the served
directory, which makes its footprint obvious and its removal trivial. After this, it owns
a directory in the user's home and clones repositories into it. That is a real change in
the tool's relationship with the machine, and it is the price of the reviewer never having
to clone anything by hand.

## Stakeholders & Impact

### Invited reviewer without a local clone

The person this change exists for.

- **Today:** receives a pull request link, opens `visual-spec`, and is refused with "Serve
  a directory inside the repository this pull request belongs to." Their route back in is
  to find the repository, clone it, restart `visual-spec` pointed at it, and try again.
- **After:** opens the pull request from a list of the ones that involve them, or by
  pasting its URL. `visual-spec` provisions what it needs and the review opens. They never
  learn that a clone happened.

### Reviewer who does have the repository

- **Today:** serves their clone, reviews pull requests inside it. Worktrees land under
  `<served>/.visual-spec/worktrees/`.
- **After:** unchanged for pull requests of that repository. Pull requests of *other*
  repositories, which they could not review at all before, now open against managed
  clones.

### Author

- **Today and after:** unaffected. Creating, editing and publishing a document all act on
  the served directory and the configured repository. Nothing in this change alters the
  author path.

### Returning user

- **Today:** has no memory of anything. Reopening yesterday's project means finding the
  folder again through the OS picker.
- **After:** sees the workspaces they have opened — their own directories and the managed
  clones alike — and reopens one directly.

### Secondary consumers

- **The two hosts** — the standalone CLI and the Vite plugin. Workspace resolution ships
  in the shared route layer, so both get it without host-specific code.
- **The Claude apply agent** — unaffected. It runs against the served directory in local
  mode and against a collaboration document's Markdown in collaboration mode; neither is
  the managed root.
- **The user's disk** — a new consumer, and the reason removal is in scope rather than
  deferred.

## Goals

When this ships, the following must be observably true.

1. A reviewer serving a directory that is not a working tree of a pull request's
   repository can open and review that pull request, with no manual git operation.
2. When the served directory *is* a working tree of that repository, it is used, and the
   review behaves exactly as it does today.
3. Pull requests from more than one repository can be reviewed in a single session,
   without restarting the server or reconfiguring it.
4. A reviewer can find a pull request that involves them without knowing which repository
   it is in, and can also open one by pasting its URL — including a URL for a repository
   the server was never configured with.
5. Opening a review never disturbs the served directory: no re-root, no checkout, no
   change to its working copy, and it is still there when the review closes.
6. The user can see every workspace `visual-spec` has opened or provisioned, and reopen
   one.
7. The user can remove a managed workspace and have its clone, checkouts and references
   actually gone from disk.
8. When a pull request merges or closes, its checkout and its private reference are
   released without the user asking.
9. Nothing in the managed root is committed, pushed or merged, and no checkout is attached
   to a branch.
10. With no managed workspace ever provisioned, local mode and existing single-repository
    review behave exactly as they do today.

## Non-Goals

- **Centralising the user's repositories.** The managed root is a fallback, not a home for
  the user's work. An existing working copy is always preferred, and `visual-spec` never
  moves, adopts, or writes into a clone it did not create.
- **Making the managed clone a place to work.** No commit, push, branch, merge, or publish
  targets it. Authoring stays on the served directory.
- **Scanning the filesystem for clones.** Reuse is decided from the served directory
  alone. `visual-spec` does not go looking for other copies of a repository, and does not
  read outside the served directory and its own root.
- **Two projects open at once.** A review takes the window and hands it back. There is no
  split view and no second file tree.
- **Automatic eviction.** No staleness timer, no disk budget, no least-recently-used
  reaping. Removal is the user's explicit act, plus the release of a checkout whose pull
  request has ended.
- **Cross-host support beyond GitHub.** The managed root is keyed by host so a second host
  is not designed out, but only GitHub is implemented.
- **A background daemon.** Provisioning and cleanup happen inside a request the user
  caused. Nothing runs when the application is closed.
- **Multi-tenancy.** Every participant still runs `visual-spec` on their own machine with
  their own credential. The managed root is per-user and is never shared.
- **Migrating existing checkouts.** Worktrees already mounted under a served directory
  stay where they are and keep working.

## Success Criteria

| # | Outcome | How it is observed |
| - | ------- | ------------------ |
| SC-1 | The refusal is gone | Serve an empty directory, open a pull request from a real repository, and read its changed files — with no `git clone` typed by anyone |
| SC-2 | The user's clone still wins | Serve a working tree of the repository, open one of its pull requests, and observe the checkout under that directory and nothing provisioned in the managed root |
| SC-3 | Many repositories, one session | Open pull requests from two different repositories in the same session and read both; each resolves to its own workspace |
| SC-4 | Discovery without a repository name | A pull request the user is a reviewer on appears in the list without the repository having been configured or previously opened |
| SC-5 | A pasted URL carries its repository | Pasting a pull request URL from a repository the server was not configured with opens that pull request, not a wrong-repository one and not an error |
| SC-6 | The served directory is untouched | With unsaved local edits present in the served directory, complete a review of a foreign repository's pull request; the edits, the branch and the working copy are unchanged, and the file tree returns to them afterwards |
| SC-7 | Workspaces are remembered and reopenable | Open two workspaces, restart the server, and reopen either from the list |
| SC-8 | Removal removes | Remove a managed workspace and observe the clone, its checkouts and its private references gone from disk, and the entry gone from the list |
| SC-9 | Ended pull requests release | Merge a pull request that has a checkout; the checkout and its reference are released without a user action |
| SC-10 | The managed clone is read-only in practice | Across a full review, no commit, push, branch creation or merge is issued against a managed clone, and every checkout is detached |
| SC-11 | Provisioning failures are legible | With no network, no credential, and an unwritable home directory in turn, each produces a distinct message naming what the user must fix |
| SC-12 | Nothing regresses | Local commenting, the apply flow, and single-repository review pass unchanged with no managed workspace present |
| SC-13 | No credential leakage | No token, and no path outside the served directory, appears in any response body, SSE event, or browser-visible state beyond the workspace list the user asked for |
