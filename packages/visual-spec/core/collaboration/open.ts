/**
 * open.ts — the open-from-PR path (R-11.2 … R-11.4).
 *
 * A sibling of `lifecycle.ts` and `publish.ts`, in the same shape: it exports a bare
 * `JobBody` factory that the 7.2 routes hand to the 8.1 hub, owns no hub and no poller,
 * and every GitHub call goes through the 4.1 adapter.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE FEATURE, NOT A CONVENIENCE
 * ---------------------------------------------------------------------------
 * The branch artifact is canonical JSON (LLD "Luthor JsonDocument as canonical"), so a
 * reviewer who opens the Pull Request on github.com sees a payload, not prose. This is
 * the only path from a PR reference to a rendered document, and it must work for someone
 * who has never had a local copy of the document (R-11.2) and whose credential can only
 * read (R-11.3).
 *
 * ---------------------------------------------------------------------------
 * ONE FORMAT, WRITTEN BY 8.2 AND READ BACK HERE (R-11.1)
 * ---------------------------------------------------------------------------
 * `buildPullRequestBody` (`lifecycle.ts`) writes repo / branch / document plus the
 * `openCommandFor()` command, ending on a 5.1-format trailer. This module reads that
 * body back with `parseCommentBody` — the same 5.1 parser the comment path uses. There
 * is no second format and no second parser; `open.test.ts` asserts the round trip.
 *
 * The trailer is the machine-readable half, so the human-readable table on github.com
 * can be reworded freely without breaking open. `pr.headBranch` is the fallback when a
 * PR carries no `branch` field in its trailer.
 *
 * ---------------------------------------------------------------------------
 * READ-ONLY BY CONSTRUCTION (R-11.3)
 * ---------------------------------------------------------------------------
 * Open performs exactly two GitHub reads — `getPullRequest` and `getFile` — and one
 * *local* store write. It never calls `commitFile`, `createBranch`, `createPullRequest`
 * or `mergePullRequest`; those methods exist on the adapter and are unreachable from
 * here. The poller the wiring starts afterwards only lists issue comments, which is also
 * a read. Nothing on the reviewer's path requires push access.
 *
 * ---------------------------------------------------------------------------
 * SPECIFIC FAILURES, NOT A GENERIC ONE (R-11.4)
 * ---------------------------------------------------------------------------
 * "It didn't work" is useless to someone who has just been handed a PR link. Every
 * failure is an `OpenDocumentError` carrying a `reason` and a message that names what to
 * do about it — see `OpenFailureReason`. The three the requirement calls out are
 * distinguished at the source: HTTP 404/403 from GitHub is `no_access`, the adapter's
 * `executor_unavailable` code (R-4.10) is `executor_unavailable`, and HTTP 401 is
 * `no_credential`. A missing credential is normally caught earlier still, by the 4.2
 * preflight the route consults before this body ever runs.
 *
 * ---------------------------------------------------------------------------
 * WHEN THE DOCUMENT IS ALREADY HERE
 * ---------------------------------------------------------------------------
 * The branch is the system of record (LLD §5); the local copy is a cache. So opening a
 * document that already exists locally **refreshes it from the branch** — a reviewer who
 * opens the same PR twice gets the current document, not a stale one. The one case that
 * refuses is a local copy already bound to a *different* pull request: silently
 * re-pointing it would move a document out from under an in-flight publish. That is
 * `already_attached`, and it names both PR numbers.
 *
 * Node-reachable from the CLI: node builtins and sibling core modules only — no
 * `@lyfie/luthor`, no react (R-3.3 / R-12.6, guarded by `core/bundle-guard.test.ts`).
 */
import type { ResolvedCollaborationConfig } from '../config';
import { parseCommentBody } from './comment-projection';
import type { GitHubBinding } from './document-protocol';
import { parseCollaborationDocument } from './document-protocol';
import type { DocumentStore } from './document-store';
import { GitHubError, type GitHubAdapter, type PullRequestDetail, type RepoRef } from './github-adapter';
import type { JobBody } from './job-hub';
import type { BoundCollaborationDocument } from './lifecycle';

/** Why an open failed. Each maps to one message; none of them is "something went wrong". */
export type OpenFailureReason =
  /** The repository or the PR is not there, or this credential cannot read it (404/403). */
  | 'no_access'
  /** GitHub rejected the credential outright (401). */
  | 'no_credential'
  /** `gh` could not be executed at all (R-4.10). */
  | 'executor_unavailable'
  /** The PR body carries no visual-spec trailer — it is somebody else's pull request. */
  | 'not_collaboration_document'
  /** The PR is a collaboration document, but not the one that was asked for. */
  | 'document_id_mismatch'
  /** The trailer names a path that is not on the branch. */
  | 'document_missing'
  /** A local copy is already bound to a different pull request. */
  | 'already_attached'
  /** Anything else GitHub reported. */
  | 'open_failed';

/** R-11.4 — a failure that names its own cause. `message` is already scrubbed (R-4.9). */
export class OpenDocumentError extends Error {
  readonly name = 'OpenDocumentError';
  readonly reason: OpenFailureReason;
  /** The adapter error underneath, when there was one. */
  readonly cause: GitHubError | undefined;

  constructor(reason: OpenFailureReason, message: string, cause?: GitHubError) {
    super(message);
    this.reason = reason;
    this.cause = cause;
  }
}

/** What a PR body told us about the document on its branch. */
export type PullRequestDocumentReference = {
  owner: string;
  repo: string;
  branch: string;
  documentId: string;
  documentPath: string;
};

const slug = (repo: RepoRef, pullNumber: number): string => `${repo.owner}/${repo.repo}#${pullNumber}`;

/**
 * Map an adapter failure onto the taxonomy above. The status is the only thing worth
 * branching on: `gh` has already normalized everything else into `GitHubError`.
 */
function classifyOpenFailure(err: unknown, repo: RepoRef, pullNumber: number): OpenDocumentError {
  const where = slug(repo, pullNumber);
  if (!(err instanceof GitHubError)) {
    return new OpenDocumentError('open_failed', `cannot open ${where}: ${(err as Error)?.message ?? String(err)}`);
  }
  if (err.ghErrorCode === 'executor_unavailable') {
    return new OpenDocumentError(
      'executor_unavailable',
      `cannot open ${where}: the GitHub CLI could not be started — install \`gh\` and run \`gh auth login\` (read access is enough).`,
      err,
    );
  }
  if (err.status === 401) {
    return new OpenDocumentError(
      'no_credential',
      `cannot open ${where}: GitHub rejected the credential (HTTP 401) — run \`gh auth login\` (read access is enough).`,
      err,
    );
  }
  if (err.status === 403) {
    return new OpenDocumentError(
      'no_access',
      `cannot open ${where}: read access denied (HTTP 403) — this credential can reach GitHub but not ${repo.owner}/${repo.repo}.`,
      err,
    );
  }
  if (err.status === 404) {
    return new OpenDocumentError(
      'no_access',
      `cannot open ${where}: not found (HTTP 404) — either it does not exist or this credential cannot read ${repo.owner}/${repo.repo}.`,
      err,
    );
  }
  return new OpenDocumentError('open_failed', `cannot open ${where}: ${err.message}`, err);
}

/**
 * R-11.1 read side — the inverse of `buildPullRequestBody`. Returns `null` for a pull
 * request that is not a visual-spec collaboration document, which is a normal answer
 * (most pull requests are not).
 */
export function readPullRequestReference(pr: PullRequestDetail, fallback: RepoRef): PullRequestDocumentReference | null {
  const { trailer } = parseCommentBody(pr.body ?? '');
  if (!trailer) return null;
  const documentId = trailer.documentId;
  const documentPath = trailer.documentPath;
  if (!documentId || !documentPath) return null;
  return {
    owner: trailer.owner || fallback.owner,
    repo: trailer.repo || fallback.repo,
    // A trailer written before the branch was named would be odd, but the PR itself
    // always knows its own head branch.
    branch: trailer.branch || pr.headBranch,
    documentId,
    documentPath,
  };
}

/**
 * The CLI's half of `openCommandFor()`: parse `collab open --repo o/r --branch b
 * --document d` back into its parts. Exported so the printed command and the parser
 * cannot drift — `open.test.ts` round-trips them.
 */
export function parseOpenCommand(command: string): { owner: string; repo: string; branch: string; documentId: string } | null {
  const flag = (name: string): string | undefined => new RegExp(`--${name}\\s+(\\S+)`).exec(command)?.[1];
  const repoFlag = flag('repo');
  const branch = flag('branch');
  const documentId = flag('document');
  const slash = repoFlag?.split('/');
  if (!slash || slash.length !== 2 || !slash[0] || !slash[1] || !branch || !documentId) return null;
  return { owner: slash[0], repo: slash[1], branch, documentId };
}

/**
 * Resolve the open pull request for a branch — how the CLI turns the `--branch` in the
 * PR body's command into the pull number the open route needs. A read.
 */
export async function findPullNumberForBranch(adapter: GitHubAdapter, repo: RepoRef, branch: string): Promise<number | null> {
  const pr = await adapter.findOpenPullRequestForBranch(repo, branch);
  return pr ? pr.number : null;
}

/** A subset of 7.2's `OpenJobInput` (`core/vite/routes/collab.ts`), so it assigns straight in. */
export type OpenBodyInput = {
  documentId: string;
  /** R-9.4 — owner / repo / base branch. */
  repo: ResolvedCollaborationConfig;
  store: DocumentStore;
  pullNumber: number;
};

export type OpenBodyOptions = { adapter: GitHubAdapter };

/**
 * The `open` body factory, in the shape 7.2's `CollabJobBodies` declares. Hand it to
 * `createCollabRoutes({ bodies: { open: createOpenBody({ adapter }) } })` —
 * `core/vite/routes/collab-wiring.ts` is the one place that does.
 */
export function createOpenBody(options: OpenBodyOptions): (input: OpenBodyInput) => JobBody {
  const { adapter } = options;

  return (input) => async (ctx) => {
    const { documentId, repo, store, pullNumber } = input;
    const repoRef: RepoRef = { owner: repo.owner, repo: repo.repo };
    const where = slug(repoRef, pullNumber);

    ctx.log(`reading pull request ${where}`, 'progress');
    let pr: PullRequestDetail;
    try {
      pr = await adapter.getPullRequest(repoRef, pullNumber);
    } catch (err) {
      throw classifyOpenFailure(err, repoRef, pullNumber);
    }

    const reference = readPullRequestReference(pr, repoRef);
    if (!reference) {
      throw new OpenDocumentError(
        'not_collaboration_document',
        `${where} is not a visual-spec collaboration document — its body carries no visual-spec trailer.`,
      );
    }
    if (reference.documentId !== documentId) {
      throw new OpenDocumentError(
        'document_id_mismatch',
        `${where} carries document "${reference.documentId}", not "${documentId}" — open it as "${reference.documentId}".`,
      );
    }

    // Refuse to re-point a document that is already attached elsewhere; refresh anything
    // else. See the header.
    const local = (await store.read(documentId)) as BoundCollaborationDocument | null;
    const attachedTo = local?.github?.pullNumber;
    if (typeof attachedTo === 'number' && attachedTo !== pullNumber) {
      throw new OpenDocumentError(
        'already_attached',
        `document "${documentId}" is already attached to ${slug(repoRef, attachedTo)} — it cannot be opened from ${where} as well.`,
      );
    }

    ctx.log(`fetching ${reference.documentPath} from ${reference.branch}`, 'progress');
    let file: Awaited<ReturnType<GitHubAdapter['getFile']>>;
    try {
      file = await adapter.getFile(
        { owner: reference.owner, repo: reference.repo },
        reference.documentPath,
        reference.branch,
      );
    } catch (err) {
      throw classifyOpenFailure(err, repoRef, pullNumber);
    }
    if (!file) {
      throw new OpenDocumentError(
        'document_missing',
        `${where} references ${reference.documentPath} on ${reference.branch}, and there is no such file on that branch.`,
      );
    }

    const fetched = parseCollaborationDocument(file.content);
    const github: GitHubBinding = {
      owner: reference.owner,
      repo: reference.repo,
      branch: reference.branch,
      pullNumber,
      headSha: pr.headSha,
      resolved: false,
    };
    // The local write is what makes the document readable with no prior copy: the store
    // the routes read (`GET /__vs/collab/:id`) is the store written here.
    await store.write({ ...fetched, documentId, github });

    ctx.log(`opened ${documentId} from ${where} at ${reference.branch} — ${pr.htmlUrl}`);
    ctx.setState('pr-open');
  };
}
