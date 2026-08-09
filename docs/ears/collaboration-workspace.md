# Collaboration Workspace — EARS Specifications

> This document **amends Unit 13** of `github-pr-collaborative-documents.md`, which
> requires a pull request checkout to live inside the served directory (R-13.5) and treats
> "the served directory is not a git repository" and "it has no origin remote" as terminal
> failures (R-13.9). Those requirements continue to hold for a served directory that *is*
> a working tree of the pull request's repository. Where it is not, this document supplies
> the behaviour instead. Unit 13's other requirements — the fork reference, the detached
> checkout, path stability, the prohibition on committing — apply unchanged to every
> checkout, wherever it is hosted.
>
> Requirement ids here are `R-W<unit>.<n>` so they cannot be confused with the `R-<unit>.<n>`
> ids of the collaboration spec.

## Unit 1: The workspace root

**Why:** A reviewer with no clone needs somewhere for one to go. That place must be the
system's own, obviously named, addressable by the user, and absent entirely for a user who
never triggers it — because `visual-spec` has until now written nothing outside the
directory it was pointed at, and a tool that creates a home directory just by starting has
already broken that expectation.

| ID | EARS statement |
| --- | --- |
| R-W1.1 | THE SYSTEM SHALL locate every resource it provisions for itself under a single root directory in the user's home directory. |
| R-W1.2 | WHERE an environment variable naming an alternative root is set, THE SYSTEM SHALL use that root instead, so that the location is addressable without editing configuration. |
| R-W1.3 | THE SYSTEM SHALL NOT create the root, or any file within it, until an operation requires one. |
| R-W1.4 | THE SYSTEM SHALL derive a provisioned repository's path from the repository's host, owner and name, so that two repositories sharing a name under different owners or hosts cannot occupy the same path. |
| R-W1.5 | THE SYSTEM SHALL reject a host, owner or repository name that would resolve outside the root, before that value reaches a filesystem path. |
| R-W1.6 | IF the root cannot be created or written to, THE SYSTEM SHALL report that the root is unusable and name it, rather than reporting a failure of the operation the user requested. |
| R-W1.7 | THE SYSTEM SHALL keep the interior layout of a provisioned repository identical to that of a served repository, so that operations acting on a checkout cannot distinguish the two. |

## Unit 2: Choosing where a review happens

**Why:** The user's own working copy must keep winning — it is the copy they chose, on the
branch they chose — and the decision must be predictable. A rule that searches for a
"best" clone gives a different answer depending on what else is on the disk, which is the
one thing a reviewer cannot debug.

| ID | EARS statement |
| --- | --- |
| R-W2.1 | WHEN a review of a pull request is requested, THE SYSTEM SHALL determine which directory hosts its checkout before any checkout is created. |
| R-W2.2 | IF the served directory is a git working tree whose origin identifies the pull request's repository, THE SYSTEM SHALL host the checkout in the served directory. |
| R-W2.3 | IF the served directory does not satisfy R-W2.2, THE SYSTEM SHALL host the checkout in a provisioned copy of the pull request's repository. |
| R-W2.4 | THE SYSTEM SHALL decide R-W2.2 from the served directory alone, and SHALL NOT search the filesystem, or any record of previously opened directories, for another copy of the repository. |
| R-W2.5 | THE SYSTEM SHALL NOT write to, check out within, or otherwise modify any working copy that it did not provision, other than as R-W2.2 already permits for the served directory. |
| R-W2.6 | THE SYSTEM SHALL report, for a mounted checkout, whether its host directory was the served directory or a provisioned one, so that a user can tell where their disk is being used. |

## Unit 3: Provisioning a repository

**Why:** The clone is the mechanism that makes the refusal disappear, and it is also the
first thing this system does that consumes meaningful disk and network on the user's
behalf. It has to be interruptible without leaving a corpse, repeatable without
duplicating work, and honest about why it failed.

| ID | EARS statement |
| --- | --- |
| R-W3.1 | WHEN a review requires a repository that has not been provisioned, THE SYSTEM SHALL obtain a working copy of it without any git operation performed by the user. |
| R-W3.2 | THE SYSTEM SHALL obtain that working copy in a form that defers file-content transfer until a file is read, so that provisioning does not transfer the contents of every revision in the repository's history. |
| R-W3.3 | THE SYSTEM SHALL authenticate provisioning with the same credential used for every other GitHub operation, so that a repository the user can read is a repository the user can review. |
| R-W3.4 | WHILE provisioning is incomplete, THE SYSTEM SHALL NOT expose the partial result at the path a completed provision would occupy. |
| R-W3.5 | IF provisioning is interrupted, THE SYSTEM SHALL leave no state that a later attempt would mistake for a completed provision. |
| R-W3.6 | WHEN provisioning of a repository is requested while provisioning of that same repository is already in progress, THE SYSTEM SHALL await the operation in progress rather than starting a second one. |
| R-W3.7 | WHEN a review requires a repository that is already provisioned, THE SYSTEM SHALL reuse it rather than provisioning again. |
| R-W3.8 | IF provisioning cannot complete, THE SYSTEM SHALL report which of the following occurred — no usable credential, the repository could not be reached or read, the root is unusable, or the local git operation was refused — rather than a generic failure. |
| R-W3.9 | WHILE provisioning is in progress, THE SYSTEM SHALL indicate that work is happening, so that a first review of a large repository does not present as an unresponsive interface. |
| R-W3.10 | THE SYSTEM SHALL ensure a provisioned repository ignores its own checkout directory before the first checkout within it is created. |

## Unit 4: Reviewing across repositories

**Why:** A reviewer's pull requests are not all in one repository, and today the repository
is a property of the running server rather than of the request. Until each request names
its own repository, a second repository cannot be reviewed without restarting the tool
against it.

| ID | EARS statement |
| --- | --- |
| R-W4.1 | THE SYSTEM SHALL accept a repository as part of each request that names a pull request, so that a pull request of any readable repository can be reviewed by a running instance. |
| R-W4.2 | WHERE a request naming a pull request omits a repository, THE SYSTEM SHALL apply the configured repository, so that existing single-repository behaviour is unchanged. |
| R-W4.3 | THE SYSTEM SHALL permit checkouts of pull requests from more than one repository to exist at the same time, and SHALL keep each within its own repository's host directory. |
| R-W4.4 | THE SYSTEM SHALL identify a mounted checkout by repository together with pull request number, so that the same number in two repositories denotes two checkouts. |
| R-W4.5 | WHEN a pull request reference is supplied as a URL, THE SYSTEM SHALL take the repository from that URL rather than discarding it. |
| R-W4.6 | THE SYSTEM SHALL treat reviewing a pull request of any repository as a read operation, requiring no write access to that repository. |

## Unit 5: Finding a pull request

**Why:** The reviewer this exists for cannot be asked which repository to look in — not
knowing is the situation. A list built from repositories already opened would be empty at
exactly the moment it is needed.

| ID | EARS statement |
| --- | --- |
| R-W5.1 | THE SYSTEM SHALL present the open pull requests that involve the authenticated user across the repositories they can read, without requiring any repository to be configured or previously opened. |
| R-W5.2 | THE SYSTEM SHALL carry each such pull request's repository in the listing, so that selecting one requires no further identification. |
| R-W5.3 | THE SYSTEM SHALL continue to present the pull requests of the configured repository, where one is configured. |
| R-W5.4 | THE SYSTEM SHALL accept a pasted pull request URL as an entry point, so that a pull request absent from any listing is still reachable. |
| R-W5.5 | IF a listing cannot be retrieved, THE SYSTEM SHALL report that the listing failed and SHALL leave the pasted-reference entry point usable. |
| R-W5.6 | THE SYSTEM SHALL NOT treat a listing as authoritative for a pull request's state, and SHALL read the pull request itself when a review begins. |

## Unit 6: Remembering workspaces

**Why:** The user should not have to find yesterday's folder in an OS picker again, and
once the system starts provisioning directories on their behalf it owes them a list of
what it has taken. The list must never claim something that is not there — an offer to
reopen a deleted directory is worse than no list.

| ID | EARS statement |
| --- | --- |
| R-W6.1 | THE SYSTEM SHALL record each directory it serves and each repository it provisions, and SHALL retain those records across restarts. |
| R-W6.2 | THE SYSTEM SHALL present those records to the user, most recently opened first, distinguishing directories the user supplied from repositories the system provisioned. |
| R-W6.3 | WHEN presenting a record, THE SYSTEM SHALL verify that its directory exists, and SHALL NOT offer one that does not. |
| R-W6.4 | THE SYSTEM SHALL derive which pull requests currently have a checkout from the repository's own state rather than from its record. |
| R-W6.5 | WHEN the user selects a recorded directory they supplied, THE SYSTEM SHALL serve that directory. |
| R-W6.6 | THE SYSTEM SHALL accept, as a directory to serve, only a path that is already one of its records or one the user selected through the operating system's own directory chooser. |
| R-W6.7 | IF the record store is missing or unreadable, THE SYSTEM SHALL continue to operate with no recorded workspaces rather than failing the operation the user requested. |

## Unit 7: Releasing what was taken

**Why:** Provisioning consumes the user's disk, so removing it has to be a real capability
rather than an instruction to delete a folder. Equally, a checkout of a pull request that
has merged is dead weight nobody will think to clean up.

| ID | EARS statement |
| --- | --- |
| R-W7.1 | THE SYSTEM SHALL allow the user to remove a repository it provisioned, and SHALL release its checkouts, the references it created, and its directory. |
| R-W7.2 | THE SYSTEM SHALL NOT delete, or offer to delete, any directory the user supplied; removing such a record SHALL discard the record only. |
| R-W7.3 | WHEN a pull request with a checkout is observed to be merged or closed, THE SYSTEM SHALL release that checkout and the reference created for it, and SHALL retain the repository. |
| R-W7.4 | THE SYSTEM SHALL treat a checkout or reference that is already absent as a completed release rather than a failure. |
| R-W7.5 | THE SYSTEM SHALL NOT release anything on a schedule, on a size threshold, or on a period of disuse. |
| R-W7.6 | WHEN a removal is requested, THE SYSTEM SHALL state what will be removed before removing it. |

## Unit 8: What must not change

**Why:** Local mode is the shipped product, and reviewing inside an existing clone is
behaviour people already depend on. A workspace feature that regresses either is a worse
outcome than a reviewer continuing to clone by hand.

| ID | EARS statement |
| --- | --- |
| R-W8.1 | WHERE no collaboration is configured, THE SYSTEM SHALL behave exactly as it does without this feature, and SHALL create no root, record, or provisioned repository. |
| R-W8.2 | WHILE a review is open, THE SYSTEM SHALL leave the served directory's working copy, current branch, and unsaved contents unmodified. |
| R-W8.3 | WHEN a review is closed, THE SYSTEM SHALL return the interface to the served directory. |
| R-W8.4 | THE SYSTEM SHALL NOT commit to, push from, create a branch in, or merge within a repository it provisioned. |
| R-W8.5 | THE SYSTEM SHALL check out a pull request in a detached state in a provisioned repository, as it does in a served one. |
| R-W8.6 | THE SYSTEM SHALL expose this behaviour identically from both hosts, without host-specific implementation. |
| R-W8.7 | THE SYSTEM SHALL NOT include a credential in any response, event, or client-visible state. |
| R-W8.8 | THE SYSTEM SHALL NOT report a filesystem path outside the served directory except where the user has asked to see their workspaces. |

## Unit 9: Testability

**Why:** The behaviours being relied on — what a partially-transferred clone can and
cannot read, what git does when two checkouts of different repositories coexist, what an
interrupted clone leaves behind — belong to git and the filesystem, not to this system. A
fixture would assert this system's beliefs about them rather than their behaviour.

| ID | EARS statement |
| --- | --- |
| R-W9.1 | THE SYSTEM SHALL include tests that provision and review against real git repositories, since the transfer form, the checkout, and the reported paths are git's behaviour. |
| R-W9.2 | THE SYSTEM SHALL include a test that a review whose repository differs from the served directory's leaves the served directory's working copy, branch and uncommitted contents unchanged. |
| R-W9.3 | THE SYSTEM SHALL include a test that two repositories' pull requests can be checked out simultaneously without either being resolved to the other's directory. |
| R-W9.4 | THE SYSTEM SHALL include a test that an interrupted provision is not reused as a completed one. |
| R-W9.5 | THE SYSTEM SHALL include a test that removal leaves no checkout, reference, or directory of the removed repository. |
| R-W9.6 | THE SYSTEM SHALL include a test that a host, owner or repository name attempting to escape the root is refused. |
| R-W9.7 | THE SYSTEM SHALL include a test that a path which is not a record and was not chosen through the operating system's directory chooser is refused as a directory to serve. |
| R-W9.8 | THE SYSTEM SHALL include a test that, with no collaboration configured, no root directory is created. |
