# Local File Creation and Rename — EARS Specifications

## Unit 1: Creating a file

**Why:** Every rule here exists so the set of paths a browser can cause to be
written is exactly "a new `.md` file under the served directory", and so a request
outside that set costs nothing on disk. The two collision checks are not
redundant: one produces the message, the other closes the race.

| ID | EARS statement |
| --- | --- |
| R-1.1 | THE SYSTEM SHALL expose `POST /__vs/tree/create` accepting a JSON body `{ path: string }`. |
| R-1.2 | WHEN the request omits `path`, or `path` trims to empty, THE SYSTEM SHALL answer 400 and SHALL NOT write to disk. |
| R-1.3 | WHEN `path` has no file extension, THE SYSTEM SHALL append `.md` and proceed with the extended path. |
| R-1.4 | IF `path` carries an extension other than `.md`, THE SYSTEM SHALL answer 400 with a message naming the extension it refused, SHALL NOT write to disk, and SHALL NOT rewrite the extension. |
| R-1.5 | IF the target resolves outside the served directory — by path traversal, by being absolute, or by traversing a symlink that leaves the served directory — THE SYSTEM SHALL answer 400 and SHALL NOT create any file or directory. |
| R-1.6 | THE SYSTEM SHALL establish R-1.5 by resolving the deepest existing ancestor of the target to its real path and comparing it against the real path of the served directory, and SHALL perform that comparison before any directory is created. |
| R-1.7 | IF a file already exists at the target, THE SYSTEM SHALL answer 409 with a message naming the collision, and SHALL leave that file's bytes unchanged. |
| R-1.8 | WHEN two create requests for the same path are in flight concurrently, THE SYSTEM SHALL allow at most one to create the file, and SHALL answer the other 409. |
| R-1.9 | WHEN every check in R-1.2 through R-1.7 passes, THE SYSTEM SHALL create any missing parent directories, then write the file, then answer 200 carrying the created posix-relative path and the root it was written under. |
| R-1.10 | THE SYSTEM SHALL seed the new file with `# <basename without extension>` followed by a blank line, so that `titleFromMarkdown` resolves a title from it. |
| R-1.11 | IF the file write fails after parent directories were created, THE SYSTEM SHALL report the failure and MAY leave those directories in place. |

## Unit 2: Renaming a file

**Why:** Rename exists so a mistyped name does not send the author back to the
terminal this feature was built to avoid. It must not be able to destroy a file,
and it must not orphan the review attached to the file it moves. It also has to
reach the same set of destinations create reaches: a user who created
`notes/2026/kickoff.md` without `notes/` existing has no way to guess why moving a
file into `other/folder/` would require the folder to be there already.

| ID | EARS statement |
| --- | --- |
| R-2.1 | THE SYSTEM SHALL expose `POST /__vs/tree/rename` accepting a JSON body `{ from: string, to: string }`. |
| R-2.2 | THE SYSTEM SHALL apply R-1.4, R-1.5 and R-1.6 to `to`, and R-1.5 and R-1.6 to `from`. |
| R-2.3 | IF `from` does not exist, or is not a regular file, THE SYSTEM SHALL answer 404 or 400 respectively and SHALL NOT modify the filesystem. |
| R-2.4 | IF a file already exists at `to`, THE SYSTEM SHALL answer 409 and SHALL leave both `from` and `to` unchanged. |
| R-2.5 | THE SYSTEM SHALL perform the move by a filesystem operation that fails when the destination exists, and SHALL NOT use an operation that overwrites the destination silently. |
| R-2.6 | WHEN the move succeeds, THE SYSTEM SHALL rewrite every comment record whose `target.path` equals `from` so that it equals `to`, and SHALL preserve every other field on those records. |
| R-2.7 | WHEN the move succeeds, THE SYSTEM SHALL preserve every comment record whose `target.path` does not equal `from`. |
| R-2.8 | WHEN the move succeeds, THE SYSTEM SHALL answer 200 carrying the new posix-relative path. |
| R-2.9 | THE SYSTEM SHALL NOT expose any operation that deletes a file. |
| R-2.10 | IF `from` names a directory, THE SYSTEM SHALL refuse, because directory rename is out of scope. |
| R-2.11 | WHEN every check in R-2.2 through R-2.4 passes and `to` names a path whose parent directories do not all exist, THE SYSTEM SHALL create the missing parent directories and then move the file, on the same terms R-1.9 gives create; and IF the move fails after those directories were created, THE SYSTEM SHALL report the failure and MAY leave them in place, as R-1.11 allows for create. |
| R-2.12 | IF a rename is refused by any of R-2.2, R-2.3 or R-2.4, THE SYSTEM SHALL NOT create any directory, so that a refused rename costs nothing on disk. |

## Unit 3: Freshness of the tree

**Why:** The server caches the directory walk for three seconds and drops it only
when the store is rebuilt. Without an explicit invalidation the user creates a file
and does not see it, which is the failure this whole feature is supposed to remove.

| ID | EARS statement |
| --- | --- |
| R-3.1 | WHEN a create or rename succeeds, THE SYSTEM SHALL discard the tree store's cached walk. |
| R-3.2 | WHEN the client reads the tree immediately after a successful create, THE SYSTEM SHALL include the created file in the response. |
| R-3.3 | WHEN the client reads the tree immediately after a successful rename, THE SYSTEM SHALL include the new path and SHALL NOT include the old one. |

## Unit 4: Host parity and transport

**Why:** These are the first *write* routes reached by both hosts, and the two
hosts already dispatch `/__vs/tree` differently — one parses a request body, the
other does not. A shared handler alone does not fix that.

| ID | EARS statement |
| --- | --- |
| R-4.1 | WHEN an identical create or rename request is issued to either host against an identical directory, THE SYSTEM SHALL produce an identical status, an identical response body, and an identical on-disk result. |
| R-4.2 | THE standalone host SHALL parse a JSON request body for non-GET methods on `/__vs/tree` before dispatching. |
| R-4.3 | WHEN a request to either route carries `Sec-Fetch-Site` of `cross-site` or `same-site`, or a non-loopback `Host`, THE SYSTEM SHALL reject it before the handler runs and SHALL NOT touch the filesystem. |
| R-4.4 | THE SYSTEM SHALL refuse a create or rename request that cannot prove the cross-origin guard ran, in the manner the collaboration dispatch already does. |
| R-4.5 | WHEN a request reaches a `/__vs/` path that no route handles, THE SYSTEM SHALL answer 404 with a JSON body, and SHALL NOT serve the single-page-app shell. |
| R-4.6 | THE SYSTEM SHALL NOT permit any module under `core/vite/routes/` to import `vite`. |

## Unit 5: The file-tree controls

**Why:** The tree is where the user sees the workspace, so it is where files are
added and renamed. The feedback loop closes in the browser or the feature has not
removed the terminal round trip it promised to remove.

| ID | EARS statement |
| --- | --- |
| R-5.1 | THE file tree SHALL present a "New file" control and, per file row, a rename control. |
| R-5.2 | WHEN the user activates either control, THE SYSTEM SHALL present an inline single-line path input within the tree column, prefilled with the current path in the rename case. |
| R-5.3 | WHEN the user submits, THE SYSTEM SHALL issue the corresponding request. |
| R-5.4 | WHEN a create succeeds, THE SYSTEM SHALL invalidate the client's cached tree, open the created path in the main pane, and place that pane in edit mode. |
| R-5.5 | WHEN a rename succeeds, THE SYSTEM SHALL invalidate the client's cached tree, and SHALL keep the pane on the renamed document under its new path. |
| R-5.6 | WHEN either operation succeeds, THE SYSTEM SHALL dismiss the inline input and clear its value. |
| R-5.7 | IF either request fails, THE SYSTEM SHALL render the server's own message verbatim beneath the input, SHALL keep the typed path, and SHALL NOT substitute a generic failure message. |
| R-5.8 | WHILE a request is in flight, THE SYSTEM SHALL disable the submit control. |
| R-5.9 | WHEN the user dismisses the inline input without submitting, THE SYSTEM SHALL issue no request. |
| R-5.10 | WHEN a file is created, THE SYSTEM SHALL accept comments against its path on the same terms as any pre-existing file. |
