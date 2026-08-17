# Checked Out Pull Requests — EARS Specifications

> Amends the pull request panel of `github-pr-collaborative-documents.md` Unit 13 and
> `pull-requests-awaiting-you.md` Unit 3. The checkout mechanism is unchanged: still
> detached, still read-only, still never commits (R-13.x holds in full).
>
> Requirement ids here are `R-C<unit>.<n>`.

## Unit 1: The checkouts on disk

**Why:** A checkout is a whole working copy of the repository. The panel marks one on the
row of its pull request, which works only while that pull request is listed — so the moment
it merges, its copy becomes invisible and its `Remove checkout` button unreachable, because
that button lives on the row. They accumulate silently. Gathering them into one section
also answers the question the badges force the reader to answer by scanning: what do I have
half-done?

| ID | EARS statement |
| --- | --- |
| R-C1.1 | THE SYSTEM SHALL display every pull request checked out on disk in a section of its own within the pull request panel. |
| R-C1.2 | THE SYSTEM SHALL display a checked-out pull request whether or not it appears in the panel's current listing. |
| R-C1.3 | WHERE a checked-out pull request does not appear in the listing, THE SYSTEM SHALL state that, and SHALL offer to remove the checkout. |
| R-C1.4 | THE SYSTEM SHALL NOT remove a checkout that the user has not asked to remove. |
| R-C1.5 | WHERE nothing is checked out, THE SYSTEM SHALL display no section. |
| R-C1.6 | THE SYSTEM SHALL continue to mark a checked-out pull request on its row in the listing, and the section SHALL NOT replace that marking. |
| R-C1.7 | THE SYSTEM SHALL derive the section from the repository's own record of its checkouts, so that a checkout made by an earlier run of the system, or removed outside it, is reported correctly. |

## Unit 2: Whether a checkout is still current

**Why:** The badge names the commit a checkout sits at, and stops. A reviewer reading a
working copy pinned to a commit the branch has moved past is reading code that no longer
exists, and nothing on screen tells them — it is the failure they cannot diagnose, because
everything looks normal. The comparison costs nothing: both commits are already loaded.
Re-checking out is already the supported way to move a checkout to a head that has changed,
so the row can name an action that works rather than asking for a new one.

Colour cannot carry this. The codebase settled that question when it chose a count over a
coloured dot for per-file comments, and three states separated only by hue would be
unreadable to a reviewer who cannot distinguish them and ambiguous to everyone else on
first sight.

| ID | EARS statement |
| --- | --- |
| R-C2.1 | THE SYSTEM SHALL state, for each checked-out pull request it can compare, whether the checkout is at the pull request's current head. |
| R-C2.2 | WHERE a checkout is not at the pull request's current head, THE SYSTEM SHALL name both commits and SHALL state that checking the pull request out again moves the checkout to the current head. |
| R-C2.3 | WHERE a checked-out pull request is absent from the listing, THE SYSTEM SHALL NOT assert whether its checkout is current, because it has nothing to compare against. |
| R-C2.4 | THE SYSTEM SHALL convey each state by a word and a mark as well as by colour, and SHALL NOT rely on colour alone to distinguish one state from another. |
| R-C2.5 | THE SYSTEM SHALL determine the comparison from information it has already read, and SHALL NOT issue a request in order to make it. |

## Unit 3: Refreshing

**Why:** Nothing here polls, by design — R-7.10 forbids a timer because a poll against a
repository spends somebody's API quota. What that rule leaves behind is a user who has
just merged, checked out, or been added as a reviewer in another window and has no way to
ask. The listing, the checkouts and the two counts refresh on different occasions today and
never together, so "refresh" has to mean all three or it will be pressed and disbelieved.
One control, because two that refresh different subsets make the reader work out which one
answers their question.

| ID | EARS statement |
| --- | --- |
| R-C3.1 | THE SYSTEM SHALL offer one control that re-reads the pull request listing, the checkouts, and both counts of pull requests awaiting the user. |
| R-C3.2 | THE SYSTEM SHALL present that control once for the panel, and SHALL NOT offer a separate control per section. |
| R-C3.3 | WHILE a refresh is in progress, THE SYSTEM SHALL say so, and SHALL NOT begin a second one. |
| R-C3.4 | WHERE a read is already in flight when a refresh is requested, THE SYSTEM SHALL join it rather than issue a duplicate request. |
| R-C3.5 | IF a refresh fails, THE SYSTEM SHALL retain what is displayed and SHALL NOT replace it with an error. |
| R-C3.6 | THE SYSTEM SHALL NOT re-read any of this on a timer. |
