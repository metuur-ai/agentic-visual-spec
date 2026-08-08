# `.mdj` Review Sessions — High-Level Design

> **RETIRED — never implemented. Do not build from this document.**
>
> This proposed `.mdj` as a local review-session sidecar beside the `.md`. The
> review session now lives entirely in the GitHub Pull Request, so the sidecar has
> no content left to hold. See `docs/ears/github-pr-collaborative-documents.md`.

## Overview

Markdown is the knowledge base. A review is a temporary thing that happens *to* a
Markdown file and then ends. Today those two are conflated: a document under
collaboration is stored as a JSON envelope (`documents/<id>.json`) and Markdown is
generated from it on publish, which puts the review machinery in the git history and
makes the JSON — not the prose — the artifact of record.

This change inverts that. `.md` is the source of truth, always. When a document goes
under review, a sibling `.mdj` appears next to it holding the review session:
comments, threads, AI suggestions, unresolved questions, review status, pending
changes. The user never sees the `.mdj`; the viewer overlays it onto the rendered
Markdown. When the review is accepted the changes land in the `.md` and the `.mdj` is
archived or deleted.

```
Authoring          Collaboration                 Accepted
─────────          ─────────────                 ────────
spec.md      →     spec.md  (source of truth)  →  spec.md   (updated)
                   spec.mdj (review session)      spec.mdj  (removed)
```

**GitHub pull requests remain the primary way users collaborate.** The shared
conversation lives in the PR, as native review comments anchored to a line of the
`.md` — which is what makes them render inline on the diff for anyone, with or
without this tool. The `.mdj` is a **local** artifact: a cache of that conversation
plus the parts that are not shared yet. It is not committed, so nothing about it can
dirty the history the change exists to keep clean.

`.mdj` is therefore not a document format. It is a pull request for documentation.

## Stakeholders & Impact

- **Document authors** (primary): today, starting a collaboration means the document
  stops being a Markdown file. After this ships, `spec.md` stays `spec.md` through
  the entire lifecycle — editable in any editor, diffable in any tool, and readable
  by anyone who never opens this viewer.
- **Reviewers** (primary): today, comments are smuggled through PR *issue* comments
  carrying a `nodeId` payload, so they appear as a flat list detached from the text.
  After this ships they are native PR review comments pinned to a line, and they show
  inline on the GitHub diff.
- **The repository and its history** (primary): review state never enters a commit.
  A merged PR contains prose changes and nothing else.
- **Agents applying comments** (secondary): they edit Markdown at a line anchor —
  the same thing local mode already asks of them — instead of editing structured JSON
  keyed by node identity.
- **In-flight PRs on the current JSON format** (secondary, must-not-break): documents
  already living as `documents/<id>.json` on an open branch must stay readable and
  publishable until those PRs close.

## Goals

- `.md` is the source of truth at every stage of a review. No stage stores the
  document in another form.
- Starting a review on `spec.md` creates `spec.mdj` beside it, and the user is not
  asked to think about the file.
- The viewer renders `spec.md` through the existing Markdown surface, with the review
  session overlaid — comments, threads, suggestions, status.
- The shared conversation is a GitHub PR review comment thread anchored to a line of
  the `.md`, visible to anyone looking at the PR.
- A comment whose anchor no longer matches the text is reported as **outdated**, the
  way a GitHub review comment goes outdated — never silently relocated, never lost.
- Accepting a review writes the changes into the `.md` and ends the session,
  archiving or deleting the `.mdj`.
- `.mdj` files are ignored by git and hidden from the file tree by default.

## Non-Goals

- **`.mdj` is not a document format.** It never holds the prose. If the `.md` is
  deleted, the `.mdj` describes nothing.
- **No committed review state.** The `.mdj` is not pushed, not merged, not required
  by any other user to participate.
- **No new Markdown renderer.** `.md` keeps rendering through the existing surface
  with its `data-vs-loc` source positions.
- **No `.mdj` viewer.** Opening the file directly is not a supported action; it is
  session data, not content.
- **No perfect anchoring.** Anchors are line + snippet + heading, re-resolved on
  open. When the text moves past recognition the comment is marked outdated. This is
  the trade that buys clean Markdown, and it is the same trade GitHub makes.
- **No migration of in-flight JSON documents.** Existing `documents/<id>.json`
  documents stay readable on their current path; they are not converted.
- **No VS Code extension in this change.** The overlay is built in the browser
  viewer, and the `.mdj` format is kept surface-agnostic so an extension can consume
  it later.

## Success Criteria

- `spec.md` under review is byte-identical to `spec.md` not under review, except for
  changes a human or an agent actually made to the prose.
- A comment left in the viewer appears on the GitHub PR, inline on the `.md` diff, to
  a reviewer who has never used this tool.
- Editing an unrelated paragraph of the `.md` leaves other comments anchored; editing
  the commented paragraph marks that comment outdated and shows what it was pinned to.
- Deleting `spec.mdj` loses no shared conversation — reopening the review rebuilds it
  from the PR.
- A merged review PR's diff contains only `.md` changes.
- An open PR created before this ships still opens, syncs, and publishes.
