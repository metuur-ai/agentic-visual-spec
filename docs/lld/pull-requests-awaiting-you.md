# Pull Requests Awaiting You — Low-Level Design

> Amends **Unit 7** of `git-context-in-header.md` (the open pull request count and its
> list). Everything Unit 7 requires of the existing chip continues to hold unchanged; this
> document adds two counts beside it and two sections inside its list.

## Architecture

```
gh api search/issues            ← two queries, server-side only
        │
core/collaboration/github-adapter.ts
  searchPullRequestNumbers(repo, qualifier, login) → { total, numbers[] }
        │
core/vite/routes/collab.ts
  GET /__vs/collab/pulls/awaiting → { reviewRequested: {...}, mentioned: {...} }
        │
ui/collab-client.ts               awaitingPullRequests()
        │
ui/use-collab-pulls.ts            same mount/focus/visibility cycle as the open count
        │
        ├── ui/main-header.tsx        two chips beside PullCount
        └── ui/collab-pulls-panel.tsx two sections above the existing groups
```

### Review requests: one query

```
is:pr is:open review-requested:<login> repo:<owner>/<repo>
```

`<login>` is the literal login from the availability snapshot rather than `@me`, because
the server's credential and the user whose obligations are being counted must be the same
identity, and `@me` would make that assumption invisible.

### Mentions: two sources, because search does not see review comments

`search/issues` with `mentions:` is **not sufficient**, and this was established
empirically against the live API rather than assumed. GitHub's mention index covers the
pull request body and its conversation comments; it does **not** cover review comments —
the diff-anchored ones, which are the only kind this tool writes.

The evidence, run inside a date window narrow enough that the unfiltered search provably
contains the pull request:

| Pull request | Where `@user` appears | Found by `mentions:` |
| --- | --- | --- |
| `vercel/next.js#95062` (@eps1lon) | conversation comments | **yes** |
| `vercel/next.js#95695` (@lukesandberg) | review comment only | **no** |
| `vercel/next.js#96641` (@bgw) | review comment only | **no** |

Building on `mentions:` alone would therefore have shipped a feature that silently misses
the exact case that motivated it. The count is a union of two sources:

```
A. is:pr is:open mentions:<login> repo:<owner>/<repo>   ← body + conversation comments
B. listReviewComments(repo, n) for each open pull request n already listed
   → keep bodies mentioning <login> → that pull request counts
```

**Source B reuses `listReviewComments` (`github-adapter.ts:818`) rather than the
repository-wide `GET /repos/:o/:r/pulls/comments`.** The repo-wide endpoint looks cheaper —
one paginated call instead of one per pull request — and it was the first design. It is
wrong, for a reason that only shows up in a busy repository:

- Its page cap is consumed **before** the open-pull-request filter, because the endpoint
  returns review comments of closed and merged pull requests too. On a repository with a
  fast merge rate, the cap fills with comments that are then discarded, and the mentions
  count silently falls as a function of *other people's* activity.
- Bounding it with `since` makes the count decay with the clock: a mention from six weeks
  ago disappears tomorrow with nothing having changed on GitHub. That is precisely the
  defect that disqualified the notifications inbox — a number mutated by something other
  than the fact it reports — reintroduced from the other side.
- `since` on that endpoint filters by *last updated*, which does not compose with
  `sort=created` the way the first design assumed. Reusing `listReviewComments` removes the
  need to establish what that combination actually returns.

The cost is one request per open pull request on the first read. It does not stay that way:
the listing already carries `updatedAt` per pull request, so a subsequent read re-reads only
the pull requests whose last update has moved (R-A2.7). In the steady state of a tab being
switched back to, that is usually none.

A mention is matched as `@` + login + a character that cannot occur in a GitHub login.
A hyphen **is** legal in a login, so `\b` is the wrong tool: `@ana-b` must not count as a
mention of `@ana`. A review comment written **by** the user is not counted as a mention
**of** the user.

### The union costs the "agrees with github.com" property, on purpose

Unit 7 established that the open count must equal what GitHub displays (R-7.3), and the
review request count keeps that. The mentions count deliberately does not: typing the same
`mentions:` query into github.com returns **fewer** pull requests, because github.com is
missing the review comments too. Being more complete than the reference is the point of
the feature; being silently *less* complete would have been the bug.

### Counts and rows come from different places, deliberately

`search/issues` returns issue-shaped items. They carry `number`, `title`, `html_url`,
`user.login`, `updated_at` — but **not** `head.ref`, `base.ref`, or `head.sha`, which are
what a checkout needs. Fetching each pull request to fill those in would turn a
two-request feature into an N-request one.

So:

- **The review request count** is the search's own `total_count`. That is the number
  github.com shows for the same query, which is the property Unit 7 spent R-7.3
  establishing for the open count and which this feature would lose if it counted only the
  rows it managed to match.
- **The mentions count** is the size of the union described above, which cannot come from
  a single `total_count` because it has two sources.
- **The rows** are looked up by number in the open pull request list `useCollabPulls`
  already holds. A matched row is a full `PullRequestSummary` and keeps every action the
  panel already offers.
- **An unmatched number** — the searched set and the listed set can diverge, because
  R-7.9 bounds the list and does not bound the count — renders as a minimal row: the
  number, the title from the search item, and a link out. It cannot be checked out,
  because the data to do so was never fetched, and it says so rather than offering a
  button that would fail.

### Where the request is issued, and the contract

Server-side, through the existing adapter. **R-7.7 of `github-pr-collaborative-documents.md`**
— not of the document amended here, whose R-7.7 is about resuming a collaboration — forbids
GitHub API calls from the browser, and the search endpoint is no exception. The route joins
the `/pulls/*` family in `collab.ts` and **must be registered above the document-scoped
match**, which takes the first path segment as a documentId: `/pulls/awaiting` would
otherwise be answered as the status of a document called `pulls`, with a 200. The hazard is
documented at `collab.ts:969` and asserted in `collab.pulls.test.ts`.

`GET /__vs/collab/pulls/awaiting` takes **no parameters**. In particular it does not take a
login: the availability snapshot is visible to the browser (`collab-client.ts:51`), so a
client-supplied identity would be both spoofable and a qualifier-injection vector into the
search `q`. The server resolves the login from its own session and rejects any login
outside GitHub's login character set before it is interpolated (R-A2.4, R-A2.5).

```ts
type AwaitingSide =
  | { ok: false }                       // this side failed; the client retains its last value
  | { ok: true; total: number; items: AwaitingItem[]; complete: boolean };

type AwaitingItem = { number: number; title: string; htmlUrl: string;
                      mention?: { author: string; excerpt: string } };  // R-A3.7

type Awaiting = { reviewRequested: AwaitingSide; mentioned: AwaitingSide };
```

Three properties of this shape are load-bearing:

- **A side can fail alone.** A flat 200 cannot express "review requests failed, mentions
  did not", and R-A4.4 requires exactly that.
- **`total` is separate from `items.length`.** R-A2.10 requires the count to be the query's
  own total while R-7.9 bounds what is listed, so the two genuinely differ and R-A3.8 makes
  the panel say so. Collapsing them would force a choice between a count that disagrees
  with GitHub and a list that pretends to be complete.
- **`complete` marks a partial union.** When one of the two mention sources fails, the
  number is real but low, and R-A4.5 forbids presenting it as if it were whole.

Total failure of the route answers with the same `githubFailure` shape its siblings in the
family already use (`collab.ts:996`), so the panel's existing error path handles it.

### Who fetches it

`useCollabPulls` feeds the header chip; the panel is **not** a consumer of it — it fetches
its own listing (`collab-pulls-panel.tsx:159`) and its own availability (`:196`). So there
are two independent readers of the pull request list today, and adding a second caller of
`/pulls/awaiting` would double the cost of every refresh.

**Corrected during implementation.** This section first said the header owns the read and
hands it to the panel as a prop. That is not possible: the panel is not a descendant of the
header. `MainHeader` renders the chips; `CollabPullsPanel` is mounted from
`collab-app.tsx:276` and `collab-drawer.tsx:134`, in a different tree, reached from `App`
via the drawer. There is no common ancestor to prop-drill from short of `App`, which would
mean threading the value through two unrelated routes.

So `awaiting` lives in a **module store read through `useSyncExternalStore`**, the same
shape `core/app/lib/use-comments.ts` already uses for the comment sidecar: one cache, one
in-flight request shared by concurrent callers, and a content comparison before the stored
value is replaced so a read that finds nothing new notifies nobody. Both the header chips
and the panel subscribe; neither owns the other.

This is what keeps R-A4.2's coalescing honest across the two trees. A per-component
`useState` would have given the header and the panel a copy each — two requests per tab
switch instead of one, and two independent re-render cascades on a refresh that changed
nothing. The prop-drilling design would have avoided the double request only while the
panel happened to be a child, which it is not.

The panel keeps fetching its own listing — that is not being reorganised here — and does
not issue a second `awaiting` request.

### Opening the panel from a chip is a route that does not exist yet

The open count's chip opens `PullMenu` (`main-header.tsx:557`), a popover local to the
header, rendered from three layout variants. `CollabPullsPanel` is reached only from the
sidebar's `onOpenCollab`, which sets `picker` in `App` and mounts `CollabDrawer`. The header
has no path to it.

R-A3.1 requires the new chips to lead to the sections, and R-A3.2 puts those sections in the
panel — so the chips need that path. It is one callback on `HeaderActions`
(`onOpenPulls`), wired in `App` to the same `setPicker(true)` the sidebar already uses. The
existing open-count chip keeps opening `PullMenu`; nothing about its behaviour changes.

The panel's `state` toggle (open / closed / all, `collab-pulls-panel.tsx:122`) does not
apply to these sections: both counts are of open pull requests by R-A1.7, and R-A3.9 has
the sections say so rather than appear to have been filtered.

## Constraints

- **R-7.7** — no GitHub call from the browser.
- **R-7.10** — mount, focus, and visibility change only. No timer. Two extra requests per
  refresh cycle.
- **Search API rate limit** is 30 requests/minute for an authenticated user and is
  *separate from the core limit*, so the two search queries cannot exhaust the budget the
  rest of collaboration spends. They can exhaust their own: a user alt-tabbing fifteen
  times a minute hits it. A 403 from the search endpoint is therefore an expected
  condition, not an exceptional one, and is handled by R-7.11's rule (retain, do not
  replace). The review comment scan is a core-limit call and is bounded by pages.
- **`focus` and `visibilitychange` both fire on one tab switch.** `use-collab-pulls.ts:81-83`
  registers both, so today a single switch costs two listings. Attaching these reads to the
  same handler without coalescing would double a much more expensive cycle, against the
  *core* limit that publish, sync and review already spend. R-A4.2 requires overlapping
  reads to collapse into one; that is de-duplication, not a timer, so R-7.10 is untouched.
- **The review comment scan is bounded by the listing, not by a clock.** It reads only the
  open pull requests already listed — a set R-7.9 already bounds — and on later reads only
  those whose `updatedAt` moved. No `since`, no separate page cap, and no count that decays
  on its own.
- **Availability is read first**, as in `use-collab-pulls.ts` today: an unconfigured server
  must issue no query at all, not merely hide the result (R-7.2).
- **422 is expected.** `search/issues` answers 422 — not 404 — for a repository the
  credential cannot see, and the message names neither the repo nor the reason clearly.
  It must degrade to "no counts", never to a broken header.
- The adapter spawns `gh` and nothing else; no hand-rolled HTTP, no GraphQL.

## Key Decisions

**The notifications inbox is rejected as the data source.** It was the user's initial
suggestion, and it was checked against the live account before being declined. Three
independent reasons, any one of them sufficient:

1. *It is not a record of obligations.* The live inbox held 26 items — 25 `ci_activity`,
   1 `state_change`, and **zero** `mention` or `review_requested`. Meanwhile
   `review-requested:@me` returned 2 real pull requests. The inbox would have shown zero
   where the truth was two.
2. *It only contains what you are subscribed to.* Unsubscribe from a thread, or never
   subscribe, and the mention never appears.
3. *It is mutable by reading it elsewhere.* Notifications are marked read — by opening
   GitHub in another tab, by the mobile app, by `gh`. The count would fall without the
   underlying fact changing, which makes it unusable as a debt indicator.

The Search API has the inverse properties: stateless, complete, and identical to what the
user would see typing the same query into github.com.

**Two chips, not one.** Being asked to review blocks another person's work; being mentioned
asks you to read something. Summing them produces a number whose urgency is unknown, and
the reviewer has to open the panel to recover the distinction the chip destroyed.

**Scoped to the configured repository.** Unit 8 exists because a count can render inside a
chip naming a different repository. Cross-repo counts would make that failure permanent
and unfixable — there would be no single repository to name. Deferred, not rejected.

**Zero renders nothing.** A `0 to review` chip is a permanent fixture that says nothing on
almost every day, and the header already carries several chips. Absent means nothing is
waiting.

## Out of Scope

- Cross-repository counts and any "all my reviews everywhere" surface.
- Team-based review requests. `review-requested:` covers requests made to the user
  directly; GitHub's `team-review-requested:` is a separate qualifier. **This one carries a
  launch risk that could not be settled from data:** if the repository asks for reviews via
  teams, the chip reads zero on day one and the feature looks broken. The configured
  repository's two open pull requests currently have *no* reviewers of either kind, so the
  question is open, not answered. Worth one look at a repository that actually uses reviews
  before this ships.
- Marking read, dismissing, or persisting any of this.
- Reacting to a mention from inside the tool. The row's existing actions are the whole
  interaction.
- Any change to the open pull request count, its list, or its repository attribution.
