# Pull Requests Awaiting You — EARS Specifications

> This document **amends Unit 7** of `git-context-in-header.md`, which requires the header
> to display the count of open pull requests of the configured repository (R-7.1), forbids
> requesting it where collaboration is not configured (R-7.2), fixes the refresh points
> (R-7.10), and requires a failed read to retain the last known value (R-7.11). Those
> requirements hold unchanged for the existing count. This document adds two further counts
> governed by the same rules, and two sections within the list of R-7.6. It also amends
> **Unit 8** of the same document, whose repository-attribution rule was written for one
> count and now has three to cover.
>
> **Two documents number a Unit 7, and their `R-7.7`s say opposite things.** In
> `git-context-in-header.md` — the document amended here — R-7.7 is about offering to
> resume a collaboration. The rule that the browser never calls GitHub is R-7.7 of
> `github-pr-collaborative-documents.md`, a different document. Every reference below to
> the browser rule names that document explicitly, because a bare "R-7.7" resolves to the
> wrong requirement in this context.
>
> Requirement ids here are `R-A<unit>.<n>` so they cannot be confused with the `R-<unit>.<n>`
> ids of the header spec.

## Unit 1: What is counted

**Why:** The header answers "how many pull requests are open" and never "which of them are
waiting on me". Those are different questions with different urgencies, and the second one
is the reason a reviewer opens the tool at all. Two counts and not one, because being
requested as a reviewer blocks another person's work while a mention asks you to read
something — a single number averages the two and destroys the distinction the reader
needs, forcing them to open the list to recover it.

Unit 8 requires the repository a count belongs to be named wherever the chip does not
already name it, and it was written when there was one count. Three counts of the same
repository cannot each carry that naming without turning the header into a chorus, so the
rule has to be restated for the group.

| ID | EARS statement |
| --- | --- |
| R-A1.1 | WHERE collaboration is configured, THE SYSTEM SHALL display the number of open pull requests of the configured repository that request the authenticated user as a reviewer. |
| R-A1.2 | WHERE collaboration is configured, THE SYSTEM SHALL display the number of open pull requests of the configured repository that mention the authenticated user. |
| R-A1.3 | WHERE a pull request carries a review comment mentioning the user, THE SYSTEM SHALL count that pull request as a mention, as it counts a mention in a conversation comment or in the pull request body. |
| R-A1.4 | THE SYSTEM SHALL present the two counts as two separate indicators, and SHALL NOT combine them into a single number. |
| R-A1.5 | WHERE a count is zero, or is not yet known, THE SYSTEM SHALL display no indicator for it. |
| R-A1.6 | THE SYSTEM SHALL count only pull requests of the configured collaboration repository. |
| R-A1.7 | THE SYSTEM SHALL count only open pull requests. |
| R-A1.8 | WHERE the user is both requested as a reviewer on a pull request and mentioned in it, THE SYSTEM SHALL count it in both indicators, because each states a different obligation. |
| R-A1.9 | THE SYSTEM SHALL match a mention as the user's login preceded by `@` and followed by a character that cannot occur in a GitHub login, and SHALL treat a hyphen as part of a login rather than as a terminator, so that `@ana-b` is not counted as a mention of `@ana`. |
| R-A1.10 | THE SYSTEM SHALL NOT count a mention written by the user being counted. |
| R-A1.11 | WHERE the header names the repository the open pull request count belongs to, THE SYSTEM SHALL apply that naming to the group of counts once, and SHALL NOT repeat it per indicator. |

## Unit 2: Where the numbers come from

**Why:** A count that disagrees with github.com is read as a bug in this tool, so a number
must be GitHub's own answer wherever GitHub has one. The notifications inbox — the
obvious-looking source — is not: it holds only subscribed threads, it is emptied by reading
it anywhere else including on a phone, and checked against a live account it reported zero
review requests where a search reported two. That prohibition is stated as a requirement
rather than left in the rationale because it is the decision a future implementer is most
likely to reverse for looking cheaper.

Mentions need a second source, and this is the requirement that carries the feature.
GitHub's mention search indexes the pull request body and the conversation comments; it
does **not** index review comments — the diff-anchored ones, which are the only kind this
tool writes. Measured, not assumed: inside a date window where the unfiltered search
provably contained the pull request, `mentions:` returned a pull request whose mention was
in a conversation comment and did not return two whose mention was only in a review
comment. A feature built on that search alone would miss precisely the case it exists for,
and would do so silently.

The user's login is the one value here that comes from outside and lands inside a query
string, so where it is resolved and what it is checked against are requirements and not
implementation notes.

| ID | EARS statement |
| --- | --- |
| R-A2.1 | THE SYSTEM SHALL derive the review request count from a repository-scoped query for open pull requests requesting the user as a reviewer. |
| R-A2.2 | THE SYSTEM SHALL NOT derive any count from the notification inbox, or from any source whose contents change when a notification is read. |
| R-A2.3 | THE SYSTEM SHALL issue every query from the server; per R-7.7 of `github-pr-collaborative-documents.md`, the browser SHALL NOT contact GitHub. |
| R-A2.4 | THE SYSTEM SHALL resolve the login being counted on the server from the authenticated session, and SHALL NOT accept it from the client. |
| R-A2.5 | THE SYSTEM SHALL reject a login containing any character that cannot occur in a GitHub login before that login is placed into a query. |
| R-A2.6 | THE SYSTEM SHALL derive the mentions count from the union of a mention query and the review comments of the open pull requests it already lists. |
| R-A2.7 | THE SYSTEM SHALL read the review comments only of pull requests it has listed as open, and on a subsequent read SHALL re-read only those whose last update has moved since the previous read. |
| R-A2.8 | THE SYSTEM SHALL count a pull request found by both mention sources once. |
| R-A2.9 | WHERE collaboration is not configured, THE SYSTEM SHALL NOT display either count and SHALL NOT issue any query. |
| R-A2.10 | THE SYSTEM SHALL report as the review request count the total that query itself reports, even where it has retrieved fewer pull requests than that total. |
| R-A2.11 | THE SYSTEM SHALL resolve the configured repository to the name GitHub currently holds for it before that name is placed into a query, because a repository whose owner has been renamed is reached by every other call through a redirect the search endpoint does not follow. |

## Unit 3: The list

**Why:** The count is only useful if it leads somewhere, and the place it must lead already
exists — the pull request panel, with the resume, review and checkout actions that already
work. A second list with its own copy of those actions is how the two drift apart.

Two things the panel cannot silently paper over. R-7.9 bounds the list and deliberately
does not bound the count, and a review request query answers in pages, so the number in the
chip can exceed the rows on screen; saying so is the difference between a bound and a lie.
And a row built from search data alone has no branch or head commit, so it cannot be
checked out — the panel must decline rather than offer a button that fails.

A mention row also has a job the review-request row does not. The user asked for this
because the information lives only on github.com; a row that says "you were mentioned" and
sends them to github.com to find out what was said has moved the trip rather than saved it.

| ID | EARS statement |
| --- | --- |
| R-A3.1 | WHEN the user opens either indicator, THE SYSTEM SHALL display the pull requests that indicator counts. |
| R-A3.2 | THE SYSTEM SHALL display those pull requests within the existing pull request list, as distinctly titled sections, and SHALL NOT introduce a separate list. |
| R-A3.3 | WHERE a counted pull request is present in the listing, THE SYSTEM SHALL offer it with the same actions the listing already offers for that pull request. |
| R-A3.4 | WHERE a counted pull request is absent from the listing, THE SYSTEM SHALL still display it, identified by its number and title, with a link to it on GitHub. |
| R-A3.5 | WHERE a counted pull request is absent from the listing, THE SYSTEM SHALL NOT offer to check it out, and SHALL state that it is not among the pull requests that were listed. |
| R-A3.6 | THE SYSTEM SHALL continue to display the pull requests of R-7.6, and the new sections SHALL NOT replace or filter that listing. |
| R-A3.7 | WHERE a pull request is listed as a mention, THE SYSTEM SHALL show who wrote the mention and the passage of the comment containing it. |
| R-A3.8 | WHERE fewer pull requests are displayed in a section than that section's count, THE SYSTEM SHALL state that the section shows fewer than it counts. |
| R-A3.9 | WHERE the listing is switched to a state other than open, THE SYSTEM SHALL continue to show the two sections as open pull requests only, and SHALL say so. |

## Unit 4: Reading, and failing to read

**Why:** R-7.10 forbids a timer because a poll against a repository is a poll against
somebody's API quota, and this feature adds reads to every refresh. `focus` and
`visibilitychange` both fire on a single tab switch — today that costs two listings, and
with these reads attached it would cost two of everything, against the same limit that
publish and sync spend. Coalescing overlapping reads is not a timer and does not weaken
R-7.10; it is what stops the amendment from taxing the operations that write.

A repository the credential cannot see is refused with a status that names neither the
repository nor the reason, and the mention count now has two sources that can fail
independently. Both must cost their own number and nothing else.

| ID | EARS statement |
| --- | --- |
| R-A4.1 | WHEN the component mounts, and again whenever the window receives focus or the document becomes visible, THE SYSTEM SHALL read both counts; THE SYSTEM SHALL NOT poll on a timer. |
| R-A4.2 | WHERE a read is already in progress, THE SYSTEM SHALL NOT begin a second one, so that a single tab switch costs one read. |
| R-A4.3 | IF a read fails, THE SYSTEM SHALL retain the last known counts and SHALL NOT replace either indicator with an error. |
| R-A4.4 | IF one count is read successfully and the other fails, THE SYSTEM SHALL display the one that succeeded. |
| R-A4.5 | IF one of the two mention sources fails, THE SYSTEM SHALL report the mentions the other found and SHALL state that the number is incomplete, so that a reduced count is not read as a true one. |
| R-A4.6 | IF a query is refused because the repository cannot be searched by this credential, THE SYSTEM SHALL treat it as a failed read and SHALL NOT report it as a fault of the pull request listing. |
| R-A4.7 | THE SYSTEM SHALL NOT allow a failure of any query introduced here to prevent the open pull request count, the pull request listing, or the header from rendering. |
