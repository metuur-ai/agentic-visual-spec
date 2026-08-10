# Reviewing a Pull Request Without a Clone — EARS Specifications

> **Revision — the workspace draft is withdrawn.** The first draft of this document
> specified a managed root, clone provisioning, a workspace registry and a removal
> lifecycle across nine units. All of it is withdrawn before implementation. Its
> `R-W1.x`–`R-W9.x` ids are **retired wholesale and never reused**; the units below are
> renumbered from `R-W1.1` with new meanings, which is safe only because nothing from the
> first draft was implemented, annotated, or tested against.
>
> **Unit 13 of `github-pr-collaborative-documents.md` is edited in place**, not amended
> from here. R-13.5 and R-13.9 are rewritten there, because a closed enumeration and a flat
> factual claim cannot be contradicted from a second file without leaving the original
> asserting the opposite. This document owns only what is new: the second review source,
> repository scoping, and the entry point.

## Unit 1: Choosing where a review reads from

**Why:** A review needs a pull request's files. A checkout supplies them when one is
available, and the reviewer this change exists for has none. The choice must preserve every
case that works today — including the reviewer serving one repository while reviewing a
pull request of another, which the fetch-source logic already handles — and must add a path
only for the case that refuses.

| ID | EARS statement |
| --- | --- |
| R-W1.1 | WHEN a review of a pull request is requested, THE SYSTEM SHALL determine which source supplies its files before any file is read. |
| R-W1.2 | IF the served directory is a git working tree with an origin remote, THE SYSTEM SHALL supply the review from a checkout, irrespective of whether that origin names the pull request's repository. |
| R-W1.3 | IF the served directory is not a git working tree, or has no origin remote, THE SYSTEM SHALL supply the review from the repository host rather than refusing the review. |
| R-W1.4 | THE SYSTEM SHALL expose both sources through one interface, so that the reviewing surface does not vary by source. |
| R-W1.5 | THE SYSTEM SHALL report which source is supplying a review, so that a reviewer can account for the difference in behaviour between them. |
| R-W1.6 | THE SYSTEM SHALL decide the source from the served directory alone, and SHALL NOT search the filesystem for another copy of the repository. |

## Unit 2: Reading a pull request from its host

**Why:** This is the new source. It must answer everything the checkout answers — the
changed files, the files around them, and their contents — while pinning every read to one
commit, because a review that silently spans two heads anchors comments to bytes the
reviewer never saw.

| ID | EARS statement |
| --- | --- |
| R-W2.1 | THE SYSTEM SHALL obtain a pull request's changed paths without a checkout. |
| R-W2.2 | THE SYSTEM SHALL obtain the contents of any file in the pull request's tree without a checkout, including files the pull request did not change. |
| R-W2.3 | THE SYSTEM SHALL enumerate the pull request's tree without a checkout, and MAY do so one directory at a time as the reviewer opens them. |
| R-W2.4 | THE SYSTEM SHALL pin every such read to the pull request's head commit rather than to a branch name, so that a force-push during a review cannot change the bytes under a comment being written. |
| R-W2.5 | WHEN the pull request head moves, THE SYSTEM SHALL refresh the changed paths and the pinned commit together, so that the two cannot disagree about which commit is under review. |
| R-W2.6 | THE SYSTEM SHALL use the same credential and the same GitHub access path as every other operation, and SHALL NOT introduce a second means of authenticating to the repository host. |
| R-W2.7 | IF a read cannot be completed, THE SYSTEM SHALL report which of the following occurred — no usable credential, the repository or file could not be read, or the host could not be reached — rather than a generic failure. |
| R-W2.8 | THE SYSTEM SHALL indicate when a read is in flight, so that a review over a slow connection does not present as an unresponsive interface. |
| R-W2.9 | THE SYSTEM SHALL NOT write any file outside the served directory in order to supply a review. |
| R-W2.10 | THE SYSTEM SHALL NOT read, through a review source, the contents of any file outside the pull request's tree, including by way of a symbolic link committed to that tree. |
| R-W2.11 | WHERE an entry in a pull request's tree is a symbolic link whose target lies inside that tree, THE SYSTEM SHALL report the target's contents, since the target is tree content the reviewer may read anyway. |
| R-W2.11a | WHERE an entry in a pull request's tree is a symbolic link whose target lies outside that tree, THE SYSTEM SHALL report the link's own target path as its contents and SHALL NOT read the target. |
| R-W2.11b | THE SYSTEM SHALL answer R-W2.11 and R-W2.11a identically from both sources, and SHALL NOT rely on a test fixture that models every link as unresolvable, since the repository host resolves the first case and not the second. |
| R-W2.12 | IF a directory named in a read does not exist, THE SYSTEM SHALL report it as unreadable rather than as an empty directory, so that a reviewer is never shown an absent directory as one the pull request emptied. |

## Unit 3: Reviewing across repositories

**Why:** The repository is currently a property of the running server, not of the request,
so a second repository cannot be reviewed without restarting against it. Making it a
request parameter is not a routing change alone: authorization is resolved from the
configured repository, and leaving that unchanged would carry one repository's permissions
into another.

| ID | EARS statement |
| --- | --- |
| R-W3.1 | THE SYSTEM SHALL require a repository to be named by each request that reviews a pull request, and SHALL refuse a request that names none rather than substituting one. |
| R-W3.2 | WHERE a request uses the route form that predates this requirement, THE SYSTEM SHALL apply the configured repository, so that existing behaviour is unchanged. |
| R-W3.3 | THE SYSTEM SHALL determine availability and authorization for a review against the repository named by the request, not against the configured repository. |
| R-W3.4 | THE SYSTEM SHALL NOT grant, on the basis of permissions held in one repository, any operation on another. |
| R-W3.5 | THE SYSTEM SHALL identify a review by repository together with pull request number, so that the same number in two repositories denotes two reviews. |
| R-W3.6 | THE SYSTEM SHALL identify locally held review comments by repository together with pull request number, for the same reason. |
| R-W3.7 | THE SYSTEM SHALL decode a repository identifier supplied in a request before validating it, and SHALL refuse one that does not name a well-formed repository. |
| R-W3.8 | THE SYSTEM SHALL treat reviewing a pull request of any repository as a read operation, requiring no write access to it. |
| R-W3.9 | WHERE locally held review comments exist under the identification that predates R-W3.6, THE SYSTEM SHALL adopt them into the configured repository's identification on first read, SHALL NOT adopt them into any other repository's, and SHALL NOT replace comments already held under the new identification. |

**Note on R-W3.7:** the refusal happens in two places and only one of them is this
requirement's. A traversal spelled in encoded form is normalised away by URL parsing before
any router sees it, so over HTTP the request arrives naming no pull request route at all
and is answered as an unknown route. The decode-then-validate of this requirement is what
answers the forms that do reach the router, and it is asserted where it lives, by calling
the router directly. Both are needed: the first is a property of the hosts, which R-W5.7
pins but this requirement does not own, and the second is what survives a host that
normalises differently or no host at all.

**Note on R-W3.9:** the file predates repository-scoped identification, so it was written
when only one repository could be reviewed and belongs to that one as a matter of fact.
Letting any repository claim it would invent a provenance and put one project's comments
into another's review, which is what R-W3.4 and R-W3.6 exist to prevent. Adopting it
matters rather than being tidy: it holds the record of which comments have already been
posted, and nothing can reconstruct that — abandoning the file silently rearms every
duplicate.

## Unit 4: Entry point

**Why:** The reviewer this change exists for is holding a link. The repository is in that
link and is currently discarded, which is why the interface already offers to open "a pull
request in another repository" and cannot.

| ID | EARS statement |
| --- | --- |
| R-W4.1 | WHEN a pull request reference is supplied as a URL, THE SYSTEM SHALL take the repository from that URL together with the pull request number. |
| R-W4.2 | THE SYSTEM SHALL continue to accept a bare pull request number, and SHALL apply the configured repository to it. |
| R-W4.3 | IF a supplied reference names no repository and no repository is configured, THE SYSTEM SHALL report that the repository is unknown rather than attempting the review. |
| R-W4.4 | THE SYSTEM SHALL continue to present the pull requests of the configured repository, where one is configured. |
| R-W4.5 | THE SYSTEM SHALL display the repository of the pull request under review at all times while a review is open. |

## Unit 5: What must not change

**Why:** Local mode is the shipped product and checkout-backed review is behaviour people
depend on. A second source that regresses either is worse than the reviewer continuing to
clone by hand.

| ID | EARS statement |
| --- | --- |
| R-W5.1 | WHERE no collaboration is configured, THE SYSTEM SHALL behave exactly as it does without this feature. |
| R-W5.2 | WHERE a checkout supplies a review, THE SYSTEM SHALL behave exactly as it does without this feature, including the path of the checkout and the failures it reports. |
| R-W5.3 | WHILE a review is open, THE SYSTEM SHALL leave the served directory's working copy, current branch, and unsaved contents unmodified. |
| R-W5.4 | WHEN a review is closed, THE SYSTEM SHALL return the interface to the served directory. |
| R-W5.5 | THE SYSTEM SHALL NOT commit, push, create a branch, or merge as part of a review. |
| R-W5.6 | THE SYSTEM SHALL NOT accept, from any caller, a directory to serve that the user did not choose through the operating system's own directory chooser. |
| R-W5.7 | THE SYSTEM SHALL expose this behaviour identically from both hosts, without host-specific implementation. |
| R-W5.8 | THE SYSTEM SHALL NOT include a credential in any response, event, or client-visible state. |
| R-W5.9 | WHEN a checkout is mounted for a pull request, THE SYSTEM SHALL remove any checkout of that same pull request left under the path form that predates R-W3.5, and SHALL leave checkouts of other pull requests untouched. |

**Note on R-W5.3:** R-13.5 requires the collaboration directory to be ignored by git before
the first checkout is created, and ensuring that is a write. It is not an exception to this
requirement because it does not go into the working copy: it is written to the repository's
own exclude file, which is per-clone, outside the working tree, invisible to `git status`,
and unaffected by which branch is checked out. A review therefore leaves no diff for the
reviewer to discard and imposes nothing on anyone who pulls the branch. Writing it to
`.gitignore` would do all three, and did.

**Note on R-W5.9:** the opposite of R-W3.9, and the difference is what the thing is. A
checkout holds no bytes the user wrote — it is a detached copy of a commit the next fetch
produces again — so there is nothing to preserve, and it is registered with git by absolute
path, so it cannot be adopted by a rename the way a plain file can. Leaving it is the
harmful option: nothing collides on disk, but the listing reads the repository out of the
path, so a pre-scoping checkout stops being reported while remaining registered with git
and holding objects alive — invisible to every surface that could remove it. It is removed
at the one moment its identity is not a guess, a mount of that same number.

## Unit 6: Testability

**Why:** One source is git's behaviour and the other is the repository host's. Fixtures for
either would assert this system's beliefs rather than their behaviour, and the two must be
shown to agree.

| ID | EARS statement |
| --- | --- |
| R-W6.1 | THE SYSTEM SHALL include tests that drive both sources through the same interface and assert they answer alike for the same pull request. |
| R-W6.2 | THE SYSTEM SHALL include a test that a served directory which is a git working tree selects the checkout source even when its origin names a different repository. |
| R-W6.3 | THE SYSTEM SHALL include a test that a served directory which is not a git working tree yields a review rather than a refusal. |
| R-W6.4 | THE SYSTEM SHALL include a test that a review of one repository is not authorized by permissions held in another. |
| R-W6.5 | THE SYSTEM SHALL include a test that a request naming no repository, on a route that requires one, is refused rather than defaulted. |
| R-W6.6 | THE SYSTEM SHALL include a test that a repository identifier attempting to escape its expected form, including in encoded spelling, is refused. |
| R-W6.7 | THE SYSTEM SHALL include a test that a full review supplied by the host source writes no file outside the served directory. |
| R-W6.8 | THE SYSTEM SHALL include tests that drive the checkout source against real git repositories, since the fetch, the checkout, and the reported paths are git's behaviour. |
| R-W6.9 | THE SYSTEM SHALL include a test, using a symbolic link committed into a pull request's tree and pointing outside it, that neither source yields the contents of the file it points to. |
| R-W6.10 | THE SYSTEM SHALL include a test that both sources report a missing directory alike. |
