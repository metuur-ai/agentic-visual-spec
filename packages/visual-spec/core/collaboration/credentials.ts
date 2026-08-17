/**
 * credentials.ts — the collaboration preflight (R-9.1 / R-9.2 / R-9.3 / R-9.4 /
 * R-9.12 / R-9.19 / R-4.10).
 *
 * NO TOKEN VALUE LEAVES THIS MODULE, AND ONLY ONE FUNCTION READS ONE.
 * `GH_TOKEN` / `GITHUB_TOKEN` are probed for *presence* only everywhere except
 * `credentialFingerprint`, which reads the value, hashes it immediately, and
 * returns only the digest. The plaintext is never stored in module state, never
 * returned to a caller, and never logged, so it still cannot be serialized into
 * a response body, an SSE frame or the client bundle (R-9.2). The digest is
 * truncated SHA-256 and is safe to hold: it is used solely as a cache key, and
 * is not a credential — it cannot authenticate anything. On a dev machine the real credential
 * is usually a keyring OAuth token that has no env var at all — that case is
 * handled identically, because the credential is only ever exercised by `gh`
 * itself through the `GhExecutor` seam (`defaultExecGh` passes `process.env`
 * straight through, so the token never appears in argv either).
 *
 * SCOPES COME FROM `gh api -i /user`, NOT FROM `gh auth status`. The executor is
 * buffered and hands back stdout/stderr as opaque strings, so the only reliable
 * channel is machine-readable text on stdout: `-i` prints the response headers
 * ahead of the body, and `X-OAuth-Scopes` is a stable GitHub API contract.
 * `gh auth status` prints a human-formatted table whose wording and stream
 * (stdout vs stderr) have both moved across `gh` releases, and it cannot resolve
 * the identity in the same call. One `gh api -i /user` yields availability,
 * identity and scopes together.
 *
 * `core/` is Node-reachable from the CLI, so this module imports only node
 * builtins and sibling core modules — no Luthor, no react.
 */
import { createHash } from 'node:crypto';

import type { ResolvedCollaborationConfig } from '../config';
import { type GhExecutor, defaultExecGh, scrubCredentials } from './github-executor';

/** Where the credential `gh` will use came from. Never the credential itself. */
export type CredentialSource = 'environment' | 'gh-auth-state';

/** Why collaboration is not available. */
export type PreflightFailureReason =
  /** `gh` could not be executed at all (R-4.10). */
  | 'executor_unavailable'
  /** `gh` ran but is not authenticated (R-9.19). */
  | 'no_credential'
  /** Authenticated, but the credential lacks a required scope (R-9.12). */
  | 'missing_scope'
  /** `gh` failed for any other reason. */
  | 'preflight_failed';

/**
 * R-9.2 — the success shape carries identity, scopes and availability. There is
 * deliberately no token field: callers cannot leak what they were never given.
 */
export type PreflightOk = {
  available: true;
  source: CredentialSource;
  /** Minimal identity: the authenticated login. Role classification is task 9.2. */
  login: string;
  /** Scopes GitHub reported for the credential. */
  scopes: readonly string[];
  repo: ResolvedCollaborationConfig;
};

export type PreflightUnavailable = {
  available: false;
  reason: PreflightFailureReason;
  /** Actionable, scrubbed, and safe to show a user (R-4.10 / R-9.3). */
  message: string;
  /** Populated only for `missing_scope`; names each absent scope (R-9.12). */
  missingScopes: readonly string[];
};

export type CollaborationPreflight = PreflightOk | PreflightUnavailable;

export type PreflightOptions = {
  /** R-9.4 — owner / repo / base branch. */
  repo: ResolvedCollaborationConfig;
  /** Scopes the session's role needs. Defaults to `['repo']`. */
  requiredScopes?: readonly string[];
  /** R-4.8 / R-12.3 — injectable; tests replay recorded `gh` output. */
  exec?: GhExecutor;
  /** Probed for key *presence* only by the preflight itself; values are never read here. */
  env?: Record<string, string | undefined>;
};

/** Env vars `gh` honours as an explicit credential override. */
const TOKEN_ENV_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;

/**
 * A non-reversible identity for whichever credential `gh` will use, for cache keying
 * only (task 9.x / U-6). Callers memoize preflight results; without this, a key built
 * from `owner/repo#base` alone lets a credential swap keep resolving the *previous*
 * login out of the cache for the life of the entry.
 *
 * THIS IS THE ONLY PLACE A TOKEN VALUE IS READ. It is hashed on the spot and the
 * plaintext is never bound beyond this function's scope. Callers receive a digest.
 *
 * KNOWN GAP: this closes the *environment* half only. `gh auth switch` rewrites `gh`'s
 * own config file and touches no env var, so it produces an identical fingerprint and
 * a swap is still invisible until the entry expires. Observing that reliably means
 * shelling out to `gh` — which is the preflight itself, so caching it would be
 * self-defeating. The TTL is the bound for that case, deliberately.
 */
export function credentialFingerprint(env: Record<string, string | undefined> = process.env): string {
  for (const key of TOKEN_ENV_KEYS) {
    const value = env[key];
    if (value) return `${key}:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
  }
  // No env override: `gh`'s own auth state governs, and it is opaque from here.
  return 'gh-auth-state';
}

/** The default role scope: pushing a branch and reading the PR both need `repo`. */
const DEFAULT_REQUIRED_SCOPES = ['repo'] as const;

/**
 * Coarser scopes GitHub treats as covering a finer one. Only the handful the
 * collaboration flow can plausibly ask for — this is not the whole OAuth table.
 */
const IMPLIED_BY: Record<string, readonly string[]> = {
  public_repo: ['repo'],
  'repo:status': ['repo'],
  'read:org': ['write:org', 'admin:org'],
  'write:org': ['admin:org'],
};

/** Does `granted` satisfy `required`, directly or through a coarser scope? */
function grants(granted: ReadonlySet<string>, required: string): boolean {
  if (granted.has(required)) return true;
  return (IMPLIED_BY[required] ?? []).some((coarser) => granted.has(coarser));
}

/**
 * Presence check only (R-9.1 / R-9.2). Reading `env[key]` would pull the secret
 * into this process's memory for no benefit — `gh` already has it.
 */
function credentialSource(env: Record<string, string | undefined>): CredentialSource {
  const fromEnv = TOKEN_ENV_KEYS.some((key) => (env[key] ?? '').length > 0);
  return fromEnv ? 'environment' : 'gh-auth-state';
}

type InclusiveResponse = { status: number | undefined; headers: Map<string, string>; body: string };

/** Split `gh api -i` output into its status line, headers and body. */
function parseInclusive(stdout: string): InclusiveResponse {
  const normalized = stdout.replace(/\r\n/g, '\n');
  const split = normalized.indexOf('\n\n');
  const head = split === -1 ? normalized : normalized.slice(0, split);
  const body = split === -1 ? '' : normalized.slice(split + 2);
  const lines = head.split('\n').filter((line) => line.length > 0);
  const headers = new Map<string, string>();
  let status: number | undefined;
  for (const line of lines) {
    const statusLine = /^HTTP\/[\d.]+\s+(\d{3})/.exec(line);
    if (statusLine) {
      status = Number(statusLine[1]);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status, headers, body };
}

/** `"repo, read:org"` → `['repo', 'read:org']`. An empty header means no scopes. */
function parseScopes(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function unavailable(
  reason: PreflightFailureReason,
  message: string,
  missingScopes: readonly string[] = [],
): PreflightUnavailable {
  // R-9.3 — every user-facing string leaves through the one scrubber.
  return { available: false, reason, message: scrubCredentials(message), missingScopes };
}

const GH_MISSING =
  'Collaboration is unavailable: the GitHub CLI (gh) could not be started. Install gh and run "gh auth login", or leave collaboration unconfigured to keep using local mode.';

const NO_CREDENTIAL =
  'Collaboration is unavailable: no GitHub credential is configured. Run "gh auth login", or set GH_TOKEN in the environment of the visual-spec server.';

/**
 * R-9.12 — the message names each absent scope, and how to grant it. Keep the
 * wording clear of the literal word "token" followed by another word:
 * `scrubCredentials` redacts that shape, and it would eat the advice.
 */
function missingScopeMessage(missing: readonly string[]): string {
  const named = missing.map((s) => `"${s}"`).join(', ');
  const noun = missing.length === 1 ? 'scope' : 'scopes';
  const pronoun = missing.length === 1 ? 'it' : 'them';
  return `Collaboration is unavailable: the GitHub credential is missing the required ${noun} ${named}. Run "gh auth refresh -h github.com -s ${missing.join(
    ' -s ',
  )}" to grant ${pronoun}, or use a credential that carries ${pronoun}.`;
}

/**
 * Run the preflight. Resolves — it never rejects — so a caller can go straight
 * from the result to "collaboration on" or "collaboration off, local mode
 * untouched" (R-9.19) with no partially-functional middle state (R-4.10).
 */
export async function preflightCollaboration(options: PreflightOptions): Promise<CollaborationPreflight> {
  const exec = options.exec ?? defaultExecGh;
  const env = options.env ?? process.env;
  const required = options.requiredScopes ?? DEFAULT_REQUIRED_SCOPES;

  const res = await exec(['api', '-i', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', '/user']);

  if (res.exitCode === null) return unavailable('executor_unavailable', GH_MISSING);

  const parsed = parseInclusive(res.stdout);

  if (res.exitCode !== 0) {
    if (parsed.status === 401 || /not logged in|authentication/i.test(res.stderr)) {
      return unavailable('no_credential', NO_CREDENTIAL);
    }
    const detail = res.stderr.trim() || parsed.body.trim() || 'gh api /user failed';
    return unavailable('preflight_failed', `Collaboration is unavailable: the GitHub preflight failed. ${detail}`);
  }

  let login = '';
  try {
    const body = JSON.parse(parsed.body) as { login?: unknown };
    if (typeof body.login === 'string') login = body.login;
  } catch {
    // fall through to the empty-login check below
  }
  if (login === '') {
    return unavailable(
      'preflight_failed',
      'Collaboration is unavailable: the GitHub preflight could not resolve the authenticated identity from gh api /user.',
    );
  }

  const scopes = parseScopes(parsed.headers.get('x-oauth-scopes'));
  const granted = new Set(scopes);
  const missing = required.filter((scope) => !grants(granted, scope));
  if (missing.length > 0) return unavailable('missing_scope', missingScopeMessage(missing), missing);

  return { available: true, source: credentialSource(env), login, scopes, repo: options.repo };
}
