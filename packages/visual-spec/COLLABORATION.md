---
title: Collaboration Guide
version: 0.1.7
---

# Reviewing documents through GitHub pull requests

Collaboration turns a document into a pull request: the canonical JSON and its generated
Markdown are committed to a branch, reviewers read and comment in visual-spec, and the
author publishes. GitHub's own permissions decide who can do which half.

Everything below is the real, current behaviour, verified against the source. Where the
product deliberately stops short — merging, for one — this guide says so rather than
describing what it would look like.

## Two roles, decided by write access

There is no role setting. The credential's push permission on the repository is the whole
classification (`core/collaboration/authorization.ts`).

| Operation | Needs write access? |
| --- | --- |
| `read`, `sync`, `open`, `comment`, `reply`, `edit-comment` | No |
| `create`, `publish`, `reconcile`, `mark-ready` | Yes |

**Commenting needs no repo access; publishing needs write.** A reviewer on a public repo
can open the document, read it, comment and reply without being a collaborator. Every
author-only operation is refused server-side, so hiding a button is never the enforcement.

## Before you start

Collaboration talks to GitHub only through the `gh` CLI. Each unmet prerequisite reports
itself with the command that fixes it — you should never have to guess which rung you are
on.

| What's missing | What you'll see |
| --- | --- |
| `gh` not installed | Collaboration is unavailable: the GitHub CLI (gh) could not be started. Install gh and run `gh auth login`, or leave collaboration unconfigured to keep using local mode. |
| Not logged in | Collaboration is unavailable: no GitHub credential is configured. Run `gh auth login`, or set `GH_TOKEN` in the environment of the visual-spec server. |
| Credential lacks the scope | Collaboration is unavailable: the GitHub credential is missing the required scope "repo". Run `gh auth refresh -h github.com -s repo` to grant it, or use a credential that carries it. |
| No write access to the repo | You do not have write access to `<owner>/<repo>`, so this is a review-only session. You can comment and reply on any document; publishing needs write access. |
| Repository not found | `<owner>/<repo>` was not found. Either the configured repository is wrong — check the `--repo` flag, or the `collaboration` block passed to `visualSpecMarkdown()` in vite.config.ts — or this credential cannot see it, so run `gh auth status`. |

The required scope is `repo`. Nothing implies it — a credential carrying only
`public_repo` will fail the scope check and be told to run the `gh auth refresh` command
above.

The last two rows are not failures of collaboration: the session still opens, and the
panel says plainly that it is review-only. A GitHub outage produces neither message —
write access reads as *unknown* and the panel stays silent rather than demoting an author
to reviewer on a network blip.

## 1. Install

```bash
cd packages/visual-spec
npm run build          # tsup + vite build → dist/
npm pack               # → metuur-visual-spec-<version>.tgz
npm install -g ./metuur-visual-spec-<version>.tgz
```

Node 18 or newer. See [INSTALL.md](./INSTALL.md) for transferring the tarball to another
machine.

## 2. Turn collaboration on

Collaboration is enabled by a `collaboration` block in the config object you pass to the
Vite plugin:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { visualSpecMarkdown } from '@metuur/visual-spec/vite';

export default defineConfig({
  plugins: [
    react(),
    ...visualSpecMarkdown({
      contentDir: 'content',
      config: {
        collaboration: {
          owner: 'acme',        // required
          repo: 'docs',         // required
          baseBranch: 'main',   // optional, defaults to 'main'
        },
      },
    }),
  ],
});
```

`owner` and `repo` are required; `baseBranch` defaults to `main`. Omit the
`collaboration` block entirely and collaboration reports itself unavailable while local
mode carries on unaffected.

Or, on the standalone CLI, name the repository with a flag:

```bash
visual-spec . --repo acme/docs [--base-branch release]
```

`--base-branch` is optional and defaults to `main`. Omit `--repo` and collaboration stays
off, local mode entirely unaffected. Both hosts reach the same routes; the flags exist so
the CLI does not need a config file it has no loader for.

## 3. Start the server

```bash
npm run dev
```

Collaboration lives behind the sidebar footer button **“Review a pull request…”**.

## 4. Start a document of your own

Click *Review a pull request…*, then use **Start a new document** at the bottom of the
panel. Give it a document id — it names the branch and the file — and optionally a title.

```
Document id   payment-rules
Title         Payment rules
```

**Create pull request** then:

1. writes `documents/<id>.json` locally as an empty document,
2. creates the branch `visual-spec/<id>` off your base branch,
3. commits that document to the branch,
4. opens the pull request, whose body carries the `collab open` command reviewers need.

The document opens straight into the pane. Switch to **Edit**, write it, and publish as in
step 6 — publishing is what puts real content on the branch; the create commit is just the
empty envelope the branch needs to exist.

The form appears only when your credential can publish. A review-only session does not get
it, because `create` is author-only and the route would refuse it anyway.

## 5. Open a document from its pull request

Either entry point works, and both go through the same route.

**In the app** — click *Review a pull request…*, then paste a pull request reference and
the document id. The panel accepts a copied URL, `#42`, or a bare `42`. Before you write
anything it states who you are:

> Signed in as *octocat* — comments you leave here are posted to acme/docs as *octocat*.

**From a terminal** — the command the pull request body itself prints:

```bash
npx @metuur/visual-spec collab open --repo <owner/name> --branch <branch> --document <id> [--pull <n>]
```

Read access is enough for either. Opening fetches the canonical JSON off the branch, so a
reviewer with no local copy still gets the rendered document. If a local copy is stale it
is refreshed; the one refusal is a copy already bound to a *different* pull request.

## 6. Comment, then publish

Reviewers read the document and comment in the review pane. Comments are posted to the
pull request as your own GitHub account.

The author switches the pane to **Edit**, makes changes, and clicks **Publish** once every
comment is resolved. Publish first shows a confirmation listing anything the Markdown
cannot carry — each entry names the block and whether it was replaced or dropped — so you
approve the loss before it is committed.

Publishing then, in order:

1. commits the canonical JSON to the pull request branch,
2. commits the generated Markdown beside it,
3. re-reads both from GitHub and verifies the bytes and blob SHAs match what was sent.

Verification happens *after* the commit and before anything else. If it fails, nothing is
regenerated or overwritten — the mismatch is reported and the branch is left exactly as
GitHub has it.

## 7. Merge

**Merging is not part of visual-spec.** There is deliberately no merge route — the
operation is the one irreversible remote write, so it happens on github.com under GitHub's
own authentication and UI. Publish stops at commit-then-verify; you finish the pull
request the way you finish any other.

## Working with an agent

When a coding agent applies review comments in collaboration mode, it edits only the
canonical JSON, never the generated Markdown, and it cannot publish. It ends its run with
a single line:

```
READY TO PUBLISH: <documentPath>
```

That line is a signal to you, not a trigger — nothing consumes it. Publishing stays a
human act. When you see it, return to the browser and publish as in step 6.
