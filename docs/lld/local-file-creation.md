# Local File Creation and Rename — Low-Level Design

## Architecture

### The routes: one module, two hosts

- `POST /__vs/tree/create` — body `{ path: string }`
- `POST /__vs/tree/rename` — body `{ from: string, to: string }`

Both live in **`core/vite/routes/files.ts`**, a pure
`handleFilesRequest(store, comments, method, pathname, body)` returning
`{ status, json }`.

`core/vite/routes/` is **already** the host-agnostic route layer despite its name:
`src/server.ts` imports `routes/comments`, `routes/apply`, `routes/collab`,
`routes/collab-wiring` and `routes/upload` from it, and nothing under
`routes/` imports `vite`. The directory name is historical accident, not
dependency. Renaming it is a separate, breaking change — `core/vite/index.ts` is
a published entrypoint (`package.json` → `"./vite"`) — so instead this design
**freezes the property with a test**: `core/import-graph.ts` already exists for
exactly this kind of assertion, and gains one saying nothing under
`core/vite/routes/` reaches `'vite'`.

Wiring is **two** lines in the standalone host, not one. `src/server.ts:214-218`
dispatches `/__vs/tree` without parsing a body:

```ts
const r = await handleTree(tree, method, sub, query);   // no body
```

The Vite host's `middleware` helper always calls `readJsonBody` (`md-plugin.ts:79`).
Left as-is, `POST /__vs/tree/create` returns 400 "missing path" on the CLI and
works under Vite — R-2.3 violated on day one, and the unread request stream can
stall a keep-alive connection. `src/server.ts` therefore reads the body for
non-GET methods before delegating.

### Path resolution: string guard, then filesystem guard

`TreeStore.resolve` (`tree-store.ts:139-140`) validates with
`resolve(base, rel)` + `startsWith(base + sep)`. That already rejects absolute
paths and NUL bytes, so the create path does not restate them — it calls
`resolve` and treats the throw as the refusal.

What it does **not** cover is symlinks: the check is string-level, so a symlink
*inside* the served directory pointing outside passes it. For the read routes that
is a disclosure question that predates this work. For a route that runs
`mkdir -p` it is arbitrary directory creation outside the workspace.

`realpath(target)` cannot fix it — the target does not exist yet, so `realpath`
throws `ENOENT`. Calling it *after* `mkdir` is too late: `mkdir` has already
followed the symlink and created the directories. The correct check, before any
write:

1. Walk up from `dirname(abs)` to the deepest ancestor that exists.
2. `realpath` that ancestor and `realpath(base)`.
3. Refuse unless the first is `base` or under it.

This belongs beside `resolve` in `tree-store.ts` as a sibling `resolveForWrite`,
**not** in the handler. Two answers to "what may this server write" is precisely
what the shared-module rule exists to prevent.

### Create sequence

1. Trim; empty → 400.
2. No extension → append `.md`. Extension that is not `.md` → refuse, naming it.
   Appending is a convenience for `notes/kickoff`; silently rewriting
   `notes/kickoff.txt` discards what the user meant, so that is a refusal instead.
3. `store.resolveForWrite(path)` — string guard and symlink guard. Nothing has
   been written.
4. `stat` the target; existing → 409 with a message naming the collision.
5. `mkdir(dirname, { recursive: true })`.
6. `writeFile(abs, seed, { flag: 'wx' })`. `EEXIST` → the same 409.
7. `store.invalidate?.()`.
8. 200 `{ path, root }`.

Steps 4 and 6 are **both** collision checks and that is deliberate. `stat` produces
the human message; `wx` closes the window between the two syscalls, where two tabs
— or a tab and a terminal — can both see ENOENT and both write. The earlier draft
rejected `wx` on the grounds that it does not cover traversal or visibility, which
was never the claim: `wx` is the atomicity of the last line, and it sits *after*
every refusal, so the read-before-write ordering is intact.

Directories created in step 5 survive a step-6 failure. Accepted: an empty
directory is invisible in the tree and harmless.

### Rename sequence

1. Both `from` and `to` through step 2–3 above.
2. `from` must exist and be a regular file.
3. `link(from, to)` — fails `EEXIST` atomically, which is the whole reason it is
   used instead of `rename`. Node's `rename` **overwrites the destination
   silently**, and this feature must not be able to destroy a file.
4. `unlink(from)`.
5. **Rewrite the comment sidecar**: every record whose `target.path` equals `from`
   is rewritten to `to`, with every other field preserved.
6. `store.invalidate?.()`.

Step 5 is not incidental. Comments are pinned to `target.path`, so a rename
without it orphans the entire review of that document — the comments survive in
the sidecar pointing at a path that no longer exists, and the apply run cannot
resolve them. This is why the handler takes the comment store as an argument.

### The `TreeStore` cache

`tree-store.ts:125` sets `TREE_CACHE_TTL_MS = 3000` and `:147` serves the cached
walk. That cache is discarded **only** when the store is recreated (`setRoot`).

Without step 7, a successful create clears the *client* cache via
`invalidateTree()`, refetches immediately, and the server answers with the stale
walk — the new file is missing from the tree for up to three seconds,
non-deterministically. That is the "I created it and it vanished" failure arriving
by a different door.

`TreeStore` is published (`core/vite/index.ts` → `export * from './tree-store'`),
so adding a required method breaks external implementations. It gains an
**optional** one instead, following the precedent `CommentDocStore` already set in
`core/vite/routes/comments.ts`:

```ts
export interface TreeStore {
  tree(): Promise<TreeEntry[]>;
  file(path: string): Promise<FileContent>;
  resolve(path: string): string;
  /** Guarded absolute path for a target that does not exist yet. */
  resolveForWrite?(path: string): Promise<string>;
  /** Drop the cached walk. Absent → the route accepts the TTL. */
  invalidate?(): void;
}
```

### Unknown `/__vs` routes must 404, not serve the SPA

`src/server.ts:340` falls through to `serveStatic`, which falls back to
`index.html`. Any unmatched `/__vs/*` path therefore answers **200 with HTML**. A
new client against an old server gets `res.ok === true` and a JSON parse error
rather than a 404 it could report. A catch-all `if (url.pathname.startsWith('/__vs/'))
return sendJson(res, 404, …)` immediately before `serveStatic` fixes this route and
every future one. The Vite host needs the equivalent.

### Client

**`ui/file-tree.tsx`** gets both controls. Note the filter input lives in
`ui/App.tsx:269` and `FileTree` receives `filter` as a prop — the new controls go
in `FileTree`, and the "beside the filter" placement is a layout detail for
`App.tsx` to resolve.

Create: an inline path input in the tree column (not a modal — one field). Rename:
a per-row affordance opening an inline input prefilled with the current path.

On success → `invalidateTree()` then navigate. On failure → the server's message
rendered verbatim beneath the input, with the typed value kept. The refusals are
written to be read by a human; flattening them into "could not create file" throws
that away.

## Constraints

- **Node 18+, no new dependencies.**
- **Both hosts reach one module**, enforced by extending the existing
  `core/bundle-guard.test.ts` host-parity block (`:66-77`), which already asserts
  invariants by reading both hosts' source.
- **`.md` only** — a product restriction, not a security one.
- **The served root is mutable** (`POST /__vs/dir/pick`); the handler reads the
  current store per request, like `handleTree`. A root change *interleaved* with a
  request is not solved by that, so the 200 body returns the `root` it wrote
  under, letting the client detect the discrepancy instead of silently trusting it.
- **Local mode only.** The controls are in `FileTree`, which `CollabApp` does not
  mount.

## Key Decisions

**`stat` for the message, `wx` for the atomicity.** Rejected: `stat` alone
(TOCTOU) and `wx` alone (no human-readable collision message).

**`link` + `unlink` for rename, not `rename`.** Rejected: `fs.rename`, which
overwrites the destination without warning. The feature's guarantee is that it
cannot destroy a file, and `rename` cannot provide it.

**Rename rewrites comment paths.** Rejected: leaving the sidecar alone. Orphaned
comments are worse than no rename.

**Refuse a non-`.md` extension; append `.md` when there is none.** Rejected:
rewriting any extension to `.md`.

**Accept creation into ignored paths.** Rejected: refusing them, which needs a new
visibility API on `TreeStore` and protects against a case where the user is looking
at the file they just made.

**Symlink guard as `resolveForWrite` in `tree-store.ts`.** Rejected: doing it in
the handler.

**Optional interface members.** Rejected: adding required ones to a published type.

**No cross-tab broadcast.** Rejected: pushing a tree-changed frame everywhere.

## Out of Scope

- Delete, move-to-trash, duplicate.
- Renaming directories.
- Non-Markdown files.
- Creating empty directories.
- Creating a collaboration document (`POST /__vs/collab/start`).
- Configurable seed templates.
- Cross-tab tree invalidation.
- Renaming the `core/vite/routes/` directory to match what it actually is —
  deferred to an ADR, frozen meanwhile by an import-graph test.
