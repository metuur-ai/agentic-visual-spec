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
import { type GhExecutor, defaultExecGh, scrubCredentials } from './github-executor';

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

const ACCEPT = 'Accept: application/vnd.github+json';

export interface GitHubAdapter {
  /** Resolve a branch to its head commit — the starting point for `createBranch`. */
  getBranch(repo: RepoRef, branch: string): Promise<GitRef>;
  /** R-4.3 — create `refs/heads/<branch>` at `fromSha`. */
  createBranch(repo: RepoRef, branch: string, fromSha: string): Promise<GitRef>;
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
}

type Json = Record<string, unknown>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);

/** Pull `{ status, message, errors[].code }` out of a `gh api` failure. */
function classify(operation: string, res: { stdout: string; stderr: string }): GitHubError {
  let body: Json = {};
  try {
    const parsed = JSON.parse(res.stdout) as unknown;
    if (parsed && typeof parsed === 'object') body = parsed as Json;
  } catch {
    // gh writes a plain-text diagnostic when there is no JSON body.
  }
  const fromStderr = /\(HTTP (\d{3})\)/.exec(res.stderr);
  const status = typeof body.status === 'string' ? Number(body.status) : fromStderr ? Number(fromStderr[1]) : undefined;
  const errors = Array.isArray(body.errors) ? (body.errors as Json[]) : [];
  const code = errors.length > 0 ? str(errors[0]?.code) || undefined : undefined;
  const message = str(body.message) || res.stderr.trim() || 'gh api failed';
  return new GitHubError(operation, message, Number.isNaN(status) ? undefined : status, code);
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
  /** One `gh api` call. Throws `GitHubError` on any non-zero exit. */
  async function call<T>(operation: string, args: string[], input?: string): Promise<T> {
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
    if (res.exitCode !== 0) throw classify(operation, res);
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

    async mergePullRequest(repo, pullNumber, method = 'merge') {
      const raw = await send('mergePullRequest', 'PUT', `/repos/${repo.owner}/${repo.repo}/pulls/${pullNumber}/merge`, {
        merge_method: method,
      });
      return { merged: raw.merged === true, sha: str(raw.sha), message: str(raw.message) };
    },

    async listIssueComments(repo, pullNumber) {
      const out: IssueComment[] = [];
      // Explicit page loop — the buffered executor cannot see `Link` headers.
      for (let page = 1; ; page += 1) {
        const endpoint = `/repos/${repo.owner}/${repo.repo}/issues/${pullNumber}/comments?per_page=${PER_PAGE}&page=${page}`;
        const raw = await call<Json[]>('listIssueComments', ['api', '--method', 'GET', '-H', ACCEPT, endpoint]);
        const items = Array.isArray(raw) ? raw : [];
        for (const item of items) out.push(toIssueComment(item));
        if (items.length < PER_PAGE) return out;
      }
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
  };
}
