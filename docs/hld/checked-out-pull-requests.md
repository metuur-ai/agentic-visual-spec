# Checked Out Pull Requests — High-Level Design

## Overview

A checkout is the heaviest thing this tool does: it writes a working copy of the repository
to disk, detached at a pull request's head. The panel already marks a row `checked out ·
ce56f8d` when one exists. What it does not say is whether that copy is still current, and
it cannot say anything at all about a checkout whose pull request is no longer in the
listing — which is every checkout of a pull request that has since been merged.

This gathers every checkout on disk into a section of its own, says for each whether it
still sits at the pull request's head, and puts one refresh control on the panel.

## Stakeholders & Impact

**The reviewer with work in progress.** Today: several checkouts exist, their badges are
scattered among every other row, and nothing distinguishes a copy that is current from one
pinned to a commit the branch has moved past. After: one section answers "what do I have
open, and is any of it stale?" without reading every row.

**The reviewer who finished a review.** Today: the pull request merges, its row leaves the
listing, and its working copy stays on disk — a full checkout per pull request — with no
way to remove it from the UI, because `Remove checkout` lives only on a listed row. After:
it appears in the section, labelled as surplus, with the button that removes it.

## Goals

- Every checkout on disk appears in one place, whether or not its pull request is listed.
- A checkout that is no longer at its pull request's head says so, and says that checking
  it out again moves it.
- A checkout whose pull request is not in the listing says why, and can be removed.
- One control re-reads the panel — the listing, the checkouts, and the two counts.

## Non-Goals

- **Tracking which pull request the user is "working on".** Three readings were considered
  and none survives: the review surface's pull request is only known while the panel is off
  screen; the served directory is never inside a checkout, because checkouts live beneath
  it; and "most recently opened" is new state that outlives the fact it describes — it
  would still name a checkout the user deleted in a terminal. The section answers what is
  on disk and whether it is current, which is knowable, and stops there.
- **Removing anything automatically.** A surplus checkout is reported, never deleted. It
  may hold work.
- **Polling.** R-7.10's no-timer rule holds; the refresh control is the manual alternative
  it implies.
- **Changing what a checkout is** — still detached, still read-only, still never commits.

## Success Criteria

- With two pull requests checked out, the section lists both with their commits, and
  neither has to be found by scanning the listing.
- When a pull request's head moves past its checkout, that row says the copy is behind and
  what to do; before it moves, it says the copy is current.
- With a merged pull request still checked out and the listing on `Open only`, the checkout
  is still listed and still removable.
- The state of each checkout is legible without relying on colour to carry it.
- Pressing refresh re-reads the listing, the checkouts and both counts.
