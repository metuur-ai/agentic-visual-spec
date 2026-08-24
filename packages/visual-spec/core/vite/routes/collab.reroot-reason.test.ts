/**
 * collab.reroot-reason.test.ts — R-10.7, the disabled state that says why.
 *
 * R-10.3 / R-10.4 already made both hosts decide WHICH kind of nothing a re-rooted
 * directory is: not a repository, no remote, a remote that is not GitHub, or a perfectly
 * good GitHub repository nobody has a credential for. That verdict reached the server's
 * stdout and stopped there. In the browser the effect of switching to such a directory
 * was that collaboration simply went quiet — the exact silent failure R-10.7 forbids.
 *
 * So what is pinned here is the transport: `GET /__vs/collab` carries the host's reason,
 * and a refusal from a gated route tells the same story rather than a second one.
 *
 * No network, no `gh`, no `git`.
 */
import { describe, expect, it } from 'vitest';
import type { CollaborationPreflight } from '../../collaboration/credentials';
import { createJobHubRegistry } from '../../collaboration/job-hub';
import type { RebindFailure } from '../../collaboration/open';
import type { ResolvedVisualSpecConfig } from '../../config';
import type { GitExecutor } from '../../git-context';
import { type CollabAuthorizer, type CollabDeps, createCollabRoutes } from './collab';

const DISABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: null, git: { allowCheckout: false } };

const ENABLED: ResolvedVisualSpecConfig = {
  surfacesDir: 'surfaces',
  collaboration: { owner: 'acme', repo: 'specs', baseBranch: 'main' },
  git: { allowCheckout: false },
};

const ALLOW_ALL: CollabAuthorizer = () => ({ ok: true });
const noGit: GitExecutor = async () => ({ stdout: '', exitCode: 1 });

function router(overrides: Partial<CollabDeps> = {}) {
  return createCollabRoutes({
    jobs: createJobHubRegistry(),
    config: () => DISABLED,
    documents: () => {
      throw new Error('no test in this file reads the document store');
    },
    authorize: ALLOW_ALL,
    baseDir: () => '/tmp/does-not-matter',
    git: noGit,
    ...overrides,
  });
}

const snapshot = (r: ReturnType<typeof router>) => r.handle({ method: 'GET', pathname: '', query: {}, body: {} });

describe('R-10.7 — the availability snapshot carries the re-root reason', () => {
  const cases: RebindFailure[] = ['not-a-repo', 'no-remote', 'remote-not-github'];

  for (const reason of cases) {
    it(`reports \`${reason}\` with a message of its own`, async () => {
      const res = await snapshot(router({ unavailable: () => reason }));
      expect(res.status).toBe(200);
      const body = res.json as { available: boolean; reason: string; message: string };
      expect(body.available).toBe(false);
      expect(body.reason).toBe(reason);
      expect(body.message.length).toBeGreaterThan(0);
    });
  }

  it('gives each reason a DIFFERENT message — three codes sharing one sentence is silence with extra steps', async () => {
    const messages = await Promise.all(
      cases.map(async (reason) => ((await snapshot(router({ unavailable: () => reason }))).json as { message: string }).message),
    );
    expect(new Set(messages).size).toBe(cases.length);
  });

  it('falls back to `not-configured` when the host has no verdict — a server started without a repository never re-rooted', async () => {
    const body = (await snapshot(router())).json as { reason: string };
    expect(body.reason).toBe('not-configured');
  });

  it('never reports a GitHub repository with no credential as unrecognised (R-10.4)', async () => {
    // The repository resolved; only the credential is missing. That answer comes from the
    // preflight and must not be overwritten by any directory-level reason.
    const noCredential: CollaborationPreflight = {
      available: false,
      reason: 'no_credential',
      message: 'no GitHub credential',
      missingScopes: [],
    };
    const body = (await snapshot(router({ config: () => ENABLED, preflight: async () => noCredential }))).json as {
      reason: string;
    };
    expect(body.reason).toBe('no_credential');
    expect(body.reason).not.toBe('not-a-repo');
  });
});

describe('R-10.7 — a refused route tells the same story as the snapshot', () => {
  it('the 503 body from a gated route carries the re-root reason too', async () => {
    const r = router({ unavailable: () => 'remote-not-github' });
    const res = await r.handle({ method: 'GET', pathname: '/pulls', query: {}, body: {} });
    expect(res.status).toBe(503);
    expect((res.json as { reason: string }).reason).toBe('remote-not-github');
  });
});
