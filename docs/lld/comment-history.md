# Comment History — Low-Level Design

## Architecture

The feature threads a single new field through the existing comment pipeline and
adds one read-only UI surface with two entry points. No new store, no new backend
job.

### Data model — `core/editing/comment-doc.ts`

- Add one optional field to `CommentRecord`:
  ```ts
  result?: string; // short summary of the resulting change, set when applied
  ```
- `parseDoc`/`upgrade()` preserves `result` **only for new-shape records** (those
  with a `target` object): `comment-doc.ts:60-61` does `{ workflow: …, ...rec }`,
  so `result` survives. The **legacy** `{file, anchor}` branch (`comment-doc.ts:77-87`)
  reconstructs the record field-by-field and would **drop** `result`. Required
  change: add `...(rec.result ? { result: rec.result } : {})` to the legacy
  reconstruction so R-2.2 holds unconditionally. (Legacy records have no `result`
  today, so severity is low — but the "no change to upgrade" assumption was wrong.)
- **Required code change (does not exist today):** extend the pure setter so the
  result is written atomically with the status flip. `comment-doc.ts:114` is
  currently `setStatus(doc, id, status)` and its `.map` at :117 spreads
  `{ ...c, status }` — it will not write `result` until both the signature and body
  change:
  ```ts
  setStatus(doc, id, status, result?): CommentDoc // writes result when provided
  ```
  Applied comments = `status === 'applied'`; the history list is derived by
  filtering, no separate collection.

### Write path — the apply run authors the summary

- `core/editing/apply-prompt.ts` (`buildApplyPrompt`): extend the instruction so
  that, when the agent sets a comment's status to `applied` in
  `visual-spec-comments.json`, it **also writes a `result` field** on that record —
  a 1–2 line summary of the user's request and what changed / where it was handed
  off. The prompt MUST pin the write contract: write `result` as a string on the
  **same record**, in the **same edit** as `status`, **preserve all other existing
  fields**, and keep the JSON valid. The agent already edits the sidecar directly
  (the skill's step 4), so no new HTTP call is required for the write.
- **Data-integrity risk (agent-writes-JSON):** if the agent writes malformed JSON,
  `fileCommentStore.read()` swallows the parse error and returns an **empty doc**
  (`comments.ts:34-38`) — silently dropping **every** comment, not just the summary.
  The prompt contract above (preserve fields, valid JSON) is the primary guard; the
  server fallback re-reads after the run and would surface a wiped doc as zero
  applied. A safer alternative write channel is the `PATCH …/{id}` route (below).
- **Server fallback (reliability net):** `runApply` (`apply.ts:210-216`) already
  re-reads the sidecar after the run and diffs by status to compute
  `appliedComments`. Extend it so that any comment that flipped to `applied` but has
  **no** `result` gets a minimal server-stamped summary (e.g. from the `done`-event
  text, or a literal "Applied (no summary recorded)") written via `setStatus`. This
  guarantees the happy path is never blank without trusting the agent alone.
- `core/vite/routes/apply.ts`: `AppliedComment` and the `done` event MAY carry the
  new `result` (read back from the sidecar) so the post-run `AppliedList` shows the
  summary immediately. Optional; the durable source is the sidecar.
- **Required code change:** `core/vite/routes/comments.ts` — the `PATCH
  /__vs/comments/{id}` handler currently calls `setStatus(doc, id, body.status)`
  (`comments.ts:122`) and passes **no** result. Forward `body.result` so a
  programmatic apply, the server fallback, or a manual correction can set the
  summary via the API.

### Read path — history is already fetchable

- `GET /__vs/comments?path=<path>` → `listComments(doc, path)` filters by path
  **only**, returning every status. So `useComments(path).comments` already
  contains applied records; the UI derives the two lists by status. No new
  endpoint is needed for the per-document panel.
- `GET /__vs/comments/all` already returns the whole doc for the header/project view.

### UI — one history view, two entry points

- `ui/comment-panel.tsx` (`CommentPanel`): add a **History** tab/toggle beside the
  existing open list. The open list keeps its filter (`status === 'open'`); the new
  history list filters `status === 'applied'` for the same `path`, ordered by `ts`
  most-recent-first, rendered as a separate list showing, per entry: heading/line
  anchor (falling back to `path` when absent), the `comment` (request), the `result`
  (summary, "—" when absent), and `ts`. Empty documents show a defined empty state.
  Reuses the "Locate" affordance.
- `ui/main-header.tsx`: add a header entry (button) that opens the comment history
  for the current document. `MainHeader` is mounted once at `App.tsx:107`
  independent of `mode`, so it is the primary entry point in **edit** mode, where
  `MarkdownDocEditor` (`App.tsx:116`) does **not** mount `CommentPanel` (only the
  view-mode `MarkdownEditor` does, `markdown-editor.tsx:33`). Note `MainHeader`
  currently calls `useComments()` **no-arg** (`main-header.tsx:651`), which returns
  **all files'** comments; the header history view MUST additionally filter by the
  current `file`/`path` (received at `main-header.tsx:637`) to stay document-scoped
  per R-4.2.
- Both surfaces are read-only views over the same `useComments` / sidecar data;
  cross-tab refresh already flows through the existing `vs:comments-changed` event
  and window-focus refetch in `use-comments.ts`.

### Data flow (apply → history)

```
open comment ──apply run (buildApplyPrompt)──▶ agent edits file
                                              └▶ agent writes {status:"applied", result:"…"} into sidecar
sidecar (visual-spec-comments.json)  ──GET /__vs/comments?path──▶ useComments
                                                                   ├─ status==='open'  → open list
                                                                   └─ status==='applied' → HISTORY list (panel tab + header entry)
```

## Constraints

- **Single JSON sidecar** stays the only store; pure functions in `comment-doc.ts`
  own the shape, the route owns I/O.
- **Backward compatibility**: records without `result` must render (empty/"—").
- **The write is agent-authored free text**: the summary quality depends on the
  apply agent following the prompt; the system must not break if `result` is
  missing (agent skipped it, older run, or hand-off with no summary).
- **No new server job or SSE stream** — reuse `useComments`, the existing comment
  routes, and the existing cross-tab refresh.
- Stack unchanged: Vite + React UI, Node route handlers, `claude -p` headless apply.

## Key Decisions

- **Store the summary on the comment record (`result`), not in a separate log.**
  The sidecar already retains applied comments as the audit trail; one optional
  field is the minimal change and keeps history = a filtered view. (Rejected: a
  separate history/events file — more moving parts, duplicate identity.)
- **The apply agent writes the summary, backed by a server fallback.** The agent
  already produces a traceability table and knows exactly what it changed, so
  writing the field directly into the sidecar it is already editing avoids brittle
  server-side free-text parsing. The tradeoff is that correctness then depends on an
  LLM following a prose instruction — and a bad write can corrupt the whole sidecar
  (see Data-integrity risk). We accept this because (a) the prompt pins a strict
  write contract, and (b) the server fallback in `runApply` stamps a minimal
  `result` for any comment applied without one, so history is never blank. (Rejected:
  server parses the free-form `result` event text as the primary source.)
- **History is a derived filter (`status === 'applied'`), shown as a separate
  list.** No new status value, no data migration; matches the user's "historic
  comments on a different list." (Rejected: a new `status` state for history.)
- **Two entry points reuse one view.** The panel tab covers the viewer; the header
  entry covers the editor (where the panel may be absent) and offers a roomier
  document-level view. Both render the same applied-comment data.
- **Read path needs no new endpoint** — `listComments(doc, path)` already returns
  all statuses for a path.

## Out of Scope

- Soft-delete / a `deleted` status and its audit entries.
- Editing or regenerating a `result` summary from the UI after the fact.
- A global cross-document history dashboard (the header entry is scoped to the
  current document; `/__vs/comments/all` remains available if a project-wide view
  is added later).
- Persisting the full apply activity feed / tool-call log per comment.
