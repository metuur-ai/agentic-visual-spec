# Pull Requests Awaiting You — High-Level Design

## Overview

The header today answers "how many pull requests are open on this repository?" It does not
answer the only question a reviewer actually opens the tool with: **which of them are
waiting on me?** Two pull requests can be open for weeks without concerning anyone; the one
where someone typed `@you` in a review comment, or added you as a reviewer, is a debt with
your name on it, and today the only place it is visible is github.com.

This adds two counts beside the existing one — pull requests of the configured repository
where the user has been **requested as a reviewer**, and pull requests where the user has
been **mentioned**, in the body or in any comment — and gives each of them a section in the
pull request panel the user already uses to resume and check out work.

## Stakeholders & Impact

**The reviewer** (primary). Today: to find out whether anything needs them, they leave the
tool for github.com, and the number in the header tells them nothing about their own
obligations. After: the header states both debts, and one click lands on the list with the
same Resume / Review / Check out actions that already work.

**The author who asked for a review** (secondary, indirect). Their request currently
competes with GitHub's email and notification noise. Making it visible in the tool the
reviewer already has open shortens the wait without anyone chasing anyone.

**No new consumers.** No agent, hook, or skill reads these counts. They are display.

## Goals

- The header states, separately, how many open pull requests of the configured repository
  request the user as a reviewer, and how many mention the user.
- A mention typed into a **review comment** counts, not only one in the pull request body —
  this is the case the user named, and it is the common one.
- The review request count agrees with what github.com shows for the same query, so a
  disagreement reads as a real change and not as a bug in this tool. The mentions count is
  deliberately **larger** than github.com's, because GitHub's own mention search does not
  index review comments and this does.
- Opening either count lands on the list of exactly those pull requests, with the actions
  that already exist there — and a mention shows **what was said and by whom**, because
  sending the user to github.com to find that out moves the trip instead of saving it.
- A repository where the user has no obligations shows nothing new — no zeroes, no empty
  chips.

## Non-Goals

- **Cross-repository counting.** Scoped to the configured collaboration repository, matching
  every other number in the header. A reviewer's obligations across all of GitHub is a
  different product and would break the repo attribution rule Unit 8 exists to enforce.
- **Anything resembling an inbox.** Nothing is marked read, dismissed, snoozed, or
  persisted. The counts are a live query, so they go down when the underlying fact changes
  on GitHub and at no other time.
- **Closed or merged pull requests.** Open only.
- **Polling.** Unit 7's no-timer rule (R-7.10) holds; a poll against a repository is a poll
  against somebody's API quota.
- **Notifying.** No sound, badge, title change, or desktop notification.
- **Changing the existing open count.** R-7.1 and R-7.3 are untouched.

## Success Criteria

- With a review requested on the configured repository, the header shows a `to review`
  count matching `is:pr is:open review-requested:@me repo:<configured>` on github.com.
- With `@user` written in a review comment on an open pull request, the `mentions` count
  includes that pull request, and it appears in the panel's mentions section.
- With neither, the header is byte-identical to today's.
- With collaboration unconfigured, neither chip renders **and neither query is issued**.
- A failing search leaves the previous counts on screen and never replaces the header with
  an error.
