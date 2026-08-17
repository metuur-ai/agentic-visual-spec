# Local File Creation and Rename — High-Level Design

## Overview

visual-spec browses a directory and lets a user comment on what is already there.
There is no way to add a document, and no way to fix its name once added. Today an
author who wants a new spec has to leave the browser, create the file in an editor
or a terminal, and come back.

This feature adds two controls to the file tree. **New file**: name a Markdown
path, and the file is created on disk, appears in the tree, and opens in the pane.
**Rename**: change a file's path in place, carrying its review comments with it.

Rename is in scope because without it the first typo re-opens the terminal this
feature exists to close. Delete is not: it destroys a user's work, and the case for
it is nothing like as strong.

## Stakeholders & Impact

- **Document authors** (primary): today, starting a document means leaving the
  tool, and misnaming one means leaving it again. After this ships both round trips
  disappear.
- **Reviewers** (unaffected): these are an author's acts on local files. A reviewer
  reading a collaboration document off a pull request branch never sees these
  controls — collaboration documents come from the branch, not the tree.
- **The apply-comments flow** (secondary): a comment can ask for a document that
  does not exist yet; the author can now make the target instead of the agent
  inventing a path. And because rename carries comments with the file, a rename
  mid-review does not silently orphan the review.

## Goals

- An author can create a `.md` file anywhere under the served directory, including
  in folders that do not exist yet, without leaving the browser.
- An author can rename an existing file, and every open comment on it keeps
  pointing at it.
- Both operations are reflected in the tree immediately, with no manual reload.
- A new file is never blank on arrival: it carries a heading derived from its own
  name, so the viewer has something to render and the document has a title.
- Neither operation can destroy an existing file.
- Every refusal names what went wrong in the user's own terms rather than as a
  generic failure.

## Non-Goals

- **No delete, no move-to-trash.** Destroying a user's work is a separate decision
  with a separate blast radius. Rename covers the case that motivated this.
- **No directory rename.** Files only. Renaming a directory means rewriting the
  comment paths of everything beneath it, which is a different problem.
- **No non-Markdown files.** The surface renders Markdown; a `.ts` created here has
  nothing to do. Note this is a *product* restriction, not a security boundary —
  `POST /__vs/upload` already writes client-named binaries into the served
  directory, so the writable surface is not new.
- **No creation in collaboration mode.** A collaboration document is created by
  `POST /__vs/collab/start`, which also makes the branch and the pull request.
- **No template system.** The seeded heading is fixed.
- **No directory-only creation.** Folders exist because a file needs them.

## Open Questions

- **Delete.** Deliberately excluded, and the decision is expected to come back.
  Rename removes the typo case, which was the sharpest argument for it. If a
  second argument appears — an author who created a file in the wrong place
  entirely and does not want a stale copy — revisit rather than treating this
  Non-Goal as settled.
- **Files created into ignored paths.** Creating `dist/notes.md` succeeds and the
  file opens in the pane, but it never appears in the tree, because
  `.visualspecignore` hides it. This is accepted rather than prevented: the user
  sees their file, and preventing it costs a new visibility API on `TreeStore`.
  If it turns out to confuse people, the fix is a warning, not a refusal.

## Success Criteria

- Creating `notes/2026/kickoff.md` in a workspace with no `notes/` directory
  produces the file, both intermediate directories, a tree entry **on the next
  tree read**, and an open pane showing `# kickoff`.
- Creating a path that already exists refuses, and the existing file's bytes are
  unchanged even when two requests race.
- Creating a path that resolves outside the served directory — including through a
  symlink inside it — refuses and writes nothing anywhere on disk.
- Renaming `a.md` to `b.md` moves the file, leaves no `a.md`, and every open
  comment that pointed at `a.md` points at `b.md` afterwards.
- Renaming onto an existing path refuses and leaves both files untouched.
- Both hosts — the standalone CLI server and the Vite plugin — accept the same
  requests and behave identically, including body parsing.
