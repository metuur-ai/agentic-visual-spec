/**
 * review-session-collab.ts — the collaborative arm of `ReviewSessionOps` (EARS Unit 9).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE OF ITS OWN, IN THIS DIRECTORY
 * ---------------------------------------------------------------------------
 *
 * `local-mode.regression.test.ts` (R-10.5) scans a fixed list of modules and fails on the
 * source text `github`, `octokit`, `pullNumber`, `headSha`, `issueCommentId`, `documentId`
 * or `nodeVersion`. `core/vite/routes/review.ts` is on that list deliberately, and the two
 * things this arm is built out of — a branch head to pin (R-9.7) and a document identity
 * to resolve (R-9.1) — are two of the forbidden words. That is not an inconvenience to be
 * routed around; it is the guard saying, correctly, that collaboration identity must not
 * appear on the local review path. So the arm arrives here, behind the interface, and the
 * hub reaches it through the injection seam it already had without naming it.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE DIFFERENCES, AS THEY LAND (LLD decision (b))
 * ---------------------------------------------------------------------------
 *
 *   comment source     — the client's projected record, carried on the start request.
 *                        Collaborative comments are projected at runtime and exist
 *                        nowhere else; R-9.1 bars reading the sidecar for one.
 *   target resolution  — the node id, exactly, with no snippet or line ladder (R-9.2).
 *                        No node id means the comment is about the document (R-9.3).
 *   drift              — the branch head moved, or the node is gone (R-9.7).
 *   terminal state     — no status and no result on disk (R-9.5); a `ready-to-publish`
 *                        frame (R-9.6) and a reply on the conversation (R-9.10).
 *   fallback           — none. There is no scoped re-derive pass on this path.
 *
 * Plus the sixth and seventh the interface grew for this arm: `promptMode` (which arm of
 * the prompt to run) and `admitPatch` (R-9.4's confinement, enforced by the server rather
 * than asked for in the prompt).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE READS AND DOES NOT READ (R-9.1)
 * ---------------------------------------------------------------------------
 *
 * It never touches `visual-spec-comments.json`. It never constructs a `CommentDocStore`.
 * `ReviewDeps.comments` is in scope through the selector below and is deliberately not
 * passed in here — a collaborative session runs identically with the sidecar deleted, and
 * `review-session-collab.test.ts` asserts exactly that by handing the selector a store
 * whose every method throws.
 */
import { createGitHubAdapter, type GitHubAdapter, type RepoRef } from './github-adapter';
import type { CollaborationRecord, GitHubBinding } from './document-record';
import type { CollaborationStore } from './record-store';
import {
  createLocalSessionOps,
  type DriftCheck,
  type LocatedTarget,
  type PatchAdmission,
  type ResolvedComment,
  type ReviewDeps,
  type ReviewEvent,
  type ReviewOutcome,
  type ReviewSessionOps,
  type ReviewStartRequest,
} from '../vite/routes/review';

/* ------------------------------------------------------------------ *
 * The start contract (C1.1 — R-8.8, R-9.1)
 * ------------------------------------------------------------------ */

/**
 * The projected comment record, as the client holds it.
 *
 * WHY THE CLIENT SENDS THIS RATHER THAN THE SERVER RESOLVING IT. A collaborative comment
 * is projected at runtime — `projectIssueComment` and `projectReviewThread` mint the
 * `c-<hex>` id from the GitHub comment id — so the record exists only inside the browser's
 * projection. The id identifies neither a repository nor a pull request, no route resolves
 * one, and R-9.1 forbids falling back to the sidecar. The LLD weighed a server-side
 * re-resolution route against this and chose this: no extra route, no GitHub round trip on
 * the start path, and no second projection site to drift from the first. The cost is that
 * the server trusts client-supplied text, which is the trust boundary every other
 * unauthenticated `/__vs/*` route already assumes.
 *
 * `reviewCommentId` / `issueCommentId` are not decoration: the projected id is `c-<8hex>`
 * for **both** kinds of comment (`recordIdFor` and `reviewRecordIdFor` are the same
 * function over different inputs), so the id alone cannot say which conversation the
 * reply of R-9.10 belongs on. The client knows; the server cannot work it out.
 */
export type CollabReviewComment = {
  id: string;
  /** The comment's text — what the reviewer wrote, with any trailer already stripped. */
  text: string;
  workflow: string;
  /** The collaborative anchor. Absent means document-level (R-9.3). */
  nodeId?: string;
  /** Set when this is a review-thread comment; the reply goes inside the thread. */
  reviewCommentId?: number;
  /** Set when this is a PR issue comment; the conversation is flat. */
  issueCommentId?: number;
};

/** Everything a collaborative session needs, all of it on the start request (R-8.8). */
export type CollabReviewStart = {
  commentId: string;
  documentId: string;
  /** The canonical document. Every write is confined to it (R-9.4). */
  documentPath: string;
  comment: CollabReviewComment;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);

/**
 * Read a collaborative start payload out of the opaque request, or answer `null`.
 *
 * `null` is not an error — it is how the selector below tells a local start from a
 * collaborative one. A malformed collaborative payload therefore reads as a local start
 * and fails at the sidecar lookup, which is a worse message than it could be; the
 * alternative is a `mode` field on the request, which is the one thing the LLD asks the
 * design not to grow. The fields checked here are exactly the ones with no local meaning,
 * so a local body cannot satisfy them by accident.
 */
export function parseCollabStart(request: ReviewStartRequest): CollabReviewStart | null {
  const documentId = str(request.documentId);
  const documentPath = str(request.documentPath);
  const raw = request.comment as Record<string, unknown> | undefined;
  if (!documentId || !documentPath || !raw || typeof raw !== 'object') return null;
  const id = str(raw.id) ?? str(request.commentId);
  const text = typeof raw.text === 'string' ? raw.text : null;
  if (!id || text === null) return null;
  return {
    commentId: request.commentId,
    documentId,
    documentPath,
    comment: {
      id,
      text,
      workflow: str(raw.workflow) ?? 'visual-spec',
      ...(str(raw.nodeId) ? { nodeId: raw.nodeId as string } : {}),
      ...(int(raw.reviewCommentId) !== undefined ? { reviewCommentId: int(raw.reviewCommentId) as number } : {}),
      ...(int(raw.issueCommentId) !== undefined ? { issueCommentId: int(raw.issueCommentId) as number } : {}),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Target resolution (C1.2 — R-9.2, R-9.3)
 * ------------------------------------------------------------------ */

/**
 * Does this document carry the node the comment names?
 *
 * EXACT, WITH NO LADDER. R-9.2 rules out the snippet + heading fallback local mode uses,
 * and the reason is that a collaborative anchor was *issued* rather than observed: a node
 * id either names a node that is still there or it names one that is gone, and guessing
 * which paragraph it used to mean is a fabricated claim about what the reviewer pointed at.
 *
 * ⚠ READ THIS BEFORE TREATING A FAILURE HERE AS A BUG. The document format changed under
 * this requirement. `document-record.ts` now states the document IS the Markdown file —
 * there is no JSON envelope and no node list — and `ui/collab-comment-source.ts` records
 * that the nodeId-keyed resolver "went with the format that issued the ids". Live review
 * threads are projected with line anchors and carry no `nodeId` at all, so in practice
 * every collaborative comment today takes the R-9.3 document-level path and this function
 * is never asked a question it can answer yes to. It scans for an explicit node marker
 * because that is the only exact answer a Markdown file can give; a document with no
 * markers answers "no such node" for every id, which is correct and is not a fallback.
 * Reconciling R-9.2/R-9.4 with the Markdown-canonical format is a spec decision, not
 * something to patch in here by quietly reintroducing a line lookup.
 */
export function documentHasNode(markdown: string, nodeId: string): boolean {
  if (!nodeId) return false;
  const id = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:vs-node:\\s*|data-vs-node-id=["'])${id}(?=["'\\s>]|$)`, 'm').test(markdown);
}

/* ------------------------------------------------------------------ *
 * Write confinement (C1.3 — R-9.4)
 * ------------------------------------------------------------------ */

/**
 * Every file path a unified diff would touch.
 *
 * Deliberately generous about what counts as a path claim: `diff --git`, `---` and `+++`
 * are all read, and anything that is not `/dev/null` is a file this patch reaches. Being
 * generous is the safe direction — a header this misses is a file that escapes the
 * confinement check, and a header it over-reads only ever refuses a patch.
 */
export function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const cleaned = raw.trim().split('\t')[0]?.trim();
    if (!cleaned || cleaned === '/dev/null') return;
    paths.add(cleaned.replace(/^[ab]\//, '').replace(/^\.\//, ''));
  };
  for (const line of patch.split('\n')) {
    const git = /^diff --git (?:"?[ab]\/)?(.+?)"? (?:"?[ab]\/)?(.+?)"?$/.exec(line);
    if (git) {
      add(git[1]);
      add(git[2]);
      continue;
    }
    const minus = /^--- (.+)$/.exec(line);
    if (minus) add(minus[1]);
    const plus = /^\+\+\+ (.+)$/.exec(line);
    if (plus) add(plus[1]);
  }
  return [...paths];
}

/**
 * R-9.4 — the patch may touch the canonical document and nothing else.
 *
 * THE PROMPT IS NOT THE BOUNDARY. `review-prompt.ts` tells the model which file it may
 * edit, and that shapes what a good-faith model proposes; it decides nothing about what
 * the server writes. This does. A patch reaching any other path is refused before
 * `git apply` runs, so the refusal costs nothing and leaves the tree untouched.
 */
export function admitPatchFor(documentPath: string, patch: string): PatchAdmission {
  const wanted = documentPath.replace(/^\.\//, '');
  const outside = patchPaths(patch).filter((p) => p !== wanted);
  if (outside.length === 0) return { ok: true };
  return {
    ok: false,
    reason: `the proposed patch would edit ${outside.join(', ')}, but a collaborative review may only change ${wanted}`,
  };
}

/* ------------------------------------------------------------------ *
 * The arm
 * ------------------------------------------------------------------ */

export type CollabSessionDeps = {
  /** Where the canonical document and its GitHub binding are read from. */
  documents: () => CollaborationStore;
  /** Injectable so a test never execs `gh`. */
  adapter?: (binding: GitHubBinding) => GitHubAdapter;
};

function repoOf(binding: GitHubBinding): RepoRef {
  return { owner: binding.owner, repo: binding.repo };
}

/**
 * The branch head to pin, and to compare against later (R-9.7).
 *
 * Read from GitHub rather than from the record's cached binding, because the record is
 * only re-written when the document is synced and a head that never moves cannot detect a
 * head that did. The cached value is the fallback for a document with no pull request yet,
 * where there is nothing to poll.
 */
async function headOf(record: CollaborationRecord, deps: CollabSessionDeps): Promise<string | null> {
  const binding = record.github;
  if (!binding) return null;
  const cached = typeof binding.headSha === 'string' ? binding.headSha : null;
  if (typeof binding.pullNumber !== 'number' || !binding.owner || !binding.repo) return cached;
  try {
    const pr = await (deps.adapter ?? (() => createGitHubAdapter()))(binding).getPullRequest(repoOf(binding), binding.pullNumber);
    return pr.headSha || cached;
  } catch {
    // A read failure is not drift. Falling back to the cached head means the approval is
    // judged against the last head we provably saw, which is the same answer this session
    // pinned with — so a flaky network refuses nothing and invents no staleness.
    return cached;
  }
}

/** The reply that records what was applied (R-9.10). */
function replyBody(outcome: ReviewOutcome, documentPath: string): string {
  return [
    `Applied via visual-spec review — \`${documentPath}\``,
    '',
    outcome.result,
    '',
    'This note records what was applied. It does not resolve the thread and it does not publish: the change is on the local copy of the branch until a person publishes it.',
  ].join('\n');
}

/**
 * The collaborative implementation. One session, built from the start request.
 *
 * It is constructed per session rather than per hub because everything it is made of —
 * which document, which comment, which conversation — arrives with the request. That is
 * the only shape in which "the record exists only in the client's projection" (R-9.1) can
 * be true and the server can still do the work.
 */
export function createCollabSessionOps(deps: CollabSessionDeps, start: CollabReviewStart): ReviewSessionOps {
  const { documentPath, documentId, comment } = start;
  const readRecord = () => deps.documents().read(documentId);

  return {
    /** R-9.5's other half, stated here: there is nothing to fall back to that would write. */
    fallbackAvailable: false,
    promptMode: { mode: 'collab', documentPath },

    /**
     * C1.1 — the record comes off the request, and nothing is read to confirm it.
     *
     * Not even a "does this comment really exist on the PR?" check, which would be a
     * GitHub round trip on the start path to re-derive something the client already holds,
     * and would put a second projection beside the first (LLD option (b), rejected).
     */
    async resolve(): Promise<ResolvedComment | null> {
      return {
        id: comment.id,
        comment: comment.text,
        workflow: comment.workflow,
        path: documentPath,
        kind: 'file',
        ...(comment.nodeId ? { collab: { nodeId: comment.nodeId } } : {}),
      };
    },

    /** C1.2 + the propose-time pin of C1.4. */
    async locate(resolved: ResolvedComment): Promise<LocatedTarget | null> {
      const record = await readRecord();
      if (!record) return null;
      const nodeId = resolved.collab?.nodeId;
      // R-9.2 — exact, no ladder. R-9.3 — no node id is not a failure to locate, it is a
      // comment about the whole document, which is a perfectly locatable thing.
      if (nodeId && !documentHasNode(record.markdown, nodeId)) return null;
      // R-9.7 — the pin is the branch head, not a hash of the bytes. The canonical
      // document lives on a branch, so "did anything move under this proposal" is answered
      // by the head, which is cheaper than a content diff and catches changes to the
      // document that arrived through a commit rather than through this session.
      return { path: documentPath, pin: await headOf(record, deps) };
    },

    /** C1.4 — R-9.7's two signals: the head moved, or the node is gone. */
    async checkDrift(located: LocatedTarget): Promise<DriftCheck> {
      const record = await readRecord();
      if (!record) return { drifted: true, reason: `${documentPath} is no longer available locally` };
      const head = await headOf(record, deps);
      if (head !== located.pin) {
        return { drifted: true, reason: 'the branch moved since the proposal — review the change again before approving' };
      }
      if (comment.nodeId && !documentHasNode(record.markdown, comment.nodeId)) {
        return { drifted: true, reason: 'the commented node is no longer in the document' };
      }
      return { drifted: false };
    },

    /** C1.3 — R-9.4, enforced rather than requested. */
    admitPatch(patch: string): PatchAdmission {
      return admitPatchFor(documentPath, patch);
    },

    /**
     * C1.5 + C1.6 — the terminal act, and what it deliberately does not do.
     *
     * R-9.5: nothing is written to any file. No `status`, no `result`, no sidecar record,
     * no GitHub comment body rewritten. The only durable trace is the reply below, and the
     * bytes the patch already landed.
     *
     * R-9.6: the session ends at `ready-to-publish` carrying the document path. It does
     * not publish, and there is no code path here that could — publishing is a human act
     * by design and this module holds no publish call.
     *
     * R-9.11: the comment goes on projecting as `open` after this runs, and that is
     * correct rather than a leak. `status` records whether the **local apply agent** has
     * acted; a collaborative comment's local status has no file to live in (R-9.5), so it
     * re-projects `open` on the next read. `review-comments.ts` rules out the tempting fix
     * — deriving it from GitHub's `isResolved` (R-5.21) — because that conflates "the
     * agent acted here" with "a human closed the thread over there" and gives the system
     * two resolution models that can disagree with nothing able to say which is right. So
     * the indicator stays up until the thread is resolved on github.com. It looks exactly
     * like a bug and it is the design.
     */
    async finish(_resolved: ResolvedComment, outcome: ReviewOutcome): Promise<ReviewEvent[]> {
      const out: ReviewEvent[] = [];
      try {
        const posted = await postResolutionReply(deps, documentId, comment, outcome, documentPath);
        if (!posted) {
          out.push({
            type: 'error',
            message: 'The change was applied, but there was no conversation to record it on — no reply was posted.',
          });
        }
      } catch (err) {
        // The write already happened; failing the approval now would be a lie about the
        // file. So the reply's failure is reported as its own fact and the session still
        // completes (R-9.10 is the act, not a precondition for the act that preceded it).
        out.push({ type: 'error', message: `The change was applied, but the reply could not be posted: ${(err as Error).message}` });
      }
      out.push({ type: 'ready-to-publish', documentPath });
      return out;
    },
  };
}

/** R-9.10 — record what was applied on the conversation the comment came from. */
async function postResolutionReply(
  deps: CollabSessionDeps,
  documentId: string,
  comment: CollabReviewComment,
  outcome: ReviewOutcome,
  documentPath: string,
): Promise<boolean> {
  const record = await deps.documents().read(documentId);
  const binding = record?.github;
  if (!binding || typeof binding.pullNumber !== 'number' || !binding.owner || !binding.repo) return false;
  const adapter = (deps.adapter ?? (() => createGitHubAdapter()))(binding);
  const body = replyBody(outcome, documentPath);
  if (typeof comment.reviewCommentId === 'number') {
    // Inside the thread, so the record sits where the reviewer will look for it. GitHub
    // flattens replies onto the root, so this attaches correctly whichever comment in the
    // thread the reviewer's record was projected from.
    await adapter.replyToReviewComment(repoOf(binding), binding.pullNumber, comment.reviewCommentId, body);
    return true;
  }
  if (typeof comment.issueCommentId === 'number') {
    // A PR issue comment has no thread to reply inside — the conversation is flat — so the
    // record is a new comment on the same conversation, quoting which one it answers.
    await adapter.createIssueComment(repoOf(binding), binding.pullNumber, `${body}\n\nIn reply to comment ${comment.issueCommentId}.`);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * The seam the hosts wire
 * ------------------------------------------------------------------ */

/**
 * Choose the arm for one session from the start request.
 *
 * This is the whole of the wiring, and it is the only place in the system that knows two
 * arms exist. `createReviewHub` takes it through the parameter it already had; the hub
 * never calls `parseCollabStart`, never sees a `mode`, and gained no branch when this
 * arrived — which is the property LLD decision (b) was written to buy.
 */
export function createReviewSessionOpsSelector(
  deps: CollabSessionDeps,
): (getDeps: () => ReviewDeps, request: ReviewStartRequest) => ReviewSessionOps {
  return (getDeps, request) => {
    const start = parseCollabStart(request);
    return start ? createCollabSessionOps(deps, start) : createLocalSessionOps(getDeps);
  };
}
