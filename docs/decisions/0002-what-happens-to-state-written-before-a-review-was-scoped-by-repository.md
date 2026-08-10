# 0002 — What happens to state written before a review was scoped by repository

- **Status:** Accepted
- **Date:** 2026-08-10
- **Relates to:** `docs/ears/collaboration-workspace.md` (R-W3.5, R-W3.6, R-W3.9, R-W5.9), `packages/visual-spec/core/collaboration/review-drafts.ts`, `packages/visual-spec/core/collaboration/worktree.ts`

## Context

A review used to be addressed by pull request number alone. It is now addressed by
repository *and* number (R-W3.5, R-W3.6), because pull request 42 exists in most
repositories and keying by the number made two of them contend for one address.

That leaves three pieces of state on disk written under the old address, and the same
question about each: adopt it, remove it, or leave it. They got three different answers,
which reads like inconsistency and is not — the answer follows from what each thing is.

## Decision

**Held review comments are adopted, and only into the configured repository.** The file
is renamed to the scoped path on first read, the destination wins if it already exists,
and no repository other than the configured one may claim it.

**Pre-scoping checkouts are removed, not adopted.** When a pull request is mounted, a
checkout of that same number left at the old path is removed with git's own worktree
removal. Checkouts of other numbers are left alone.

**The private ref stays keyed by number**, unscoped: `refs/visual-spec/pr/<n>`.

## Rationale

*Why the comments are adopted.* The file holds the record of which comments have already
been posted to GitHub. Nothing reconstructs that — abandoning the file does not lose bytes,
it loses the answer to "has this already gone out?", and every held comment silently rearms
as a duplicate. It is renamed rather than copied, so no second original diverges.

*Why only the configured repository may adopt it.* The file was written when only one
repository could be reviewed, so it belongs to that one as a matter of fact. Letting
whichever repository asks first claim it would invent a provenance and put one project's
comments into another project's review — the failure R-W3.4 and R-W3.6 exist to prevent.

*Why the checkouts are not adopted.* Two reasons, and the second is the one that decides
it. A worktree is registered with git: the checkout's `.git` file and git's
`.git/worktrees/<name>` admin directory point at each other by absolute path, so adopting
one is `git worktree move` — a different operation with its own failure modes, not the same
rename with a different destination. And it does not need adopting: a checkout holds no
bytes the user wrote. It is a detached copy of a commit the next fetch produces again,
which is the same fact that lets `unmountPullRequest` remove one with `--force`.

*Why leaving them was worse than removing them.* Nothing collides on disk — `pr-42` and
`acme/` are siblings. But the listing reads the repository out of the path, so a
pre-scoping checkout stops being reported while remaining registered with git and holding
objects alive: invisible to every surface that could remove it. A silent leak is worse than
an explicit removal. It is removed at the one moment its identity is not a guess — a mount
of that same number, which is the reviewer asking for a fresh checkout of exactly what that
directory holds a stale copy of.

*Why the ref is not scoped.* Git rejects a ref component beginning with a dot
(`check-ref-format`), and `.github` is a repository name in wide use, so
`refs/visual-spec/pr/<owner>/<repo>/<n>` would make a real repository unmountable. It would
also fix nothing: `worktree add --detach` pins the checkout to the *commit*, so a later
fetch for another repository moves the ref without touching any checkout, and the commit
stays reachable because a registered worktree's HEAD is a reachability root. Both halves
are asserted against real git rather than reasoned about, in the case that mounts two
repositories' pull request #42 side by side.

## Consequences

The migration of the comments file is irreversible by design — a `rename` has no undo. A
user who has run a version carrying this change has their comments at the scoped path; one
who has not, at the old path. R-W3.9 is what says which is correct.

`retireLegacyMount` runs on every mount and is single-use migration code. It costs one
`rev-parse` per mount, asked rather than attempted so git is not made to fail on every
mount forever to discover there is nothing to retire. It should be given an expiry.

A pre-scoping checkout of a number that is never mounted again is never removed. That is
accepted: removing it would be acting on a checkout nobody asked about.
