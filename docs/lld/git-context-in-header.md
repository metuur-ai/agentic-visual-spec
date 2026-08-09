# Git Context in the Header — Low-Level Design

## Architecture

### Reading git state via `git`

**`core/git-context.ts`** (host-agnostic, no HTTP or Vite awareness):

```ts
export type GitContext =
  | { state: 'none' }
  | { state: 'local';  branch: string; detached: boolean; url?: string }
  | { state: 'remote'; branch: string; detached: boolean;
      owner: string; repo: string; host: string; url: string };

export async function readGitContext(dir: string): Promise<GitContext>;
```

Three invocations, all with `git -C <dir>`:

| command | yields |
| --- | --- |
| `rev-parse --abbrev-ref HEAD` | the branch, or the literal `HEAD` when detached |
| `rev-parse --short HEAD` | the short sha, read only when the above says `HEAD` |
| `remote get-url origin` | the origin URL; a non-zero exit means no origin |

An earlier draft parsed `.git/HEAD` and `.git/config` by hand to avoid spawning a
process. That was reversed, and the reason is worth recording: the *formats* are
stable, but a hand parser is not. Before a line of it existed, review had already
found two defects in the design — a linked worktree's git directory holds `HEAD`
but not `config` (that lives in the common directory), and a naive scan of
`.git/config` picks up `[remote "upstream"]` when it precedes `[remote "origin"]`.
Neither is exotic; both are free with `git`. Beyond them sit `include`,
`includeIf` and `url.<base>.insteadOf`, which git resolves and a file scan cannot.
Reimplementing a runtime primitive to avoid depending on it is not a trade this
design should make — particularly in a tool whose collaboration half already
depends on `gh`, which depends on `git`.

Delegating to `git` deletes the ancestor walk, the `gitdir:` indirection, the
`commondir` resolution, submodule handling and the config parser outright. What
remains hand-written is one regex over the remote URL, which has no alternative.

**Every failure degrades to `{ state: 'none' }`**: `git` not installed (spawn
`ENOENT`), `git` refusing the directory (`safe.directory` / "dubious ownership",
which the 2022 CVE fix made a real occurrence in containers and mounted volumes),
or any non-zero exit. `readGitContext` never throws.

**The `local` state carries `url?`.** Two distinct situations reach it: there is no
`origin`, and there is an `origin` whose URL matched neither supported form. Both
were `local` in the earlier draft and the chip rendered both as "no remote" — which
is a lie in the second case. With `url` present the chip says "unrecognised remote"
and puts the raw URL in the title, so the display never contradicts the repository.

URL parsing accepts `https://<host>/<owner>/<repo>` and `git@<host>:<owner>/<repo>`,
each with an optional `.git` suffix. No match → `local` with `url` set, never
`remote` with empty fields.

### Crossing the served-directory boundary

`git -C <dir>` searches upward, so this route reports a repository that may sit
*above* the directory the user chose to serve. Every other route holds the
`TreeStore` boundary. Crossing it here is deliberate and is the point — a `docs/`
subdirectory is a common way to point this tool at a repository — but it is a
security-relevant decision and belongs in `docs/decisions/` as an ADR.

The limit: owner, repo, host, branch and the origin URL leave the process. No
absolute paths, no config contents, nothing else.

### The route

`GET /__vs/git` → the `GitContext` for the **currently served** directory, read
per request. The served root is mutable (`POST /__vs/dir/pick` → `setRoot`), so the
handler reads the current root rather than closing over the startup value.

Shared handler in **`core/vite/routes/git.ts`**, wired by both hosts, for the same
reason the file routes are — and note that `ChangeDirButton` (`ui/main-header.tsx:113`)
does a full `window.location.reload()` after a directory change, so re-reporting on
a picker change is free by construction rather than something to engineer.

**No cache.** The earlier draft cached the parse by `mtime` of `HEAD` and `config`.
That is deleted: it is state with invalidation, built to avoid work that now
happens only on a focus event rather than on a timer, and its key was never
specified — a root change to a different repository with indistinguishable mtimes
would have served the previous repository's context, contradicting the requirement
that a directory change be reflected immediately.

Unknown `/__vs/*` paths must answer 404 JSON rather than falling through to the
SPA shell (`src/server.ts:340`); see the file-authoring LLD, which introduces that
catch-all. Without it a new client against an old server receives `200 text/html`
and a JSON parse error instead of a reportable 404.

### Refresh: the event, not a timer

The client fetches on mount and again on `focus` and `visibilitychange`.

This is the pattern the repository already uses and already tests:
`core/app/lib/use-comments.ts:56-57` registers exactly these two listeners, and
`ui/comment-history.integration.test.ts:170-174` asserts they are there.

It also covers the actual case. The user goes to a terminal, changes branch, comes
back — and coming back *is* the focus event. A timer only wins while the user
stares at an untouched browser tab, which is not a scenario. Dropping it removes
the interval, the hidden-tab pause, and the cache that existed to make the interval
cheap.

### Type placement

`core/git-context.ts` imports `node:child_process`. The browser must not reach it.
`ui/browser-safety.test.ts` guards value imports from `ui/App.tsx`, but the
repository's established answer to this exact situation is `ui/use-tree.ts`, which
**redeclares** `TreeEntry` and `FileKind` rather than importing them from
`tree-store.ts` — because a `type` keyword that someone deletes is not a guard.
`ui/use-git-context.ts` redeclares `GitContext` the same way.

### The chip

`ui/main-header.tsx`, inside `Brand`, beside the path button — the directory and
its branch are the same fact.

| state | icon | content |
| --- | --- | --- |
| `none` | slashed branch, grey | `not a git repo` |
| `local`, no `url` | unplugged, amber | `<branch>` · `no remote` |
| `local`, with `url` | unplugged, amber | `<branch>` · `unrecognised remote` (raw URL in the title) |
| `remote` | link, green | `<owner>/<repo>` · `<branch>` |

Before the first read completes the chip asserts none of the three states — a
placeholder, so it cannot flash "not a git repo" and then correct itself, which is
precisely the confusion the three states exist to prevent.

On `github.com` the repository name is an anchor with `target="_blank"` and
`rel="noopener noreferrer"`. On any other host it is text. `detached: true` renders
the sha with a "detached HEAD" title so a short hex string is not read as a branch.

`BrandHeader` gets the chip on the same terms.

### The branch at the point of apply

`ScopeChooser` in `ui/main-header.tsx` is where the user commits to an apply run.
It displays the active branch when one is known. That is what makes the HLD's
motivating sentence true rather than merely stated: the branch is on screen at the
moment the decision is made, not only in the corner.

### Changing branch

`core/git-branches.ts`, a sibling of `core/git-context.ts` rather than an extension
of it. The separation is the point: `core/git-context.ts` states that nothing in it
writes, and that statement is worth more intact than the one import it would save.
Both use the same injectable `GitExecutor` seam.

`core/vite/routes/git.ts` gains `GET /__vs/git/branches` and
`POST /__vs/git/checkout`. Both are absent when configuration has not enabled
changing branch — absent, not present-and-403, so a client cannot distinguish
"disabled" from "older server", and neither can reach the working tree by guessing.
The existing `/__vs` cross-origin guard already covers them on both hosts; nothing
per-route is added.

**The refusal is decided before `checkout` runs.** `git checkout` succeeds when a
modified file is identical in both commits, carrying the edit silently onto the new
branch — which in a repository of documents is the common case. So `git status
--porcelain` runs first and any output refuses the change (R-5.5). This also settles
where the reported paths come from: `core/git-context.ts` drains stderr unread
because git writes absolute paths into it, so git's own "would be overwritten"
message is unavailable by construction. `--porcelain` puts repository-relative paths
on stdout, which is the only form allowed across the boundary anyway (R-5.10).

`ensureIgnored` runs again after a successful change (R-5.8). `.gitignore` is
tracked, so a branch predating the collaboration entry un-ignores `.visual-spec/`
and every mounted worktree becomes untracked noise in `git status` — the failure
`core/collaboration/worktree.ts` already exists to prevent, at the one other moment
it can occur.

**Mounted worktrees do not block a change.** They are detached checkouts holding no
branch, so git permits it, and the review surface reads them by absolute path, so a
change to the main tree cannot disturb a review in progress. An earlier draft
blocked on them; the block described no real constraint.

### Open pull requests in the chip

The count comes from the existing `GET /__vs/collab/pulls?state=open`, refreshed on
the same focus and visibility events as the context itself and by nothing else —
the reasoning of R-3.11 applies unchanged, and here it is also a rate limit.

`PullRequestSummary` gains `documentId?: string`, resolved on the server from the
body trailer with the parser that writes it. The client never sees the body. The
head repository is deliberately **not** added: it is only interesting for forks, its
source is null for a deleted fork, and nothing on screen was going to use it.

The count is of all open pull requests so that it agrees with GitHub's own number;
the list within distinguishes collaborations, which resume through the existing
`POST /__vs/collab/open`, from the rest, which mount for review. The list is
bounded, the count is not (R-7.9).

### Two repositories, named

The chip reads `owner/repo` from the served directory's `origin`; the count comes
from the configured collaboration repository. `POST /__vs/dir/pick` can re-root the
served directory into a different repository while the configuration stays fixed, so
the two genuinely diverge. Unit 1 declined to reconcile them, correctly, while
nothing displayed both at once. R-7.1 does. The response carries both and the chip
names which repository the count belongs to when they differ — a disclosure, not a
reconciliation (R-8.3).

### The pull request under review

`CollabApp` renders its own header and the main header is not mounted beneath it, so
nothing there was ever displaying a stale branch. What it fails to do is say which
pull request is on screen. `CollabPrReview` already receives `pull` and `worktree`
as props; the title line is composed from those. No state crosses a surface
boundary, and no branch is named, because the mounted tree is detached at a commit
and has none.

## Constraints

- **No new dependencies.**
- **`readGitContext` never throws**; every failure is a state.
- **`core/git-context.ts` stays read-only**; no git command that writes is invoked
  from it. Writes live in `core/git-branches.ts` and only when enabled.
- **Dirt refuses the change**; nothing stashes, discards or forces.
- **`origin` only.**
- **The served root is mutable**; the handler must not capture it.
- **Both hosts, one handler.**
- **The browser bundle must not reach `core/git-context.ts`.**

## Key Decisions

**Delegate to `git`; degrade to `none` without it.** Rejected: a hand parser of
`.git/HEAD` and `.git/config`, for the reasons above. The legitimate requirement
was "works when `git` is absent", and a `catch` satisfies it — not a parser.

**Refresh on focus, not on an interval.** Rejected: a polling timer with a
hidden-tab pause. The elegant-sounding option loses to the one the repo already
ships, and removing it cascaded away three further requirements.

**No cache.** Rejected: caching by `mtime`, which optimised a cost that no longer
exists and whose key was underspecified.

**`local` carries an optional `url`.** Rejected: a bare three-state union that
renders an unparseable remote as "no remote".

**Three explicit states rather than hiding the chip.** Rejected: rendering nothing
without a repository — ambiguous between "not a repository" and "broken".

**Report any host; link only GitHub.** Rejected: showing the chip only for GitHub.

**A distinct pre-first-read state.** Rejected: defaulting to `none` while loading.

**Redeclare the type in the UI hook.** Rejected: importing it across the boundary
under `import type`.

**Cross the served-directory boundary, and limit what leaves instead.** Recorded
in `docs/decisions/0001-git-context-crosses-the-served-directory-boundary.md`.
Rejected: refusing to search upward, which reports "not a git repo" in the most
common case; a confirmation prompt for a read-only lookup; a configuration flag
nobody asked for.

**Refuse on any dirt, decided before `checkout`.** Rejected: invoking `checkout` and
mapping git's refusal, which silently carries a modified file onto the new branch
whenever that file is identical in both commits, and whose message is on a stderr
stream this package drains unread by design.

**Changing branch is off unless configured.** Rejected: available wherever the
served directory is a repository — it is the first browser-initiated change to the
user's own checkout, and read-only remains the default posture.

**Disclose the two repositories; do not reconcile them.** Rejected: assuming the
configured repository and the served `origin` agree, which `POST /__vs/dir/pick`
makes false at runtime.

**Name the pull request inside the surface that is on screen.** Rejected: a
mode-aware chip carrying worktree state into the main header — that header is not
rendered during review at all, so the misreading it corrected could not occur.

**Omit the head repository.** Rejected: adding it to `PullRequestSummary` for fork
pull requests, where its source is null once the fork is deleted and no display
consumes it.

## Out of Scope

- Git writes other than changing branch, which Unit 5 admits deliberately and
  narrowly. Creating, deleting, renaming, merging, rebasing, committing, pushing and
  stashing all remain out.
- Working-tree status beyond the dirty check R-5.4 requires to refuse a change.
- Remotes other than `origin`.
- Commit history, log, blame, tags.
- Bare repositories.
- Resolving a difference between the configured collaboration repository and the
  served `origin`. Unit 8 names it; nothing changes either.
- The head repository of a pull request, including fork attribution.

> **Reversal note.** The first three entries above previously read "Any git write
> operation", "Working-tree status" and "Reconciling the served directory's remote
> against the `--repo` flag", with no qualification. Units 5–8 narrow them on
> purpose. The original exclusions were right for a chain that only read; they stop
> being right at the moment the header both changes the branch and displays a count
> belonging to a repository it may not be naming.
