/**
 * authorization.ts — role classification and author-only enforcement (task 9.2,
 * R-9.5 … R-9.11).
 *
 * WHY THIS IS NOT "PAT OWNER == PR AUTHOR". That check alone locks reviewers out of the
 * feature entirely, which is the whole point of the two-role model in LLD §9. The role
 * is derived from *two* facts: the credential's effective permission on the repository,
 * and its identity relative to the Pull Request's author.
 *
 *   | Role     | Derived from                                  | Permitted                  |
 *   | -------- | --------------------------------------------- | -------------------------- |
 *   | author   | identity == PR author, **and** write access    | create, publish (commits)   |
 *   | reviewer | anything else that can read the repository    | read, sync, open, comment…  |
 *
 * THE SERVER CHECK IS THE SECOND LINE, NOT THE FIRST. GitHub itself enforces the
 * boundary — a reviewer's credential cannot push — so single-writer holds even if
 * everything below is wrong. What this module buys is that a reviewer's own instance
 * refuses the operation up front instead of letting them attempt it and fail
 * confusingly three GitHub calls later (R-9.10). Hiding the UI control is *not* part of
 * the answer (R-9.11): the route is the enforcement point, and the reviewer-token table
 * in `authorization.test.ts` drives the router directly, with no UI in the picture.
 *
 * WHAT IT COSTS. Nothing at all for a reviewer-permitted operation: the table below is
 * consulted first, and an `any-role` op returns without a single `gh` call. An
 * author-only op costs at most two, both cached:
 *
 *   - `GET /repos/{owner}/{repo}` → `permissions.{admin,maintain,push}` — the effective
 *     permission of the *authenticated* user, readable by anyone who can read the repo.
 *     (`/repos/{o}/{r}/collaborators/{user}/permission` answers the same question but
 *     itself requires push access, so a reviewer gets a 403 and the check cannot tell
 *     "no write access" from "cannot ask" — which is exactly the distinction needed.)
 *   - `GET /repos/{owner}/{repo}/pulls/{n}` → `user.login` — the PR author.
 *
 * CACHING AND WHAT INVALIDATES IT. A stale *author* verdict is a security bug; a stale
 * *reviewer* verdict is merely annoying. So:
 *   - repo permission is cached per `owner/repo` under a short TTL (default 60s), which
 *     bounds how long a revoked write grant can still read as `author`;
 *   - the PR author is cached per `owner/repo#number` with no expiry, because GitHub
 *     does not let a Pull Request change author — it is immutable for the PR's life;
 *   - **failures are never cached**, in either direction, so a transient network error
 *     can neither pin a deny nor pin an allow.
 *
 * FAIL CLOSED. If the role cannot be determined at all — `gh` unavailable, the repo or
 * the PR not found, a malformed response, the document store throwing — an author-only
 * operation is refused with **403** and a message that says the role could not be
 * determined. It is deliberately not a 503: 503 is this family's "collaboration is
 * unavailable" answer and carries a `CollabAvailability` payload the UI acts on, and an
 * undeterminable role is not that. Reviewer-permitted operations are unaffected, because
 * they never ask.
 *
 * `core/` is Node-reachable from the CLI, so this module imports only node builtins and
 * sibling core modules — no Luthor, no react (R-3.3 / R-12.6). The one import from the
 * route layer is `import type`, erased at compile time: it exists so `OPERATION_POLICY`
 * is a total `Record<CollabOperation, …>` and a newly added operation fails the build
 * rather than silently defaulting to permitted.
 */
import type { ResolvedCollaborationConfig } from '../config';
import type { AuthorizationVerdict, CollabAuthorizer, CollabOperation } from '../vite/routes/collab';
import type { CollaborationStore } from './record-store';
import { type GhExecutor, defaultExecGh, scrubCredentials } from './github-executor';

/** LLD §9 — the only two roles. There is no hierarchy and no third role. */
export type CollabRole = 'author' | 'reviewer';

/**
 * Whether an operation needs the author role. **Total over `CollabOperation` on
 * purpose**: adding an operation to the union without deciding here is a type error, so
 * a new mutating route cannot default its way into being reviewer-permitted.
 *
 * `read` / `sync` need no role at all (R-9.8): sync only refreshes the local copy from
 * GitHub, and a reviewer who cannot sync cannot see the comments they are there to read.
 * `open` attaches to a Pull Request that already exists and writes nothing to GitHub —
 * it is the reviewer onboarding path (Unit 11), so gating it would defeat the feature.
 * `comment` / `reply` / `edit-comment` are R-9.8 verbatim; GitHub separately refuses to
 * let anyone edit a comment they do not own.
 *
 * `create` and `publish` are the two that commit (R-9.9). `reconcile` may delete the
 * orphan branch a partial create left behind and `mark-ready` records the author's
 * declaration that the document is done, so both are author-only too. Edit and merge
 * have no route in this family yet — merge is deliberately not part of publish (LLD §7).
 */
export const OPERATION_POLICY: Record<CollabOperation, 'any-role' | 'author-only'> = {
  read: 'any-role',
  sync: 'any-role',
  open: 'any-role',
  comment: 'any-role',
  reply: 'any-role',
  'edit-comment': 'any-role',
  create: 'author-only',
  publish: 'author-only',
  reconcile: 'author-only',
  'mark-ready': 'author-only',
};

export type CollabAuthorizerOptions = {
  /** Injectable so tests never exec `gh` (R-4.8 / R-12.3). Defaults to the real CLI. */
  exec?: GhExecutor;
  /**
   * The host's collaboration-store thunk, so a runtime re-root is honoured. Used only to
   * find the Pull Request an author-only operation applies to.
   */
  documents: () => CollaborationStore;
  /** How long a repo-permission answer may be reused. Default 60s. */
  permissionTtlMs?: number;
  /** Injectable clock, so the TTL is testable without a timer. */
  now?: () => number;
};

const DEFAULT_PERMISSION_TTL_MS = 60_000;

type Json = Record<string, unknown>;

const deny = (error: string): AuthorizationVerdict => ({ ok: false, status: 403, error: scrubCredentials(error) });

/**
 * Raised internally when the role is undeterminable; never escapes this module.
 * `status` carries GitHub's HTTP code when `gh` reported one, so a caller that cares
 * about a *specific* refusal (R-12.5: a repo that is not there) can tell it apart from
 * the outage case. Everything that reaches `authorize` still treats them alike.
 */
class Undeterminable extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
  }
}

/** `gh: Not Found (HTTP 404)` → 404. Null when `gh` said nothing parseable. */
function statusFromGhError(detail: string): number | null {
  const m = /\(HTTP (\d{3})\)/.exec(detail);
  return m ? Number(m[1]) : null;
}

/**
 * One `gh api` GET. Throws `Undeterminable` for every failure mode there is — a failed
 * spawn, a non-zero exit, a non-JSON body — because from this module's point of view
 * they are the same fact: the role is not known, so the answer is "refused".
 */
async function getJson(exec: GhExecutor, what: string, endpoint: string): Promise<Json> {
  const res = await exec(['api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', endpoint]);
  if (res.exitCode !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim() || 'gh api failed';
    throw new Undeterminable(`${what}: ${detail}`, statusFromGhError(detail));
  }
  try {
    const parsed = JSON.parse(res.stdout) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Json;
  } catch {
    throw new Undeterminable(`${what}: gh api returned an unreadable response`);
  }
}

/**
 * Build the authorizer 7.2's route layer calls on every request. It is the *only* place
 * author-only gating lives; no route knows about roles.
 */
export function createCollabAuthorizer(options: CollabAuthorizerOptions): CollabAuthorizer {
  const exec = options.exec ?? defaultExecGh;
  const ttl = options.permissionTtlMs ?? DEFAULT_PERMISSION_TTL_MS;
  const clock = options.now ?? (() => Date.now());

  /** `owner/repo` → the answer and when it expires. Errors are never stored. */
  const permissions = new Map<string, { write: boolean; expiresAt: number }>();
  /** `owner/repo#number` → PR author login. Immutable for the PR's life, so no TTL. */
  const authors = new Map<string, string>();

  /** R-9.7 — does the credential carry write access to the repository? */
  async function hasWriteAccess(repo: ResolvedCollaborationConfig): Promise<boolean> {
    const key = `${repo.owner}/${repo.repo}`;
    const cached = permissions.get(key);
    if (cached && cached.expiresAt > clock()) return cached.write;
    const raw = await getJson(exec, 'repository permission', `/repos/${repo.owner}/${repo.repo}`);
    const perms = raw.permissions;
    if (!perms || typeof perms !== 'object') {
      // A repo payload with no `permissions` block means the response was not made on
      // behalf of an authenticated user. Refusing to guess is the whole point.
      throw new Undeterminable('repository permission: the response carried no permissions for the authenticated user');
    }
    const p = perms as Json;
    const write = p.admin === true || p.maintain === true || p.push === true;
    permissions.set(key, { write, expiresAt: clock() + ttl });
    return write;
  }

  /** The PR author's login, or `null` when the document is not attached to a PR yet. */
  async function pullRequestAuthor(repo: ResolvedCollaborationConfig, documentId: string | null): Promise<string | null> {
    if (!documentId) return null;
    let document;
    try {
      document = await options.documents().read(documentId);
    } catch (err) {
      throw new Undeterminable(`document lookup: ${(err as Error).message}`);
    }
    if (!document) return null;
    const binding = (document as { github?: { pullNumber?: unknown } }).github;
    const pullNumber = binding?.pullNumber;
    if (typeof pullNumber !== 'number') return null;

    const key = `${repo.owner}/${repo.repo}#${pullNumber}`;
    const cached = authors.get(key);
    if (cached !== undefined) return cached;
    const raw = await getJson(exec, 'pull request author', `/repos/${repo.owner}/${repo.repo}/pulls/${pullNumber}`);
    const login = (raw.user as Json | undefined)?.login;
    if (typeof login !== 'string' || login === '') {
      throw new Undeterminable('pull request author: the response named no author');
    }
    authors.set(key, login);
    return login;
  }

  const authorizer: CollabAuthorizer = async (op, ctx) => {
    // R-9.8 — a reviewer-permitted operation costs nothing and asks nothing. This is
    // also why a network outage never blocks reading, syncing or commenting.
    if (OPERATION_POLICY[op] === 'any-role') return { ok: true };

    try {
      // R-9.7, first half. Checked before identity because it is the cheaper cache and
      // because a credential with no write access is a reviewer whoever it belongs to.
      if (!(await hasWriteAccess(ctx.repo))) {
        return deny(
          `${op} is available to the document author only: the GitHub credential has no write access to ${ctx.repo.owner}/${ctx.repo.repo}. Comment and reply instead — they need no write access.`,
        );
      }

      // R-9.7, second half. Absent a Pull Request there is no author to differ from —
      // `create` is the operation that opens one, and whoever opens it becomes its
      // author — so write access is the whole test.
      const author = await pullRequestAuthor(ctx.repo, ctx.documentId);
      if (author !== null && author !== ctx.login) {
        return deny(
          `${op} is available to the document author only: this pull request was opened by ${author}, and the GitHub credential authenticates as ${ctx.login}.`,
        );
      }

      return { ok: true };
    } catch (err) {
      // FAIL CLOSED. Anything at all that leaves the role unknown refuses the operation.
      return deny(`${op} was refused: the collaboration role could not be determined (${(err as Error).message}).`);
    }
  };

  /**
   * The first half of R-9.7 asked as a question instead of a verdict, so the availability
   * snapshot can tell a reviewer their session is comment-only before they look for a
   * publish control. Shares `hasWriteAccess`'s cache.
   *
   * R-12.5 — three answers, not two. A 404 is the *repo* being wrong (a typo in `--repo`
   * or in the plugin's `collaboration` block, or a credential that cannot see it at all) and is worth
   * saying out loud; every other failure is an outage and stays `null`, so it reads as
   * "unknown" rather than demoting an author to reviewer on a network blip.
   */
  authorizer.writeAccess = async (repo) => {
    try {
      const write = await hasWriteAccess(repo);
      return write
        ? { write: true }
        : {
            write: false,
            reason: 'no_write_access',
            message:
              `You do not have write access to ${repo.owner}/${repo.repo}, so this is a review-only session. ` +
              'You can comment and reply on any document; publishing needs write access.',
          };
    } catch (err) {
      if (err instanceof Undeterminable && err.status === 404) {
        return {
          write: false,
          reason: 'no_repo',
          message:
            `${repo.owner}/${repo.repo} was not found. Either the configured repository is wrong — check the ` +
            '`--repo` flag, or the `collaboration` block passed to `visualSpecMarkdown()` in vite.config.ts — ' +
            'or this credential cannot see it, so run `gh auth status`.',
        };
      }
      return { write: null, reason: 'unknown' };
    }
  };

  return authorizer;
}
