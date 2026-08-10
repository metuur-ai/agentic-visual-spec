# Reviewing a Pull Request Without a Clone — Tasks

> Source: `docs/ears/collaboration-workspace.md` (6 units, 39 requirements) and the in-place
> edits to Unit 13 of `docs/ears/github-pr-collaborative-documents.md`.
>
> **Order that matters.** Unit 1 + Unit 2 deliver the actual goal — the refusal disappears
> for the configured repository — and are usable on their own. Unit 3 is a separate
> concern (repository scoping) whose largest story, 3.3, is an authorization change and
> should not be rushed into the same increment. Unit 4 depends on Unit 3. Units 5 and 6 are
> the regression and parity contract, and their stories attach where the risk is.
>
> `mutex: collab-routes` marks stories that restructure `core/vite/routes/collab.ts`; they
> cannot run concurrently with each other.

## Unit 1: Choosing where a review reads from

- [ ] 1.1 Define the `ReviewSource` interface (est: ~45m)
  - why: the seam is the reusable artifact of this whole change — one interface, two implementations — and every later story depends on its shape. Four operations: changed paths, list a directory, read a file, head sha.
  - acceptance: R-W1.4 — THE SYSTEM SHALL expose both sources through one interface, so that the reviewing surface does not vary by source.
  - verify: the interface compiles with no implementation; a type-level test asserts both future implementations must satisfy it
  - landed:

- [ ] 1.2 Extract today's checkout behaviour behind `ReviewSource` (deps: 1.1, est: ~2h)
  - why: the checkout path must be provably unchanged before a second source exists, otherwise a regression there is indistinguishable from a bug in the new one. `mountPullRequest` is not touched — only the code that reads through the resulting checkout.
  - acceptance: R-W1.2 — IF the served directory is a git working tree with an origin remote, THE SYSTEM SHALL supply the review from a checkout, irrespective of whether that origin names the pull request's repository. R-W5.2 — WHERE a checkout supplies a review, THE SYSTEM SHALL behave exactly as it does without this feature.
  - verify: the existing checkout-backed review tests pass with no edits to their assertions; `core/collaboration/worktree.ts` shows no diff
  - landed:

- [ ] 1.3 `resolveReviewSource` and route wiring (deps: 1.2, 2.4, est: ~1.5h) (mutex: collab-routes)
  - why: this is the move the whole design rests on — replacing the single `baseDir` thunk with a decision. The rule keys on "is a git working tree with an origin", **not** on whether that origin matches the pull request's repository, because `fetchSource` already handles the foreign case and a match-only rule would move a working case off the checkout.
  - acceptance: R-W1.1 — WHEN a review is requested, THE SYSTEM SHALL determine which source supplies its files before any file is read. R-W1.3 — IF the served directory is not a git working tree, or has no origin remote, THE SYSTEM SHALL supply the review from the repository host rather than refusing. R-W1.6 — THE SYSTEM SHALL decide from the served directory alone.
  - verify: serve an empty directory, open a real pull request, read its changed files; serve a git repository and observe the checkout path taken
  - landed:

- [ ] 1.4 Report the active source to the reviewing surface (deps: 1.3, est: ~45m)
  - why: the two sources differ in one user-visible way — the host source needs the network per file and cannot work offline. A reviewer who cannot tell which one they are on cannot account for that.
  - acceptance: R-W1.5 — THE SYSTEM SHALL report which source is supplying a review.
  - verify: the review surface names its source in both configurations
  - landed:

## Unit 2: Reading a pull request from its host

- [ ] 2.1 Changed paths without a checkout (est: ~30m)
  - why: cheapest story in the unit and already half-true — the changed-files pane is API-sourced today via `compareCommits`. This makes that explicit as a `ReviewSource` operation rather than a coincidence.
  - acceptance: R-W2.1 — THE SYSTEM SHALL obtain a pull request's changed paths without a checkout.
  - verify: the changed-files pane renders for a pull request with no checkout mounted
  - landed:

- [ ] 2.2 File contents without a checkout (deps: 1.1, est: ~1h)
  - why: this is the operation the checkout is currently kept for. `adapter.getFile(repo, path, ref)` already exists and is already called on the review path for comment anchoring, so no new GitHub access mechanism is introduced — which is what keeps the credential story unchanged.
  - acceptance: R-W2.2 — THE SYSTEM SHALL obtain the contents of any file in the pull request's tree without a checkout, including files the pull request did not change. R-W2.6 — THE SYSTEM SHALL use the same credential and access path as every other operation.
  - verify: open a changed file and an unchanged file with no checkout; assert no second executor or credential path is introduced
  - landed:

- [ ] 2.3 Directory enumeration without a checkout (deps: 1.1, est: ~1h)
  - why: the reviewer needs the files *around* the change, which is the second thing the checkout supplies. `adapter.listFiles(repo, path, ref)` answers one directory per call, which matches how a tree expands on click — no recursive-tree endpoint is needed or exists.
  - acceptance: R-W2.3 — THE SYSTEM SHALL enumerate the pull request's tree without a checkout, and MAY do so one directory at a time as the reviewer opens them.
  - verify: expand two levels of the tree with no checkout mounted; assert one call per directory opened, none for unopened ones
  - landed:

- [ ] 2.4 Pin every read to the head commit (deps: 2.1, 2.2, 2.3, est: ~1h)
  - why: a review that silently spans two heads anchors comments to bytes the reviewer never saw. A force-push mid-review is the case this exists for.
  - acceptance: R-W2.4 — THE SYSTEM SHALL pin every such read to the pull request's head commit rather than to a branch name. R-W2.5 — WHEN the head moves, THE SYSTEM SHALL refresh the changed paths and the pinned commit together.
  - verify: force-push to a pull request mid-review; the surface reports a moved head and refreshes both together, never one alone
  - landed:

- [ ] 2.5 Failure taxonomy for host reads (deps: 2.2, est: ~1h)
  - why: `defaultExecGit` deliberately discards stderr, and the adapter's failures are the only ones with any detail. Without a taxonomy a failed read during browsing is an error with no cause and no recovery text — the one new user-visible failure class this design introduces.
  - acceptance: R-W2.7 — IF a read cannot be completed, THE SYSTEM SHALL report which of the following occurred — no usable credential, the repository or file could not be read, or the host could not be reached — rather than a generic failure.
  - verify: three induced failures produce three distinct messages, each naming what the user must fix
  - landed:

- [ ] 2.6 In-flight indication for host reads (deps: 2.2, est: ~30m)
  - why: every file open is now a network round trip. Silence during one reads as a frozen interface.
  - acceptance: R-W2.8 — THE SYSTEM SHALL indicate when a read is in flight.
  - verify: throttled connection; opening a file shows progress rather than nothing
  - landed:

- [ ] 2.7 Assert the host source writes nothing (deps: 2.2, 2.3, est: ~45m)
  - why: this is the invariant the withdrawn workspace design would have broken, and the reason the request guard's "a non-browser caller has no ambient authority to borrow" rationale still holds. It needs a test, not a promise.
  - acceptance: R-W2.9 — THE SYSTEM SHALL NOT write any file outside the served directory in order to supply a review. R-W6.7 — a test that a full review supplied by the host source writes no file outside the served directory.
  - verify: run a full host-sourced review under a filesystem observer; no write outside the served directory, no directory created in the user's home
  - landed:

- [ ] 2.8 Close the two source divergences (deps: 1.2, 2.3, 6.1, est: ~2h)
  - why: story 6.1 did its job and found two places the sources answer differently for the same pull request. The symlink one is not merely cosmetic — the checkout source calls `fs.readFile`, which follows a link out of the checkout, and a fork pull request's tree is attacker-controlled, so a committed link to `~/.ssh/id_rsa` renders its contents in the review surface. The exposure predates this feature (worktrees already mount inside the served directory and `/__vs/tree` already walks them) but this is the first requirement that names it.
  - acceptance: R-W2.10 — THE SYSTEM SHALL NOT read the contents of any file outside the pull request's tree, including by way of a committed symbolic link. R-W2.11 — a symbolic link reports its own target path as its contents, identically from both sources. R-W2.12 — a missing directory is reported as unreadable, not as an empty directory.
  - verify: R-W6.9 and R-W6.10 added to the parity suite; a link pointing outside the checkout yields its target path, never the pointed-at file's bytes, from either source
  - landed:

- [ ] 2.9 Resolve in-tree symlinks, refuse escaping ones (deps: 2.8, est: ~1.5h)
  - why: 2.8 closed the security hole but overshot. GitHub resolves a link whose target is inside the repository and returns that file's contents; it answers with the link's target path only when it cannot resolve — which is the out-of-tree case. Returning the target path for an in-repo link is a fresh divergence in the opposite direction, and the parity fixture cannot see it because it models every link as unresolvable.
  - acceptance: R-W2.11 — a link targeting inside the tree reports the target's contents. R-W2.11a — a link targeting outside reports its own target path and does not read the target. R-W2.11b — both sources answer alike, and the fixture models both cases.
  - verify: parity suite covers an in-repo link and an escaping link; the escaping case still never yields the target file's bytes
  - landed:

- [ ] 2.10 Record the tree and raw review routes (deps: 1.3, est: ~0m — already built)
  - why: story 1.3 had to add `GET /pulls/:n/tree` and `GET /pulls/:n/raw` because without them the host source is unreachable from either host and R-W1.1's "before any file is read" has no read to precede. No story asked for them; the plan was incomplete, not the agent overstepping. Recorded here so the work is attributed rather than landing unaccounted for.
  - acceptance: R-W1.3 — the host source supplies a review rather than the request being refused.
  - verify: covered by 1.3's route tests — listing, file read, root default, not-readable → 404, one resolution across three reads
  - landed: (built under 1.3)

- [ ] 2.11 Wire the reviewing surface to the host source's reads (deps: 1.3, 1.4, est: ~4h)
  - why: **SC-1 is not met without this.** A host-sourced review currently opens, names its source, lists its changed files and holds comments, but opening a file still reads through `/__vs/tree/file` under the worktree prefix — so with no checkout on disk the reader sees "No preview for this file." Story 1.3 built `/pulls/:n/tree` and `/pulls/:n/raw`; nothing consumes them. The honest blocker is that `useTree`'s contract is a flat full walk of a directory, and the host source can only answer one directory per call, so the surface needs lazy per-directory expansion before it can read from either source uniformly. Branching the read path on the source kind would satisfy the symptom and destroy the seam, so it is explicitly not the fix.
  - acceptance: R-W1.3 — the host source supplies a review rather than the request being refused. R-W1.4 — both sources are exposed through one interface, so that the reviewing surface does not vary by source. R-W2.2 — the contents of any file in the tree, including files the pull request did not change.
  - verify: serve an empty directory, open a real pull request, open a changed file and an unchanged file, and read both — the SC-1 check, end to end, with nothing cloned
  - landed:

## Unit 3: Reviewing across repositories

- [ ] 3.1 Repository-scoped route family (est: ~2h) (mutex: collab-routes)
  - why: putting the repository in the path rather than a body field turns "the client forgot the repository" into a 404 instead of a plausible wrong-repository review. A header cannot carry it — `EventSource` cannot set headers, which is the same reason the request guard is not a token.
  - acceptance: R-W3.1 — THE SYSTEM SHALL require a repository to be named by each request that reviews a pull request, and SHALL refuse a request that names none rather than substituting one. R-W3.2 — WHERE a request uses the route form that predates this requirement, THE SYSTEM SHALL apply the configured repository.
  - verify: a request on the new form with no repository 404s; the legacy form still resolves the configured repository
  - landed:

- [ ] 3.2 Decode then validate repository segments (deps: 3.1, est: ~45m)
  - why: segments are matched `[^/]+`, so a bare `..` cannot appear — but `%2e%2e` can, and normalising it instead of refusing it is how a path-confusion bug gets written.
  - acceptance: R-W3.7 — THE SYSTEM SHALL decode a repository identifier supplied in a request before validating it, and SHALL refuse one that does not name a well-formed repository. R-W6.6 — a test that an identifier attempting to escape its expected form, including in encoded spelling, is refused.
  - verify: encoded and bare traversal attempts both refused, not normalised
  - landed:

- [ ] 3.3 Scope availability and authorization to the requested repository (deps: 3.1, est: ~3h) (mutex: collab-routes)
  - why: **the largest omitted piece of the original design.** `gate()` resolves the repository from server config and seven handlers call `repoRefOf(gated.repo)`; the authorizer caches effective permission per `owner/repo` and decides author-only from it. Left alone, a credential with write access to the configured repository carries author-level decisions into a repository it can only read. Harmless while every review route is any-role, and privilege confusion the moment one is not.
  - acceptance: R-W3.3 — THE SYSTEM SHALL determine availability and authorization for a review against the repository named by the request. R-W3.4 — THE SYSTEM SHALL NOT grant, on the basis of permissions held in one repository, any operation on another. R-W3.8 — reviewing any repository is a read operation.
  - verify: a credential with write on repo A and read-only on repo B is classified reviewer for B's pull requests; preflight and availability cache per requested repository
  - landed:

- [ ] 3.4 Identify a review by repository and number (deps: 3.1, est: ~1h)
  - why: pull request 42 exists in most repositories. Keying on the number alone was safe only while there was one repository.
  - acceptance: R-W3.5 — THE SYSTEM SHALL identify a review by repository together with pull request number.
  - verify: two repositories' pull request 42 resolve to two distinct reviews
  - landed:

- [ ] 3.5 Identify held review comments by repository and number (deps: 3.4, est: ~1.5h) (mutex: collab-routes)
  - why: drafts live at `<servedDir>/.visual-spec/reviews/pr-<n>.json`, keyed by number alone. Under multi-repository review two repositories' drafts would share a file. Five call sites pass `baseDir()` today and all five change.
  - acceptance: R-W3.6 — THE SYSTEM SHALL identify locally held review comments by repository together with pull request number.
  - verify: hold a comment on repo A's #42 and repo B's #42; two files, neither overwriting the other; publish targets the right pull request
  - landed:

## Unit 4: Entry point

- [ ] 4.1 A pasted URL carries its repository (deps: 3.1, est: ~1h)
  - why: the panel already advertises "for a pull request in another repository" and cannot deliver it, because `parsePullRequestReference` extracts the digits and discards the owner and repo. Cheapest requirement in the spec and the one that makes a link-holding reviewer self-sufficient.
  - acceptance: R-W4.1 — WHEN a reference is supplied as a URL, THE SYSTEM SHALL take the repository from it together with the number. R-W4.2 — THE SYSTEM SHALL continue to accept a bare number and apply the configured repository. R-W4.3 — IF a reference names no repository and none is configured, THE SYSTEM SHALL report the repository is unknown rather than attempting the review.
  - verify: a URL from an unconfigured repository opens that pull request; `#42` still resolves the configured one; a bare number with nothing configured reports unknown repository
  - landed:

- [ ] 4.2 Display the repository under review (deps: 1.4, est: ~30m)
  - why: with multiple repositories reachable, a wrong-repository review must be obvious in a second rather than after twenty minutes of reading a plausible diff. This is the cheap half of the defence; 3.1's 404 is the other.
  - acceptance: R-W4.5 — THE SYSTEM SHALL display the repository of the pull request under review at all times while a review is open.
  - verify: the repository is visible in the review surface without scrolling or hovering
  - landed:

## Unit 5: What must not change

- [ ] 5.1 Local mode and configured-repository listing untouched (est: ~45m)
  - why: local mode is the shipped product, and a regression there is worse than this feature not shipping. The existing pull request listing — including the shipped "awaiting you" sections — must be unaffected.
  - acceptance: R-W5.1 — WHERE no collaboration is configured, THE SYSTEM SHALL behave exactly as it does without this feature. R-W4.4 — THE SYSTEM SHALL continue to present the pull requests of the configured repository.
  - verify: the local-mode and `pull-requests-awaiting-you` suites pass with no assertion edits
  - landed:

- [ ] 5.2 The served directory is undisturbed by a review (deps: 1.3, est: ~1h)
  - why: the promise the worktree design was built on, now extended to a source that has no working copy at all. Unsaved edits are the case that matters.
  - acceptance: R-W5.3 — WHILE a review is open, THE SYSTEM SHALL leave the served directory's working copy, current branch, and unsaved contents unmodified. R-W5.4 — WHEN a review is closed, THE SYSTEM SHALL return the interface to the served directory.
  - verify: with uncommitted edits present, complete a foreign-repository review; edits, branch and working copy unchanged, and the file tree returns to the project
  - landed:

- [ ] 5.3 No writes, no serve-path creep, no credential leak (deps: 1.3, est: ~1h)
  - why: R-W5.6 is the guard against the withdrawn design creeping back — the server has never accepted a caller-supplied directory to serve, and that must stay true now that nothing needs it to change.
  - acceptance: R-W5.5 — THE SYSTEM SHALL NOT commit, push, create a branch, or merge as part of a review. R-W5.6 — THE SYSTEM SHALL NOT accept a directory to serve that the user did not choose through the operating system's own directory chooser. R-W5.8 — no credential in any response, event, or client-visible state.
  - verify: no write git command issued across a full review; a caller-supplied serve path is refused; token scan over responses and SSE events is clean
  - landed:

- [ ] 5.4 Host parity (deps: 1.3, 3.1, est: ~45m)
  - why: source selection lives in the shared route layer, and the bundle guard already fails any host source containing `writeFile(`, `mkdir(` or `readGitContext(` — free enforcement worth an explicit assertion rather than an assumption.
  - acceptance: R-W5.7 — THE SYSTEM SHALL expose this behaviour identically from both hosts, without host-specific implementation.
  - verify: the host-parity suite drives both servers through the same review; bundle guard passes
  - landed:

## Unit 6: Testability

- [ ] 6.1 Both sources answer alike (deps: 1.3, est: ~2h)
  - why: the whole design rests on the two sources being substitutable. If they disagree about a directory listing or a file's bytes, the reviewing surface silently means two different things depending on where the user happened to be sitting.
  - acceptance: R-W6.1 — THE SYSTEM SHALL include tests that drive both sources through the same interface and assert they answer alike for the same pull request.
  - verify: one test body, two sources, identical assertions on changed paths, a directory listing, and a file's bytes
  - landed:

- [ ] 6.2 Source selection is correct at both boundaries (deps: 1.3, est: ~1h)
  - why: 6.2's first case is the regression the corrected resolution rule exists to prevent — a served repository whose origin names a *different* repository must still take the checkout, because `fetchSource` already handles it.
  - acceptance: R-W6.2 — a test that a served directory which is a git working tree selects the checkout source even when its origin names a different repository. R-W6.3 — a test that a served directory which is not a git working tree yields a review rather than a refusal.
  - verify: both cases against real git repositories, not fixtures
  - landed:

- [ ] 6.3 Authorization does not cross repositories (deps: 3.3, est: ~1h)
  - why: 3.3 is the story most likely to look finished while being wrong, because the failure is invisible until a repo-scoped write route exists.
  - acceptance: R-W6.4 — a test that a review of one repository is not authorized by permissions held in another. R-W6.5 — a test that a request naming no repository, on a route that requires one, is refused rather than defaulted.
  - verify: write-on-A read-only-on-B credential; B's review is reviewer-classified and no route substitutes a repository
  - landed:

- [ ] 6.4 Checkout tests stay on real git (deps: 1.2, est: ~30m)
  - why: already the practice in this package, and the reason a hand-written `.git` parser was replaced once before. The extraction in 1.2 must not quietly swap real repositories for fixtures.
  - acceptance: R-W6.8 — THE SYSTEM SHALL include tests that drive the checkout source against real git repositories.
  - verify: the checkout suite still creates real repositories; no fixture `.git` directories introduced
  - landed:
