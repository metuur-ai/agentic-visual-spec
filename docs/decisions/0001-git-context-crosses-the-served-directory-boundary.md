# 0001 — `GET /__vs/git` crosses the served-directory boundary

- **Status:** Accepted
- **Date:** 2026-08-08
- **Relates to:** `docs/lld/git-context-in-header.md`, `docs/ears/git-context-in-header.md` (R-1.11)

## Context

Every route this server exposes reads inside the directory the user chose to
serve, and `TreeStore` is what makes that true rather than merely intended:
`core/vite/tree-store.ts` resolves each relative path against `base` and throws
`path escapes base` for anything that lands outside it. Nothing reaches the
filesystem through that module without proving it stayed under the root.

`GET /__vs/git` is the first route that reads outside it. `readGitContext` runs
`git -C <dir>`, and `git` searches upward for the repository, so the branch and
remote it reports may belong to a repository whose root sits *above* the served
directory. Serving `~/work/acme-api/docs` reports `acme-api`.

That is not a side effect to be tolerated; it is what the feature is for.
Pointing this tool at the `docs/` subdirectory of a repository is the ordinary
way to use it, and a version that refused to search upward would answer "not a
git repository" in the most common case, which is the confusion the three
states exist to remove.

## Decision

`GET /__vs/git` reports the repository `git` finds from the served directory,
including one whose root lies above that directory. The `TreeStore` boundary is
not applied to this route, and no ancestor check is performed on the result.

The boundary is replaced by a limit on what leaves the process. Only these
fields cross it, per R-1.11:

- the remote host,
- the owner and repository name,
- the branch (or the short sha when `HEAD` is detached),
- the `origin` URL.

No absolute filesystem path. No configuration content. The served directory goes
into `readGitContext` as `dir` and does not come back out — `GitContext` has no
field that could carry it, so `core/vite/routes/git.ts` serving the value
verbatim cannot leak the path.

`git`'s stderr is the one channel that would break this, because the
`safe.directory` refusal prints the absolute repository path
("dubious ownership in repository at '/…'"). `defaultExecGit` calls
`child.stderr?.resume()` and never reads it: the pipe is drained so it cannot
fill and stall the child, and the bytes are discarded. Only `stdout` and the
exit code are observable, and `GitResult` has no field for anything else. A
refusal becomes `{ state: 'none' }` with no diagnostic attached.

The commands are all reads (R-1.10) and `origin` is asked for by name (R-1.9),
so no other remote's URL is seen either.

## Consequences

Someone serving `~/clients/acme/docs` publishes the repository name, the owner
and the current branch of the `acme` repository to anything that can reach the
server. "Confidential" as a branch name, or a client's name as a repository
name, is disclosed by a directory choice that did not look like a disclosure.
The user picked a subdirectory; they did not obviously pick its parent's
identity.

The `/__vs` cross-origin guard (`core/vite/request-guard.ts`) bounds this but
does not remove it. It rejects `Sec-Fetch-Site: cross-site` and `same-site` and
any non-loopback `Host`, so a page in the user's browser cannot read the route.
It deliberately allows requests with no `Sec-Fetch-Site` header, because a
non-browser caller has no ambient authority to borrow. That means any local
process that can open a socket to the port — the same trust level that already
reads the served files and can start an apply run — can also read this. The
exposure is one more fact for a caller that already has the directory.

The route also reports a repository the user cannot see in the tree. That is
correct for the feature's purpose, since the branch an apply run lands on is the
parent repository's branch, but it means the chip can name a repository whose
files the sidebar will never list.

Nothing here is reconciled against the `--repo` flag; that stays out of scope.

## Alternatives rejected

**Refuse to search upward — report `none` unless the served directory is itself
a repository root.** This holds the boundary exactly, and breaks the most common
way the tool is used. A `docs/` subdirectory would show "not a git repo" while
sitting inside a repository, and the header would be wrong in precisely the
situation the feature was built for.

**Ask the user to confirm before reading a repository above the served
directory.** A modal for a read-only lookup of a branch name, on every directory
change, paid on every startup. The cost lands on every use to guard a disclosure
that is already scoped to the local machine, and the answer would be "yes" every
time until the prompt stopped being read.

**Make the upward search configurable.** A flag, a config key, two code paths
and a state the tests must cover twice, for a preference nobody has expressed.
If a user needs the boundary held, that is a request to respond to with
evidence, not a switch to ship in advance.
