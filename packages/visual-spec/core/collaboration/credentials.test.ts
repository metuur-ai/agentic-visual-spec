import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config';
import { credentialFingerprint, preflightCollaboration } from './credentials';
import type { GhExecutor, GhResult } from './github-executor';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name: string): string => readFileSync(`${here}fixtures/${name}`, 'utf8');

const repo = { owner: 'acme', repo: 'docs', baseBranch: 'main' };

type Call = { args: string[]; input?: string };

/** Same recorded-response executor shape as `github-adapter.test.ts` (R-4.8). */
function recorder(responses: Array<Partial<GhResult>>): { exec: GhExecutor; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const exec: GhExecutor = async (args, input) => {
    calls.push(input === undefined ? { args } : { args, input });
    const r = responses[i++] ?? {};
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: 'exitCode' in r ? (r.exitCode as number | null) : 0 };
  };
  return { exec, calls };
}

/** A real-looking classic PAT, used to prove it never comes back out. */
const SECRET = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
/** Anything that looks like a GitHub token, in any of its shapes. */
const TOKEN_SHAPED = /gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}/;

describe('preflightCollaboration — credential discovery (R-9.1)', () => {
  it('reports an env-supplied credential as sourced from the environment', async () => {
    const { exec, calls } = recorder([{ stdout: fixture('user-inclusive-ok.txt') }]);
    const result = await preflightCollaboration({ repo, exec, env: { GH_TOKEN: SECRET } });

    expect(result).toEqual({
      available: true,
      source: 'environment',
      login: 'octodev',
      scopes: ['gist', 'read:org', 'repo'],
      repo,
    });
    // Scopes and identity come from one buffered `gh api -i /user` call.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      'api',
      '-i',
      '--method',
      'GET',
      '-H',
      'Accept: application/vnd.github+json',
      '/user',
    ]);
  });

  it('accepts GITHUB_TOKEN as well as GH_TOKEN', async () => {
    const { exec } = recorder([{ stdout: fixture('user-inclusive-ok.txt') }]);
    const result = await preflightCollaboration({ repo, exec, env: { GITHUB_TOKEN: SECRET } });

    expect(result).toMatchObject({ available: true, source: 'environment' });
  });

  it('reports a keyring OAuth token — no env var at all — as gh auth state', async () => {
    const { exec } = recorder([{ stdout: fixture('user-inclusive-ok.txt') }]);
    const result = await preflightCollaboration({ repo, exec, env: {} });

    expect(result).toMatchObject({ available: true, source: 'gh-auth-state', login: 'octodev' });
  });

  it('treats an empty token env var as absent rather than as a credential', async () => {
    const { exec } = recorder([{ stdout: fixture('user-inclusive-ok.txt') }]);
    const result = await preflightCollaboration({ repo, exec, env: { GH_TOKEN: '' } });

    expect(result).toMatchObject({ source: 'gh-auth-state' });
  });
});

describe('preflightCollaboration — the credential never escapes (R-9.2 / R-9.3)', () => {
  it('returns no token-shaped string even when the env holds one and gh echoes it', async () => {
    const { exec } = recorder([
      {
        stdout: `HTTP/2.0 403 Forbidden\r\nAuthorization: Bearer ${SECRET}\r\n\r\n{"message":"Bad credentials"}`,
        stderr: `gh: request failed with token ${SECRET} (HTTP 403)`,
        exitCode: 1,
      },
    ]);
    const result = await preflightCollaboration({
      repo,
      exec,
      env: { GH_TOKEN: SECRET, GITHUB_TOKEN: SECRET },
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(TOKEN_SHAPED);
    expect(serialized).not.toContain(SECRET);
    // Scrubbed, not merely truncated — the marker proves the scrubber ran.
    expect((result as { message: string }).message).toContain('[redacted]');
  });

  it('exposes no token field on the success shape', async () => {
    const { exec } = recorder([{ stdout: fixture('user-inclusive-ok.txt') }]);
    const result = await preflightCollaboration({ repo, exec, env: { GH_TOKEN: SECRET } });

    expect(Object.keys(result).sort()).toEqual(['available', 'login', 'repo', 'scopes', 'source']);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe('preflightCollaboration — repository configuration (R-9.4)', () => {
  it('echoes the configured owner, repo and base branch back on success', async () => {
    const { exec } = recorder([{ stdout: fixture('user-inclusive-ok.txt') }]);
    const configured = { owner: 'metuur', repo: 'visual-spec', baseBranch: 'develop' };
    const result = await preflightCollaboration({ repo: configured, exec, env: {} });

    expect(result).toMatchObject({ available: true, repo: configured });
  });

  it('resolveConfig defaults the base branch and leaves collaboration null when unconfigured', () => {
    expect(resolveConfig({}).collaboration).toBeNull();
    expect(resolveConfig({ collaboration: { owner: 'acme', repo: 'docs' } }).collaboration).toEqual({
      owner: 'acme',
      repo: 'docs',
      baseBranch: 'main',
    });
  });
});

describe('preflightCollaboration — scope verification (R-9.12)', () => {
  it('names the specific missing scope', async () => {
    const { exec } = recorder([{ stdout: fixture('user-inclusive-no-repo-scope.txt') }]);
    const result = await preflightCollaboration({ repo, exec, env: {} });

    expect(result).toMatchObject({ available: false, reason: 'missing_scope', missingScopes: ['repo'] });
    expect((result as { message: string }).message).toBe(
      'Collaboration is unavailable: the GitHub credential is missing the required scope "repo". Run "gh auth refresh -h github.com -s repo" to grant it, or use a credential that carries it.',
    );
  });

  it('names every missing scope when more than one is absent', async () => {
    const { exec } = recorder([{ stdout: fixture('user-inclusive-no-repo-scope.txt') }]);
    const result = await preflightCollaboration({
      repo,
      exec,
      env: {},
      requiredScopes: ['repo', 'workflow', 'read:org'],
    });

    // `read:org` is granted by the fixture, so it must not be reported.
    expect(result).toMatchObject({ reason: 'missing_scope', missingScopes: ['repo', 'workflow'] });
    expect((result as { message: string }).message).toContain('"repo", "workflow"');
    expect((result as { message: string }).message).toContain('-s repo -s workflow');
  });

  it('treats a coarser granted scope as satisfying a finer required one', async () => {
    const { exec } = recorder([{ stdout: fixture('user-inclusive-ok.txt') }]);
    const result = await preflightCollaboration({
      repo,
      exec,
      env: {},
      requiredScopes: ['public_repo', 'repo:status'],
    });

    expect(result).toMatchObject({ available: true });
  });

  it('fails closed when the credential reports no scopes at all', async () => {
    const { exec } = recorder([{ stdout: 'HTTP/2.0 200 OK\r\nX-OAuth-Scopes: \r\n\r\n{"login":"octodev"}' }]);
    const result = await preflightCollaboration({ repo, exec, env: {} });

    expect(result).toMatchObject({ available: false, reason: 'missing_scope', missingScopes: ['repo'] });
  });
});

describe('preflightCollaboration — unavailable execution path (R-4.10)', () => {
  it('reports gh not being startable as unavailable, with no partial success', async () => {
    const { exec } = recorder([{ exitCode: null, stderr: 'spawn gh ENOENT' }]);
    const result = await preflightCollaboration({ repo, exec, env: {} });

    expect(result).toEqual({
      available: false,
      reason: 'executor_unavailable',
      missingScopes: [],
      message:
        'Collaboration is unavailable: the GitHub CLI (gh) could not be started. Install gh and run "gh auth login", or leave collaboration unconfigured to keep using local mode.',
    });
  });

  it('reports any other gh failure as unavailable rather than half-working', async () => {
    const { exec } = recorder([{ stdout: 'HTTP/2.0 502 Bad Gateway\r\n\r\n{}', stderr: 'gh: Server Error (HTTP 502)', exitCode: 1 }]);
    const result = await preflightCollaboration({ repo, exec, env: {} });

    expect(result).toMatchObject({ available: false, reason: 'preflight_failed' });
    expect((result as { message: string }).message).toContain('gh: Server Error (HTTP 502)');
  });

  it('reports an unparseable identity as unavailable', async () => {
    const { exec } = recorder([{ stdout: 'HTTP/2.0 200 OK\r\nX-OAuth-Scopes: repo\r\n\r\nnot json' }]);
    const result = await preflightCollaboration({ repo, exec, env: {} });

    expect(result).toMatchObject({ available: false, reason: 'preflight_failed' });
  });
});

describe('preflightCollaboration — no credential disables collaboration (R-9.19)', () => {
  it('reports no_credential when gh is installed but not authenticated', async () => {
    const { exec } = recorder([
      {
        stdout: fixture('user-inclusive-unauthenticated.txt'),
        stderr: 'gh: Requires authentication (HTTP 401)',
        exitCode: 1,
      },
    ]);
    const result = await preflightCollaboration({ repo, exec, env: {} });

    expect(result).toEqual({
      available: false,
      reason: 'no_credential',
      missingScopes: [],
      message:
        'Collaboration is unavailable: no GitHub credential is configured. Run "gh auth login", or set GH_TOKEN in the environment of the visual-spec server.',
    });
  });

  it('resolves rather than throwing, so local mode is entirely unaffected', async () => {
    const { exec, calls } = recorder([{ exitCode: null, stderr: 'spawn gh ENOENT' }]);
    // No rejection to catch, and no second attempt at a fallback path.
    await expect(preflightCollaboration({ repo, exec, env: {} })).resolves.toMatchObject({ available: false });
    expect(calls).toHaveLength(1);

    // Local mode's own config resolution is untouched by collaboration being off.
    expect(resolveConfig({ surfacesDir: 'surfaces' })).toEqual({
      surfacesDir: 'surfaces',
      collaboration: null,
      // R-6.3 — off by omission, exactly as collaboration is.
      git: { allowCheckout: false },
    });
  });
});

/* ================================================================== *
 * U-6 — credential fingerprint (cache keying only)
 * ================================================================== */
describe('U-6 — credentialFingerprint', () => {
  const SECRET = 'ghp_averyrealsecrettokenvalue0000000000';

  it('never returns the plaintext, in whole or in part', () => {
    const fp = credentialFingerprint({ GH_TOKEN: SECRET });
    // The whole point of the invariant carve-out: the digest must not be a leak.
    expect(fp).not.toContain(SECRET);
    expect(fp).not.toContain(SECRET.slice(4));
    expect(fp).not.toContain('ghp_');
    expect(fp).toMatch(/^GH_TOKEN:[0-9a-f]{16}$/);
  });

  it('is stable for one credential and different for another', () => {
    expect(credentialFingerprint({ GH_TOKEN: SECRET })).toBe(credentialFingerprint({ GH_TOKEN: SECRET }));
    expect(credentialFingerprint({ GH_TOKEN: SECRET })).not.toBe(credentialFingerprint({ GH_TOKEN: `${SECRET}x` }));
  });

  it('distinguishes which env var supplied the credential, and falls back to gh auth state', () => {
    // Same value under a different key is still a different `gh` resolution order.
    expect(credentialFingerprint({ GH_TOKEN: SECRET })).not.toBe(credentialFingerprint({ GITHUB_TOKEN: SECRET }));
    expect(credentialFingerprint({ GH_TOKEN: SECRET, GITHUB_TOKEN: 'other' })).toBe(credentialFingerprint({ GH_TOKEN: SECRET }));
    expect(credentialFingerprint({})).toBe('gh-auth-state');
  });

  it('KNOWN GAP — a gh auth switch is invisible, because it touches no env var', () => {
    // Documented, not a bug to fix here: the TTL is the only bound for this case.
    expect(credentialFingerprint({})).toBe(credentialFingerprint({}));
  });
});
