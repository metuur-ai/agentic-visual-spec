/**
 * collab-drawer.tsx — the collaboration *picker*, as a right-side modal panel.
 *
 * WHY A DRAWER AND NOT A ROUTE. Choosing a pull request is a detour, not a destination:
 * the reviewer is looking at their files, wants to know what is open, and wants to come
 * back. `App.tsx` used to swap its whole shell for `CollabApp` to answer that — the file
 * tree, the open document and the header all unmounted so the user could read a list.
 * The drawer keeps the work behind it on screen and puts the list beside it, and the
 * full-surface swap is reserved for the thing that actually needs the width: the document
 * pane, or a pull request's code.
 *
 * ONLY THE ✕ CLOSES IT (product decision). No Escape, and a click on the scrim is
 * swallowed rather than treated as dismissal. Both are deliberate: `CollabPullsPanel`'s
 * buttons run git — a checkout, a `POST /__vs/collab/open` — and a stray click outside
 * the panel mid-mount would tear the surface down around a request already in flight.
 * The cost is the standard keyboard escape route, so the ✕ is paid for in the other
 * direction: it takes focus on open, it is the first thing in the tab order, and focus
 * cannot leave the panel while it is up.
 *
 * PICKING CLOSES IT. A row's `Resume writing` / `Review the code` hands the result up to
 * `App.tsx`, which dismisses the drawer and mounts the full-width surface. Nothing that
 * needs room is ever rendered inside it.
 */
import type { OpenedReview, PullRequestSummary } from './collab-client';
import { CollabOpenPanel } from './collab-open-panel';
import { CollabPullsPanel } from './collab-pulls-panel';
import { Drawer } from './drawer';

export type CollabDrawerProps = {
  /** The ✕, and nothing else. */
  onClose: () => void;
  /** R-7.7 — a pull request that carries a document, opened for writing. */
  onResume: (documentId: string) => void;
  /** R-7.8 — a pull request opened for reading, with the source supplying its files. */
  onReview: (pull: PullRequestSummary, review: OpenedReview) => void;
};

/**
 * The same sentence the sidebar item is labelled with, deliberately.
 *
 * A drawer titled differently from the control that opened it reads as a second place,
 * and the reviewer has to check they landed where they meant to. One name, said twice.
 */
const PANEL_LABEL = 'Collaborate on pull requests';

export function CollabDrawer({ onClose, onResume, onReview }: CollabDrawerProps) {
  return (
    <Drawer
      label={PANEL_LABEL}
      // See the header note: these buttons run git, so the ✕ is the only way out.
      dismissible={false}
      /*
       * Wider than the 480px it started at, because the rows now hold prose. A pull request
       * description is Markdown a reviewer is expected to *read* — paragraphs, lists, task
       * checklists — and at 480px, inside a card, inside a scroll box, it was a column of
       * five-word lines. 720px puts the body near the 60–75 character measure that makes it
       * readable, and the listing rows get their branch names back on one line as well.
       */
      width="min(720px, 100vw)"
      slug="collab-drawer"
      onClose={onClose}
    >
      <div style={body}>
        {/*
          * Same two entries, same order and same reasoning as the full-surface landing
          * page had: the list is the primary path because the server already resolved a
          * `documentId` for every row that has one (R-7.4), and the URL form below is the
          * fallback for a pull request this repository does not list.
          */}
        <CollabPullsPanel onReview={onReview} onResume={onResume} />
        <hr style={rule} />
        <CollabOpenPanel onOpened={onResume} />
      </div>
    </Drawer>
  );
}

const body: React.CSSProperties = { padding: '4px 0 24px' };

const rule: React.CSSProperties = { border: 0, borderTop: '1px solid #e5e7eb', margin: '4px 12px' };
