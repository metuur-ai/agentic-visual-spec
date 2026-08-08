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

| ID | EARS statement |
| --- | --- |
| R-4.1 | WHEN the user is presented with the apply scope chooser, THE SYSTEM SHALL display the active branch. |
| R-4.2 | WHERE no branch is known — state `none`, or the first read has not completed — THE SYSTEM SHALL display no branch there, and SHALL NOT block the apply run. |
