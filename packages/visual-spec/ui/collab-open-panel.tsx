/**
 * collab-open-panel.tsx — the reviewer's way in (R-11.2, R-11.4, R-11.5).
 *
 * A reviewer arrives holding a pull request link and, from the PR body, the document id
 * (`--document <id>` in the copyable command 8.2 writes). This panel turns those two into
 * a `POST /__vs/collab/open` and reports what happened in the reviewer's own words.
 *
 * IT SHOWS WHO THEY ARE BEFORE THEY WRITE ANYTHING (R-11.5). `GET /__vs/collab` carries
 * the login the 4.2 preflight resolved from the credential the *server* holds — which is
 * not necessarily the account the reviewer is signed into on github.com. Comments are
 * attributed to that login, so it is stated up front rather than discovered afterwards in
 * the PR thread.
 *
 * IT NEVER TALKS TO GITHUB (R-7.7). Both calls are to `/__vs/collab`; every GitHub touch
 * happens server-side behind those routes. There is no token here to have.
 *
 * The error text is the server's own (R-11.4): this component never rewrites a failure
 * into a generic one, which is the whole point of `OpenDocumentError`'s taxonomy.
 *
 * IT IMPORTS NOTHING FROM `core/collaboration/`. Reaching `core/collaboration/open.ts`
 * for `parsePullRequestReference` would pull `github-executor.ts` — and with it
 * `node:child_process` — into the browser bundle. Parsing what a human typed is a
 * browser concern anyway, so it lives here; the *machine* format (the PR trailer, the
 * printed command) stays in core, where its round trip with 8.2 is asserted.
 */
import { useEffect, useState } from 'react';

/** The `CollabAvailability` shape `GET /__vs/collab` serves (`core/vite/routes/collab.ts`). */
export type CollabAvailabilitySnapshot =
  | {
      available: true;
      login: string;
      repo: { owner: string; repo: string };
      scopes?: readonly string[];
      /** R-9.7 as a hint. Absent means the server could not determine it — say nothing. */
      canPublish?: boolean;
      /** R-12.5 — why, when `canPublish` is false. The server owns the wording. */
      publishBlocked?: { reason: 'no_write_access' | 'no_repo'; message: string };
    }
  | { available: false; reason: string; message: string };

export type CollabOpenPanelProps = {
  /** Called with the document id once the open job has been accepted. */
  onOpened?: (documentId: string) => void;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

/**
 * Accept the shapes a reviewer actually has to hand: a pull request URL copied from the
 * browser, `#42`, or `42`. `null` when none of them parses, so the panel can say so
 * rather than posting a nonsense request.
 */
export function parsePullRequestReference(input: string): number | null {
  const text = input.trim();
  if (!text) return null;
  const fromUrl = /\/pull\/(\d+)/.exec(text);
  const digits = fromUrl ? fromUrl[1] : /^#?(\d+)$/.exec(text)?.[1];
  if (!digits) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string } | { kind: 'ok'; message: string };

export function CollabOpenPanel({ onOpened, fetchImpl }: CollabOpenPanelProps) {
  const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const [availability, setAvailability] = useState<CollabAvailabilitySnapshot | null>(null);
  const [reference, setReference] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [newId, setNewId] = useState('');
  const [newTitle, setNewTitle] = useState('');

  useEffect(() => {
    let live = true;
    void doFetch('/__vs/collab')
      .then((res) => res.json() as Promise<CollabAvailabilitySnapshot>)
      .then((snapshot) => {
        if (live) setAvailability(snapshot);
      })
      .catch((err: unknown) => {
        // The request never reached the server, so this is not a preflight verdict
        // and must not borrow one: `message` is the only field rendered, and a bare
        // "Failed to fetch" would sit where `gh` remediation text goes.
        if (live)
          setAvailability({
            available: false,
            reason: 'request_failed',
            message: `Could not reach the visual-spec server to check your GitHub identity. Confirm it is still running, then reload. (${(err as Error).message})`,
          });
      });
    return () => {
      live = false;
    };
    // The availability probe is per-mount: it is memoized server-side per repo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function open() {
    const pullNumber = parsePullRequestReference(reference);
    if (pullNumber === null) {
      setStatus({ kind: 'error', message: 'Enter a pull request URL or number, e.g. https://github.com/acme/docs/pull/42 or 42.' });
      return;
    }
    const id = documentId.trim();
    if (!id) {
      setStatus({ kind: 'error', message: 'Enter the document id — the PR body names it as `--document <id>`.' });
      return;
    }
    setStatus({ kind: 'busy' });
    try {
      const res = await doFetch('/__vs/collab/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documentId: id, pullNumber }),
      });
      const json = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) {
        // The server's own words — a 503 carries the availability message (R-7.8), a 4xx
        // carries `error`. Neither is flattened into "could not open".
        setStatus({ kind: 'error', message: json.error ?? json.message ?? `Open failed (HTTP ${res.status}).` });
        return;
      }
      setStatus({ kind: 'ok', message: `Opening ${id} from #${pullNumber}…` });
      onOpened?.(id);
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    }
  }

  /**
   * R-8.5 — create the branch and the pull request for a document that does not exist
   * yet. This is the author's entry; `open` above is the reviewer's.
   *
   * No `doc` is sent. `markdownToInjectable` is forbidden on the collaboration path
   * (it reparses Markdown and drops every `nodeId`), so the browser has no way to author
   * starting content — the server seeds a valid empty document and the author fills it
   * in the editor before the first publish.
   */
  async function create() {
    const id = newId.trim();
    if (!id) {
      setStatus({ kind: 'error', message: 'Enter a document id — it names the branch and the file, e.g. doc-1.' });
      return;
    }
    setStatus({ kind: 'busy' });
    try {
      const title = newTitle.trim();
      const res = await doFetch('/__vs/collab/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          documentId: id,
          // The path `fsDocumentStore` already uses, so the committed artifact and the
          // local copy agree without the author having to know either convention.
          documentPath: `documents/${id}.json`,
          ...(title ? { title, frontmatter: { title } } : {}),
        }),
      });
      const json = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) {
        // Same rule as `open`: the server's own words. A reviewer's credential is
        // refused here by `authorize` with a message naming write access.
        setStatus({ kind: 'error', message: json.error ?? json.message ?? `Create failed (HTTP ${res.status}).` });
        return;
      }
      setStatus({ kind: 'ok', message: `Creating ${id} — opening a pull request…` });
      onOpened?.(id);
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    }
  }

  return (
    <section data-vs-collab-open style={wrap}>
      <h2 style={heading}>Open a document from a pull request</h2>

      {/* R-11.5 — who the comments will be from, stated before any are written. */}
      <p data-vs-collab-identity style={identity}>
        {availability === null
          ? 'Checking your GitHub identity…'
          : availability.available
            ? `Signed in as ${availability.login} — comments you leave here are posted to ${availability.repo.owner}/${availability.repo.repo} as ${availability.login}.`
            : availability.message}
      </p>

      {/*
        R-9.7 — a reviewer's credential cannot publish, and the honest place to say so is
        here, before they open anything. Rendered only for a definite `false`: absent
        means the server could not determine write access, and guessing either way is
        worse than silence.
      */}
      {availability?.available === true && availability.canPublish === false && (
        <p data-vs-collab-role style={identity}>
          {/*
            R-12.5 — the server distinguishes "no write grant" from "no such repo" and
            owns the remediation wording, so render it verbatim when it is there. The
            literal below is the pre-12.2 sentence, kept for a server that sends only
            the boolean.
          */}
          {availability.publishBlocked?.message ??
            `This is a review-only session: your credential has no write access to ${availability.repo.owner}/${availability.repo.repo}, so you can comment and reply but not publish. Publishing is the document author's to do.`}
        </p>
      )}

      <label style={row}>
        <span style={label}>Pull request</span>
        <input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="https://github.com/owner/repo/pull/42"
          style={input}
        />
      </label>
      <label style={row}>
        <span style={label}>Document id</span>
        <input value={documentId} onChange={(e) => setDocumentId(e.target.value)} placeholder="doc-1" style={input} />
      </label>

      <button
        type="button"
        onClick={() => void open()}
        disabled={status.kind === 'busy' || availability?.available === false}
        style={button}
      >
        {status.kind === 'busy' ? 'Opening…' : 'Open'}
      </button>

      {(status.kind === 'error' || status.kind === 'ok') && (
        <p data-vs-collab-status style={status.kind === 'error' ? error : note}>
          {status.message}
        </p>
      )}

      {/*
        The author's half. Rendered only when the credential can actually publish:
        `create` is author-only (`OPERATION_POLICY`), so offering it to a reviewer would
        be a control that exists to be refused. Absent `canPublish` means the server
        could not determine write access — the form is shown, because hiding it on an
        unknown would strand an author who is merely offline from the permission probe,
        and the route refuses server-side regardless (R-9.11).
      */}
      {availability?.available === true && availability.canPublish !== false && (
        <>
          <hr style={rule} />
          <h2 style={heading}>Start a new document</h2>
          <p style={identity}>
            Creates the branch <code>visual-spec/&lt;id&gt;</code>, commits an empty document and opens a pull request.
            You write it in the editor, then publish.
          </p>

          <label style={row}>
            <span style={label}>New document id</span>
            <input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="payment-rules" style={input} />
          </label>
          <label style={row}>
            <span style={label}>Title</span>
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Optional — defaults to the document id"
              style={input}
            />
          </label>

          <button type="button" onClick={() => void create()} disabled={status.kind === 'busy'} style={button}>
            {status.kind === 'busy' ? 'Creating…' : 'Create pull request'}
          </button>
        </>
      )}
    </section>
  );
}

const wrap: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, maxWidth: 520 };
const heading: React.CSSProperties = { font: '600 13px/1.4 system-ui, sans-serif', color: '#334155', margin: 0 };
const identity: React.CSSProperties = { fontSize: 12, color: '#64748b', margin: 0 };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };
const label: React.CSSProperties = { fontSize: 11, color: '#64748b', width: 92, flexShrink: 0 };
const input: React.CSSProperties = { font: '12px ui-monospace, monospace', padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4, flex: 1 };
const button: React.CSSProperties = { font: '12px system-ui, sans-serif', padding: '4px 10px', border: '1px solid #d1d5db', borderRadius: 4, background: 'white', color: '#334155', alignSelf: 'flex-start' };
const rule: React.CSSProperties = { border: 0, borderTop: '1px solid #e5e7eb', margin: '4px 0 0' };
const note: React.CSSProperties = { fontSize: 12, color: '#0f766e', margin: 0 };
const error: React.CSSProperties = { fontSize: 12, color: '#b91c1c', margin: 0 };
