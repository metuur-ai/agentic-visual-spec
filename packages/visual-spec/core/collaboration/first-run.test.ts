/**
 * first-run.test.ts — the author's first run, as a ladder (task 12.2).
 *
 * REQUIREMENT IDs (docs/ears/github-pr-collaborative-documents.md)
 *   R-12.5 — each unmet prerequisite produces its own message naming the fix
 *
 * WHY THIS FILE EXISTS SEPARATELY. `credentials.test.ts` and `authorization.test.ts`
 * each assert their own rung's wording, which proves every message is right and proves
 * nothing about the set: two rungs could drift into the same sentence and both suites
 * would stay green. R-12.5 is a claim about the ladder, so it is tested as a ladder —
 * every state an author can be in on a clean machine, collected in one place, asserted
 * pairwise distinct and each carrying a literal the author can run or open.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCollabAuthorizer } from './authorization';
import { preflightCollaboration } from './credentials';
import type { CollaborationRecord } from './document-record';
import type { CollaborationStore } from './record-store';
import type { GhExecutor } from './github-executor';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name: string): string => readFileSync(`${here}fixtures/${name}`, 'utf8');

const repo = { owner: 'acme', repo: 'docs', baseBranch: 'main' };

/** The authorizer needs a store; no rung below reaches a document. */
const noDocuments = (): CollaborationStore =>
  ({
    read: async (): Promise<CollaborationRecord | null> => null,
    write: async () => undefined,
    list: async () => [],
  }) as unknown as CollaborationStore;

/** `exitCode` is load-bearing and `null` is a real value here, so it is not defaulted away. */
const constant =
  (result: { stdout?: string; stderr?: string; exitCode?: number | null }): GhExecutor =>
  async () => ({
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: 'exitCode' in result ? (result.exitCode as number | null) : 0,
  });

/** One rung: what is wrong, and the sentence the author is shown. */
async function ladder(): Promise<Array<{ rung: string; message: string }>> {
  const rungs: Array<{ rung: string; message: string }> = [];

  const say = (rung: string, value: unknown): void => {
    const message = value && typeof value === 'object' && 'message' in value ? String((value as { message: unknown }).message) : '';
    rungs.push({ rung, message });
  };

  // 1. No `gh` on the machine at all. The real executor turns a spawn failure into a
  //    `null` exit code rather than throwing (github-executor.ts:50), so that — not an
  //    exception — is what a machine without `gh` actually looks like from here.
  say('no gh', await preflightCollaboration({ repo, exec: constant({ stderr: 'spawn gh ENOENT', exitCode: null }), env: {} }));

  // 2. `gh` installed, nobody logged in.
  say(
    'unauthenticated',
    await preflightCollaboration({
      repo,
      exec: constant({ stdout: fixture('user-inclusive-unauthenticated.txt'), stderr: 'gh: Requires authentication (HTTP 401)', exitCode: 1 }),
      env: {},
    }),
  );

  // 3. Logged in, but the credential cannot write to a repository.
  say('missing scope', await preflightCollaboration({ repo, exec: constant({ stdout: fixture('user-inclusive-no-repo-scope.txt') }), env: {} }));

  // 4. Fully credentialled, but read-only on this repository.
  const readOnly = createCollabAuthorizer({ exec: constant({ stdout: fixture('repo-read-only.json') }), documents: noDocuments });
  say('read-only', await readOnly.writeAccess?.({ ...repo }));

  // 5. Fully credentialled, but the repository is not there to be seen. The `(HTTP nnn)`
  //    suffix `statusFromGhError` parses is `gh`'s real format, not a guess: verified
  //    against live `gh` on 2026-08-07, which printed
  //    `gh: Must have push access to view collaborator permission. (HTTP 403)`.
  const missingRepo = createCollabAuthorizer({ exec: constant({ stderr: 'gh: Not Found (HTTP 404)', exitCode: 1 }), documents: noDocuments });
  say('no repo', await missingRepo.writeAccess?.({ ...repo }));

  return rungs;
}

describe('the five ways a first run stops (R-12.5)', () => {
  it('gives every rung its own sentence', async () => {
    const rungs = await ladder();

    expect(rungs.map((r) => r.rung)).toEqual(['no gh', 'unauthenticated', 'missing scope', 'read-only', 'no repo']);
    // Every rung speaks, and no two rungs say the same thing.
    expect(rungs.filter((r) => r.message.length > 0)).toHaveLength(5);
    expect(new Set(rungs.map((r) => r.message)).size).toBe(5);
  });

  /*
   * "Distinct" is cheap to satisfy with five different apologies. The requirement is
   * that the author can act, so each sentence must hand over something to run or open.
   */
  it('hands every rung something the author can run or open', async () => {
    const actionable = [
      /Install gh and run "gh auth login"/,
      /Run "gh auth login"/,
      /Run "gh auth refresh -h github\.com -s repo"/,
      /publishing needs write access/,
      /run `gh auth status`/,
    ];

    const rungs = await ladder();
    rungs.forEach((rung, i) => {
      expect(rung.message, `rung: ${rung.rung}`).toMatch(actionable[i] as RegExp);
    });
  });
});
