/**
 * collab-open-panel.tsx — the reviewer's way in (R-11.2, R-11.4, R-11.5).
 *
 * A reviewer arrives holding a pull request link and, from the PR body, the document id
 * (`--document <id>` in the copyable command 8.2 writes). This panel turns those two into
 * a `POST /__vs/collab/open` and reports what happened in the reviewer's own words.
 *
 * THE FORM IS NO LONGER THE FIRST THING ANYONE SEES. It used to lead the collaboration
 * surface, asking for a pull request URL *and* a document id typed by hand — while
 * `CollabPullsPanel` sat underneath it holding both, as buttons, for every open pull
 * request, because the server resolves `documentId` from the pull request body (R-7.4).
 * Asking someone to type what the page already knows is a worse first screen than the
 * list. So the list leads, and this form folds into a disclosure labelled for the case it
 * is genuinely the only answer to: a pull request that is not in this repository's
 * listing. Nothing is removed — expanded, it posts exactly what it always did.
 *
 * IT NO LONGER CREATES ANYTHING. A "New document" form used to sit here and post
 * `POST /__vs/collab/start` with an *empty* body, creating a branch and a pull request
 * for a document nobody had written yet. Two things were wrong with it. It made the
 * author's first act a publish, when the whole point of the local sidecar is to draft
 * first and share when ready; and it was the second create path in the product, on a
 * screen only reviewers ever open — the author's own is `StartPullRequestButton` in the
 * main header, which commits the file they have actually written, at the path it already
 * has. Creating a *file* is `+ New file` in the tree. Neither of those is here, and this
 * panel is one job again: turning a pull request reference into a mounted document.
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
import { useEffect, useMemo, useState } from 'react';

import { type CollabAvailabilitySnapshot, createCollabClient } from './collab-client';
import { BusyLabel } from './spinner';

export type { CollabAvailabilitySnapshot };

export type CollabOpenPanelProps = {
  /** Called with the document id once the open job has been accepted. */
  onOpened?: (documentId: string) => void;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

/** Half a repository name, as GitHub spells one, and as the route layer re-checks it. */
const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * A pull request reference as a reviewer typed it: always a number, and a repository when
 * whatever they pasted carried one.
 *
 * `repo: null` IS NOT "THE CONFIGURED REPOSITORY" (R-W4.2 / R-W4.3). It is "this reference
 * named none", which is a different fact and is the only one a parser can know. What to
 * apply in its place — the configured repository, or a refusal because there is none — is
 * `repositoryForReference`'s question, one layer up, where the session is visible.
 */
export type PullRequestReference = {
  pullNumber: number;
  repo: { owner: string; repo: string } | null;
};

/**
 * Accept the shapes a reviewer actually has to hand: a pull request URL copied from the
 * browser, `#42`, or `42`. `null` when none of them parses, so the panel can say so
 * rather than posting a nonsense request.
 *
 * THE URL CARRIES A REPOSITORY, AND IT USED TO BE THROWN AWAY (R-W4.1). The pattern was
 * `/\/pull\/(\d+)/` — the digits and nothing else — so a link to `facebook/react#37256`
 * pasted into a server started for `vitejs/vite` opened `vitejs/vite#37256`. It answered
 * "unknown document", naming a document and never a repository, which is the wrong-
 * repository confusion this panel's own label ("a pull request in another repository")
 * promised to solve and could not.
 *
 * A MALFORMED REPOSITORY IN A URL IS A REFUSAL, NOT A BARE NUMBER. Falling back to "no
 * repository named" for `https://github.com/../react/pull/1` would apply the configured
 * repository to a reference that plainly meant another one — the substitution R-W3.1
 * forbids, arrived at by way of a lenient parser. The patterns above are the browser-side
 * half of that; the route layer decodes and re-checks its own segments regardless (R-W3.7),
 * because nothing typed here is trusted over there.
 */
export function parsePullRequestReference(input: string): PullRequestReference | null {
  const text = input.trim();
  if (!text) return null;
  const number = (digits: string | undefined, repo: PullRequestReference['repo']): PullRequestReference | null => {
    if (!digits) return null;
    const n = Number(digits);
    return Number.isSafeInteger(n) && n > 0 ? { pullNumber: n, repo } : null;
  };
  // Anything with a `/pull/<n>` in it is a link, whatever host it came from — the two
  // segments before it are the repository. A link whose shape is right and whose
  // repository is not is refused rather than downgraded to a bare number.
  const fromUrl = /(?:^|\/)([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(text);
  if (fromUrl) {
    const [, owner, repo, digits] = fromUrl as unknown as [string, string, string, string];
    if (!OWNER_RE.test(owner) || !REPO_NAME_RE.test(repo) || repo === '.' || repo === '..') return null;
    return number(digits, { owner, repo });
  }
  return number(/^#?(\d+)$/.exec(text)?.[1], null);
}

/**
 * Which repository a parsed reference is about — the one it named, or the session's.
 *
 * R-W4.3 is the third arm and the reason this is a function rather than a `??`: a
 * reference that names no repository, in a session that has none either, is not a request
 * to be sent and guessed at. It is a thing to say out loud, before anything is attempted,
 * naming what the reviewer can do about it.
 */
export function repositoryForReference(
  reference: PullRequestReference,
  availability: CollabAvailabilitySnapshot | null,
): { ok: true; repo: { owner: string; repo: string } | null } | { ok: false; message: string } {
  // Named in the link: it wins outright, including over a configured repository that
  // differs from it. That is the whole of R-W4.1.
  if (reference.repo) return { ok: true, repo: reference.repo };
  // R-W4.2 — a bare number applies the configured repository, and it does so by saying
  // nothing: `repo: null` sends the legacy route form, which is where that rule lives
  // (R-W3.2). Restating it in the path here would be a second place for it to be wrong.
  if (availability?.available === true) return { ok: true, repo: null };
  return {
    ok: false,
    message:
      'The repository is unknown: this reference is a bare pull request number and this session has no repository ' +
      'to apply to it. Paste the full pull request URL instead, e.g. https://github.com/owner/repo/pull/42.',
  };
}

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string } | { kind: 'ok'; message: string };

export function CollabOpenPanel({ onOpened, fetchImpl }: CollabOpenPanelProps) {
  // One contract, not two. Issuing these routes with an inline `fetch` here is what left
  // `availability`, `open` and `start` on `CollabClient` with no caller — a typed surface
  // and a hand-rolled copy of it, only one of which the tests covered.
  const client = useMemo(() => createCollabClient(fetchImpl), [fetchImpl]);
  const [availability, setAvailability] = useState<CollabAvailabilitySnapshot | null>(null);
  const [reference, setReference] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  /** The manual form, collapsed until someone has the case it exists for. */
  const [byUrlOpen, setByUrlOpen] = useState(false);

  useEffect(() => {
    let live = true;
    void client.availability().then((res) => {
      if (!live) return;
      // The route answers 200 with `available: false` when collaboration is off, so an
      // `ok` result already carries both outcomes.
      if (res.ok) {
        setAvailability(res.value);
        return;
      }
      // The request never reached the route layer, so this is not a preflight verdict
      // and must not borrow one: `message` is the only field rendered, and a bare
      // "Failed to fetch" would sit where `gh` remediation text goes.
      setAvailability({
        available: false,
        reason: 'request_failed',
        message: `Could not reach the visual-spec server to check your GitHub identity. Confirm it is still running, then reload. (${res.message})`,
      });
    });
    return () => {
      live = false;
    };
    // The availability probe is per-mount: it is memoized server-side per repo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function open() {
    const parsed = parsePullRequestReference(reference);
    if (parsed === null) {
      setStatus({ kind: 'error', message: 'Enter a pull request URL or number, e.g. https://github.com/acme/docs/pull/42 or 42.' });
      return;
    }
    // R-W4.3 — decided before the document id is even looked at, because "which
    // repository" is the question that has to be answerable for any of the rest to mean
    // anything. Nothing is posted when it is not.
    const where = repositoryForReference(parsed, availability);
    if (!where.ok) {
      setStatus({ kind: 'error', message: where.message });
      return;
    }
    const pullNumber = parsed.pullNumber;
    const id = documentId.trim();
    if (!id) {
      setStatus({ kind: 'error', message: 'Enter the document id — the PR body names it as `--document <id>`.' });
      return;
    }
    setStatus({ kind: 'busy' });
    // The server's own words either way — a 503 carries the availability message (R-7.8),
    // a 4xx carries `error`, and a dead server carries `fetch`'s. `failureOf` already
    // applies exactly that precedence, so nothing is flattened into "could not open".
    const res = await client.open({ documentId: id, pullNumber, ...(where.repo ? { repo: where.repo } : {}) });
    if (!res.ok) {
      setStatus({ kind: 'error', message: res.message });
      return;
    }
    // The repository is in the sentence whenever the reference named one, so a link
    // pasted from the wrong tab is visible in the confirmation rather than twenty minutes
    // into reading it.
    const from = where.repo ? `${where.repo.owner}/${where.repo.repo}#${pullNumber}` : `#${pullNumber}`;
    setStatus({ kind: 'ok', message: `Opening ${id} from ${from}…` });
    onOpened?.(id);
  }

  return (
    <section data-vs-collab-open style={wrap}>
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

      {(status.kind === 'error' || status.kind === 'ok') && (
        <p data-vs-collab-status style={status.kind === 'error' ? error : note}>
          {status.message}
        </p>
      )}

      <hr style={rule} />
      {/*
        The fallback, said as one. The list above answers this repository; this answers a
        pull request that is not in it — which is the only case where typing the URL and
        the document id by hand is the shortest route rather than the longest.
      */}
      <button
        type="button"
        onClick={() => setByUrlOpen((v) => !v)}
        aria-expanded={byUrlOpen}
        aria-controls="vs-collab-open-by-url"
        style={disclosure}
      >
        <span aria-hidden="true">{byUrlOpen ? '▾' : '▸'}</span> Open a document from a pull request URL — for a pull
        request in another repository
      </button>

      {byUrlOpen && (
        <div id="vs-collab-open-by-url" style={disclosureBody}>
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
            <BusyLabel busy={status.kind === 'busy'}>{status.kind === 'busy' ? 'Opening…' : 'Open'}</BusyLabel>
          </button>
        </div>
      )}
    </section>
  );
}

const wrap: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, maxWidth: 520 };
const identity: React.CSSProperties = { fontSize: 12, color: '#64748b', margin: 0 };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };
const label: React.CSSProperties = { fontSize: 11, color: '#64748b', width: 92, flexShrink: 0 };
const input: React.CSSProperties = { font: '12px ui-monospace, monospace', padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4, flex: 1 };
const button: React.CSSProperties = { font: '12px system-ui, sans-serif', padding: '4px 10px', border: '1px solid #d1d5db', borderRadius: 4, background: 'white', color: '#334155', alignSelf: 'flex-start' };
const rule: React.CSSProperties = { border: 0, borderTop: '1px solid #e5e7eb', margin: '4px 0 0' };
/** A disclosure, not a heading: it is a control, so it looks and behaves like one. */
const disclosure: React.CSSProperties = {
  font: '12px system-ui, sans-serif',
  textAlign: 'left',
  padding: '6px 8px',
  border: '1px solid #e5e7eb',
  borderRadius: 6,
  background: '#f8fafc',
  color: '#475569',
  cursor: 'pointer',
};
const disclosureBody: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 8px 0' };
const note: React.CSSProperties = { fontSize: 12, color: '#0f766e', margin: 0 };
const error: React.CSSProperties = { fontSize: 12, color: '#b91c1c', margin: 0 };
