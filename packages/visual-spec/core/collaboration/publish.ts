/**
 * publish.ts — publish: commit, then verify, and **never merge** (R-8.9 … R-8.14).
 *
 * A sibling of `lifecycle.ts`, in the same shape: it exports a bare `JobBody` factory
 * that the 7.2 routes hand to the 8.1 hub. It owns no hub, no state and no poller, and
 * every GitHub call goes through the 4.1 adapter.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ORDER IS COMMIT → VERIFY, AND WHY MERGE IS NOT HERE (LLD §7)
 * ---------------------------------------------------------------------------
 * Verifying *after* a merge would discover bad bytes only once they are on the base
 * branch, in a state that by rule must not self-heal (R-8.21 forbids regenerating or
 * overwriting). Verifying immediately after the commit catches a mismatch while it is
 * still confined to the PR branch, which is exactly where a human can look at it.
 *
 * **Merge is deliberately not part of publish.** Publishing writes the final artifacts
 * to the PR branch and stops; merging happens on github.com where the reviewers already
 * are. That removes the irreversible half of the write primitive from an unauthenticated
 * localhost endpoint at no cost to the workflow. `adapter.mergePullRequest` exists and is
 * never called from this module — `publish.test.ts` asserts no merge endpoint is reached.
 *
 * ---------------------------------------------------------------------------
 * WHAT GETS COMMITTED, AND WHERE
 * ---------------------------------------------------------------------------
 * Two artifacts, both derived from `document.documentPath` so nothing has to be stored
 * to find them again:
 *
 *   - the canonical JSON at `document.documentPath` (`documents/<id>.json`) — the
 *     envelope the 3.1 stores read, with the client's payload installed as `doc`;
 *   - the generated Markdown at `markdownPathFor(document.documentPath)`, i.e. the same
 *     path with `.json` swapped for `.md` (`documents/<id>.md`).
 *
 * The Markdown path is a pure function of the document path, so task 11.x and the
 * changelog read it back with `markdownPathFor` rather than a persisted field that could
 * drift from the branch it claims to describe.
 *
 * ---------------------------------------------------------------------------
 * VERIFICATION: RE-READ THE BLOB, DO NOT TRUST THE WRITE'S OWN ECHO (R-8.10 / R-8.11)
 * ---------------------------------------------------------------------------
 * After both commits, each path is read back off the branch with `getFile` and checked
 * two ways: the returned content must equal the bytes we sent, and the blob sha GitHub
 * reports for it must equal `gitBlobSha(bytes)` computed here with `node:crypto`.
 *
 * The cheaper alternative — comparing `gitBlobSha(bytes)` against the `contentSha` the
 * `PUT /contents` response already carried — is one fewer round trip and is rejected on
 * purpose. That value is GitHub's echo of the write it just performed, produced by the
 * same code path that stored it, and it says nothing about the branch *afterwards*. The
 * read-back observes the branch as any later reader would, so it also catches a push
 * that landed between the commit and the check — which is precisely the "someone pushed
 * to the branch" case the LLD calls a `Failed` state a human must look at.
 *
 * WHAT THE READ-BACK DOES **NOT** CATCH:
 *   - a push that lands *after* verification returns. Verification is a snapshot, not a
 *     lock; there is no such thing as a durable one here.
 *   - byte sequences that are not valid UTF-8. `getFile` decodes base64 to a utf-8
 *     string, so the comparison is over decoded text. The blob-sha comparison closes
 *     most of that gap, since the sha is computed over the raw bytes.
 *   - base divergence (R-8.22). Nothing here reads the base branch — see below.
 *
 * The expected hash is **always** computed server-side from the received bytes. There is
 * no client-supplied hash anywhere in `PublishJobInput` to trust, by construction.
 *
 * ---------------------------------------------------------------------------
 * CLIENT MARKDOWN IS OPAQUE (R-8.12)
 * ---------------------------------------------------------------------------
 * `input.markdown` is committed exactly as received: not parsed, not re-rendered, not
 * validated, not normalized. The publishing author already holds write access to the
 * branch, so there is nothing this layer could enforce that a `git push` would not
 * bypass. It is also what makes byte verification meaningful — a server that reformatted
 * the input would be verifying its own output. `core/collaboration/import-boundary.test.ts`
 * enforces the same thing structurally: no Markdown parser may reach this path.
 *
 * ---------------------------------------------------------------------------
 * CLIENT DISCONNECT (R-8.14)
 * ---------------------------------------------------------------------------
 * This body **never reads `ctx.signal`**, unlike `lifecycle.ts`'s create/sync bodies
 * which abort between steps. The hub already owns the operation server-side, and a
 * subscriber closing its SSE stream only removes a sink — it does not abort anything. A
 * publish that has been accepted must reach a decided state (published or failed) even
 * with nobody watching: a half-published branch that nothing verified is the one outcome
 * this task exists to prevent. Publish is at most six `gh api` calls, so there is no long
 * step for an abort check to shorten anyway.
 *
 * ---------------------------------------------------------------------------
 * ROOM FOR BASE DIVERGENCE (R-8.22 — task 8.4)
 * ---------------------------------------------------------------------------
 * Base divergence is a *distinct* state from verification failure: if base gained a
 * change to the same generated path after the branch point, the merge legitimately
 * produces different content, and reporting that as a verification failure would fire an
 * integrity alarm on a correct outcome. So:
 *   - this module reads only the PR branch, never `repo.baseBranch`. It cannot mistake
 *     one for the other because it never looks;
 *   - the read-before-write already fetches each target path's current blob on the
 *     branch, which is the exact input a base comparison needs — 8.4 adds a
 *     `getFile(repo, path, repo.baseBranch)` beside it and throws its own error type
 *     *before* the commit;
 *   - failures are a typed `PublishVerificationError`, not a bare `Error`, so a sibling
 *     `PublishBaseDivergedError` discriminates without changing anything here.
 *
 * Node-reachable from the CLI: node builtins and sibling core modules only — no
 * `@lyfie/luthor`, no react (R-3.3 / R-12.6, guarded by `core/bundle-guard.test.ts`).
 */
import { createHash } from 'node:crypto';
import type { ResolvedCollaborationConfig } from '../config';
import type { CollaborationDocument, JsonDocument } from './document-protocol';
import { serializeCollaborationDocument } from './document-protocol';
import type { DocumentStore } from './document-store';
import { ensureLinguistGeneratedEntry } from './gitattributes';
import type { GitHubAdapter, RepoRef } from './github-adapter';
import type { JobBody } from './job-hub';
import type { BoundCollaborationDocument } from './lifecycle';

/**
 * Git's blob object hash: `sha1("blob " + byteLength + "\0" + content)`. Computed here,
 * from the bytes we are about to send, so correctness never depends on a hash supplied
 * by the client or echoed by GitHub (R-8.11). Length is in **bytes**, not UTF-16 code
 * units, which is why the buffer is measured rather than the string.
 */
export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

/**
 * Where the generated Markdown for a document lives: the canonical JSON path with
 * `.json` swapped for `.md`. A pure function of the document path, so task 11.x and the
 * changelog derive it instead of reading a stored field (R-8.13).
 */
export function markdownPathFor(documentPath: string): string {
  return documentPath.endsWith('.json') ? `${documentPath.slice(0, -'.json'.length)}.md` : `${documentPath}.md`;
}

/**
 * R-8.21 — the committed blob is not what we sent. Typed rather than a bare `Error` so
 * task 8.4 can record a verification failure distinctly from a base divergence (R-8.22)
 * without this module changing.
 */
export class PublishVerificationError extends Error {
  readonly name = 'PublishVerificationError';
  /** Repo-relative path of the blob that did not match. */
  readonly path: string;
  readonly branch: string;
  /** `gitBlobSha` of the bytes we sent. */
  readonly expectedSha: string;
  /** What the branch actually holds — `null` when the path is missing entirely. */
  readonly actualSha: string | null;

  constructor(args: { path: string; branch: string; expectedSha: string; actualSha: string | null }) {
    super(
      `publish verification failed for ${args.path} on ${args.branch}: expected blob ${args.expectedSha}, branch has ${args.actualSha ?? 'no file'}`,
    );
    this.path = args.path;
    this.branch = args.branch;
    this.expectedSha = args.expectedSha;
    this.actualSha = args.actualSha;
  }
}

/**
 * What the `publish` body needs. Deliberately a **subset** of 7.2's `PublishJobInput`
 * (`core/vite/routes/collab.ts`), exactly as `CreateBodyInput` is of `CreateJobInput`, so
 * the factory drops straight into `CollabDeps.bodies` and the route hands its own input
 * through untouched.
 */
export type PublishBodyInput = {
  documentId: string;
  /** R-9.4 — owner / repo / base branch, supplied per call rather than per instance. */
  repo: ResolvedCollaborationConfig;
  store: DocumentStore;
  /** The route's already-loaded document. Re-read from `store` when absent or null. */
  document?: CollaborationDocument | null;
  /** The structured document, exactly as received. Never re-derived server-side. */
  json: unknown;
  /** R-8.12 — opaque bytes, committed verbatim. */
  markdown: string;
};

export type PublishBodyOptions = { adapter: GitHubAdapter };

/** One thing publish writes and then checks. */
type Artifact = { label: string; path: string; content: string };

/**
 * The `publish` body factory, in the shape 7.2's `CollabJobBodies` declares. Hand it to
 * `createCollabRoutes({ bodies: { publish: createPublishBody({ adapter }) } })` —
 * `core/vite/routes/collab-wiring.ts` is the one place that does.
 */
export function createPublishBody(options: PublishBodyOptions): (input: PublishBodyInput) => JobBody {
  const { adapter } = options;

  return (input) => async (ctx) => {
    const { documentId, repo, store } = input;
    const repoRef: RepoRef = { owner: repo.owner, repo: repo.repo };

    // R-8.9 — the route validates this first and rejects with 400 (R-12.7), so this is
    // reached only by a caller that bypassed it. Kept because the body is exported on
    // its own and a bad payload must not be committed under any entrypoint.
    if (input.json === undefined || input.json === null) throw new Error('publish: missing json');
    if (typeof input.markdown !== 'string') throw new Error('publish: missing markdown');

    ctx.setState('publishing');

    const doc = (input.document ?? ((await store.read(documentId)) as BoundCollaborationDocument | null)) as
      | BoundCollaborationDocument
      | null;
    if (!doc) throw new Error(`no collaboration document: ${documentId}`);
    const branch = doc.github?.branch;
    if (!branch) throw new Error(`no collaboration branch for ${documentId}`);

    const markdownPath = markdownPathFor(doc.documentPath);
    const artifacts: Artifact[] = [
      // The canonical JSON keeps its envelope — the 3.1 stores parse it — with the
      // client's payload installed as `doc`. `serializeCollaborationDocument` is a
      // deterministic stringify, so the bytes are still a pure function of what arrived.
      { label: 'json', path: doc.documentPath, content: serializeCollaborationDocument({ ...doc, doc: input.json as JsonDocument }) },
      { label: 'markdown', path: markdownPath, content: input.markdown },
    ];

    // Contents API only — a `git add` would apply `.gitattributes` CRLF normalization
    // and break byte verification permanently (LLD §7). No git subprocess exists here.
    for (const artifact of artifacts) {
      // Read-before-write: the Contents API needs the blob being replaced. This is also
      // where 8.4's base-divergence check goes (see the header, R-8.22).
      const existing = await adapter.getFile(repoRef, artifact.path, branch);
      ctx.log(`committing ${artifact.label} to ${artifact.path} on ${branch}`, 'progress');
      await adapter.commitFile(repoRef, {
        path: artifact.path,
        content: artifact.content,
        message: `visual-spec: publish ${documentId} (${artifact.label})`,
        branch,
        ...(existing ? { sha: existing.sha } : {}),
      });
    }

    ctx.setState('verifying');

    for (const artifact of artifacts) {
      const expectedSha = gitBlobSha(artifact.content);
      const committed = await adapter.getFile(repoRef, artifact.path, branch);
      // Content first, then sha: the content comparison is the one that names the
      // requirement (R-8.10), the sha closes the utf-8 decoding gap over raw bytes.
      if (!committed || committed.content !== artifact.content || committed.sha !== expectedSha) {
        // R-8.21 — abort. Nothing is regenerated and nothing is overwritten.
        throw new PublishVerificationError({
          path: artifact.path,
          branch,
          expectedSha,
          actualSha: committed?.sha ?? null,
        });
      }
      ctx.log(`verified ${artifact.label} at ${artifact.path} — blob ${expectedSha}`, 'progress');
    }

    // O-2 — best effort, never allowed to fail the publish (see gitattributes.ts).
    // Runs after verification, on the same PR head branch the artifacts just landed
    // on, so a reviewer opening the PR sees the JSON diff already collapsed.
    await ensureLinguistGeneratedEntry({ adapter, repo: repoRef, branch, documentPath: doc.documentPath, log: ctx.log });

    // R-8.13 — the Markdown is on the branch and readable by the same `getFile` the
    // verification step just used, so an agent can build the PR summary and changelog.
    // R-8.10 — publish stops here. Merge happens on github.com.
    ctx.log(`published ${documentId} to ${branch} — markdown at ${markdownPath}; merge on github.com`);
    ctx.setState('published');
  };
}
