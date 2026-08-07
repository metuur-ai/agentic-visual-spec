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
  | { available: true; login: string; repo: { owner: string; repo: string }; scopes?: readonly string[] }
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
const note: React.CSSProperties = { fontSize: 12, color: '#0f766e', margin: 0 };
const error: React.CSSProperties = { fontSize: 12, color: '#b91c1c', margin: 0 };
