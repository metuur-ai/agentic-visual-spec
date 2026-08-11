# Git Context in the Header — EARS Specifications

## Unit 1: Reading git state

**Why:** The chip's value must be right in the layouts users actually have —
a subdirectory, a worktree, a detached HEAD, an SSH remote — and it must never take
the rest of the application down with it when git is absent or refuses. Delegating
to `git` is what makes the first true; never throwing is what makes the second true.

| ID | EARS statement |
| --- | --- |
| R-1.1 | THE SYSTEM SHALL determine the branch, the detached state and the `origin` URL by invoking `git` against the served directory. |
| R-1.2 | IF `git` cannot be started, exits non-zero, or refuses the directory, THE SYSTEM SHALL report state `none` and SHALL NOT throw. |
| R-1.3 | THE git-context module SHALL be unreachable from the browser bundle's import graph. |
| R-1.4 | WHEN the repository reports a branch name, THE SYSTEM SHALL report that branch with `detached` false. |
| R-1.5 | WHEN the repository reports a detached HEAD, THE SYSTEM SHALL report the short commit sha as the branch with `detached` true. |
| R-1.6 | WHERE the repository has no `origin` remote, THE SYSTEM SHALL report state `local` with the branch and no URL. |
| R-1.7 | WHEN the `origin` URL is of the form `https://<host>/<owner>/<repo>` or `git@<host>:<owner>/<repo>`, each with an optional `.git` suffix, THE SYSTEM SHALL report state `remote` with that host, owner and repo. |
| R-1.8 | IF the `origin` URL matches neither form, THE SYSTEM SHALL report state `local` **carrying the raw URL**, and SHALL NOT report state `remote` with empty fields. |
| R-1.9 | THE SYSTEM SHALL read only the `origin` remote. |
| R-1.10 | THE SYSTEM SHALL invoke no git command that writes to the repository. |
| R-1.11 | THE SYSTEM SHALL emit only the host, owner, repository, branch and origin URL beyond the process boundary, and SHALL NOT emit absolute filesystem paths or configuration contents. |

## Unit 2: The route

**Why:** The chip must describe the directory currently on screen, and a client
newer than its server must be able to tell that the route is missing rather than
receiving the app shell with a 200.

| ID | EARS statement |
| --- | --- |
| R-2.1 | THE SYSTEM SHALL expose `GET /__vs/git` returning the git context of the currently served directory as JSON. |
| R-2.2 | WHEN the served directory changes, THE SYSTEM SHALL report the git context of the new directory. |
| R-2.3 | THE route handler SHALL be reached by both the standalone host and the Vite host from one shared module, and neither host SHALL carry an independent implementation. |
| R-2.4 | THE SYSTEM SHALL read the git context per request and SHALL NOT serve it from a cache. |
| R-2.5 | THE route SHALL be served behind the existing `/__vs` cross-origin guard on both hosts. |
| R-2.6 | IF the host does not implement this route, THE SYSTEM SHALL answer 404 with a JSON body and SHALL NOT serve the single-page-app shell. |

## Unit 3: The header chip

**Why:** Three states the user asked for, each visually distinct, honest about
what has not been read yet, and refreshed by the event that corresponds to the real
scenario — leaving for a terminal and coming back.

| ID | EARS statement |
| --- | --- |
| R-3.1 | THE header SHALL display a git context chip adjacent to the served directory path, in both the main header and the empty-state header. |
| R-3.2 | WHILE the first read has not completed, THE SYSTEM SHALL assert none of the three states. |
| R-3.3 | WHERE the state is `none`, THE SYSTEM SHALL display a "not a git repository" icon and label, and no branch or repository name. |
| R-3.4 | WHERE the state is `local` without a URL, THE SYSTEM SHALL display a "disconnected" icon, the branch, and that no remote is configured. |
| R-3.5 | WHERE the state is `local` with a URL, THE SYSTEM SHALL display a "disconnected" icon, the branch, and that the remote was not recognised, and SHALL make the raw URL available on hover. |
| R-3.6 | WHERE the state is `remote`, THE SYSTEM SHALL display a "connected" icon, the `owner/repo` pair, and the branch. |
| R-3.7 | WHERE the state is `remote` and the host is `github.com`, THE SYSTEM SHALL render the repository name as a link opening in a new tab with `rel="noopener noreferrer"`. |
| R-3.8 | WHERE the host is not `github.com`, THE SYSTEM SHALL render the repository name as text and SHALL NOT construct a link. |
| R-3.9 | WHERE `detached` is true, THE SYSTEM SHALL present the displayed sha as a detached HEAD rather than as a branch name. |
| R-3.10 | WHEN the component mounts, and again whenever the window receives focus or the document becomes visible, THE SYSTEM SHALL read `GET /__vs/git`. |
| R-3.11 | THE SYSTEM SHALL NOT poll on a timer. |
| R-3.12 | IF a read fails, THE SYSTEM SHALL retain the last known state and SHALL NOT replace the chip with an error. |

## Unit 4: The branch at the point of apply

**Why:** The motivating failure is that apply edits land on an unnoticed branch. A
chip in the header corner does not fix that on its own — the branch has to be
visible where the user commits to the run.

And "the branch" is not always a branch. A detached HEAD reports a 7-character
sha, which read bare is indistinguishable from a branch named `a1b2c3d`. R-3.9
already forbids that misreading in the chip; it must hold here too, and for a
stronger reason. The chip is passive orientation. This chooser is the moment
someone consents to an agent editing files — believing you are on a branch when
you are not is precisely the failure this unit exists to prevent, and this is
where it has consequences.

| ID | EARS statement |
| --- | --- |
| R-4.1 | WHEN the user is presented with the apply scope chooser, THE SYSTEM SHALL display the head the run will edit, as defined by R-4.3. |
| R-4.2 | WHERE no branch is known — state `none`, or the first read has not completed — THE SYSTEM SHALL display no branch there, and SHALL NOT block the apply run. |
| R-4.3 | WHERE `detached` is true, THE SYSTEM SHALL present the displayed sha in the scope chooser as a detached HEAD rather than as a branch name; WHERE `detached` is false, THE SYSTEM SHALL display the branch name. |

## Unit 5: Listing and switching branches

**Why:** Units 1–4 are a reader, and the LLD put "any git write operation" out of
scope on purpose. This unit reverses that, so it has to carry its own justification
rather than inherit one: the user asked to change branch from the header, and the
alternative — leaving for a terminal — is the same context switch R-3.10 was written
to accommodate.

The reversal is contained rather than general. R-1.10 still holds for
`core/git-context.ts`; the write lives in a separate module, and the capability is
absent unless configuration turns it on. It is the first browser-initiated change to
the user's own checkout, which is why it is off by default.

The refusal rule is the load-bearing part. `git checkout` **succeeds** when a
modified file is identical in both commits, silently carrying the edit onto the new
branch — for a documentation repository that is the ordinary case, not the exotic
one. Letting git decide would therefore move uncommitted work while reporting
success. The switch is refused on any dirt instead, decided before `checkout` runs.

The paths in that refusal cannot come from git's own message: `core/git-context.ts`
discards stderr because git writes absolute paths into it and R-1.11 forbids those
crossing the boundary. They come from `git status --porcelain`, which reports
repository-relative paths on stdout.

Those paths have to survive the trip verbatim. `git status --porcelain` quotes and
C-escapes any path containing a space or a non-ASCII byte unless `-z` is used, so a
refusal built on the default output would name `"my notes.md"` — a string that is not
a path to any file the user has. R-6.6 renders exactly those strings to the user, so
the escaping is not cosmetic: it is the difference between naming the file that
blocked the change and naming something that does not exist. A rename or copy record
carries two paths, and both of them are places the user's uncommitted work currently
is; reporting only one of them under-reports what the refusal is about. That rule was
asserted in a test with no requirement above it, which is why it is stated here now.

| ID | EARS statement |
| --- | --- |
| R-5.1 | THE SYSTEM SHALL determine the list of local branches, and the branches of `origin`, by invoking `git` against the served directory. |
| R-5.2 | THE SYSTEM SHALL report, for each local branch, its name, whether it is the current branch, and its ahead and behind counts relative to its upstream WHERE an upstream exists. |
| R-5.3 | THE branch-writing module SHALL be separate from the git-context module, and R-1.10 SHALL continue to hold for the git-context module. |
| R-5.4 | THE SYSTEM SHALL determine whether the working tree is dirty by invoking `git status --porcelain`, and SHALL report each reported path repository-relative and verbatim, without quoting or escaping; WHERE a record reports a rename or copy, THE SYSTEM SHALL report both the resulting path and the original. |
| R-5.5 | BEFORE changing branch, THE SYSTEM SHALL evaluate R-5.4; IF any path is reported, THE SYSTEM SHALL refuse the change and SHALL NOT invoke `checkout`. |
| R-5.6 | THE SYSTEM SHALL NOT stash, discard, force or otherwise modify uncommitted work in order to change branch. |
| R-5.7 | THE SYSTEM SHALL change branch only to a branch that already exists locally, or to a branch of `origin` for which a tracking branch is created; THE SYSTEM SHALL NOT create a branch from an arbitrary name supplied by the client. |
| R-5.8 | THE SYSTEM SHALL keep the collaboration directory ignored across a branch change, and SHALL NOT write to the working tree in order to do so. |
| R-5.9 | WHEN a branch change succeeds, THE SYSTEM SHALL report the git context of Unit 1 as read after the change, and the client SHALL NOT infer the resulting context. |
| R-5.10 | THE SYSTEM SHALL emit only branch names, ahead and behind counts, and repository-relative paths beyond the process boundary, and SHALL NOT emit absolute filesystem paths or git's error output. |
| R-5.11 | IF `git` cannot be started, exits non-zero, or refuses the directory, THE SYSTEM SHALL report the failure and SHALL NOT throw. |

**Note on R-5.8:** what this requires depends entirely on where the entry lives, and it
used to require a great deal. Written to `.gitignore` the entry is tracked content, so a
branch predating it un-ignores `.visual-spec/` — turning every mounted pull-request
worktree into thousands of untracked entries in `git status`. That made a branch change
the second moment the entry had to be written, and because that write goes through the
filesystem rather than through git it could fail for reasons git never sees (a read-only
checkout, a read-only volume) with the absolute path of the file in the error, on the one
route in the package that writes — so it also needed a state for "the branch changed and
the entry did not get written", carried as a warning beside the fresh context rather than
as a failure, since R-6.7 has the client adopt the returned context and nothing else.

None of that is required now. The entry is written to `.git/info/exclude`, which is
per-clone and outside the working tree: no branch carries a version of it, so a checkout
cannot take it away. The guarantee is kept by ensuring it once, where R-13.5 already
does — before the first checkout is created — and this unit writes nothing at all. The
requirement is therefore stated as the property to preserve, not as a write to perform.

## Unit 6: Changing branch from the header

**Why:** The capability of Unit 5 is only useful where the branch is already
displayed, and it must be indistinguishable from absent when configuration has not
enabled it — not present-and-failing.

The confirmation guards the main document editor. The collaboration editor is on a
surface that replaces this header entirely, so it cannot be unsaved while this
control is on screen.

| ID | EARS statement |
| --- | --- |
| R-6.1 | WHERE branch changing is enabled by configuration, THE SYSTEM SHALL render the branch in the chip as a control that opens a list of the branches of R-5.1. |
| R-6.2 | WHERE branch changing is not enabled by configuration, THE SYSTEM SHALL render the branch exactly as Unit 3 specifies and SHALL NOT render a control. |
| R-6.3 | WHERE branch changing is not enabled by configuration, THE SYSTEM SHALL NOT expose the routes of Unit 5. |
| R-6.4 | WHERE `detached` is true, THE SYSTEM SHALL continue to satisfy R-3.9 and SHALL NOT present the displayed sha as a selectable branch. |
| R-6.5 | WHEN the user selects a branch AND the main document editor holds unsaved changes, THE SYSTEM SHALL present the existing unsaved-changes confirmation before requesting the change. |
| R-6.6 | IF a branch change is refused for a dirty working tree, THE SYSTEM SHALL display the reported paths and SHALL NOT offer to discard or stash them. |
| R-6.7 | WHEN a branch change succeeds, THE SYSTEM SHALL display the context reported by R-5.9 and SHALL re-read the file tree. |
| R-6.8 | IF the file open before the change does not exist on the new branch, THE SYSTEM SHALL return to the empty state and SHALL NOT display the previous file's contents. |
| R-6.9 | THE SYSTEM SHALL NOT change branch as a consequence of any collaboration action. |

## Unit 7: Open pull requests in the header

**Why:** Each open pull request that carries a collaboration document is an active
collaboration, and today the only way back into one is a full-surface swap the user
has to know exists. Surfacing the count where the repository is already named makes
them discoverable, and resuming one is a route that already exists.

The count is of every open pull request, not only the collaborations, so that it
agrees with the number GitHub itself displays. Which of them are collaborations is
then a distinction drawn within the list.

Whether a pull request is a collaboration is decided by the server from the body
trailer, using the one parser that writes it. A second implementation in the client
is how the two formats diverge.

| ID | EARS statement |
| --- | --- |
| R-7.1 | WHERE collaboration is configured, THE SYSTEM SHALL display the number of open pull requests of the configured repository in the header chip. |
| R-7.2 | WHERE collaboration is not configured, THE SYSTEM SHALL NOT display a count and SHALL NOT request it. |
| R-7.3 | THE count SHALL be the number of all open pull requests, and SHALL NOT be filtered to collaboration documents. |
| R-7.4 | THE SYSTEM SHALL determine the collaboration document identifier of a pull request on the server, from the pull request body, using the same parser that writes it. |
| R-7.5 | THE client SHALL NOT parse the pull request body. |
| R-7.6 | WHEN the user opens the count, THE SYSTEM SHALL display the open pull requests, distinguishing those that carry a collaboration document from those that do not. |
| R-7.7 | WHERE a pull request carries a collaboration document, THE SYSTEM SHALL offer to resume that collaboration by its document identifier. |
| R-7.8 | WHERE a pull request carries no collaboration document, THE SYSTEM SHALL offer to review it. |
| R-7.9 | THE SYSTEM SHALL bound the number of pull requests rendered in the list, and SHALL state that the list is bounded WHERE it has been truncated, and SHALL NOT bound the count of R-7.1. |
| R-7.10 | WHEN the component mounts, and again whenever the window receives focus or the document becomes visible, THE SYSTEM SHALL read the open pull requests; THE SYSTEM SHALL NOT poll on a timer. |
| R-7.11 | IF the read fails, THE SYSTEM SHALL retain the last known count and SHALL NOT replace the chip with an error. |

## Unit 8: Naming the repository the count belongs to

**Why:** The chip's `owner/repo` is read from the served directory's `origin`
(R-1.7). The pull request count is read from the configured collaboration
repository. Nothing has ever reconciled the two, and the served directory can be
re-rooted at runtime into a different repository while the configuration stays
fixed — so the count of one repository can render inside a chip naming another.

Unit 1's out-of-scope list declined to reconcile them, which was correct while
nothing displayed both. R-7.1 displays both.

The rule is attribution, not difference. Written as a difference test it says nothing
about states `local` and `none`, where the chip asserts there is no remote repository
at all and then shows a count of pull requests — a number with no referent anywhere on
screen. There is nothing for the count to differ from in those states, and that is
precisely when naming its repository matters most. So the condition is whether the
chip already names the count's repository, which is false whenever the served
directory has no recognised `origin` as well as when the two names disagree.

| ID | EARS statement |
| --- | --- |
| R-8.1 | WHERE the chip does not already name the `origin` of the served directory as the configured collaboration repository — because the two differ, or because the served directory has no recognised `origin` — THE SYSTEM SHALL name the repository the count belongs to. |
| R-8.2 | WHEN the configured collaboration repository matches the `origin` of the served directory, THE SYSTEM SHALL NOT add that naming. |
| R-8.3 | THE SYSTEM SHALL NOT resolve the difference by changing either repository. |
| R-8.4 | THE SYSTEM SHALL name the collaboration repository on every surface that lists its pull requests or offers to check one out, and SHALL NOT refer to it only as the repository of the served directory. |

**Note on R-8.4:** R-8.1 was written about the count, and the disclosure stopped where
the count did. The panel behind the chip opened with "Every open pull request in this
repository" and named none — and "this" is read as the directory on screen, which is the
one pairing that can be false. That surface is also the one that acts: a checkout from
it lands inside the served directory, at
`<served>/.visual-spec/worktrees/<owner>/<repo>/pr-<n>`, and a comment written from it is
posted to the collaboration repository. Naming the repository beside the number is what
stops a reviewer checking a foreign pull request into their own workspace believing it is
their project's.

Where the surface can compare — the header and its popover both hold the served
directory's context — R-8.2's rule still applies and nothing is added when the two agree.
Where it cannot, the repository is named unconditionally: a sentence that always says
which repository is never noise, and silence there is not neutral, it is an invitation to
assume.

## Unit 9: Naming the pull request under review

**Why:** The collaboration surface replaces this header with its own, which reads
`Collaboration review` and never says which pull request is on screen — although the
review component already holds the pull request and the worktree it was mounted
from. The tree being displayed is a detached checkout at a commit, so there is no
branch to name and naming one would be false.

| ID | EARS statement |
| --- | --- |
| R-9.1 | WHILE a pull request is under review, THE collaboration surface SHALL display its number and the short commit sha of the mounted tree. |
| R-9.2 | THE SYSTEM SHALL NOT present a branch name for a mounted pull request tree. |
| R-9.3 | THE SYSTEM SHALL present the mounted tree as read-only. |
| R-9.4 | THE SYSTEM SHALL derive this from the state the review surface already holds, and SHALL NOT read git or the network to obtain it. |
