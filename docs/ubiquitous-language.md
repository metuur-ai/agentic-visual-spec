# Ubiquitous Language

Terms that mean one thing here. Added when a word was found doing two jobs at once,
not pre-emptively.

## Starting versus finding

| Control | Does |
| --- | --- |
| **Start collaboration** (header, Review zone) | **Creates**: a branch `visual-spec/<id>`, a commit, and a pull request. |
| **Open pull requests** (git chip, plural) | **Lists** what already exists, to resume or review. |

These were briefly both called "open a pull request", and the author reported the create
action as missing — it was on screen the whole time wearing the name of the thing beside
it. A verb that names *finding* must never be attached to a control that *creates*.

### There is one create, and it is not on the reviewer's screen

A second control called **Create pull request** used to sit in the collaboration surface's
open panel, under the heading "New document". It created an *empty* document and opened a
pull request for it in one act — so the same words named two different operations
depending on which screen you were on, and the one on the reviewer's screen made an
author's first act a publish of something nobody had written yet.

| Act | Control | Where |
| --- | --- | --- |
| Create a **file** | **+ New file** | The file tree. Local, nothing is shared. |
| Share a **written file** | **Start collaboration** | The main header, on the open file. |

Drafting happens between the two, in local notes. Nothing reaches GitHub until
**Start collaboration**, which is the only control in the product that creates a pull
request.

## Comments

There are two **kinds** of comment. They are not two states of one thing, and code or
copy that treats them as a draft/published pair of the same object is wrong.

| Term | Means | Where it lives |
| --- | --- | --- |
| **Note** | The user's own note, written **as author**, about their own file. Nothing sends it anywhere. | The local sidecar, shown in the comment panel. Labelled `Your note`. |
| **Pull request comment** | A comment made while collaborating on a pull request, in either role — reviewer or author. Belongs on GitHub. | The review surface, against a mounted pull request. |

A pull request comment — and only a pull request comment — additionally has a **state**:

| Term | Means |
| --- | --- |
| **Draft** | Written, held, not yet on GitHub. Labelled `N drafts — not sent yet`. |
| **Sent** | On the pull request. Labelled `On GitHub · #<n>`. |

**Send**, never *publish*, is the verb that moves a draft to GitHub. *Publish* is
already taken by the collaboration document lifecycle, which commits a document to a
branch — a different act on a different object.

### The word "local" is retired from user-facing copy

It named the *kind* in the comment panel (`Local only — not on GitHub`) and the *state*
in the review surface (`N local — not yet on GitHub`), so a personal note read as an
unsent pull request comment. The failure that made it visible: a `Publish all N` action
sat directly beneath the word "local", which read as an offer to push the user's private
notes to GitHub.

`where: 'local'` survives as an **internal identifier** in `ui/comment-panel.tsx` and
the `data-vs-draft-status` attribute. Renaming those is not required — the collision was
in what people read, not in what the code calls things.

**R-13.18** (`docs/ears/github-pr-collaborative-documents.md`) requires only that the two
be distinguishable and that origin never be inferred from a missing control. It does not
prescribe the words, so this table can change without touching the requirement.
