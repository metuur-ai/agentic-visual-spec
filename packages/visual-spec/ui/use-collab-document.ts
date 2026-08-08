/**
 * use-collab-document.ts — one document's live state, for whoever mounts the collab UI.
 *
 * The server already solved the hard half of this (R-8.4): the first frame of
 * `GET /:id/events` is the whole snapshot, so a subscriber that attaches late — or
 * reattaches after a reload — recovers without replaying anything. This hook is
 * therefore deliberately thin: seed from `GET /:id`, then let the stream be the source
 * of truth for job state via `applyJobFrame`. It does NOT poll.
 *
 * WHY THREE READS. The stream carries the job snapshot and nothing else, so everything
 * a component actually renders comes from a plain GET: `GET /:id` for identity + the
 * R-8.4 snapshot, `GET /:id/document` for the canonical document, `GET /:id/comments`
 * for the conversation. They are separate requests because `GET /:id`'s body doubles as
 * the SSE `sync` frame and must not grow.
 *
 * WHY A FRAME RE-READS TWO OF THEM. Re-fetching the *snapshot* on every frame would
 * race the stream, so that never happens — `applyJobFrame` stays authoritative. But the
 * document and the comments are not in the stream at all, so there is nothing for a
 * re-read of those to race. Without one, a reviewer's comment reaches the server (the
 * hub's poller runs `sync` on an interval) and then dies there: the frame announcing it
 * arrives and the author's browser renders nothing until a reload. So a successful
 * `job-done` re-reads what that kind of job can have changed — see `COMMENT_ONLY_JOBS`.
 *
 * WHY 409 IS NOT AN ERROR HERE (R-8.1). `sync` and `publish` answer `conflict` when a
 * job is already running for this document. That is the expected answer to a second
 * click, and the caller's response is to wait for `job-done` — which is already arriving
 * on the stream — so it is surfaced as `conflict`, distinct from `error`.
 *
 * `EventSource` is injectable for the same reason `fetchImpl` is on the client: the
 * tests drive real frames through a fake rather than standing up a server.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CollaborationDocument } from '../core/collaboration/document-protocol';
import type { CommentRecord } from '../core/editing/comment-doc';
import type { JobEvent, JobKind, JobSnapshot, JobSync } from '../core/collaboration/job-hub';
import type { CommentPatch } from '../core/vite/routes/comments';
import {
  applyJobFrame,
  createCollabClient,
  type CollabClient,
  type CollabDocumentSummary,
  type CollabFailure,
  type JobAccepted,
  type PublishInput,
} from './collab-client';

/**
 * Job kinds whose only remote effect is on comments. The hub's poller runs `sync` on an
 * interval, so re-reading the document on those would replace `fullDocument` every tick
 * and re-render the editor surface underneath an author who is typing. Any kind NOT
 * listed re-reads both, which makes a newly added kind stale-free by default and merely
 * costs it one extra pair of GETs.
 */
const COMMENT_ONLY_JOBS: ReadonlySet<JobKind> = new Set<JobKind>(['sync', 'remap', 'resolve']);

/** The minimum of `EventSource` this hook uses — so a test double stays small. */
export type EventSourceLike = {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
};

export type UseCollabDocumentOptions = {
  /** Defaults to a client over the global `fetch`. */
  client?: CollabClient;
  /** Defaults to the global `EventSource`. */
  eventSourceImpl?: (url: string) => EventSourceLike;
};

/** The outcome of a job-starting action a component triggers. */
export type JobActionResult = { ok: true; value: JobAccepted } | CollabFailure;

export type UseCollabDocumentState = {
  /** R-8.4 job state — null until the first `GET /:id` (or `sync` frame) lands. */
  snapshot: JobSnapshot | null;
  /** Identity of the document, from `GET /:id`. Null when the server has no such document. */
  document: CollabDocumentSummary | null;
  /**
   * The whole document, from `GET /:id/document` — what `CollabDocumentView` renders and
   * what `collabCommentPanelSource` resolves anchors against. Null until it lands.
   */
  fullDocument: CollaborationDocument | null;
  /** The conversation, from `GET /:id/comments`, kept current by the mutations below. */
  comments: CommentRecord[];
  /** True while the seeding `GET /:id` is in flight. */
  loading: boolean;
  /** The failure that stopped seeding, if it did. Action failures are returned, not stored. */
  error: CollabFailure | null;
  /**
   * The last comment read or mutation that failed. These four actions answer
   * `Promise<void>` because that is the shape `CollabCommentSourceDeps.add` / `.remove`
   * require, so a failure has nowhere to be returned to and is surfaced here instead.
   */
  commentsError: CollabFailure | null;
  /** Whether the hub reports a job in flight — what a component disables its buttons on. */
  running: boolean;
  sync: () => Promise<JobActionResult>;
  publish: (input: PublishInput) => Promise<JobActionResult>;
  /** Assignable straight to `CollabCommentSourceDeps.add` (R-7.5). */
  addComment: (input: { nodeId: string; comment: string; workflow: string }) => Promise<void>;
  replyToComment: (commentId: string, comment: string) => Promise<void>;
  patchComment: (commentId: string, patch: CommentPatch) => Promise<void>;
  /**
   * Assignable straight to `CollabCommentSourceDeps.remove`. There is no delete route
   * and GitHub is the system of record (R-5.2), so "remove from the panel" is the
   * `applied` status the PATCH route already understands — nothing is destroyed.
   */
  removeComment: (commentId: string) => Promise<void>;
  /** The inverse of `removeComment` — reopens a resolved thread (R-5.12). */
  restoreComment: (commentId: string) => Promise<void>;
  /**
   * Re-read the canonical document from the server.
   *
   * The stream only re-reads after a job this hub started, so a document edited OUT OF
   * BAND — an agent applying comments against `documents/<id>.json` on disk — is
   * invisible here until something remounts. Worse than invisible: the editor is seeded
   * from `fullDocument`, so publishing on top of a stale copy commits the pre-agent
   * document and drops the agent's work with no warning. This is how the author gets a
   * current copy to look at before deciding anything.
   */
  reload: () => Promise<void>;
};

export function useCollabDocument(documentId: string, options: UseCollabDocumentOptions = {}): UseCollabDocumentState {
  const { client: injectedClient, eventSourceImpl } = options;
  const client = useMemo(() => injectedClient ?? createCollabClient(), [injectedClient]);
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null);
  const [document, setDocument] = useState<CollabDocumentSummary | null>(null);
  const [fullDocument, setFullDocument] = useState<CollaborationDocument | null>(null);
  const [comments, setComments] = useState<CommentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CollabFailure | null>(null);
  const [commentsError, setCommentsError] = useState<CollabFailure | null>(null);

  // Read inside the stream callback so a re-render never re-opens the stream.
  const openStream = useRef(eventSourceImpl);
  openStream.current = eventSourceImpl;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    setSnapshot(null);
    setDocument(null);
    setFullDocument(null);
    setComments([]);
    setCommentsError(null);

    void client.document(documentId).then((result) => {
      if (!live) return;
      if (result.ok) setFullDocument(result.value);
      else setError(result);
    });

    void client.comments(documentId).then((result) => {
      if (!live) return;
      if (result.ok) setComments(result.value);
      else setCommentsError(result);
    });

    void client.status(documentId).then((result) => {
      if (!live) return;
      if (result.ok) {
        const { document: summary, ...job } = result.value;
        setSnapshot(job);
        setDocument(summary);
      } else {
        setError(result);
      }
      setLoading(false);
    });

    /**
     * A finished job can have changed data the stream does not carry. Failures here are
     * swallowed on purpose: these reads run in the background, and `error` blanks the
     * whole document view (`collab-app.tsx`), so a blip must not replace a working
     * screen — the last good data stays on screen until a later frame succeeds.
     */
    const reread = (frame: JobEvent | JobSync) => {
      if (frame.type !== 'job-done' || !frame.ok) return;

      void client.comments(documentId).then((result) => {
        if (live && result.ok) setComments(result.value);
      });

      if (COMMENT_ONLY_JOBS.has(frame.kind)) return;

      void client.document(documentId).then((result) => {
        if (live && result.ok) setFullDocument(result.value);
      });
      void client.status(documentId).then((result) => {
        // Only the identity half: `create` is how a PR number first appears in the title
        // bar. The job half is deliberately dropped — a racing read of it could rewind
        // the state the frame just advanced.
        if (live && result.ok) setDocument(result.value.document);
      });
    };

    const factory = openStream.current ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike);
    const stream = factory(client.eventsUrl(documentId));
    stream.onmessage = (event) => {
      if (!live) return;
      let frame: JobEvent | JobSync;
      try {
        frame = JSON.parse(event.data) as JobEvent | JobSync;
      } catch {
        // A truncated frame is not worth tearing the stream down for; the next `sync`
        // (on reconnect) is authoritative anyway.
        return;
      }
      setSnapshot((current) => applyJobFrame(current, frame));
      reread(frame);
    };

    return () => {
      live = false;
      // R-8.2 — the server drops the subscriber on close, which is also what stops the
      // hub's poller. Leaking one here would keep a document polling GitHub forever.
      stream.close();
    };
  }, [client, documentId]);

  const sync = useCallback(async (): Promise<JobActionResult> => {
    const result = await client.sync(documentId);
    return result.ok ? { ok: true, value: result.value } : result;
  }, [client, documentId]);

  const publish = useCallback(
    async (input: PublishInput): Promise<JobActionResult> => {
      const result = await client.publish(documentId, input);
      return result.ok ? { ok: true, value: result.value } : result;
    },
    [client, documentId],
  );

  // The three mutations fold the server's own saved record into local state rather than
  // re-reading the list: the route answers with what it persisted, so a refetch would
  // add a round trip and a window in which the panel disagrees with the click.
  const addComment = useCallback(
    async (input: { nodeId: string; comment: string; workflow: string }): Promise<void> => {
      // `workflow` is the routing tag the panel's "Apply via" control sets — which skill
      // handles this comment, not whether it is worth handling. It used to stop here.
      const result = await client.addComment(documentId, {
        comment: input.comment,
        nodeId: input.nodeId,
        workflow: input.workflow,
      });
      if (result.ok) setComments((current) => [...current, result.value.comment]);
      else setCommentsError(result);
    },
    [client, documentId],
  );

  const replyToComment = useCallback(
    async (commentId: string, comment: string): Promise<void> => {
      const result = await client.replyToComment(documentId, commentId, { comment });
      if (result.ok) setComments((current) => [...current, result.value.comment]);
      else setCommentsError(result);
    },
    [client, documentId],
  );

  const patchComment = useCallback(
    async (commentId: string, patch: CommentPatch): Promise<void> => {
      const result = await client.patchComment(documentId, commentId, patch);
      if (result.ok) setComments((current) => current.map((c) => (c.id === commentId ? result.value.comment : c)));
      else setCommentsError(result);
    },
    [client, documentId],
  );

  const removeComment = useCallback(
    (commentId: string): Promise<void> => patchComment(commentId, { status: 'applied' }),
    [patchComment],
  );

  const reload = useCallback(async (): Promise<void> => {
    const result = await client.document(documentId);
    if (result.ok) setFullDocument(result.value);
    else setCommentsError(result);
  }, [client, documentId]);

  const restoreComment = useCallback(
    (commentId: string): Promise<void> => patchComment(commentId, { status: 'open' }),
    [patchComment],
  );

  return {
    snapshot,
    document,
    fullDocument,
    comments,
    loading,
    error,
    commentsError,
    running: snapshot?.running ?? false,
    sync,
    publish,
    addComment,
    replyToComment,
    patchComment,
    removeComment,
    restoreComment,
    reload,
  };
}
