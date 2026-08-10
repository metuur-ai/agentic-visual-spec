# Checked Out Pull Requests — Low-Level Design

> Amends the pull request panel established by `github-pr-collaborative-documents.md`
> Unit 13 (checkouts) and extended by `pull-requests-awaiting-you.md` (the two sections
> above the listing). The checkout mechanism itself is untouched.

## Architecture

No new server route and no new GitHub call. Everything the section needs is already in the
panel's memory:

```
mountedPullRequests()  → MountedWorktree[] { pullNumber, path, headSha }   ← git's own registry
client.pullRequests()  → PullRequestSummary[] { number, title, headSha, … }
```

The section is `mounted` rendered directly. Today `mounted` is never iterated — it is only
consulted as `mountedFor(pull.number)` from inside a listed row (`collab-pulls-panel.tsx:205`),
which is exactly why a checkout of an unlisted pull request is invisible. Iterating it is
the whole fix.

Each row joins against the listing by number:

| Join result | State | What the row says |
| --- | --- | --- |
| listed, `worktree.headSha === pull.headSha` | current | the commit |
| listed, shas differ | behind | the commit, the pull request's head, and that checking out again moves it |
| not listed | surplus | that its pull request is not in the listing, and that removing it frees the copy |

Staleness costs nothing: both shas are already loaded. R-13.12 already makes re-mounting
the supported way to move a checkout to a head that has moved, so the row names an action
that already works rather than asking for a new one.

A surplus row cannot report staleness — there is no `PullRequestSummary` to compare against
— and does not try.

### Reading the state without leaning on colour

Each state is an icon **and** a word, with colour reinforcing and never carrying. This is
not a preference: the codebase already argued it when it chose a count over a dot for
per-file comments — *"a dot says 'something is here' only if you already know the colour
means that, and colour alone is not allowed to carry meaning"* (`collab-pr-review.tsx`).
Three states that differ only by green/amber/grey would be unreadable to a reviewer who
cannot distinguish them, and ambiguous to everyone on first sight.

### Refresh

One control in the drawer header, beside `Collaborate on pull requests`. It re-reads three
things that today refresh on different schedules and never together:

- the listing (`client.pullRequests(state)`, panel-local),
- the checkouts (`refreshMounted`, panel-local),
- the two counts (the `use-awaiting-pulls` module store, shared with the header).

The store currently exports `useAwaitingPulls`, `retainedAwaiting` and `resetAwaitingCache`
and no way to ask it to re-read. It needs a `refreshAwaiting()` that joins the existing
shared in-flight promise, so pressing refresh while a focus-triggered read is in flight
does not start a second one — the same coalescing R-A4.2 already requires.

One control and not one per section. Two buttons that refresh different subsets make the
reader work out which one answers their question, and the cheap half (git's worktree
registry, local, no network) is not worth its own control.

R-7.10 forbids a timer because a poll against a repository spends someone's API quota. A
manual refresh is what that rule leaves behind, so this is the sanctioned escape hatch
rather than an exception to it.

## Constraints

- **No new GitHub calls for the section itself.** Both inputs are already fetched.
- **`mounted` is git's answer, not a cache.** It reports a checkout made by a previous run
  of the server and one removed by hand, which is what makes the surplus case real.
- **The refresh must not multiply cost.** It reads the same three sources the panel already
  reads; the awaiting store's shared in-flight promise is what keeps a double press to one
  request.
- **A failed refresh keeps what is on screen** — the rule R-A4.3 already sets for the counts
  and R-7.11 for the listing.

## Key Decisions

**No "currently working on" marker.** The user asked to see which pull request they are
working on, and the honest answer is that the app does not know. The review surface's pull
request is only known while this panel is off screen. The served directory is never inside
a checkout — checkouts live *beneath* it, at `docs/.visual-spec/worktrees/pr-N`. And a
remembered "last opened" is new state that can outlive the thing it names: it would still
point at a checkout deleted from a terminal, which is the one case the whole section exists
to surface. What the user actually needs from that question — *what do I have half-done,
and is it still valid?* — is answered by the disk, so the section answers from the disk.

**Surplus checkouts are reported, never removed.** A working copy may hold uncommitted
work. The section makes it visible and reachable; deleting it stays a decision.

**The section joins on the current listing, so the toggle moves it.** With the listing on
`closed`, an open pull request's checkout reads as surplus. Retaining a separate copy of
the open listing to avoid that would duplicate server state, which is the thing this
codebase has spent the last several changes removing. The wording stays true either way.

## Out of Scope

- Disk usage per checkout, and any total.
- Bulk removal.
- Any change to how a checkout is created, where it lives, or its read-only nature.
- Marking which checkout is active, per the decision above.
