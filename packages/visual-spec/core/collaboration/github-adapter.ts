/**
 * github-adapter.ts — the single adapter every GitHub operation goes through.
 *
 * R-4.1: one adapter, not a client per feature. R-4.2 / R-4.6: REST only, over
 * `gh api`; there is no hand-rolled HTTP client and no GraphQL anywhere — issue
 * comments have no `resolveReviewThread` equivalent to reach for, so REST covers
 * the whole surface.
 *
 * COMMITS GO THROUGH THE CONTENTS API, NEVER A WORKING TREE. Git's `text=auto` /
 * `eol=lf` filters run at `git add` inside a checkout, not on API writes, so a
 * shell-out to `git add` / `git commit` would silently normalize line endings and
 * make the publish byte-verification step fail on every publish. This module
 * spawns exactly one binary — `gh` — and `commitFile` is a `PUT /contents/:path`.
 *
 * PAGINATION (R-4.5) is an explicit `page=` loop, not `Link` header following and
 * not `--paginate`. The executor is buffered and hands back stdout only, so
 * response headers are not observable; `--paginate` would emit concatenated JSON
 * documents that need a streaming splitter. A page loop keyed on `per_page` is
 * the only option the executor shape actually supports.
 *
 * Comments are PR **issue** comments (`/issues/:number/comments`) — never review
 * comments, which require a diff hunk a JSON payload cannot provide.
 */
import { parseCommentBody } from './comment-projection';
import { type GhExecutor, defaultExecGh, scrubCredentials } from './github-executor';
import { type ReviewComment, type ThreadResolution, toReviewComment } from './review-comments';

export type { ReviewComment, ThreadResolution };

/** Owner + repo, the pair every endpoint needs. */
export type RepoRef = { owner: string; repo: string };

/** A git ref and the commit it points at. */
export type GitRef = { ref: string; sha: string };

/** A file read back from the Contents API, already decoded to utf-8. */
export type FileContent = { path: string; sha: string; content: string };

/**
 * One entry of a Contents API *directory* listing. `type` is GitHub's own
 * (`file`, `dir`, `symlink`, `submodule`), passed through rather than narrowed.
 */
export type DirectoryEntry = { name: string; path: string; sha: string; type: string };

export type CommitFileInput = {
  /** Repo-relative posix path. */
  path: string;
  /** File body as utf-8 text; base64-encoded here, never written to disk. */
  content: string;
  message: string;
  branch: string;
  /** Blob sha of the file being replaced. Omit to create. */
  sha?: string;
};

export type CommitResult = { path: string; commitSha: string; contentSha: string };

export type CreatePullRequestInput = { title: string; head: string; base: string; body?: string; draft?: boolean };

export type PullRequest = { number: number; headSha: string; htmlUrl: string; state: string };

/**
 * A pull request as *read back*, carrying everything `GET /pulls/{n}` returns that
 * creating one cannot: `body` (task 11.1 parses the 5.1 trailer out of it),
 * `headBranch`/`baseBranch` (the branches the document and its target live on), and
 * `merged` / `mergeable` (task 8.4 — how a PR closed or made unmergeable **on
 * github.com** becomes observable to a poll; nothing else in this package can see an
 * out-of-band change).
 *
 * Tasks 8.4 and 11.1 each introduced a read type independently. They are one type:
 * a single `GET` returns all of these fields, so splitting them would mean two calls
 * for one resource. `PullRequestStatus` is retained as an alias so 8.4's call sites
 * read as intended. `mergeable` is `null` while GitHub is still computing the merge
 * commit — a third answer, not a synonym for `false`.
 */
export type PullRequestDetail = PullRequest & {
  body: string;
  headBranch: string;
  baseBranch: string;
  merged: boolean;
  mergeable: boolean | null;
  /** GitHub's own word: `clean`, `dirty`, `blocked`, `unknown`, … Passed through. */
  mergeableState: string;
};

/** Task 8.4's name for the same read-back shape. */
export type PullRequestStatus = PullRequestDetail;

/** Which Pull Requests a list call asks for. GitHub's own vocabulary, passed through. */
export type PullRequestListState = 'open' | 'closed' | 'all';

/**
 * One row of a Pull Request list. Deliberately not `PullRequestDetail`: see
 * `listPullRequests`. `author` is the login, or `''` when GitHub reports a deleted user.
 *
 * `documentId` is present exactly when the pull request carries a visual-spec trailer,
 * i.e. when it is a collaboration document (R-7.4). It is resolved **here**, on the
 * server, and the body it was resolved from is not carried alongside it — see
 * `toPullRequestSummary`. Note the asymmetry with `PullRequestDetail`, which does carry
 * `body`: that one is read one PR at a time by a caller that needs the whole reference
 * (branch and path as well as the id), and it never reaches a browser.
 */
export type PullRequestSummary = {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  htmlUrl: string;
  author: string;
  updatedAt: string;
  /** R-7.4 — the collaboration document on this PR, absent when there is none. */
  documentId?: string;
};

/**
 * `GET /compare/{base}...{head}` reduced to what a divergence check needs: the branch
 * point and the paths that changed between it and `head` (R-8.22).
 */
export type BranchComparison = {
  /** The merge base — i.e. the branch point. */
  mergeBaseSha: string;
  aheadBy: number;
  behindBy: number;
  /** Repo-relative paths changed between the merge base and `head`. */
  files: string[];
};

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export type MergeResult = { merged: boolean; sha: string; message: string };

/** A PR issue comment, flattened to what the projection layer needs. */
export type IssueComment = {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
};

/**
 * R-4.9 — a failed operation surfaces this and nothing else. It names the
 * operation, carries GitHub's status and error code, and its `message` has been
 * run through `scrubCredentials`, so no credential material can reach a log, an
 * SSE frame or a response body.
 */
export class GitHubError extends Error {
  readonly name = 'GitHubError';
  /** HTTP status, when `gh` reported one. */
  readonly status?: number;
  /** GitHub's machine-readable error code, e.g. `already_exists`, or
   *  `executor_unavailable` when `gh` itself could not be run (R-4.10). */
  readonly ghErrorCode?: string;
  /** The adapter method that failed, e.g. `createBranch`. */
  readonly operation: string;

  constructor(operation: string, message: string, status?: number, ghErrorCode?: string) {
    super(scrubCredentials(message));
    this.operation = operation;
    if (status !== undefined) this.status = status;
    if (ghErrorCode !== undefined) this.ghErrorCode = ghErrorCode;
  }
}

/** GitHub caps `per_page` at 100; the page loop stops on the first short page. */
const PER_PAGE = 100;

/**
 * Hard stop for the page loop. The normal exit is a short page; this exists so a
 * server that never returns one cannot spin forever. 100 pages is 10,000 comments
 * on one pull request — far past any real review, so hitting it means the exit
 * condition is broken, and a truncated read would be worse than a loud failure.
 */
const MAX_PAGES = 100;

const ACCEPT = 'Accept: application/vnd.github+json';

export interface GitHubAdapter {
  /** Resolve a branch to its head commit — the starting point for `createBranch`. */
  getBranch(repo: RepoRef, branch: string): Promise<GitRef>;
  /** R-4.3 — create `refs/heads/<branch>` at `fromSha`. */
  createBranch(repo: RepoRef, branch: string, fromSha: string): Promise<GitRef>;
  /**
   * R-8.18 — delete `refs/heads/<branch>`. Resolves `false` when the ref was already
   * gone (404 / 422), because "there is no orphan" is the outcome the caller wanted.
   */
  deleteBranch(repo: RepoRef, branch: string): Promise<boolean>;
  /** Read a file from a ref. Resolves `null` when it does not exist (404). */
  getFile(repo: RepoRef, path: string, ref: string): Promise<FileContent | null>;
  /**
   * List a directory on a ref, via the same Contents API endpoint as `getFile` —
   * GitHub returns an array instead of an object when `path` is a directory.
   * Resolves `[]` for a missing directory (404) and for a `path` that is a file.
   * Not recursive: the Git Trees API is the recursive option and is deliberately
   * not used here, because a flat documents directory needs no tree walk.
   */
  listFiles(repo: RepoRef, path: string, ref: string): Promise<DirectoryEntry[]>;
  /** R-4.3 — commit file content via the Contents API. Never shells out to git. */
  commitFile(repo: RepoRef, input: CommitFileInput): Promise<CommitResult>;
  /** R-4.3 — open a Pull Request. */
  createPullRequest(repo: RepoRef, input: CreatePullRequestInput): Promise<PullRequest>;
  /**
   * R-11.2 / R-8.19 / R-8.20 — read one Pull Request back: body included (11.1 parses
   * the trailer), and `merged`/`mergeable` included (8.4 observes out-of-band closes
   * and conflicts). A read — no write scope needed.
   */
  getPullRequest(repo: RepoRef, pullNumber: number): Promise<PullRequestDetail>;
  /**
   * R-11.2 — the open Pull Request whose head is `branch`, or `null` when there is
   * none. How the `openCommandFor()` command (which names a branch, not a number)
   * reaches the pull number the open path needs.
   */
  findOpenPullRequestForBranch(repo: RepoRef, branch: string): Promise<PullRequestDetail | null>;
  /**
   * Every Pull Request on the repo, newest first, across all pages — what a "which PRs
   * can I review?" list needs and `findOpenPullRequestForBranch` cannot answer, because
   * that one starts from a branch the caller must already know.
   *
   * Returns summaries, not `PullRequestDetail`: the list endpoint omits `mergeable`
   * (GitHub only computes it per-PR), so promising the detail shape here would mean
   * promising a field that is always `null`. Carries `title` and `author`, which the
   * detail shape lacks and a list has to render.
   *
   * The list endpoint *does* return each pull request's body. It is reduced here to
   * `documentId` (R-7.4) and then dropped, so no caller of this method — least of all a
   * browser — ever holds a body to parse (R-7.5).
   */
  listPullRequests(repo: RepoRef, state?: PullRequestListState): Promise<PullRequestSummary[]>;
  /**
   * R-8.22 — `GET /compare/{base}...{head}`. Called as `compareCommits(repo, branch,
   * baseBranch)`, `files` is exactly "what changed on the base branch since the branch
   * point", which is the question R-8.22 asks.
   */
  compareCommits(repo: RepoRef, base: string, head: string): Promise<BranchComparison>;
  /** R-4.7 — merge a Pull Request. The publish flow deliberately does not call this. */
  mergePullRequest(repo: RepoRef, pullNumber: number, method?: MergeMethod): Promise<MergeResult>;
  /** R-4.4 / R-4.5 — every issue comment on the PR, across all pages. */
  listIssueComments(repo: RepoRef, pullNumber: number): Promise<IssueComment[]>;
  /** R-4.4 — create a PR issue comment. */
  createIssueComment(repo: RepoRef, pullNumber: number, body: string): Promise<IssueComment>;
  /** R-4.4 — update an existing issue comment by its id. */
  updateIssueComment(repo: RepoRef, commentId: number, body: string): Promise<IssueComment>;
  /** R-4.4 — delete an issue comment by its id. */
  deleteIssueComment(repo: RepoRef, commentId: number): Promise<void>;

  /**
   * R-4.5 — every **review** comment on the PR, across all pages, in one array.
   *
   * Callers must group threads only on the complete result (R-5.17): a root on one
   * page whose reply lands on the next would project as an orphan otherwise. `sort`
   * and `direction` are deliberately not passed — the default `created` ascending is
   * what threading wants, and a non-default sort risks a reply preceding its root.
   */
  listReviewComments(repo: RepoRef, pullNumber: number): Promise<ReviewComment[]>;

  /**
   * R-4.4 / R-4.13 — create a review comment, opening a new thread.
   *
   * `commitId` is **required by GitHub** and must be the PR's current head, re-read at
   * creation time; a stale sha makes the comment outdated the moment it is posted.
   *
   * Omitting `line` posts a file-level comment (`subject_type: file`) — the R-4.14
   * fallback for a line outside the diff. This method does not retry on its own: a
   * `422` surfaces as a `GitHubError` with status 422 so the caller can apply the
   * disclosure-then-degrade policy rather than having it buried here.
   */
  createReviewComment(repo: RepoRef, pullNumber: number, input: CreateReviewCommentInput): Promise<ReviewComment>;

  /**
   * R-4.4 — reply inside an existing thread. `commentId` should be the thread root;
   * GitHub flattens, so replying to a reply still attaches to the root.
   */
  replyToReviewComment(repo: RepoRef, pullNumber: number, commentId: number, body: string): Promise<ReviewComment>;

  /**
   * R-4.6 / R-4.15 — the one GraphQL read in the adapter: review-thread resolution.
   *
   * REST's review-comment payload carries no `resolved` field and no thread id at all
   * (verified), so this is not a preference. Results join onto the REST projection by
   * `rootCommentId`, which is GraphQL's `databaseId` — the same integer REST uses.
   *
   * Nothing is ever written over GraphQL: resolving happens on github.com (R-5.13).
   */
  listThreadResolution(repo: RepoRef, pullNumber: number): Promise<ThreadResolution[]>;
}

/** Input for `createReviewComment`. Omit `line` for a file-level thread. */
export type CreateReviewCommentInput = {
  path: string;
  body: string;
  /** The PR's CURRENT head sha. Required by GitHub. */
  commitId: string;
  /** Omit for `subject_type: file`. */
  line?: number;
  startLine?: number;
  side?: 'LEFT' | 'RIGHT';
};

type Json = Record<string, unknown>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);

/**
 * The one GraphQL document this adapter sends. Threads, their comments' REST integer
 * ids, and resolution — everything `listThreadResolution` needs in a single request.
 *
 * Measured at 1 point against a 5,000/hour budget that is separate from REST's, so
 * this read is cheaper than the conversation read it accompanies.
 */
const REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$after){
        pageInfo{ hasNextPage endCursor }
        nodes{ isResolved isOutdated comments(first:1){ nodes{ databaseId } } }
      }
    }
  }
}`;

/**
 * R-4.11 — classify a `gh api graphql` failure.
 *
 * Separate from `classify()` because the REST classifier reads an `(HTTP nnn)` marker
 * out of stderr, and GraphQL has none to give: it answers **HTTP 200** for schema
 * errors, runtime errors, and partial failures alike. Routing a GraphQL failure
 * through the REST classifier would surface it unclassified, with a status of
 * `undefined` and a message that says nothing useful.
 *
 * What `gh` does give us — verified — is a non-zero exit whenever `errors` is present,
 * *including* a partial failure that also returns usable `data`. So the exit code is a
 * sound failure signal; only the status is missing. `graphqlErrorsIn` below covers the
 * remaining case: a caller that reads the body directly must not mistake a partial
 * error for a complete answer.
 */
function classifyGraphql(operation: string, res: { stdout: string; stderr: string }): GitHubError {
  const message = graphqlErrorsIn(res.stdout) ?? res.stderr.trim() ?? '';
  return new GitHubError(operation, message || 'gh api graphql failed', undefined, 'graphql_error');
}

/**
 * The joined `errors[].message` of a GraphQL response body, or `null` when it carries
 * none. Exported-in-spirit: the partial-failure guard, kept here so both the failure
 * path and the success path consult the same rule.
 */
function graphqlErrorsIn(stdout: string): string | null {
  let body: Json = {};
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (parsed && typeof parsed === 'object') body = parsed as Json;
  } catch {
    return null;
  }
  const errors = Array.isArray(body.errors) ? (body.errors as Json[]) : [];
  if (errors.length === 0) return null;
  return errors.map((e) => str(e.message, 'unknown GraphQL error')).join('; ');
}

/**
 * `owner/repo` out of a `gh api` argument list, for an error that needs to name it.
 *
 * The endpoint is one of the positional arguments — everything else is a flag or a flag's
 * value — so the repo is found by shape rather than by position, which changes per call.
 */
function repoInArgs(args: readonly string[]): string | null {
  for (const arg of args) {
    // Endpoints are written with a leading slash (`/repos/…`); the GraphQL ones are not
    // endpoints at all, so an argument that does not start this way is simply skipped.
    const match = /^\/?repos\/([^/]+\/[^/]+)/.exec(arg);
    if (match) return match[1]!;
  }
  return null;
}

/** Put `canonical` where `stale` was, in whichever argument carried the endpoint. */
function retargetRepo(args: readonly string[], stale: string, canonical: string): string[] {
  return args.map((arg) => (/^\/?repos\//.test(arg) ? arg.replace(`repos/${stale}`, `repos/${canonical}`) : arg));
}

/**
 * The statuses GitHub answers for a repository that has been renamed or transferred.
 *
 * 301 is the read; **307** is the write — a method-preserving redirect, which `gh` will
 * not follow for a POST, and which is therefore the one a reviewer meets in practice. 308
 * is the permanent form of the same thing.
 */
const MOVED = new Set([301, 307, 308]);

/**
 * The message for a move this adapter could NOT resolve on its own.
 *
 * The normal path never reaches here: `call()` asks GitHub for the repository's current
 * name and retries against it (see the note there). This is what is left when even that
 * read fails — the credential cannot see the repository at all, or `gh` is not answering —
 * and at that point the honest instruction is the manual one.
 */
function movedPermanently(repo: string | null): string {
  const named = repo ?? 'the configured repository';
  return (
    `${named} has been renamed or transferred on GitHub, and its current name could not be read back. ` +
    "Point the repository's `origin` remote at its current name (or set `collaboration` in visual-spec.config.ts), then try again."
  );
}

/** Pull `{ status, message, errors[].code }` out of a `gh api` failure. */
function classify(operation: string, res: { stdout: string; stderr: string }, args: readonly string[] = []): GitHubError {
  let body: Json = {};
  try {
    const parsed = JSON.parse(res.stdout) as unknown;
    if (parsed && typeof parsed === 'object') body = parsed as Json;
  } catch {
    // gh writes a plain-text diagnostic when there is no JSON body.
  }
  /*
   * `gh` writes the status two ways, and only one of them was being read.
   *
   *   gh: Not Found (HTTP 404)   ← a failure with a message from the body
   *   gh: HTTP 307               ← a redirect, which has no message of its own
   *
   * The parenthesised form was the only one matched, so every redirect arrived with no
   * status at all — and the branch below that turns a redirect into a sentence could
   * never fire. Found in the browser: a `Send` against a renamed repository showed
   * GitHub's bare "Moved Permanently" long after the code to replace it existed.
   */
  const fromStderr = /\(?HTTP (\d{3})\)?/.exec(res.stderr);
  const status = typeof body.status === 'string' ? Number(body.status) : fromStderr ? Number(fromStderr[1]) : undefined;
  const errors = Array.isArray(body.errors) ? (body.errors as Json[]) : [];
  const code = errors.length > 0 ? str(errors[0]?.code) || undefined : undefined;
  const moved = status !== undefined && MOVED.has(status);
  const message = moved ? movedPermanently(repoInArgs(args)) : str(body.message) || res.stderr.trim() || 'gh api failed';
  return new GitHubError(operation, message, Number.isNaN(status) ? undefined : status, moved ? 'repo_moved' : code);
}

function toPullRequestDetail(raw: Json): PullRequestDetail {
  const head = raw.head as Json | undefined;
  const base = raw.base as Json | undefined;
  return {
    number: num(raw.number),
    headSha: str(head?.sha),
    htmlUrl: str(raw.html_url),
    state: str(raw.state),
    body: str(raw.body),
    headBranch: str(head?.ref),
    baseBranch: str(base?.ref),
    merged: raw.merged === true,
    // `null` means GitHub has not finished computing it — a third answer, kept.
    mergeable: typeof raw.mergeable === 'boolean' ? raw.mergeable : null,
    mergeableState: str(raw.mergeable_state, 'unknown'),
  };
}

/**
 * R-7.4 — the collaboration document a pull request carries, or `undefined`.
 *
 * `parseCommentBody` is the 5.1 parser that `buildPullRequestBody` writes against, and
 * this is the only implementation of the read (R-11.1). Nothing about the body escapes:
 * only the id comes back, so no second parser is ever *possible* downstream.
 *
 * It can throw, on exactly one input: `decodeURIComponent` rejects an undecodable
 * percent-escape, which a hand-edited trailer on github.com can easily produce. One such
 * pull request must not take down the whole list, so a malformed trailer is answered the
 * same way as no trailer — this pull request is not a collaboration document.
 */
function documentIdOf(body: unknown): string | undefined {
  try {
    return parseCommentBody(str(body)).trailer?.documentId || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The list projection. `head.ref` is the **bare** branch name even for a pull request
 * from a fork — GitHub puts the owner-qualified form in `head.label`, which nothing here
 * reads, because a fork's head branch does not exist on this repository and naming it as
 * though it did is how a comparison 404s.
 *
 * `body` is deliberately absent from the result: it is reduced to `documentId` and
 * dropped. R-7.5 says the client does not parse the body, and shipping it would leave
 * that a convention rather than a structural fact.
 */
function toPullRequestSummary(raw: Json): PullRequestSummary {
  const head = raw.head as Json | undefined;
  const base = raw.base as Json | undefined;
  const user = raw.user as Json | undefined;
  const documentId = documentIdOf(raw.body);
  return {
    number: num(raw.number),
    title: str(raw.title),
    state: str(raw.state),
    draft: raw.draft === true,
    headBranch: str(head?.ref),
    baseBranch: str(base?.ref),
    headSha: str(head?.sha),
    htmlUrl: str(raw.html_url),
    author: str(user?.login),
    updatedAt: str(raw.updated_at),
    ...(documentId ? { documentId } : {}),
  };
}

function toIssueComment(raw: Json): IssueComment {
  return {
    id: num(raw.id),
    body: str(raw.body),
    user: str((raw.user as Json | undefined)?.login),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
    htmlUrl: str(raw.html_url),
  };
}

/**
 * Build the adapter. `exec` defaults to spawning `gh`; tests inject a
 * recorded-response executor (R-4.8 / R-12.3).
 */
export function createGitHubAdapter(exec: GhExecutor = defaultExecGh): GitHubAdapter {
  /**
   * Stale name → the name GitHub currently uses. Cached for the adapter's lifetime.
   *
   * A rename does not un-happen, so one read answers every subsequent call. A name that
   * resolved to itself is cached too: that is the overwhelmingly common case, and caching
   * it means a repository with no rename in its past never pays for this twice.
   */
  const canonicalNames = new Map<string, string | null>();

  /**
   * What GitHub currently calls this repository, or `null` if it will not say.
   *
   * `GET /repos/{owner}/{repo}` is a read, and `gh` follows the permanent redirect on a
   * read — so asking the OLD name returns the NEW repository, whose `full_name` is the
   * answer. That asymmetry is the whole trick: the information needed to fix a write is
   * available over exactly the verb that still works.
   */
  async function canonicalRepo(stale: string): Promise<string | null> {
    const cached = canonicalNames.get(stale);
    if (cached !== undefined) return cached;
    const res = await exec(['api', '--method', 'GET', '-H', ACCEPT, `/repos/${stale}`]);
    let resolved: string | null = null;
    if (res.exitCode === 0) {
      try {
        const body = JSON.parse(res.stdout) as Json;
        const fullName = str(body.full_name);
        if (/^[^/]+\/[^/]+$/.test(fullName)) resolved = fullName;
      } catch {
        // A non-JSON body is no answer; the caller falls back to the manual instruction.
      }
    }
    canonicalNames.set(stale, resolved);
    return resolved;
  }

  /**
   * One `gh api` call. Throws `GitHubError` on any non-zero exit.
   *
   * IT FOLLOWS A REPOSITORY RENAME RATHER THAN REPORTING ONE. GitHub answers a write
   * against a renamed or transferred repository with a method-preserving redirect (307,
   * or 301/308), and `gh` will not follow it — so every read kept working while every
   * write failed, and the failure surfaced as GitHub's two-word "Moved Permanently" on
   * whatever the reviewer happened to be doing. Reporting that is not the fix a person
   * wants: the name they have and the name GitHub uses identify the same repository, and
   * GitHub says so. So the retry resolves the current name over the verb that still works
   * and sends the write there.
   *
   * ONCE, AND ONLY ON A MOVE. `retried` closes the loop against a server that answered a
   * redirect for some other reason; anything still failing after the retarget is a real
   * failure and is thrown with its own words.
   */
  async function call<T>(operation: string, args: string[], input?: string, retried = false): Promise<T> {
    const res = await exec(args, input);
    if (res.exitCode === null) {
      // R-4.10: `gh` could not be executed — the path is unavailable, not failing.
      throw new GitHubError(
        operation,
        `GitHub CLI could not be started: ${res.stderr.trim() || 'gh not found on PATH'}`,
        undefined,
        'executor_unavailable',
      );
    }
    if (res.exitCode !== 0) {
      const err = classify(operation, res, args);
      if (err.ghErrorCode === 'repo_moved' && !retried) {
        const stale = repoInArgs(args);
        const canonical = stale ? await canonicalRepo(stale) : null;
        // A name that resolves to itself is not a move this can act on — falling through
        // to the throw is what keeps that from becoming a silent second attempt.
        if (stale && canonical && canonical !== stale) {
          return call<T>(operation, retargetRepo(args, stale, canonical), input, true);
        }
      }
      throw err;
    }
    try {
      return JSON.parse(res.stdout) as T;
    } catch {
      throw new GitHubError(operation, 'gh api returned a non-JSON response');
    }
  }

  const get = (operation: string, endpoint: string) =>
    call<Json>(operation, ['api', '--method', 'GET', '-H', ACCEPT, endpoint]);

  const send = (operation: string, method: 'POST' | 'PATCH' | 'PUT', endpoint: string, body: Json) =>
    call<Json>(operation, ['api', '--method', method, '-H', ACCEPT, endpoint, '--input', '-'], JSON.stringify(body));

  /**
   * One `gh api graphql` call. Deliberately not routed through `call()`: that helper
   * hands a failure to `classify()`, which reads an HTTP status GraphQL never sends
   * (R-4.11). The success path also re-checks for `errors`, because a *partial*
   * failure returns HTTP 200 with both `data` and `errors` — and a caller that trusted
   * `data` alone would treat a half-answer as a whole one.
   */
  async function graphql<T>(operation: string, variables: Json): Promise<T> {
    const args = ['api', 'graphql', '-f', `query=${REVIEW_THREADS_QUERY}`];
    for (const [key, value] of Object.entries(variables)) {
      if (value === undefined || value === null) continue;
      args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${String(value)}`);
    }
    const res = await exec(args);
    if (res.exitCode === null) {
      throw new GitHubError(
        operation,
        `GitHub CLI could not be started: ${res.stderr.trim() || 'gh not found on PATH'}`,
        undefined,
        'executor_unavailable',
      );
    }
    if (res.exitCode !== 0) throw classifyGraphql(operation, res);
    const errors = graphqlErrorsIn(res.stdout);
    if (errors) throw new GitHubError(operation, errors, undefined, 'graphql_error');
    try {
      return JSON.parse(res.stdout) as T;
    } catch {
      throw new GitHubError(operation, 'gh api graphql returned a non-JSON response');
    }
  }

  return {
    async getBranch(repo, branch) {
      const raw = await get('getBranch', `/repos/${repo.owner}/${repo.repo}/git/ref/heads/${branch}`);
      return { ref: str(raw.ref), sha: str((raw.object as Json | undefined)?.sha) };
    },

    async createBranch(repo, branch, fromSha) {
      const raw = await send('createBranch', 'POST', `/repos/${repo.owner}/${repo.repo}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: fromSha,
      });
      return { ref: str(raw.ref), sha: str((raw.object as Json | undefined)?.sha) };
    },

    async deleteBranch(repo, branch) {
      const endpoint = `/repos/${repo.owner}/${repo.repo}/git/refs/heads/${branch}`;
      const res = await exec(['api', '--method', 'DELETE', '-H', ACCEPT, endpoint]);
      if (res.exitCode === null) {
        throw new GitHubError(
          'deleteBranch',
          `GitHub CLI could not be started: ${res.stderr.trim() || 'gh not found on PATH'}`,
          undefined,
          'executor_unavailable',
        );
      }
      // 204 No Content — gh exits 0 with an empty body, so there is nothing to parse.
      if (res.exitCode === 0) return true;
      const err = classify('deleteBranch', res);
      // Already gone is the outcome the caller asked for, not a failure (R-8.18).
      if (err.status === 404 || err.status === 422) return false;
      throw err;
    },

    async getFile(repo, path, ref) {
      try {
        const raw = await get('getFile', `/repos/${repo.owner}/${repo.repo}/contents/${path}?ref=${ref}`);
        // GitHub wraps base64 at 60 columns; strip whitespace before decoding.
        const encoded = str(raw.content).replace(/\s+/g, '');
        return { path: str(raw.path, path), sha: str(raw.sha), content: Buffer.from(encoded, 'base64').toString('utf8') };
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) return null;
        throw err;
      }
    },

    async listFiles(repo, path, ref) {
      const endpoint = `/repos/${repo.owner}/${repo.repo}/contents/${path}?ref=${ref}`;
      try {
        const raw = await call<Json[]>('listFiles', ['api', '--method', 'GET', '-H', ACCEPT, endpoint]);
        // A file path answers with an object, not an array — nothing to list.
        if (!Array.isArray(raw)) return [];
        return raw.map((e) => ({ name: str(e.name), path: str(e.path), sha: str(e.sha), type: str(e.type) }));
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) return [];
        throw err;
      }
    },

    async commitFile(repo, input) {
      // Contents API only — see the file header. No git subprocess exists here.
      const raw = await send('commitFile', 'PUT', `/repos/${repo.owner}/${repo.repo}/contents/${input.path}`, {
        message: input.message,
        content: Buffer.from(input.content, 'utf8').toString('base64'),
        branch: input.branch,
        ...(input.sha ? { sha: input.sha } : {}),
      });
      return {
        path: str((raw.content as Json | undefined)?.path, input.path),
        commitSha: str((raw.commit as Json | undefined)?.sha),
        contentSha: str((raw.content as Json | undefined)?.sha),
      };
    },

    async createPullRequest(repo, input) {
      const raw = await send('createPullRequest', 'POST', `/repos/${repo.owner}/${repo.repo}/pulls`, {
        title: input.title,
        head: input.head,
        base: input.base,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.draft !== undefined ? { draft: input.draft } : {}),
      });
      return {
        number: num(raw.number),
        headSha: str((raw.head as Json | undefined)?.sha),
        htmlUrl: str(raw.html_url),
        state: str(raw.state),
      };
    },

    async getPullRequest(repo, pullNumber) {
      const raw = await get('getPullRequest', `/repos/${repo.owner}/${repo.repo}/pulls/${pullNumber}`);
      return toPullRequestDetail(raw);
    },

    async findOpenPullRequestForBranch(repo, branch) {
      const endpoint = `/repos/${repo.owner}/${repo.repo}/pulls?state=open&head=${repo.owner}:${branch}`;
      const raw = await call<Json[]>('findOpenPullRequestForBranch', ['api', '--method', 'GET', '-H', ACCEPT, endpoint]);
      const first = Array.isArray(raw) ? raw[0] : undefined;
      return first ? toPullRequestDetail(first) : null;
    },

    async listPullRequests(repo, state = 'open') {
      const out: PullRequestSummary[] = [];
      // Same explicit page loop as the comment lists: the buffered executor cannot
      // see `Link` headers, so the short page is the only available exit.
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const endpoint = `/repos/${repo.owner}/${repo.repo}/pulls?state=${state}&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`;
        const raw = await call<Json[]>('listPullRequests', ['api', '--method', 'GET', '-H', ACCEPT, endpoint]);
        const items = Array.isArray(raw) ? raw : [];
        for (const item of items) out.push(toPullRequestSummary(item));
        if (items.length < PER_PAGE) return out;
      }
      throw new Error(`listPullRequests: ${repo.owner}/${repo.repo} did not terminate within ${MAX_PAGES} pages of ${PER_PAGE}`);
    },

    async compareCommits(repo, base, head) {
      const raw = await get('compareCommits', `/repos/${repo.owner}/${repo.repo}/compare/${base}...${head}`);
      const files = Array.isArray(raw.files) ? (raw.files as Json[]) : [];
      return {
        mergeBaseSha: str((raw.merge_base_commit as Json | undefined)?.sha),
        aheadBy: typeof raw.ahead_by === 'number' ? raw.ahead_by : 0,
        behindBy: typeof raw.behind_by === 'number' ? raw.behind_by : 0,
        files: files.map((f) => str(f.filename)).filter((f) => f !== ''),
      };
    },

    async mergePullRequest(repo, pullNumber, method = 'merge') {
      const raw = await send('mergePullRequest', 'PUT', `/repos/${repo.owner}/${repo.repo}/pulls/${pullNumber}/merge`, {
        merge_method: method,
      });
      return { merged: raw.merged === true, sha: str(raw.sha), message: str(raw.message) };
    },

    async listIssueComments(repo, pullNumber) {
      const out: IssueComment[] = [];
      // Explicit page loop — the buffered executor cannot see `Link` headers.
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const endpoint = `/repos/${repo.owner}/${repo.repo}/issues/${pullNumber}/comments?per_page=${PER_PAGE}&page=${page}`;
        const raw = await call<Json[]>('listIssueComments', ['api', '--method', 'GET', '-H', ACCEPT, endpoint]);
        const items = Array.isArray(raw) ? raw : [];
        for (const item of items) out.push(toIssueComment(item));
        if (items.length < PER_PAGE) return out;
      }
      // Fail rather than return a silently truncated comment list: callers resolve
      // and reply against this, so a missing page reads as a deleted comment.
      throw new Error(
        `listIssueComments: pull ${pullNumber} did not terminate within ${MAX_PAGES} pages of ${PER_PAGE}`,
      );
    },

    async createIssueComment(repo, pullNumber, body) {
      const raw = await send('createIssueComment', 'POST', `/repos/${repo.owner}/${repo.repo}/issues/${pullNumber}/comments`, { body });
      return toIssueComment(raw);
    },

    async updateIssueComment(repo, commentId, body) {
      const raw = await send('updateIssueComment', 'PATCH', `/repos/${repo.owner}/${repo.repo}/issues/comments/${commentId}`, { body });
      return toIssueComment(raw);
    },

    async deleteIssueComment(repo, commentId) {
      const endpoint = `/repos/${repo.owner}/${repo.repo}/issues/comments/${commentId}`;
      const res = await exec(['api', '--method', 'DELETE', '-H', ACCEPT, endpoint]);
      if (res.exitCode === null) {
        throw new GitHubError(
          'deleteIssueComment',
          `GitHub CLI could not be started: ${res.stderr.trim() || 'gh not found on PATH'}`,
          undefined,
          'executor_unavailable',
        );
      }
      // 204 No Content — gh exits 0 with an empty body, so there is nothing to parse.
      if (res.exitCode !== 0) throw classify('deleteIssueComment', res);
    },

    async listReviewComments(repo, pullNumber) {
      const out: ReviewComment[] = [];
      // Same explicit page loop as `listIssueComments`, for the same reason: the
      // buffered executor cannot see `Link` headers.
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const endpoint = `/repos/${repo.owner}/${repo.repo}/pulls/${pullNumber}/comments?per_page=${PER_PAGE}&page=${page}`;
        const raw = await call<Json[]>('listReviewComments', ['api', '--method', 'GET', '-H', ACCEPT, endpoint]);
        const items = Array.isArray(raw) ? raw : [];
        for (const item of items) out.push(toReviewComment(item));
        if (items.length < PER_PAGE) return out;
      }
      // A truncated list is worse than a loud failure here: threading groups on the
      // whole result, so a missing page turns replies into orphan threads (R-5.17).
      throw new Error(
        `listReviewComments: pull ${pullNumber} did not terminate within ${MAX_PAGES} pages of ${PER_PAGE}`,
      );
    },

    async createReviewComment(repo, pullNumber, input) {
      const body: Json = {
        body: input.body,
        path: input.path,
        commit_id: input.commitId,
      };
      if (input.line === undefined) {
        // No line ⇒ a file-level thread. GitHub requires `subject_type` to be explicit;
        // sending neither `line` nor `subject_type` is a 422 of its own.
        body.subject_type = 'file';
      } else {
        body.line = input.line;
        body.side = input.side ?? 'RIGHT';
        if (input.startLine !== undefined && input.startLine !== input.line) {
          body.start_line = input.startLine;
          body.start_side = input.side ?? 'RIGHT';
        }
      }
      const raw = await send(
        'createReviewComment',
        'POST',
        `/repos/${repo.owner}/${repo.repo}/pulls/${pullNumber}/comments`,
        body,
      );
      return toReviewComment(raw);
    },

    async replyToReviewComment(repo, pullNumber, commentId, body) {
      const raw = await send(
        'replyToReviewComment',
        'POST',
        `/repos/${repo.owner}/${repo.repo}/pulls/${pullNumber}/comments/${commentId}/replies`,
        { body },
      );
      return toReviewComment(raw);
    },

    async listThreadResolution(repo, pullNumber) {
      const out: ThreadResolution[] = [];
      let after: string | undefined;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const raw = await graphql<Json>('listThreadResolution', {
          owner: repo.owner,
          repo: repo.repo,
          number: pullNumber,
          ...(after ? { after } : {}),
        });
        const threads = (((raw.data as Json | undefined)?.repository as Json | undefined)?.pullRequest as Json | undefined)
          ?.reviewThreads as Json | undefined;
        const nodes = Array.isArray(threads?.nodes) ? (threads?.nodes as Json[]) : [];
        for (const node of nodes) {
          const comments = node.comments as Json | undefined;
          const first = Array.isArray(comments?.nodes) ? (comments?.nodes as Json[])[0] : undefined;
          const rootCommentId = num(first?.databaseId);
          // A thread with no readable root cannot be joined to anything, so carrying
          // it would produce resolution state attached to no comment.
          if (Number.isNaN(rootCommentId)) continue;
          out.push({
            rootCommentId,
            isResolved: node.isResolved === true,
            isOutdated: node.isOutdated === true,
          });
        }
        const pageInfo = threads?.pageInfo as Json | undefined;
        if (pageInfo?.hasNextPage !== true) return out;
        after = str(pageInfo.endCursor) || undefined;
        if (!after) return out;
      }
      throw new Error(`listThreadResolution: pull ${pullNumber} did not terminate within ${MAX_PAGES} pages`);
    },
  };
}
