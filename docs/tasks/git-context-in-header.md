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

---

> **Second pass — Units 5–9.** Build order: the branch reader and its refusal rule
> (5.1–5.3) → the routes and their config gate (5.4–5.5) → the switcher in the chip
> (6.x) → the pull-request count, which is independent of all of the above (7.x) →
> the two disclosures (8.1, 9.1).
>
> Units 5 and 6 reverse exclusions the first pass recorded on purpose; the reversal
> note at the end of `docs/lld/git-context-in-header.md` is the justification and
> should be read before starting 5.1. Unit 7 is the largest share of the user's
> stated value and depends on nothing in Units 5–6 — ship it first if the two are
> ever separated.

## Unit 5: Listing and switching branches

- [x] 5.1 Write `core/git-branches.ts` — list branches, never throwing (est: ~45m)
  - why: a sibling of `core/git-context.ts`, not an extension of it. That file's header states that nothing in it writes, and R-1.10 makes the statement a requirement; keeping it true is worth more than the one import a merge would save. The same `GitExecutor` seam is reused, so the tests stay stubbed the same way.
  - acceptance: R-5.1 — local branches and the branches of `origin` come from invoking `git` against the served directory; R-5.2 — each local branch reports its name, whether it is current, and ahead/behind counts where an upstream exists; R-5.3 — the module is separate from the git-context module and R-1.10 still holds there; R-5.11 — a spawn failure, non-zero exit or refused directory reports the failure and does not throw.
  - verify: integration tests over real temp repositories — a repo with several branches, one with no upstream configured (assert ahead/behind absent rather than zero, which is a different claim), one with a detached HEAD, and a directory with no repository. Assert `core/git-context.ts` is unchanged by this story.
  - landed: e22d3fd — core/git-branches.ts, core/git-branches.test.ts

- [x] 5.2 Report a dirty working tree from `--porcelain`, repo-relative (deps: 5.1, est: ~30m)
  - why: this is where the paths in a refusal come from, and there is only one place they can. `core/git-context.ts:81` drains stderr unread because git writes absolute paths into it and R-1.11 forbids those crossing the boundary — so git's own "your local changes would be overwritten" message is unavailable by construction. `git status --porcelain` puts repository-relative paths on stdout, which is the form allowed out anyway.
  - acceptance: R-5.4 — dirtiness is determined by `git status --porcelain` and the reported paths are repository-relative; R-5.10 — only branch names, ahead/behind counts and repository-relative paths cross the boundary, never absolute paths or git's error output.
  - verify: fixture repository with a modified tracked file, a staged file, an untracked file and a renamed file; assert each is reported and that no reported string starts with the fixture's absolute root. Serve from a nested subdirectory and assert paths are still relative to the repository, not to the served directory.
  - landed: e22d3fd — core/git-branches.ts, core/git-branches.test.ts

- [x] 5.3 Refuse the change on any dirt, before `checkout` runs (deps: 5.2, est: ~40m)
  - why: the load-bearing story of the unit, and the one an earlier draft got backwards. That draft invoked `checkout` and mapped git's refusal — but `git checkout` **succeeds** whenever the modified file is identical in both commits, silently carrying the edit onto the new branch. In a repository of documents that is the ordinary case, so the draft's rule would have moved uncommitted work while reporting success, leaving the user's "it would have stopped me" false about their own edits.
  - acceptance: R-5.5 — R-5.4 is evaluated first and any reported path refuses the change without invoking `checkout`; R-5.6 — nothing stashes, discards or forces; R-5.7 — the change targets an existing local branch, or a branch of `origin` for which a tracking branch is created, and never an arbitrary client-supplied name; R-5.8 — the collaboration ignore entry is ensured present before success is reported; R-5.9 — the git context is re-read after the change and returned.
  - verify: the regression test that names the defect — modify a file that is byte-identical on both branches, attempt the change, assert it is refused and that `git rev-parse --abbrev-ref HEAD` still reports the original branch. Assert no `stash`, `--force` or `--hard` appears in any recorded invocation. Assert R-5.7 by sending `--upload-pack=…`, `-`, and a name that does not exist, and asserting each is rejected before any `checkout`. For R-5.8, check out a branch whose `.gitignore` lacks the entry and assert it is present afterwards and that `git status --porcelain` does not list the worktree directory.
  - landed: e22d3fd — core/git-branches.ts, core/git-branches.test.ts

- [x] 5.4 Add the routes to `core/vite/routes/git.ts` and wire both hosts (deps: 5.3, est: ~35m)
  - why: same rule as story 2.1 — one module, two hosts, no independent copy to drift. The served root stays mutable, so the handlers read it per request rather than closing over startup.
  - acceptance: `GET /__vs/git/branches` returns the listing of R-5.1/R-5.2; `POST /__vs/git/checkout` returns the context of R-5.9 on success and a refusal carrying the paths of R-5.4 on dirt; R-2.3 — both hosts reach one shared module; R-2.5 — both sit behind the existing `/__vs` cross-origin guard.
  - verify: extend `core/vite/host-parity.test.ts` to cover both new routes and diff the bodies across hosts. Extend `core/vite/cross-origin.test.ts` to assert `POST /__vs/git/checkout` is rejected cross-origin — note the guard is already global to `/__vs`, so this test is asserting that the new route did not escape it, not that a new gate was added.
  - landed: e22d3fd, b73062a — core/vite/routes/git.ts, core/vite/routes/git.test.ts, core/vite/host-parity.test.ts, core/vite/cross-origin.test.ts; hosts wired in b73062a (src/server.ts, core/vite/md-plugin.ts)

- [x] 5.5 Gate the routes on configuration, absent when off (deps: 5.4, est: ~25m)
  - why: this is the first browser-initiated change to the user's own checkout, and read-only is the posture everything else in this chain holds. Absent rather than present-and-403 for the same reason `resolveConfig` returns null when the collaboration block is omitted — a client cannot then distinguish "disabled" from "older server", and nothing reaches the working tree by guessing a path.
  - acceptance: R-6.3 — where changing branch is not enabled by configuration, the routes of Unit 5 are not exposed; default is off.
  - verify: with no `git` block configured, assert both routes 404 with a JSON body and not the app shell (R-2.6), and assert `GET /__vs/git` still answers — the reader is not gated. With the flag on, assert both answer. Assert the default of a config omitting the block is off, not on.
  - landed: e22d3fd — core/config.ts, core/vite/routes/git.ts, core/vite/routes/git.test.ts

## Unit 6: Changing branch from the header

- [x] 6.1 Turn the branch into a switcher when enabled (deps: 5.5, est: ~40m)
  - why: the capability is only useful where the branch already is, and when configuration has not enabled it the chip must be indistinguishable from the one Unit 3 shipped — not a disabled control advertising something the user cannot have.
  - acceptance: R-6.1 — where enabled, the branch is a control opening the list of R-5.1; R-6.2 — where not enabled, the branch renders exactly as Unit 3 specifies with no control; R-6.4 — a detached HEAD still satisfies R-3.9 and the sha is not selectable as a branch.
  - verify: component tests for enabled and disabled. In the disabled case assert the rendered output matches the existing Unit 3 chip tests — reuse those assertions rather than writing new ones, so a regression in the default path fails an existing test. Assert the detached case exposes no selectable branch.
  - landed: f1cbba3 — ui/use-git-branches.ts, ui/main-header.tsx, ui/git-branch-switch.test.tsx, ui/git-chip.test.tsx

- [x] 6.2 Confirm unsaved work against the editor that is actually on screen (deps: 6.1, est: ~25m)
  - why: an earlier draft guarded `CollabEditor`. That editor lives inside `CollabApp`, which `ui/App.tsx:180` returns early — so the main header, and therefore the switcher, is not rendered at all when it exists. The buffer that can genuinely be dirty here is `MarkdownDocEditor`, already tracked by `editorState`/`pending` in `ui/App.tsx` with a working `UnsavedDialog`. Reuse it; the draft's named guard protected nothing.
  - acceptance: R-6.5 — selecting a branch while the main document editor holds unsaved changes presents the existing unsaved-changes confirmation before the request is made.
  - verify: component test — dirty the main editor, select a branch, assert the existing dialog appears and that no request is issued until it is confirmed. Assert cancelling issues none and leaves the buffer intact.
  - landed: f1cbba3 — ui/App.tsx, ui/main-header.tsx, ui/branch-switch-app.test.tsx

- [x] 6.3 Handle the outcome — refusal, success, and a file that is gone (deps: 6.2, est: ~35m)
  - why: the refusal has to be readable without offering the escape hatch that would defeat it, and after a successful change the previously open file may not exist on the new branch. Rendering its stale contents under the new branch name is the same class of lie the chip's states exist to prevent.
  - acceptance: R-6.6 — a dirty refusal displays the reported paths and offers no discard or stash; R-6.7 — success displays the context of R-5.9 and re-reads the file tree; R-6.8 — a file absent on the new branch returns to the empty state rather than showing the previous contents.
  - verify: component tests over a refusal response (paths listed, no discard affordance rendered anywhere in the subtree), a success (chip shows the returned context rather than the optimistically selected name, tree refetched), and a success where the open file is absent from the new tree.
  - landed: f1cbba3 — ui/use-git-context.ts, ui/use-tree.ts, ui/App.tsx, ui/main-header.tsx, ui/git-branch-switch.test.tsx, ui/branch-switch-app.test.tsx

- [x] 6.4 Keep collaboration and branch changing decoupled (deps: 6.3, est: ~20m)
  - why: the two touch git for unrelated reasons and were kept apart deliberately — starting a collaboration commits through the GitHub API and never checks anything out. A future change that "helpfully" switches to `visual-spec/<documentId>` after publishing would reintroduce exactly the working-tree disturbance `core/collaboration/worktree.ts` was designed to avoid.
  - acceptance: R-6.9 — no collaboration action changes the branch.
  - verify: assert no module under `core/collaboration/` imports the checkout function, as an import-graph test in the style of `ui/browser-safety.test.ts` rather than a behavioural one — this is a boundary that must fail at the moment it is crossed, not when someone notices the symptom.
  - landed: f1cbba3 — core/collaboration/checkout-boundary.test.ts

## Unit 7: Open pull requests in the header

- [x] 7.1 Resolve `documentId` on the server from the pull request body (est: ~30m)
  - why: R-11.1's one-format rule. The trailer is written by `buildPullRequestBody` and read back by the shared parser; a second implementation in the client is how the two formats diverge, and the client would need the body shipped to it to run one.
  - acceptance: R-7.4 — the collaboration document identifier is determined on the server from the body using the same parser that writes it; R-7.5 — the client does not parse the body; `PullRequestSummary` gains `documentId?: string`.
  - verify: unit tests over a body with a trailer, one without, and one with a malformed trailer (assert `undefined`, not a throw). Assert the response body carries no pull request description text at all — the client having no body to parse is what makes R-7.5 structural rather than a convention.
  - landed: f1bb21a — core/collaboration/github-adapter.ts, core/collaboration/github-adapter.test.ts, core/vite/routes/collab.pulls.test.ts

- [x] 7.2 Fix the fork fixture that teaches the wrong shape (est: ~10m)
  - why: `core/collaboration/collab.pulls.test.ts:83` mocks `headBranch: 'contributor:patch-1'`, but `toPullRequestSummary` (`core/collaboration/github-adapter.ts:394`) maps `str(head?.ref)`, which is the bare branch name — GitHub does not owner-qualify `head.ref`. The fixture is currently validating an assumption the real mapper contradicts, so any code written against it for fork pull requests would be written against fiction.
  - acceptance: the fixture matches what `toPullRequestSummary` actually produces for a fork pull request.
  - verify: assert against a captured real payload shape rather than a hand-written one. Independent of every other story here — land it first, it is ten minutes and it stops the next reader inheriting the error.
  - landed: f1bb21a — core/vite/routes/collab.pulls.test.ts, core/collaboration/fixtures/pulls-list.json

- [x] 7.3 Show the open count in the chip, refreshed on focus (deps: 7.1, est: ~35m)
  - why: the count belongs where the repository is already named. The refresh events are the ones already chosen in R-3.10 for the same reason — the real scenario is leaving for GitHub or a terminal and coming back — and here not polling is also a rate limit, which is why R-7.10 restates it rather than leaving it to inheritance.
  - acceptance: R-7.1 — where collaboration is configured, the count of open pull requests of the configured repository appears in the chip; R-7.2 — where it is not configured, no count is displayed and none is requested; R-7.3 — the count is of all open pull requests, not filtered to collaborations; R-7.10 — read on mount and on focus/visibility, never on a timer; R-7.11 — a failed read retains the last known count and does not replace the chip with an error.
  - verify: component tests for configured and unconfigured (in the second, assert zero requests were made, not merely that nothing rendered). Assert the count equals the total returned including non-collaboration pull requests. Assert no timer is registered. Assert a failing refresh leaves the previous count on screen.
  - landed: f1cbba3 — ui/use-collab-pulls.ts, ui/main-header.tsx, ui/pull-count-chip.test.tsx, ui/git-chip.test.tsx

- [x] 7.4 Open the list, distinguish collaborations, resume or review (deps: 7.3, est: ~45m)
  - why: this is the story that delivers the user's stated need — every open pull request carrying a collaboration document is an active collaboration, and today the only way back into one is a full-surface swap you have to know exists. Both destinations already exist: `POST /__vs/collab/open` resumes, and the mount path reviews. This is wiring, not new machinery.
  - acceptance: R-7.6 — the list distinguishes pull requests carrying a collaboration document from those that do not; R-7.7 — a collaboration offers to resume by its document identifier; R-7.8 — a non-collaboration offers to review; R-7.9 — the rendered list is bounded and says so when truncated, while the count of R-7.1 is not bounded.
  - verify: component test over a mixed list asserting each row offers the correct single action. Assert resume calls the existing open route with the `documentId` and does not re-derive it. For R-7.9, render more pull requests than the bound and assert the count still reports the true total while the list states it is truncated — the two numbers disagreeing on purpose is the requirement, and a test that lets them agree is not testing it.
  - landed: f1cbba3 — ui/main-header.tsx, ui/collab-app.tsx, ui/collab-pulls-panel.tsx, ui/App.tsx, ui/pull-count-chip.test.tsx, ui/collab-app.test.tsx

## Unit 8: Naming the repository the count belongs to

- [x] 8.1 Disclose a configured repository that differs from `origin` (deps: 7.3, est: ~25m)
  - why: the chip's `owner/repo` comes from the served directory's `origin` (R-1.7); the count comes from `config.collaboration`. `POST /__vs/dir/pick` re-roots the served directory at runtime while the configuration stays fixed, so the chip can name repository Y beside repository X's count. Unit 1 declined to reconcile the two and was right to while nothing displayed both; R-7.1 displays both.
  - acceptance: R-8.1 — where the configured collaboration repository differs from the served `origin`, the repository the count belongs to is named; R-8.2 — where they match, no such naming is added; R-8.3 — neither repository is changed to resolve the difference.
  - verify: component tests for matching and differing pairs. Reach the differing case through a root change rather than by constructing the state directly, so the test exercises the path that makes divergence real. Assert the matching case renders exactly what story 7.3 rendered.
  - landed: f1cbba3 — ui/main-header.tsx, ui/pull-count-chip.test.tsx

## Unit 9: Naming the pull request under review

- [x] 9.1 Name the pull request in the collaboration surface's own header (est: ~20m)
  - why: an earlier draft made the main header mode-aware, on the premise that it shows a stale branch during review. `ui/App.tsx:180` returns `CollabApp` early, so the main header is not rendered then and the premise was false. The real gap is smaller and real: `CollabApp`'s header (`ui/collab-app.tsx:102`) says `Collaboration review` and never says which pull request, although `CollabPrReview` already holds `pull` and `worktree` as props. No state crosses a surface boundary.
  - acceptance: R-9.1 — the number and the short sha of the mounted tree are displayed while a pull request is under review; R-9.2 — no branch name is presented for a mounted tree; R-9.3 — the tree is presented as read-only; R-9.4 — this is derived from state the surface already holds, with no git call and no network call.
  - verify: component test asserting the number and short sha render from props alone, with no fetch and no git invocation. Assert no branch name appears anywhere in the header — the mounted tree is detached at a commit and naming a branch would be false. Assert the read-only presentation is present.
  - landed: deb855f — ui/collab-app.tsx, ui/collab-app.test.tsx

## Review fixes

Four defects found reading back the landed work, plus the two spec corrections they
exposed. Each was reverted locally to watch its test fail before the fix was kept.

- [x] RF.1 Attest the request guard on the git write route (R-5.5, R-2.3)
  - why: the `/__vs/git` block in both hosts was deliberately attestation-free and said so, on the grounds that it was read-only. That was true through Units 1–4 and stopped being true when `POST /__vs/git/checkout` joined it — a route that changes the user's own checkout. `core/vite/guard-attestation.ts` sets out why registration order is too weak a guarantee for a write: it is invisible at runtime and the two hosts express the guard differently. `core/vite/host-parity.test.ts` asserted the attestation was *absent*, so the omission would have stayed green.
  - acceptance: every non-GET under `/__vs/git` is refused with 500 `GUARD_NOT_RUN` unless the guard provably ran on that request, on both hosts; `GET /__vs/git` and `GET /__vs/git/branches` continue to answer with no attestation.
  - verify: the host-parity assertion inverted rather than deleted, so the record of why survives; plus a behavioural suite that starts both hosts with `attestGuardRan` replaced by a no-op — what a host that lost its guard looks like from the dispatch — and asserts the write fails closed while the reads still answer.
  - landed: b73062a — src/server.ts, core/vite/md-plugin.ts, core/vite/host-parity.test.ts, core/vite/git-write-attestation.test.ts

- [x] RF.2 Stop `ensureIgnored` leaking an absolute path from the one route that writes (R-5.12, R-5.10, R-1.11)
  - why: `ensureIgnored` rethrows any non-ENOENT read error and can fail on the write (`EACCES` on a read-only checkout, `EROFS` on a mounted volume). Node puts the absolute path into that error, `handleGitRequest` catches nothing by design, and each host's last-resort handler answers 500 with `err.message` — measured, the body was `{"error":"EACCES: permission denied, open '/var/folders/…/.gitignore'"}` on both hosts.
  - acceptance: R-5.12 — the branch change is reported as changed, carrying the context of R-5.9 and a warning that the entry was not written; answered 200 rather than 5xx, because R-6.7 has the client adopt the returned context and a failure would leave the chip naming a branch the repository has already left.
  - verify: a real repository whose committed `.gitignore` is identical on both branches and chmod 0444, driven over a socket through both hosts — the branch moved, the answer is 200 with the context and the warning, and no absolute path, errno or filesystem wording appears anywhere in the body. The read-only precondition is asserted rather than assumed, so the suite cannot pass green on a machine where nothing was tested.
  - landed: b73062a — core/git-branches.ts, core/vite/routes/git.ts, core/git-branches.test.ts, core/vite/git-checkout-ignore.test.ts

- [x] RF.3 Read only 404 as "the capability is absent" in the enablement probe (R-6.1, R-6.2)
  - why: the listing read is the capability probe, and it treated any `!res.ok` as "off". An enabled server whose git call fails answers 500, so a transient git failure removed the switcher for the rest of the session — conditioning the control on git's health when R-6.1 conditions it on configuration.
  - acceptance: 404 concludes the routes are absent; any other failing status leaves `enabled` where it was, exactly as a read that never reached a route already did; a listing concludes they are present.
  - verify: hook tests for the three-valued flag, because `null` and `false` render identically in the header by design and only the hook can tell "no answer yet" from "answered, off"; plus header tests for what the user sees in the 404, 500 and 200 cases.
  - landed: b73062a — ui/use-git-branches.ts, ui/use-git-branches.test.tsx

- [x] RF.4 Correct two requirements the implementation had already outgrown
  - why: R-5.4 said only that the paths are repository-relative. `readDirtyPaths` passes `-z` because git quotes and C-escapes any path with a space unless it does, and R-6.6 renders those strings to the user — a refusal naming `"my notes.md"` names nothing that exists. The two-path rename rule was asserted in a test with no requirement above it. R-8.1 was written as a difference test, but the implementation (`namesCountRepo`) performs an attribution test: in states `local` and `none` the chip asserts there is no remote repository and then shows a count, which has no referent at all, and a difference test says nothing about that case.
  - acceptance: R-5.4 restated to require verbatim, unescaped, repository-relative paths and both paths of a rename or copy; R-8.1 restated as attribution — the count's repository is named wherever the chip does not already name it, including where the served directory has no recognised `origin`; R-5.12 added for the ignore-write failure.
  - verify: no code change — both amendments describe behaviour the suite already asserts, and the point is that the written requirement stops disagreeing with it. Story 8.1's acceptance line above still quotes the superseded difference wording; R-8.1 in `docs/ears/` is the authority.
  - landed: b73062a — docs/ears/git-context-in-header.md
