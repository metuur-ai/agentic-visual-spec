# Checked Out Pull Requests — Tasks

> Source specs: `docs/ears/checked-out-pull-requests.md`, `docs/lld/checked-out-pull-requests.md`,
> `docs/hld/checked-out-pull-requests.md`. Amends the panel of
> `github-pr-collaborative-documents.md` Unit 13 and `pull-requests-awaiting-you.md` Unit 3.
>
> Build order: the store's refresh seam (3.1) first, because it is the only new API and the
> refresh control cannot be wired without it → the section (Unit 1) → what each row says
> about its commit (Unit 2) → the control itself (rest of Unit 3).
>
> Almost all of this is `ui/collab-pulls-panel.tsx`. Stories inside Unit 1 and Unit 2 touch
> the same render path and are marked `mutex: panel-rows` — they are ordered, not parallel.
>
> **Accepted risk, recorded so nobody rediscovers it as a bug.** The section joins against
> the panel's current listing, so with the toggle on `Closed` an open pull request's
> checkout reads as absent from the listing. The wording stays true and the open-only note
> sits beside it. Hardening this — offering removal only while the listing is `All` — was
> recommended and declined; changing it means editing R-C1.3 first.

## Unit 3: Refreshing — the store seam

- [ ] 3.1 Add `refreshAwaiting()` to the awaiting store, joining any read already in flight (est: ~25m)
  - why: the refresh control has to re-read the two counts, and the store exposes no way to ask — only `useAwaitingPulls`, `retainedAwaiting` and `resetAwaitingCache`. It must join the existing shared in-flight promise rather than start a second read, or pressing refresh during a focus-triggered read costs two of everything and re-renders the header's chips from the panel, which is the exact coupling the module store exists to prevent.
  - acceptance: R-C3.4 — a refresh requested while a read is in flight joins it rather than issuing a duplicate.
  - verify: store test counts requests, not results — a `focus` and a `refreshAwaiting()` in the same tick issue exactly one; and a second test counts renders in two mounted roots to confirm a refresh finding identical data re-renders neither.
  - landed:

## Unit 1: The checkouts on disk

- [x] 1.1 Render the checkouts as a section of their own (deps: 3.1, est: ~40m, mutex: panel-rows)
  - why: `mounted` is never iterated today — it is only consulted as `mountedFor(pull.number)` from inside a listed row (`collab-pulls-panel.tsx:205`). Iterating it is what turns a scattered set of badges into an answer to "what do I have half-done?". It comes from git's own worktree registry, so a checkout made by an earlier run of the server, or removed by hand in a terminal, is reported correctly rather than remembered wrongly.
  - acceptance: R-C1.1 — every checkout on disk appears in its own section of the panel; R-C1.7 — the section is derived from the repository's record of its checkouts; R-C1.5 — with nothing checked out, no section renders.
  - verify: panel test with two checkouts asserts both appear in the section; a test with an empty `mounted` asserts the section is absent, not present-and-empty.
  - landed: `ui/collab-pulls-panel.tsx` — `checkoutRow` / `checkoutsSection`, joined to the panel's `sections` array so the listing gains its heading below it. Tests: `ui/collab-pulls-panel.test.tsx` › "what is checked out on disk (R-C1)" — "renders every checkout the repository reports, in a section of its own" (R-C1.1, R-C1.7), "renders no section at all when nothing is checked out" (R-C1.5).

- [x] 1.2 Include a checkout whose pull request is not in the listing, and let it be removed (deps: 1.1, est: ~35m, mutex: panel-rows)
  - why: this is the leak. `Remove checkout` lives only on a listed row, so the moment a pull request merges its working copy — a full copy of the repository — becomes invisible and unreachable from the UI, and they accumulate. The row says the pull request is not in the listing rather than guessing why, because the panel cannot tell "merged" from "filtered by the toggle".
  - acceptance: R-C1.2 — a checked-out pull request appears whether or not it is listed; R-C1.3 — where it is not listed, the section says so and offers to remove the checkout; R-C1.4 — nothing is removed without the user asking.
  - verify: panel test with a `mounted` entry having no matching listed pull request asserts the row renders, states it is not in the listing, and exposes the remove control; a test asserts no removal request is issued on render.
  - landed: `ui/collab-pulls-panel.tsx` — `checkoutRow` renders the unlisted line and a `Remove checkout` button calling the existing `unmount`; `checkoutsSection` carries the note naming the `Show` setting when a row leans on it. Tests: "includes a checkout whose pull request is not listed, and offers to remove it" (R-C1.2, R-C1.3), "removes an unlisted checkout through the same DELETE the listed row uses" (R-C1.3), "removes nothing that the user has not asked to remove" (R-C1.4).

- [x] 1.3 Keep the badge on the listed row (deps: 1.1, est: ~10m, mutex: panel-rows)
  - why: the section answers "what do I have open"; the badge answers "is this row one of them" while reading the listing. Removing the badge would make the second question cost a scroll to a different section.
  - acceptance: R-C1.6 — a checked-out pull request is still marked on its row in the listing, and the section does not replace that marking.
  - verify: existing badge assertions still pass, plus a test asserting a checked-out pull request appears both in the section and marked on its listing row.
  - landed: `ui/collab-pulls-panel.tsx` — the badge in `listRow` is unchanged, now with the reason recorded beside it. Test: "still marks a checked-out pull request on its own row in the listing" (R-C1.6), alongside the untouched "marks a pull request that is already checked out, and names the commit".

## Unit 2: Whether a checkout is still current

- [x] 2.1 Compare the checkout's commit with the pull request's head (deps: 1.1, est: ~25m, mutex: panel-rows)
  - why: the badge names a commit and stops. A reviewer reading a working copy pinned to a commit the branch has moved past is reading code that no longer exists, and nothing on screen says so — everything looks normal, which is what makes it undiagnosable. Both commits are already in memory, so the answer costs nothing.
  - acceptance: R-C2.1 — each comparable checkout states whether it is at the pull request's current head; R-C2.5 — the comparison is made from information already read, with no request issued for it.
  - verify: panel test with matching shas asserts the current state and with differing shas the behind state; the injected `fetchImpl` is asserted to have issued no additional request in either case.
  - landed: `ui/collab-pulls-panel.tsx` — `checkoutRow` compares `pull.headSha` with `worktree.headSha`, both already in memory. Tests: `ui/collab-pulls-panel.test.tsx` › "whether a checkout is at the pull request's head (R-C2)" — "says a checkout at the pull request's head is up to date" and "says a checkout the branch has moved past is out of date", each asserting the injected `fetch` made only the three reads of mount (R-C2.5).

- [ ] 2.2 Name both commits and the way out when a checkout is behind (deps: 2.1, est: ~20m, mutex: panel-rows)
  - why: "out of date" without the two commits is unverifiable, and without the remedy it is a dead end. Re-checking out is already the supported way to move a checkout to a head that has changed (R-13.12), so the row names an action that already works instead of asking for a new one.
  - acceptance: R-C2.2 — both commits are named, and the row states that checking the pull request out again moves the checkout to the current head.
  - verify: panel test asserts both short shas are present on the behind row and that the remedy is stated.
  - landed:

- [ ] 2.3 Say nothing about currency for a checkout that is not listed (deps: 2.1, 1.2, est: ~15m, mutex: panel-rows)
  - why: there is no pull request record to compare against, and a row that silently defaulted to "current" would be asserting the one thing it cannot know — about exactly the checkouts most likely to be stale.
  - acceptance: R-C2.3 — an unlisted checkout does not assert whether it is current.
  - verify: panel test asserts the unlisted row carries neither the current nor the behind wording.
  - landed:

- [ ] 2.4 Carry each state in a word and a mark, not in colour (deps: 2.1, est: ~20m, mutex: panel-rows)
  - why: this codebase already settled the question when it chose a count over a coloured dot for per-file comments — a mark says "something is here" only to a reader who already knows what the colour means. Three states separated only by hue are unreadable to a reviewer who cannot distinguish them and ambiguous to everyone else on first sight.
  - acceptance: R-C2.4 — each state is conveyed by a word and a mark as well as by colour, and colour alone never distinguishes one state from another.
  - verify: test asserts each state is identifiable from text content alone, with no reference to a style value — a test that passes with every colour in the component set to the same value.
  - landed:

## Unit 3: Refreshing — the control

- [ ] 3.2 Put one refresh in the panel header, re-reading all three sources (deps: 3.1, 1.1, est: ~35m)
  - why: nothing polls, by design — R-7.10 forbids a timer because a poll against a repository spends somebody's API quota — so a user who has just merged, checked out, or been added as a reviewer in another window has no way to ask. The listing, the checkouts and the counts refresh on different occasions today and never together, so refresh has to mean all three or it will be pressed and disbelieved.
  - acceptance: R-C3.1 — one control re-reads the listing, the checkouts and both counts; R-C3.2 — it is presented once for the panel, with no per-section control.
  - verify: panel test asserts a single press issues a listing read, a mounted read and an awaiting read; and that the panel renders exactly one refresh control.
  - landed:

- [ ] 3.3 Say a refresh is running, and refuse a second (deps: 3.2, est: ~20m)
  - why: these reads are not instant and one of them crosses the network. Without a running state the button looks inert and gets pressed again; five presses in ten seconds is fifteen calls against a search limit of thirty a minute.
  - acceptance: R-C3.3 — while a refresh is in progress the system says so and does not begin a second.
  - verify: panel test with a deferred response asserts the running state is shown and that a second press during it issues no further requests.
  - landed:

- [ ] 3.4 Keep what is on screen when a refresh fails (deps: 3.2, est: ~15m)
  - why: the same rule the counts already follow (R-A4.3) and the listing already follows (R-7.11). A refused search is an ordinary Tuesday here, and it must cost the refresh, not the panel.
  - acceptance: R-C3.5 — a failed refresh retains what is displayed and does not replace it with an error.
  - verify: panel test — a good render, then a refresh whose reads all fail, leaves the rows and counts unchanged and renders no error node.
  - landed:

- [ ] 3.5 Guard that none of this runs on a timer (deps: 3.2, est: ~10m)
  - why: R-7.10 exists because a poll against a repository spends someone else's quota, and this change adds a control whose obvious next step is "just refresh it every 30 seconds". A guard is what makes that a deliberate decision later rather than an accident.
  - acceptance: R-C3.6 — none of the listing, the checkouts or the counts is re-read on a timer.
  - verify: panel test advances fake timers several minutes with the panel mounted and asserts zero requests.
  - landed:
