# Git Context in the Header — Tasks

> Source specs: `docs/ears/git-context-in-header.md`, `docs/lld/git-context-in-header.md`,
> `docs/hld/git-context-in-header.md`. Build order: the reader (Unit 1) → the route
> (Unit 2) → the chip (Unit 3) → the branch at apply (Unit 4).
>
> **Cross-chain ordering:** story 2.3 below depends on the `/__vs/*` 404 catch-all
> landing first, which is story 4.1 of `docs/tasks/local-file-creation.md`. That is
> a sequencing note, not a declared dependency — the two chains ship independently
> otherwise.

## Unit 1: Reading git state

- [x] 1.1 Write `core/git-context.ts` over `git`, never throwing (est: ~45m)
  - why: an earlier design parsed `.git/HEAD` and `.git/config` by hand to avoid a subprocess. Review found two defects in it before a line existed — a linked worktree's git directory holds `HEAD` but not `config`, and a naive config scan picks up `[remote "upstream"]` when it precedes `[remote "origin"]` — and `include`/`includeIf`/`insteadOf` sit behind those. Delegating deletes the ancestor walk, the `gitdir:` indirection, `commondir`, submodules and the config parser outright. The legitimate requirement was "works when `git` is absent", and a `catch` satisfies that; a parser was never what it asked for.
  - acceptance: R-1.1 — the branch, detached state and `origin` URL come from invoking `git` against the served directory; R-1.2 — a spawn failure, a non-zero exit, or a refused directory reports state `none` and does not throw; R-1.4 — a named branch reports that branch with `detached` false; R-1.5 — a detached HEAD reports the short sha with `detached` true; R-1.10 — no git command that writes is invoked.
  - verify: integration tests over real temp repositories — a plain repo, a subdirectory of one, a linked worktree, a detached HEAD, and a directory with no repository. Assert `readGitContext` resolves rather than rejects when `git` is unavailable (stub the spawn with `ENOENT`) and when it exits non-zero with a `safe.directory` "dubious ownership" message, which the 2022 CVE fix made a real occurrence in containers and mounted volumes.
  - landed: eb30bf8 — core/git-context.ts, core/git-context.test.ts

- [x] 1.2 Parse the remote URL, and keep the raw one when it will not parse (deps: 1.1, est: ~30m)
  - why: two different situations reach the `local` state — no `origin` at all, and an `origin` whose URL matched neither supported form. Rendering both as "no remote" is a lie in the second case: an `ssh://host:2222/owner/repo.git` remote exists and the chip would deny it. Carrying the raw URL lets the display say "unrecognised" instead of "none".
  - acceptance: R-1.6 — no `origin` reports `local` with the branch and no URL; R-1.7 — `https://<host>/<owner>/<repo>` and `git@<host>:<owner>/<repo>`, each with an optional `.git` suffix, report `remote` with host, owner and repo; R-1.8 — any other URL reports `local` **carrying the raw URL**, never `remote` with empty fields; R-1.9 — only `origin` is read.
  - verify: table-driven unit tests over both accepted forms with and without `.git`, plus `ssh://`, `file://` and a malformed URL asserting `local` with `url` set. Add a repo with `upstream` and `origin` both configured and assert `origin` wins — the case the hand parser would have got wrong.
  - landed: eb30bf8 — core/git-context.ts, core/git-context.test.ts

- [x] 1.3 Keep the git reader out of the browser bundle (deps: 1.1, est: ~20m)
  - why: `core/git-context.ts` imports `node:child_process`. `ui/browser-safety.test.ts` guards value imports from `ui/App.tsx`, but the repository's answer to this exact situation is `ui/use-tree.ts`, which redeclares `TreeEntry` and `FileKind` rather than importing them from `tree-store.ts` — because a `type` keyword someone later deletes is not a guard. `browser-safety.test.ts`'s own header records that the last time this boundary was crossed, `npm run build` was broken for several commits with the suite green.
  - acceptance: R-1.3 — the git-context module is unreachable from the browser bundle's import graph; R-1.11 — only host, owner, repository, branch and origin URL cross the process boundary, never absolute paths or configuration contents.
  - verify: extend the existing browser-safety import-graph assertion to cover `core/git-context.ts`. Assert the route's JSON response contains no absolute filesystem path for a repository served from a nested directory.
  - landed: b8bf0a8 — ui/browser-safety.test.ts

## Unit 2: The route

- [x] 2.1 Add `core/vite/routes/git.ts` and wire both hosts (deps: 1.2, est: ~30m)
  - why: same rule as every other route in that directory — one module, two hosts, no independent copy to drift. The served root is mutable via `POST /__vs/dir/pick`, so the handler reads the current root per request rather than closing over the startup value, exactly as `handleTree` does.
  - acceptance: R-2.1 — `GET /__vs/git` returns the git context of the currently served directory as JSON; R-2.2 — a directory change is reflected in the reported context; R-2.3 — both hosts reach one shared module and neither carries its own implementation.
  - verify: request the route on both hosts against the same repository fixture and diff the bodies. Change the root and assert the next request reports the new directory. Note `ChangeDirButton` (`ui/main-header.tsx:113`) does a full `window.location.reload()`, so the picker path is covered by construction — assert it anyway at the route level, where the reload does not help.
  - landed: b8bf0a8 — core/vite/routes/git.ts, core/vite/routes/git.test.ts; hosts wired in c352139 (src/server.ts, core/vite/md-plugin.ts)

- [x] 2.2 Read per request, with no cache (deps: 2.1, est: ~10m)
  - why: an earlier design cached the parse by `mtime`. It is deleted: it was state with invalidation built to make a polling timer cheap, and the timer is gone. Its key was also never specified — a root change to a different repository with indistinguishable mtimes would have served the previous repository's context, contradicting R-2.2 outright.
  - acceptance: R-2.4 — the git context is read per request and never served from a cache.
  - verify: change the branch of the fixture repository between two consecutive requests with no delay and assert the second reports the new branch. Assert the module holds no module-level mutable state.
  - landed: b8bf0a8 — core/vite/routes/git.ts, core/vite/routes/git.test.ts

- [x] 2.3 Put the route behind the guard, and 404 when absent (deps: 2.1, est: ~15m)
  - why: read-only, so it inherits the `/__vs` cross-origin guard by registration order and needs nothing further. The 404 half matters for a different reason: without it a new client against an old server receives the SPA shell with a 200 and a JSON parse error, instead of a 404 it could report.
  - acceptance: R-2.5 — the route sits behind the existing `/__vs` cross-origin guard on both hosts; R-2.6 — a host without this route answers 404 with a JSON body and does not serve the SPA shell.
  - verify: raw requests with `Sec-Fetch-Site: cross-site` and with a non-loopback `Host` are refused on both hosts. For the 404 half, assert against a host build with the route unwired. Sequencing: needs story 4.1 of the file-authoring plan.
  - landed: c352139 — core/vite/host-parity.test.ts

- [x] 2.4 Record the served-directory boundary crossing as an ADR (deps: 2.1, est: ~20m)
  - why: `git -C <dir>` searches upward, so this route reports a repository that may sit *above* the directory the user chose to serve. Every other route holds the `TreeStore` boundary. Crossing it is deliberate and is the point — a `docs/` subdirectory is a common way to point this tool at a repository — but it is a security-relevant decision, and the difference between a decision and an oversight is whether it was written down.
  - acceptance: the ADR states what crosses the boundary and what does not, matching R-1.11.
  - verify: `docs/decisions/` carries the ADR, and the LLD's Key Decisions references it.
  - landed: c352139 — docs/decisions/0001-git-context-crosses-the-served-directory-boundary.md, docs/lld/git-context-in-header.md

## Unit 3: The header chip

- [x] 3.1 Write `ui/use-git-context.ts` — read on mount, focus and visibility (deps: 2.1, est: ~30m)
  - why: this is the pattern the repository already ships and already tests — `core/app/lib/use-comments.ts:56-57` registers exactly these two listeners, and `ui/comment-history.integration.test.ts:170-174` asserts they are present. It also covers the actual scenario: the user goes to a terminal, changes branch, comes back — and coming back *is* the focus event. A timer only wins while someone stares at an untouched tab.
  - acceptance: R-3.10 — the hook reads `GET /__vs/git` on mount and again on window focus and on document visibility change; R-3.11 — it polls on no timer; R-3.12 — a failed read retains the last known state rather than replacing the chip with an error.
  - verify: hook test asserting a fetch on mount, one more per `focus` and per `visibilitychange`, and none in between with fake timers advanced. Assert a rejected fetch leaves the previously returned state in place. Redeclare `GitContext` in this file rather than importing it across the boundary, per story 1.3.
  - landed: d807f65 — ui/use-git-context.ts, ui/use-git-context.test.tsx

- [x] 3.2 Render the chip's states, including before the first read (deps: 3.1, est: ~40m)
  - why: the three states are what the user asked for, each with its own icon. The pre-first-read state is the fourth thing on screen and the easiest to skip: without it the chip flashes "not a git repo" and then corrects itself, which is exactly the confusion the three states exist to prevent.
  - acceptance: R-3.1 — the chip sits adjacent to the served path in both the main header and `BrandHeader`; R-3.2 — before the first read completes it asserts none of the three states; R-3.3 — `none` shows a "not a git repository" icon and label and no branch or repository; R-3.4 — `local` without a URL shows a disconnected icon, the branch, and that no remote is configured; R-3.5 — `local` with a URL shows a disconnected icon, the branch, that the remote was not recognised, and the raw URL on hover; R-3.6 — `remote` shows a connected icon, the `owner/repo` pair and the branch.
  - verify: component tests over each state including the pre-read placeholder. Assert the `local`-with-URL case never renders the words used for the no-remote case — that is the specific lie this state exists to prevent.
  - landed: d807f65 — ui/main-header.tsx, ui/git-chip.test.tsx

- [x] 3.3 Link only GitHub, and mark a detached HEAD as one (deps: 3.2, est: ~20m)
  - why: owner, repository and branch are host-independent facts and a GitLab user should see them. Only the URL shape for linking is GitHub-specific, so only the link is conditional. And a bare 7-character hex string in the branch slot reads as a branch called `a1b2c3d` unless it says otherwise.
  - acceptance: R-3.7 — on `github.com` the repository name is a link opening in a new tab with `rel="noopener noreferrer"`; R-3.8 — on any other host it is text with no link; R-3.9 — `detached` true presents the sha as a detached HEAD rather than as a branch name.
  - verify: component tests for a `github.com` remote (anchor present, correct `rel` and `target`), a `gitlab.com` remote (no anchor), and a detached HEAD (sha shown, labelled detached).
  - landed: d807f65 — ui/main-header.tsx, ui/git-chip.test.tsx

## Unit 4: The branch at the point of apply

- [x] 4.1 Show the active branch in the apply scope chooser (deps: 3.1, est: ~25m)
  - why: this is the requirement that makes the HLD's motivating sentence true rather than merely stated. The failure being fixed is "comment, run apply, and the edits land on whichever branch happened to be checked out" — a chip in the header corner does not fix that, because the decision is made in `ScopeChooser` (`ui/main-header.tsx`), which is somewhere else on screen.
  - acceptance: R-4.1 — the apply scope chooser displays the active branch; R-4.2 — where no branch is known, whether state `none` or the first read has not completed, it displays none and does not block the apply run.
  - verify: component test — with a `remote` state, assert the branch appears in the scope chooser before any scope is picked. With state `none` and with the pre-read state, assert no branch is shown and every scope button still works.
  - landed: d807f65 — ui/main-header.tsx, ui/git-chip.test.tsx
