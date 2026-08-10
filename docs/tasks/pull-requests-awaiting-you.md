# Pull Requests Awaiting You — Tasks

> Source specs: `docs/ears/pull-requests-awaiting-you.md`, `docs/lld/pull-requests-awaiting-you.md`,
> `docs/hld/pull-requests-awaiting-you.md`. Amends Units 7 and 8 of `git-context-in-header.md`.
>
> Build order: adapter (Unit 2) → route and payload (Unit 2, Unit 4) → hook (Unit 4) →
> chips (Unit 1) → list (Unit 3). Nothing renders until the server can answer, and the
> panel is last because it consumes what the header already read.
>
> **`R-7.7` is ambiguous across the spec set.** In `git-context-in-header.md` it is about
> resuming a collaboration; the "browser never calls GitHub" rule is `R-7.7` of
> `github-pr-collaborative-documents.md`. Stories below name the document.

## Unit 2: Where the numbers come from

- [ ] 2.1 Add `searchPullRequests(repo, qualifier, login)` to the GitHub adapter (est: ~40m)
  - why: the review request count has to be GitHub's own answer, and the adapter is the only place allowed to spawn `gh`. Search is the first endpoint in this codebase that carries free text, so how `q` is built is decided once, here, rather than at each call site.
  - acceptance: R-A2.1 — a repository-scoped query for open pull requests requesting the user as a reviewer; R-A2.10 — the result carries the query's own `total` **separately** from the items it retrieved, because search pages at 30 and R-7.9 bounds the listing.
  - verify: adapter test with a stubbed executor asserts the exact `gh` argv — `['api','-X','GET','search/issues','-f','q=is:pr is:open review-requested:<login> repo:<owner>/<repo>']` — and that a response whose `total_count` exceeds `items.length` yields both numbers unchanged, not `items.length` twice.
  - landed:

- [ ] 2.2 Resolve and validate the login server-side (deps: 2.1, est: ~25m)
  - why: the availability snapshot is visible to the browser (`collab-client.ts:51`), so a client-supplied login would be both spoofable and a way to inject extra qualifiers into `q`. The value that crosses into a query string is the one thing here that must not be taken on trust.
  - acceptance: R-A2.4 — the login comes from the server's authenticated session and the route accepts no identity parameter; R-A2.5 — a login containing any character outside GitHub's login set is rejected **before** it reaches a query.
  - verify: unit test rejects `me repo:other/repo`, `a b`, `x"y` and accepts `ana-b`, `Bob99`; route test confirms a login supplied in the query string or body is ignored, not honoured.
  - landed:

- [ ] 2.3 Build the mentions union from search plus the open pull requests' review comments (deps: 2.1, est: ~60m)
  - why: this is the requirement the feature exists for. GitHub's mention index covers the body and conversation comments but **not** review comments — the only kind this tool writes — measured against three live pull requests during design. Search alone would silently miss the motivating case.
  - acceptance: R-A2.6 — the count is the union of the mention query and the review comments of the open pull requests already listed; R-A2.8 — a pull request found by both sources counts once; R-A1.3 — a mention in a review comment counts as one in a conversation comment does.
  - verify: unit test over a fixture where PR #1 is mentioned only via search, PR #2 only via a review comment, PR #3 via both — the union is `{1,2,3}` with size 3, not 4.
  - landed:

- [ ] 2.4 Read review comments only for listed open pull requests, and only those that moved (deps: 2.3, est: ~35m)
  - why: reuses `listReviewComments` (`github-adapter.ts:818`) instead of the repository-wide endpoint. The repo-wide scan filled its page cap with closed pull requests' comments before the open-only filter could run, so the count fell as a function of other people's merge rate; bounding it with `since` instead made it decay with the clock, which is the same defect that disqualified the notifications inbox.
  - acceptance: R-A2.7 — review comments are read only for pull requests listed as open, and a later read re-reads only those whose last update has moved since the previous read.
  - verify: test with three listed pull requests — the first read issues three calls; a second read after only one `updatedAt` advanced issues exactly one; a read with no change issues none.
  - landed:

- [ ] 2.5 Match a mention without over- or under-matching (deps: 2.3, est: ~20m)
  - why: hyphens are legal in GitHub logins, so `\b` is the wrong tool and would count `@ana-b` as a mention of `@ana`. And a mention you wrote yourself is not a debt you owe.
  - acceptance: R-A1.9 — `@` + login + a character that cannot occur in a login, with `-` treated as part of the login; R-A1.10 — a mention written by the counted user is not counted.
  - verify: table test — `@ana` matches in `@ana.`, `@ana,`, `@ana ` and at end-of-string; does not match in `@ana-b` or `@anabel`; a comment authored by `ana` mentioning `@ana` yields no count.
  - landed:

- [ ] 2.6 Scope both counts to open pull requests of the configured repository (deps: 2.1, 2.3, est: ~15m)
  - why: every other number in the header belongs to the configured repository, and Unit 8 exists because a count rendered under the wrong repository name is unreadable. A count that quietly spanned repositories would have no repository to name.
  - acceptance: R-A1.6 — only the configured repository; R-A1.7 — only open pull requests.
  - verify: test asserts a pull request of another repository, and a closed pull request of this one carrying a mention, are both absent from either count.
  - landed:

- [ ] 2.7 Expose `GET /__vs/collab/pulls/awaiting`, above the document-scoped match (deps: 2.2, 2.6, est: ~40m)
  - why: the `/pulls/*` family must be registered before the match that reads the first path segment as a documentId, or the route is answered as the status of a document called `pulls` — with a 200, which is why the failure is invisible. The hazard is already written down at `collab.ts:969`.
  - acceptance: R-A2.3 — every query is issued from the server and the browser contacts GitHub for none of this (R-7.7 of `github-pr-collaborative-documents.md`); R-A2.9 — an unconfigured server displays nothing **and issues nothing**.
  - verify: route-order assertion in `collab.pulls.test.ts` alongside the existing ones; a test with collaboration unconfigured asserts zero calls reached the adapter, not merely an empty response.
  - landed:

- [ ] 2.8 Guard the inbox prohibition in the test suite (deps: 2.7, est: ~15m)
  - why: "use the notifications inbox" is the decision most likely to be reverted later for looking cheaper — it is one endpoint instead of several. A requirement that only lives in prose leaves no mark when someone tries.
  - acceptance: R-A2.2 — no count derives from the notification inbox or any source mutated by reading a notification.
  - verify: source-level guard in the style of `local-mode.regression.test.ts` — no module on this path references `notifications`.
  - landed:

- [x] 2.9 Resolve the repository to the name GitHub currently holds before searching (deps: 2.7, est: ~30m)
  - why: found by a browser test against the real server, not by a unit test. This repository's `origin` says `metuur/agentic-visual-spec`; GitHub renamed the org and now serves a 301 to `metuur-ai/agentic-visual-spec`. Every REST call follows that redirect — which is why the open count works and why nobody noticed — but **the search endpoint does not**, and answers 422. Shipped as-is, the two chips would read zero forever on this very machine, with no error on screen because R-A4.3 correctly says to retain rather than shout.
  - acceptance: R-A2.11 — the configured repository is resolved to its current name before that name enters a query.
  - verify: adapter test where `repos/{o}/{r}` answers `full_name: new-owner/name` asserts the subsequent `search/issues` argv carries `repo:new-owner/name`, not the configured one; a second test asserts the resolution is not repeated per query.
  - landed: uncommitted — core/collaboration/github-adapter.ts (`searchPullRequests` resolves through the existing `canonicalRepo` cache), core/collaboration/github-adapter.test.ts

## Unit 4: Reading, and failing to read

- [ ] 4.1 Shape the payload so each side can fail alone (deps: 2.7, est: ~30m)
  - why: a flat 200 cannot say "review requests failed, mentions did not", and the mentions number now has two sources that fail independently. A union missing one source is real but low, and indistinguishable from a true number unless the payload says so.
  - acceptance: R-A4.4 — one count succeeding and the other failing displays the one that succeeded; R-A4.5 — a partial union is reported **and marked incomplete**; R-A4.6 — a repository the credential cannot search is a failed read, not a fault of the listing.
  - verify: route tests for four shapes — both ok, review side failed, mention side failed, one mention source failed (`complete: false`); the 422 case asserts the listing's own error field is untouched.
  - landed:

- [ ] 4.2 Read on mount, focus and visibility — once per tab switch (deps: 4.1, est: ~30m)
  - why: `use-collab-pulls.ts:81-83` registers `focus` **and** `visibilitychange`, which both fire on a single tab switch. Today that costs two listings; attaching these reads without coalescing doubles a far more expensive cycle against the core limit that publish and sync also spend. De-duplicating overlapping reads is not a timer, so R-7.10 stands.
  - acceptance: R-A4.1 — mount, focus, visibility change, no timer; R-A4.2 — a read already in progress does not start a second.
  - verify: hook test dispatches `focus` and `visibilitychange` in the same tick and asserts exactly one request; a fake timer advanced by minutes issues none.
  - landed:

- [ ] 4.3 Retain the last known counts through a failure (deps: 4.2, est: ~20m)
  - why: mirrors R-7.11, which the existing count already honours by simply not writing on failure. A rate-limited search is an ordinary Tuesday here, not an exception.
  - acceptance: R-A4.3 — a failed read leaves the previous counts on screen and shows no error in their place.
  - verify: hook test — a successful read then a failing one leaves the rendered numbers unchanged and renders no error node.
  - landed:

- [ ] 4.4 Keep the header and listing alive when these reads fail (deps: 4.3, est: ~15m)
  - why: this is an amendment; nothing it adds is allowed to take down what already worked. A reviewer who cannot see their mentions must still see the open count and the file tree.
  - acceptance: R-A4.7 — no failure introduced here prevents the open pull request count, the listing, or the header from rendering.
  - verify: component test with the `awaiting` route stubbed to 500 asserts `git-pull-count` still renders with its value.
  - landed:

## Unit 1: The chips

- [ ] 1.1 Render the two counts as two chips (deps: 4.2, est: ~40m)
  - why: being asked to review blocks someone else's work; being mentioned asks you to read something. One combined number averages two different urgencies and forces the reader into the panel to recover the distinction the chip destroyed.
  - acceptance: R-A1.1 — the review request count; R-A1.2 — the mentions count; R-A1.4 — two separate indicators, never one number.
  - verify: component test with counts 3 and 2 asserts two distinct testids with those values and no element carrying `5`.
  - landed:

- [ ] 1.2 Show nothing for a count that is zero or not yet known (deps: 1.1, est: ~20m)
  - why: a permanent `0 to review` says nothing on almost every day, and the header already carries several chips. Absent means nothing is waiting — which is also the honest rendering before the first read lands.
  - acceptance: R-A1.5 — a zero or unknown count renders no indicator.
  - verify: component test asserts neither chip is in the document at counts of zero, and neither is present before the first response resolves.
  - landed:

- [ ] 1.3 Count a pull request in both chips when it qualifies for both (deps: 1.1, est: ~10m)
  - why: the two numbers are not a partition. Being tagged in a review comment on a pull request you were also asked to review is two facts about it, and suppressing one to keep the numbers tidy hides an obligation.
  - acceptance: R-A1.8 — a pull request both requested and mentioned is counted in both indicators.
  - verify: test with a single pull request matching both sources asserts both chips read 1.
  - landed:

- [ ] 1.4 Name the repository once for the group of counts (deps: 1.1, est: ~30m)
  - why: R-8.1 requires the count's repository to be named wherever the chip does not already name it, and it was written when there was one count. Three chips each carrying `on owner/repo` is a chorus; none carrying it reopens the exact hole Unit 8 exists to close, in the `local` and `none` states where nothing on screen names a repository at all.
  - acceptance: R-A1.11 — the naming is applied to the group once and not repeated per indicator.
  - verify: extend the `git-chip` tests — with the served directory on a different origin, `git-pull-count-repo` appears exactly once across all three chips.
  - landed:

## Unit 3: The list

- [ ] 3.1 Add the two sections to the existing pull request panel (deps: 1.1, est: ~45m)
  - why: the panel already resumes, reviews and checks out pull requests. A second list with its own copy of those actions is how the two drift apart. The header owns the read and hands the result down, because the panel already fetches its own listing (`collab-pulls-panel.tsx:159`) and a second caller would double every refresh.
  - acceptance: R-A3.1 — opening an indicator shows the pull requests it counts; R-A3.2 — as titled sections inside the existing list, not a separate one; R-A3.6 — the existing listing is still shown and is not filtered.
  - verify: panel test asserts both sections render above the existing groups, and that `groupByOwner`'s output is still present and unfiltered beneath them.
  - landed:

- [ ] 3.2 Give matched rows the actions the panel already offers (deps: 3.1, est: ~20m)
  - why: a pull request present in the listing is a full record with a branch and a head commit. Anything less than the existing actions on it would be a downgrade for having arrived through a different door.
  - acceptance: R-A3.3 — a counted pull request present in the listing carries the same actions.
  - verify: panel test asserts a matched row exposes the same Resume / Review / Check out controls as its equivalent in the main listing.
  - landed:

- [ ] 3.3 Render an unmatched pull request without offering a checkout (deps: 3.1, est: ~30m)
  - why: R-7.9 bounds the listing and deliberately does not bound the count, and search pages, so the counted set and the listed set genuinely diverge. A row built from search data has no branch or head commit — offering a button that cannot work is worse than declining.
  - acceptance: R-A3.4 — displayed by number and title with a link to GitHub; R-A3.5 — no checkout offered, and it says it is not among the pull requests that were listed.
  - verify: panel test with a counted number absent from the listing asserts the row renders with a link, exposes no checkout control, and states the reason.
  - landed:

- [ ] 3.4 Show who wrote the mention and what it said (deps: 3.1, est: ~30m)
  - why: the whole ask was "not only on GitHub". A row that says "you were mentioned" and links out has moved the trip rather than saved it — and the scan already has the comment body in hand at the moment it matches, so this costs nothing extra to fetch.
  - acceptance: R-A3.7 — a mention row shows the mention's author and the passage of the comment containing it.
  - verify: panel test asserts the author's login and a fragment of the comment body appear on the row.
  - landed:

- [ ] 3.5 Say when a section shows fewer rows than it counts (deps: 3.3, est: ~20m)
  - why: R-A2.10 keeps the count equal to GitHub's while R-7.9 bounds what is listed. The gap is legitimate; leaving it unexplained turns a bound into a lie and reads as a bug in this tool.
  - acceptance: R-A3.8 — a section displaying fewer pull requests than its count says so.
  - verify: panel test with a count of 40 and 30 rows asserts the shortfall is stated.
  - landed:

- [ ] 3.6 Keep the sections open-only when the listing is switched (deps: 3.1, est: ~20m)
  - why: the panel's `state` toggle (`collab-pulls-panel.tsx:122`) re-queries for closed or all, and both counts are of open pull requests by R-A1.7. Sections that silently stayed put would look filtered by a control that never touched them.
  - acceptance: R-A3.9 — with the listing in a state other than open, the sections still show open pull requests only, and say so.
  - verify: panel test switches to `closed` and asserts the sections are unchanged and carry the open-only note.
  - landed:
