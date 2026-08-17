# Git Context in the Header — High-Level Design

## Overview

The header names the directory being served and the file being read. It says
nothing about version control — which repository the directory belongs to, which
branch is checked out, whether it has a remote at all.

The consequence is concrete: comment on a document, run apply, and the edits land
on whichever branch happened to be checked out. Nothing on screen would have told
you which one.

This feature adds a **git context chip** to the header, reporting one of three
states with its own icon:

- **not a git repository** — the served directory is not under version control
- **local only** — a repository with a branch, no usable remote
- **connected** — a repository with a remote, showing the branch and the repository

It also puts the branch where the branch actually matters: at the point of
confirming an apply run, not only in the header. A chip in one corner and the
apply button in another does not close the gap the paragraph above describes.

## Stakeholders & Impact

- **Authors and reviewers** (primary): today they infer the branch from memory.
  After this ships the branch is on screen next to the path, it is on screen again
  when they commit to an apply run, and a directory that is not a repository says
  so instead of looking identical to one that is.
- **Users on non-GitHub hosts** (secondary): a GitLab or self-hosted remote is
  reported with its owner, repository and branch like any other. Only the
  click-through link is GitHub-specific, because only GitHub's URL shape is known.

## Goals

- The header always states which of the three states the served directory is in.
- When there is a branch, the branch name is on screen.
- When there is a remote, the repository it points at is on screen, and a GitHub
  remote is a link.
- The active branch is visible at the moment the user confirms an apply run.
- A branch switch performed outside the browser is reflected when the user returns
  to the tab, without a reload.
- The chip is honest about uncertainty: it never claims a state it has not read,
  and it never reports "no remote" for a repository that has one.

## Non-Goals

- **No git operations.** The chip reads. It does not checkout, commit, push, pull,
  fetch or stage.
- **No working-tree status.** Dirty/clean, ahead/behind, stash counts and conflict
  state are absent; they answer a question the user has a terminal for.
- **No remote other than `origin`.**
- **No history, log, or blame.**
- **No credential or identity display.** Who you are on GitHub is stated in the
  collaboration panel, where it decides what you may do.
- **No reconciliation with the `--repo` collaboration flag.** Collaboration is
  configured independently of the served directory's own remote. This feature does
  not compare them, and does not claim to.
- **Bare repositories are not supported.** Serving a bare repository reports "not a
  git repository". Known limitation, not a defect.

## Success Criteria

- Serving a directory with no repository shows the "not a repository" state, and
  no branch or repository name.
- Serving a fresh `git init` with no remote shows the "local only" state and the
  branch name — including before the first commit, where the branch exists but has
  no commits yet.
- Serving a clone of `github.com/metuur-ai/visual-spec-collaboration-test` on
  branch `spike/anchor-test` shows the connected state, the `owner/repo` pair, the
  branch, and links to the repository.
- Serving a *subdirectory* of a repository reports that repository.
- Serving a linked worktree reports that worktree's branch **and** the repository's
  remote.
- A repository whose `origin` URL is in a form the display cannot parse reports the
  local state *with the raw URL available*, and does not claim there is no remote.
- Switching branch in a terminal and returning to the browser tab shows the new
  branch without a reload.
- A detached HEAD reports the short commit sha rather than reporting no branch.
- Changing the served directory via the header's folder picker reports the git
  state of the newly served directory.
- `git` not being installed, or refusing the directory, leaves the rest of the
  application working exactly as before.
