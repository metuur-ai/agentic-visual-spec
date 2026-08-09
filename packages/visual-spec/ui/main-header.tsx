import { type CommentRecord, buildApplyPrompt, useComments, useInspector, useSpecsRoot } from '../core/app';
import { Fragment, type ReactNode, memo, useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { HelpButton } from './help-page';
import { CommentHistoryList } from './comment-history-list';
import { isCommentPanelListening, revealInCommentPanel, subscribeCommentPanel } from './comment-panel';
import { toPath } from './md-path';
// `document-record.ts` imports nothing (see its header), so the id pattern crosses into
// the browser as a value without dragging `node:*` behind it.
import { DOCUMENT_ID_RE } from '../core/collaboration/document-record';
import { type CollabAvailabilitySnapshot, createCollabClient } from './collab-client';
import type { PullRequestSummary } from './collab-client';
import { type CollabPulls, type ConfiguredRepo, useCollabPulls } from './use-collab-pulls';
import { type BranchListing, useGitBranches } from './use-git-branches';
import { type GitContext, useGitContext } from './use-git-context';

/**
 * What the chip needs from the shell around it, and the whole of it.
 *
 * Every entry is optional because `BrandHeader` renders the same `Brand` with none of
 * them: there is no document open behind the empty state, so there is nothing to
 * confirm, no pane to re-point and no surface to swap to. A missing handler is not a
 * degraded mode — it is a header with less of an app underneath it.
 */
export type HeaderActions = {
  /**
   * R-6.5 — run `proceed` once the main document editor's unsaved work is resolved,
   * or immediately where there is none. The dirty buffer and the dialog both live in
   * `ui/App.tsx`; this is the header asking, not deciding.
   */
  confirmUnsaved?: (proceed: () => void) => void;
  /** R-6.7 / R-6.8 — the branch moved, so the file tree and the open file are stale. */
  onBranchChanged?: () => void;
  /** R-7.7 — open the collaboration surface on a document that is already attached. */
  onResumeCollab?: (documentId: string) => void;
  /** R-7.8 — open the collaboration surface on a pull request to be checked out. */
  onReviewPull?: (pullNumber: number) => void;
};

function CommentIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** The brand mark: three offset spec "sheets", echoing a stack of reviewed pages. */
function SpecMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ display: 'block' }} aria-hidden>
      <defs>
        <linearGradient id="vs-mark" x1="4" y1="3" x2="28" y2="29" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
      <rect x="9" y="4.5" width="16" height="20" rx="3" fill="url(#vs-mark)" opacity="0.28" />
      <rect x="6.5" y="6" width="16" height="20" rx="3" fill="url(#vs-mark)" opacity="0.5" />
      <rect x="4" y="7.5" width="16" height="20" rx="3" fill="url(#vs-mark)" />
      <path d="M7.5 13.5h9M7.5 17h9M7.5 20.5h5.5" stroke="white" strokeWidth="1.6" strokeLinecap="round" opacity="0.92" />
    </svg>
  );
}

function FolderIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/**
 * The promoted "Start collaboration" carries this so the state is not colour alone —
 * a violet fill says "ready" only to someone who can see violet.
 */
function CheckIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }} aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function CopyIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

/**
 * The three chip icons. Each state gets its own glyph rather than a shared icon
 * with a colour swap, because colour alone is not a distinction a colour-blind
 * user can read, and these three states are the whole point of the chip.
 */

/** State `none`: a branch symbol struck through — "there is no repository here". */
function BranchOffIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} aria-hidden>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="3" y1="21" x2="21" y2="3" />
    </svg>
  );
}

/** State `local`: an unplugged connector — a repository, but no remote we can follow. */
function UnplugIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} aria-hidden>
      <path d="M18.5 3.5 15 7l2 2-3.5 3.5" />
      <path d="M10.5 20.5 14 17l-2-2 3.5-3.5" />
      <line x1="3" y1="21" x2="6" y2="18" />
      <line x1="18" y1="6" x2="21" y2="3" />
    </svg>
  );
}

/**
 * GitHub's own mark (octicon `mark-github`), for a repository that is actually on GitHub.
 *
 * WHY IT IS CONDITIONAL. R-3.7 / R-3.8 keep owner, repository and branch host-independent
 * — only the *link* is GitHub-specific — so stamping this on every remote would tell a
 * GitLab user their repository is on GitHub. It appears on exactly the condition the link
 * does, and `LinkIcon` still covers every other recognised host.
 *
 * WHY IT IS FILLED WHILE EVERY OTHER GLYPH HERE IS STROKED. It is a brand mark, not an
 * icon: the shape is GitHub's and is not ours to redraw at 2px stroke to match the set.
 * Official path, unmodified proportions, `currentColor` so it takes the chip's tone —
 * which is how GitHub ships it in octicons themselves.
 */
function GitHubMark({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" style={{ display: 'block', flexShrink: 0 }} aria-hidden>
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

/** State `remote`: a chain link — the repository is connected to a known host. */
function LinkIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  );
}

/** The branch chip's own glyph — it is a pill in its own right now, so it carries a mark. */
function BranchIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} aria-hidden>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

/** The count chip's glyph. Same shape the sidebar's nav item uses, for the same subject. */
function PullRequestChipIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} aria-hidden>
      <circle cx="6" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 9v6" />
      <circle cx="18" cy="18" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
    </svg>
  );
}

/**
 * How a HEAD is worded, in ONE place (R-3.9 / R-4.3). A detached HEAD's "branch"
 * is a 7-character hex string, and rendered bare it reads as a branch literally
 * called `a1b2c3d`. The sha is still shown — it is the useful fact — but it is
 * labelled as what it is.
 *
 * Two surfaces say this: the header chip and the apply scope chooser. They must
 * be honest together or not at all, so the wording is a shared function rather
 * than a shape each site re-derives — the chip's version drifting away from the
 * chooser's is exactly how the chooser came to print a bare sha in the first place.
 */
const DETACHED_TITLE = 'detached HEAD';
const headText = (branch: string, detached: boolean) => (detached ? `${DETACHED_TITLE} @ ${branch}` : branch);

/* ------------------------------------------------------------------ *
 * The tooltip the chips wear.
 *
 * The chips truncate — a repository or branch name long enough to ellipsize is common,
 * and the whole point of truncating rather than clipping is that the full value is still
 * *available*. `title` was how it was available, and `title` is the wrong tool for it: a
 * ~1s browser delay, no styling, no keyboard reach on a non-focusable element, and it
 * renders in a font that belongs to the OS rather than to this header.
 *
 * SHOWN ON FOCUS AS WELL AS HOVER. A truncated branch name is exactly the sort of thing a
 * keyboard user needs, and the branch switcher is a button they can already reach.
 * `aria-describedby` points at the bubble so a screen reader gets the full string too,
 * which `title` did unreliably and only sometimes.
 * ------------------------------------------------------------------ */

/**
 * A short hover delay, so dragging the pointer across a row of three chips does not
 * strobe three bubbles on the way past. Focus is immediate — a keyboard user asked.
 */
const TOOLTIP_DELAY_MS = 320;

/** Reduced motion is honoured, so the fade needs a stylesheet rather than an inline style. */
const TOOLTIP_CSS =
  '@keyframes vs-tip-in{from{opacity:0;transform:translate(-50%,-2px)}to{opacity:1;transform:translate(-50%,0)}}' +
  '.vs-tip{animation:vs-tip-in 120ms ease-out}' +
  '@media (prefers-reduced-motion: reduce){.vs-tip{animation:none}}';

let tooltipSeq = 0;

function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Focus that arrived by pointer is not a request to be told what the control is. */
  const pointerDown = useRef(false);
  // `useId` would be tidier, but this file targets React 18 without it in scope here and
  // a module counter is stable across renders for the same mounted tooltip.
  const idRef = useRef<string | null>(null);
  idRef.current ??= `vs-tip-${(tooltipSeq += 1)}`;
  const id = idRef.current;

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  // A tooltip left on screen by an unmount that raced its own timer is the classic leak
  // here; the pending timer is the thing that has to go, not just the visible state.
  useEffect(() => cancel, [cancel]);

  const show = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => setShown(true), TOOLTIP_DELAY_MS);
  }, [cancel]);
  const hide = useCallback(() => {
    cancel();
    setShown(false);
  }, [cancel]);

  return (
    <span
      style={tipWrap}
      onMouseEnter={show}
      onMouseLeave={hide}
      /*
       * Acting on the control dismisses its own hint. Two of these chips open a popover
       * directly beneath themselves, and the bubble sat on top of it — explaining a
       * control the user had already used, over the answer they had just asked for.
       * `mousedown` rather than `click`, so it goes before the popover arrives.
       */
      onMouseDown={() => {
        // `mousedown` → `focus` → `click`, so without this flag the focus handler below
        // would put the bubble straight back up on the way to opening the popover.
        pointerDown.current = true;
        hide();
      }}
      onFocus={() => {
        if (pointerDown.current) {
          pointerDown.current = false;
          return;
        }
        cancel();
        setShown(true);
      }}
      onBlur={() => {
        pointerDown.current = false;
        hide();
      }}
      // R-1.x's escape habit: every transient layer in this header closes on Escape.
      onKeyDown={(e) => {
        if (e.key === 'Escape') hide();
      }}
    >
      {/*
        `aria-describedby` names the bubble whether or not it is rendered. Pointing at a
        missing id is ignored by assistive tech, and wiring it only while shown would mean
        the description appears mid-interaction rather than being part of the control.
      */}
      <span aria-describedby={id} style={tipAnchor}>
        {children}
      </span>
      {shown && (
        <span role="tooltip" id={id} className="vs-tip" style={tipBubble} data-vs-tooltip>
          <style>{TOOLTIP_CSS}</style>
          {label}
        </span>
      )}
    </span>
  );
}

/**
 * The chip's branch slot, when there is no switcher to make it a button.
 *
 * The tooltip carries the full ref rather than only the words "detached HEAD": on a
 * detached HEAD the visible text is already truncated to something like
 * `detached HEAD @ a1b2…`, so the thing worth revealing is the whole of it.
 */
function BranchLabel({ branch, detached }: { branch: string; detached: boolean }) {
  return (
    <Tooltip label={headText(branch, detached)}>
      <span style={gitBranchText}>{headText(branch, detached)}</span>
    </Tooltip>
  );
}

/** Which of the chip's two popovers is on screen, if either. */
type ChipMenu = 'closed' | 'branches' | 'pulls';

/**
 * The git context chip (R-3.1 … R-3.9), the branch switcher (R-6.1 … R-6.8) and the
 * open pull request count (R-7.1 … R-7.9). Lives beside the served path because the
 * directory and the branch checked out in it are one fact, not two.
 *
 * The `null` case is not a fourth cosmetic state — it is the requirement (R-3.2).
 * Before the first read returns, the chip asserts none of the three states; if it
 * defaulted to "not a git repo" it would flash a falsehood and then correct
 * itself, which is exactly the confusion the three states exist to prevent. The count
 * waits for the same moment for the same reason: it renders *inside* a chip that has
 * not yet said what it is describing.
 *
 * WHY THE POPOVERS SIT OUTSIDE THE CHIP ELEMENT. `gitChip` clips its overflow so a
 * long `owner/repo` truncates instead of pushing the path button off the row — which
 * would clip a popover too. The chip and its two popovers therefore share a
 * positioned wrapper, and the open/refusal state lives here rather than in either
 * popover, because both are dismissed by the same click-outside.
 */
function GitChip({ actions }: { actions?: HeaderActions }) {
  const ctx = useGitContext();
  const branches = useGitBranches();
  const pulls = useCollabPulls();
  const [menu, setMenu] = useState<ChipMenu>('closed');
  /** R-6.6 — the paths git reported, held until the menu is dismissed. */
  const [refusal, setRefusal] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [changing, setChanging] = useState<string | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (menu === 'closed') return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenu('closed');
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  const change = useCallback(
    async (name: string) => {
      setChanging(name);
      const outcome = await branches.checkout(name);
      setChanging(null);
      if (outcome.ok) {
        // The chip itself needs nothing: `checkout` published the server's own context
        // (R-6.7) and `useGitContext` has already adopted it. What the shell owns is
        // the file tree and the pane, which the branch may just have emptied.
        setMenu('closed');
        actions?.onBranchChanged?.();
        return;
      }
      if (outcome.kind === 'dirty') {
        setRefusal(outcome.paths);
        return;
      }
      setFailure(outcome.message);
    },
    [branches, actions],
  );

  /**
   * R-6.5 — the confirmation belongs to the shell, and the request waits behind it.
   * Where no shell passed one there is no main document editor mounted to have
   * dirtied, so proceeding immediately is not a shortcut past the guard.
   */
  const select = (name: string) => {
    setRefusal(null);
    setFailure(null);
    const run = () => void change(name);
    if (actions?.confirmUnsaved) actions.confirmUnsaved(run);
    else run();
  };

  const toggle = (which: Exclude<ChipMenu, 'closed'>) => {
    setRefusal(null);
    setFailure(null);
    setMenu((current) => (current === which ? 'closed' : which));
  };

  /*
   * R-6.1 / R-6.2 — a control only where configuration has enabled one. `enabled` is
   * still `null` while the probe is in flight, and that renders as Unit 3 too: a
   * control that appears a beat later is as distinguishable from absent as a disabled
   * one, which is what R-6.2 forbids.
   */
  const switchable = branches.enabled === true;

  /*
   * The branch, as its own chip.
   *
   * It used to sit inside the repository's pill behind a `·`, which made one pill mean
   * two things and forced them to share a width — the arrangement that let a long
   * repository name push the branch off the edge. Two pills cannot do that to each
   * other: each truncates its own content and neither can consume the other's room.
   */
  const branchChip = (branch: string, detached: boolean, tone: React.CSSProperties) => {
    const full = headText(branch, detached);
    return switchable ? (
      <Tooltip label={detached ? `${full} — choose a branch to check out` : `${full} — change branch`}>
        <button type="button" onClick={() => toggle('branches')} data-testid="git-branch-switch" style={{ ...gitChip, ...tone, ...branchBtn }}>
          <BranchIcon />
          {/*
            Wrapped rather than bare. A bare text node is an anonymous flex item, which
            cannot take `text-overflow`, so a long branch name was clipped mid-character —
            and took the ▾ with it, leaving a dropdown with no affordance that it was one.
          */}
          <span style={branchBtnLabel}>{full}</span>
          <span style={gitDot}>▾</span>
        </button>
      </Tooltip>
    ) : (
      <span style={{ ...gitChip, ...tone }} data-testid="git-branch-chip">
        <BranchIcon />
        <BranchLabel branch={branch} detached={detached} />
      </span>
    );
  };

  /*
   * `git-chip` names the GROUP, not a pill.
   *
   * Splitting the pill would otherwise have split what the id refers to, and every
   * assertion that reads the chip's text as one string — "it says the repository AND the
   * branch" — is a claim about the header's git statement rather than about a particular
   * pill. The statement survived the split; only its packaging changed.
   */
  const body = (() => {
    if (ctx == null) {
      return (
        <span style={gitGroup} data-testid="git-chip" aria-busy="true">
          <span style={{ ...gitChip, ...gitTonePending }}>
            <span style={gitPlaceholderBar} aria-hidden />
          </span>
        </span>
      );
    }

    if (ctx.state === 'none') {
      return (
        <span style={gitGroup} data-testid="git-chip">
          <Tooltip label="This directory is not inside a git repository">
            <span style={{ ...gitChip, ...gitToneNone }} data-testid="git-repo-chip">
              <BranchOffIcon />
              <span>not a git repo</span>
            </span>
          </Tooltip>
          <PullCount ctx={ctx} pulls={pulls} onOpen={() => toggle('pulls')} />
        </span>
      );
    }

    if (ctx.state === 'local') {
      // Two different situations land here and they are NOT the same claim. No
      // `origin` at all (R-3.4) versus an `origin` whose URL matched none of the
      // supported shapes (R-3.5) — saying "no remote" in the second case denies a
      // remote the user can see in their own git config.
      const unrecognised = Boolean(ctx.url);
      return (
        <span style={gitGroup} data-testid="git-chip">
          <Tooltip label={unrecognised ? `Remote not recognised · ${ctx.url}` : 'No remote is configured for this repository'}>
            <span style={{ ...gitChip, ...gitToneLocal }} data-testid="git-repo-chip">
              <UnplugIcon />
              <span style={gitRepoText}>{unrecognised ? 'unrecognised remote' : 'no remote'}</span>
            </span>
          </Tooltip>
          {branchChip(ctx.branch, ctx.detached, gitToneLocal)}
          <PullCount ctx={ctx} pulls={pulls} onOpen={() => toggle('pulls')} />
        </span>
      );
    }

    // Owner, repository and branch are host-independent facts, so they render the
    // same everywhere; only the URL *shape* for a link is GitHub-specific, so only
    // the link is conditional (R-3.7 / R-3.8). A GitLab user still sees who owns
    // the repository they are commenting on.
    const label = `${ctx.owner}/${ctx.repo}`;
    const linkable = ctx.host === 'github.com';
    return (
      <span style={gitGroup} data-testid="git-chip">
        {/* The full `owner/repo` and the origin URL — the two things truncation hides. */}
        <Tooltip label={`${label} · ${ctx.url}`}>
          <span style={{ ...gitChip, ...gitToneRemote }} data-testid="git-repo-chip">
            {/* GitHub's mark where it is GitHub, the generic link everywhere else (R-3.7). */}
            {linkable ? <GitHubMark /> : <LinkIcon />}
            {linkable ? (
              <a
                href={`https://github.com/${ctx.owner}/${ctx.repo}`}
                target="_blank"
                rel="noopener noreferrer"
                style={gitRepoLink}
              >
                {label}
              </a>
            ) : (
              <span style={gitRepoText}>{label}</span>
            )}
          </span>
        </Tooltip>
        {branchChip(ctx.branch, ctx.detached, gitToneRemote)}
        <PullCount ctx={ctx} pulls={pulls} onOpen={() => toggle('pulls')} />
      </span>
    );
  })();

  return (
    <span ref={rootRef} style={gitChipWrap} data-testid="git-chip-area">
      {body}
      {menu === 'branches' && (
        <BranchMenu
          listing={branches.listing}
          current={ctx && ctx.state !== 'none' && !ctx.detached ? ctx.branch : null}
          changing={changing}
          refusal={refusal}
          failure={failure}
          onSelect={select}
          onClose={() => setMenu('closed')}
        />
      )}
      {menu === 'pulls' && (
        <PullMenu
          pulls={pulls.pulls ?? []}
          onResume={(pull) => {
            // R-7.7 — the id the *server* resolved from the body (R-7.4/R-7.5), passed
            // through untouched. Nothing here re-derives it, and nothing here could:
            // the body it was read from is not in this process.
            const documentId = pull.documentId;
            if (!documentId) return;
            setMenu('closed');
            void pulls.resume(documentId, pull.number).then(() => actions?.onResumeCollab?.(documentId));
          }}
          onReview={(pull) => {
            setMenu('closed');
            actions?.onReviewPull?.(pull.number);
          }}
          onClose={() => setMenu('closed')}
        />
      )}
    </span>
  );
}

/**
 * The open pull request count (R-7.1 … R-7.3) and, where they differ, the name of the
 * repository it belongs to (R-8.1).
 *
 * Renders nothing at all where collaboration is not configured (R-7.2) or before the
 * first listing lands — and `useCollabPulls` has issued no request in the first case,
 * which is the half of R-7.2 an absent element cannot demonstrate on its own.
 */
function PullCount({ ctx, pulls, onOpen }: { ctx: GitContext; pulls: CollabPulls; onOpen: () => void }) {
  if (pulls.configured !== true || pulls.pulls === null) return null;
  const count = pulls.pulls.length;
  const named = namesCountRepo(ctx, pulls.repo);
  const plural = `${count} open pull request${count === 1 ? '' : 's'}`;
  /*
   * R-8.1's disclosure rides in the tooltip AND stays on screen, because the two say
   * different things: the visible `on owner/repo` is what stops an unlabelled number
   * being read as this directory's, and the tooltip is where the *reason* fits without
   * spending a header row on it.
   */
  const disclosure =
    named && pulls.repo
      ? ` — in ${pulls.repo.owner}/${pulls.repo.repo}, the configured collaboration repository, which is not this directory's origin`
      : '';
  return (
    <Tooltip label={`${plural}${disclosure} — click to list them`}>
      <button type="button" onClick={onOpen} data-testid="git-pull-count" style={{ ...gitChip, ...gitTonePulls, ...pullCountBtn }}>
        <PullRequestChipIcon />
        {count} open
        {named && pulls.repo && (
          <span data-testid="git-pull-count-repo" style={pullRepoNote}>
            on {pulls.repo.owner}/{pulls.repo.repo}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

/**
 * R-8.1 / R-8.2 — must the chip say which repository the count is of?
 *
 * The chip's `owner/repo` comes from the served directory's `origin` (R-1.7); the
 * count comes from `config.collaboration`. `POST /__vs/dir/pick` re-roots the served
 * directory at runtime while the configuration stays fixed, so the two genuinely
 * diverge and the count can render inside a chip naming a different repository.
 *
 * Where they agree, nothing is added (R-8.2). Where the served directory names no
 * remote repository at all — `local`, or `none` — the naming is added too: there the
 * chip names nothing beside the count, so an unlabelled number belongs to whichever
 * repository the reader assumes. Neither repository is changed either way (R-8.3);
 * this is a disclosure, not a reconciliation.
 */
function namesCountRepo(ctx: GitContext, repo: ConfiguredRepo | null): boolean {
  if (!repo) return false;
  if (ctx.state === 'remote') return ctx.owner !== repo.owner || ctx.repo !== repo.repo;
  return true;
}

/**
 * The branch list (R-6.1) and what a refusal looks like (R-6.6).
 *
 * THERE IS NO WAY PAST THE REFUSAL, AND THAT IS THE FEATURE. R-5.5 refuses on any
 * uncommitted work because `git checkout` silently carries an edit onto the new branch
 * whenever the file is identical in both commits — the ordinary case in a repository
 * of documents. A "change anyway" control here would hand back precisely the outcome
 * the server refused to produce, so the refusal names the files and stops. Committing
 * or setting the work aside is the user's decision to make in their own terminal.
 */
function BranchMenu({
  listing,
  current,
  changing,
  refusal,
  failure,
  onSelect,
  onClose,
}: {
  listing: BranchListing | null;
  /** The branch `HEAD` is on, or `null` on a detached HEAD — where none is current. */
  current: string | null;
  changing: string | null;
  refusal: string[] | null;
  failure: string | null;
  onSelect: (branch: string) => void;
  onClose: () => void;
}) {
  // R-6.4 — the list is built from names git reported as branches, and a detached
  // HEAD's sha is not one of them. It cannot appear here to be selected.
  const local = listing?.local ?? [];
  const localNames = new Set(local.map((b) => b.name));
  const remoteOnly = (listing?.remote ?? []).filter((name) => !localNames.has(name));

  return (
    <div style={gitPop} data-testid="git-branch-menu">
      <div style={applyPopHead}>
        <span style={{ fontWeight: 700 }}>Change branch</span>
        <button type="button" onClick={onClose} style={closeBtn} title="Close" aria-label="Close">
          ✕
        </button>
      </div>

      {refusal && (
        <div style={refusalBox} data-testid="git-branch-refusal">
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            Uncommitted work is in the way, so the branch was not changed.
          </div>
          <ul style={refusalList}>
            {refusal.map((path) => (
              <li key={path}>
                <code style={targetChip}>{path}</code>
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 6 }}>Commit these, or set them aside yourself, and try again.</div>
        </div>
      )}
      {failure && <div style={refusalBox}>{failure}</div>}

      {listing === null ? (
        <div style={{ padding: '12px', color: '#94a3b8', fontSize: 12.5 }}>Reading branches…</div>
      ) : (
        <div style={{ maxHeight: 300, overflow: 'auto', padding: 8 }}>
          {local.map((branch) => (
            <button
              key={branch.name}
              type="button"
              onClick={() => onSelect(branch.name)}
              disabled={branch.name === current || changing !== null}
              data-testid={`git-branch-${branch.name}`}
              style={{ ...scopeRow, opacity: branch.name === current ? 0.55 : 1 }}
            >
              <span style={scopeTitle}>{branch.name}</span>
              <span style={branchMeta}>
                {branch.name === current
                  ? 'current'
                  : changing === branch.name
                    ? 'changing…'
                    : // Absent counts are absent, not zero: R-5.2 distinguishes "level
                      // with an upstream" from "has no upstream to be level with".
                      branch.ahead === undefined
                      ? 'no upstream'
                      : `↑${branch.ahead} ↓${branch.behind ?? 0}`}
              </span>
            </button>
          ))}
          {remoteOnly.map((name) => (
            <button
              key={`origin/${name}`}
              type="button"
              onClick={() => onSelect(name)}
              disabled={changing !== null}
              data-testid={`git-branch-${name}`}
              style={scopeRow}
            >
              <span style={scopeTitle}>{name}</span>
              <span style={branchMeta}>{changing === name ? 'changing…' : 'on origin'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * How many pull requests the list renders before it stops (R-7.9).
 *
 * The count beside the chip is NOT bounded by this and must never be: it is the
 * number github.com shows for the same repository, and a header that quietly reported
 * "8 open" on a repository with sixty would be wrong in the one place the user checks
 * it against another screen. So the two numbers are allowed to disagree, and the list
 * says which of them it is.
 */
const PULL_LIST_BOUND = 8;

/**
 * The open pull requests, with the one action each of them has (R-7.6 … R-7.9).
 *
 * A pull request carrying a collaboration document is an active collaboration and the
 * thing to do with it is resume it; one that carries none is somebody's code and the
 * thing to do with it is read it. Offering both on every row would ask the user to
 * know which kind they are looking at — which is the distinction this list exists to
 * draw for them.
 */
function PullMenu({
  pulls,
  onResume,
  onReview,
  onClose,
}: {
  pulls: PullRequestSummary[];
  onResume: (pull: PullRequestSummary) => void;
  onReview: (pull: PullRequestSummary) => void;
  onClose: () => void;
}) {
  const shown = pulls.slice(0, PULL_LIST_BOUND);
  return (
    <div style={gitPop} data-testid="git-pull-menu">
      <div style={applyPopHead}>
        <span style={{ fontWeight: 700 }}>Open pull requests</span>
        <button type="button" onClick={onClose} style={closeBtn} title="Close" aria-label="Close">
          ✕
        </button>
      </div>
      {pulls.length === 0 ? (
        <div style={{ padding: 12, color: '#94a3b8', fontSize: 12.5 }}>No open pull requests.</div>
      ) : (
        <div style={{ maxHeight: 320, overflow: 'auto', padding: 8 }}>
          {shown.map((pull) => (
            <div key={pull.number} style={pullRow} data-testid={`git-pull-${pull.number}`}>
              <span style={scopeTitle}>
                <span style={gitDot}>#{pull.number}</span> {pull.title}
              </span>
              {pull.documentId ? (
                <>
                  <span style={collabBadge} data-testid={`git-pull-${pull.number}-collab`}>
                    collaboration
                  </span>
                  <button type="button" onClick={() => onResume(pull)} style={rerunBtn}>
                    Resume
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => onReview(pull)} style={rerunBtn}>
                  Review
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {pulls.length > shown.length && (
        <div style={modelNote} data-testid="git-pull-truncated">
          Showing {shown.length} of {pulls.length}. The rest are on GitHub.
        </div>
      )}
    </div>
  );
}

/** Brand lockup + the full on-disk path of the file shown in the main section. */
function Brand({ file, actions }: { file: string; actions?: HeaderActions }) {
  const root = useSpecsRoot();
  const [pathCopied, setPathCopied] = useState(false);

  // Full path to the displayed file, joined with the platform separator inferred from root.
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const fullPath = root && file ? `${root}${sep}${file}` : root;

  const copyPath = async () => {
    if (!fullPath) return;
    try {
      await navigator.clipboard.writeText(fullPath);
    } catch {
      window.prompt('File path:', fullPath);
    }
    setPathCopied(true);
    setTimeout(() => setPathCopied(false), 1600);
  };

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
      <SpecMark />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={wordmarkRow}>
          <span style={wordmark}>Visual Specs</span>
          <span style={byline}>by Uncle&#8209;Dev</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, minWidth: 0 }}>
          <button
            type="button"
            onClick={copyPath}
            title={fullPath ? `Click to copy · ${fullPath}` : 'Locating specs…'}
            style={pathBtn}
          >
            <span style={{ color: '#94a3b8', display: 'flex' }}><FolderIcon /></span>
            <span style={pathText}>{root || 'locating specs…'}</span>
            {file && (
              <>
                <span style={pathSep}>›</span>
                <span style={pathFile}>{file}</span>
              </>
            )}
            <span style={{ color: pathCopied ? '#16a34a' : '#cbd5e1', display: 'flex', marginLeft: 2 }}>
              {pathCopied ? '✓' : <CopyIcon />}
            </span>
          </button>
          {/* R-3.1 — adjacent to the served path, in both headers: `Brand` is what
              `MainHeader` and `BrandHeader` share, so one placement covers both. */}
          <GitChip actions={actions} />
          <ChangeDirButton />
        </div>
      </div>
    </div>
  );
}

/** Open a different directory via the OS-native folder picker, then reload. */
function ChangeDirButton() {
  const [picking, setPicking] = useState(false);
  const pick = async () => {
    setPicking(true);
    try {
      const res = await fetch('/__vs/dir/pick', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as { root?: string; cancelled?: boolean; error?: string };
      if (res.ok && data.root) {
        window.location.reload(); // full reset onto the new directory
        return;
      }
      if (data.cancelled) return; // dialog dismissed — no change
      window.alert(data.error || 'Could not change the directory.');
    } catch {
      window.alert('Could not open the folder picker.');
    } finally {
      setPicking(false);
    }
  };
  return (
    <button
      type="button"
      onClick={pick}
      disabled={picking}
      title="Open a different directory (uses your system folder picker)"
      style={changeBtn}
    >
      <FolderIcon size={11} /> {picking ? 'Opening…' : 'Change…'}
    </button>
  );
}

/** Paste-into-chat variant: the shared prompt, with a placeholder header to fill in. */
function buildPrompt(open: CommentRecord[]): string {
  return `{{your skill/command/prompt}}\n\n${buildApplyPrompt(open)}`;
}

// ---- Apply activity: a SHARED, server-side job. Every tab on the same
// directory subscribes to /__vs/apply/events and watches the identical stream;
// starting/cancelling is a separate POST. So two browsers see the same run.

type ApplyLogKind = 'system' | 'tool' | 'assistant' | 'result' | 'error';
type Row = { kind: ApplyLogKind; text?: string; tool?: string; target?: string };
type AppliedComment = { id: string; path: string; comment: string; workflow: string };
type Agent = { id: string; type: string; task?: string; status: 'running' | 'done' };
type ApplyFrame =
  | { type: 'sync'; running: boolean; startedAt: number | null; events: ApplyFrame[] }
  | { type: 'start'; openCount: number; startedAt: number }
  | { type: 'log'; kind: ApplyLogKind; text?: string; tool?: string; target?: string; agentId?: string }
  | { type: 'agent-start'; agentId: string; agentType: string; task?: string }
  | { type: 'agent-done'; agentId: string }
  | { type: 'done'; ok: boolean; applied: number; appliedComments?: AppliedComment[]; exitCode: number | null; cancelled?: boolean }
  | { type: 'error'; message: string };

type ApplyPhase = 'idle' | 'running' | 'done' | 'error' | 'cancelled';
type ApplyState = { phase: ApplyPhase; startedAt: number | null; rows: Row[]; summary: string; applied: AppliedComment[]; agents: Agent[] };
const APPLY_INIT: ApplyState = { phase: 'idle', startedAt: null, rows: [], summary: '', applied: [], agents: [] };
const ROW_CAP = 400;

function applyReduce(s: ApplyState, e: ApplyFrame): ApplyState {
  switch (e.type) {
    case 'sync': {
      // Rebuild from a fresh snapshot — makes EventSource reconnects idempotent.
      let st: ApplyState = { ...APPLY_INIT, startedAt: e.startedAt };
      for (const ev of e.events) st = applyReduce(st, ev);
      return e.running ? { ...st, phase: 'running' } : st;
    }
    case 'start':
      return { ...APPLY_INIT, phase: 'running', startedAt: e.startedAt };
    case 'log':
      return { ...s, rows: [...s.rows.slice(-ROW_CAP), { kind: e.kind, text: e.text, tool: e.tool, target: e.target }] };
    case 'agent-start':
      // Dedupe by id — a replayed sync must not double-list an agent.
      return s.agents.some((a) => a.id === e.agentId)
        ? s
        : { ...s, agents: [...s.agents, { id: e.agentId, type: e.agentType, task: e.task, status: 'running' }] };
    case 'agent-done':
      // Ignore ids we never tracked (every tool_result emits one, not just Tasks).
      return s.agents.some((a) => a.id === e.agentId)
        ? { ...s, agents: s.agents.map((a) => (a.id === e.agentId ? { ...a, status: 'done' } : a)) }
        : s;
    case 'error':
      return { ...s, rows: [...s.rows.slice(-ROW_CAP), { kind: 'error', text: e.message }] };
    case 'done':
      return {
        ...s,
        applied: e.appliedComments ?? [],
        // Any sub-agent still flagged running when the run ends is, by definition, finished.
        agents: s.agents.map((a) => ({ ...a, status: 'done' })),
        phase: e.cancelled ? 'cancelled' : e.ok ? 'done' : 'error',
        summary: e.cancelled
          ? `Cancelled — ${e.applied} applied before stop`
          : e.ok
            ? `Applied ${e.applied} comment${e.applied === 1 ? '' : 's'}`
            : `claude exited ${e.exitCode ?? '—'}`,
      };
    default:
      return s;
  }
}

const TOOL_GLYPH: Record<string, string> = {
  Read: '⌖', Edit: '✎', Write: '✎', MultiEdit: '✎', NotebookEdit: '✎',
  Bash: '⌘', Skill: '✦', Task: '⚇', Grep: '⌕', Glob: '⌕', TodoWrite: '☑', AskUserQuestion: '?',
};
const toolGlyph = (t?: string) => (t && TOOL_GLYPH[t]) || '▸';
const kindGlyph = (k: ApplyLogKind) => (k === 'error' ? '!' : k === 'result' ? '✓' : '·');
const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * The running clock, isolated in its own leaf so its 250ms tick re-renders only
 * this text node — NOT the parent ApplyButton and its (up to 400-row) feed. Keeps
 * the activity panel from pegging the CPU while a run is in flight. When not
 * running it holds the last value (the SAME instance persists across the
 * running→done transition, so the duration stays put).
 */
function ElapsedTimer({ startedAt, running }: { startedAt: number | null; running: boolean }) {
  const [elapsed, setElapsed] = useState(() => (startedAt ? Date.now() - startedAt : 0));
  useEffect(() => {
    if (!running || !startedAt) return;
    const tick = () => setElapsed(Date.now() - startedAt);
    tick();
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
  }, [running, startedAt]);
  return <>{fmtElapsed(elapsed)}</>;
}

type ApplyView = 'closed' | 'scope' | 'activity';

/** The Apply control: scope chooser → shared live activity feed + timer + cancel. */
function ApplyButton({ open, file, onRunningChange }: { open: CommentRecord[]; file: string; onRunningChange?: (running: boolean) => void }) {
  const [state, dispatch] = useReducer(applyReduce, APPLY_INIT);
  const [view, setView] = useState<ApplyView>('closed');
  const feedRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const openCount = open.length;
  // The active file is whatever is shown in the main section; its comments share its path.
  const activeFile = open.filter((c) => c.target.path === file);

  // Always-on subscription — this is what makes activity shared across tabs.
  // Frames are coalesced and flushed once per animation frame: a fast `claude`
  // can emit a burst of stream-json lines, and dispatching each one separately
  // would re-render (and re-reconcile the feed) per line — enough to peg a core.
  // Batching collapses a burst into a single render.
  useEffect(() => {
    const es = new EventSource('/__vs/apply/events');
    let pending: ApplyFrame[] = [];
    let raf: number | null = null;
    const flush = () => {
      raf = null;
      const batch = pending;
      pending = [];
      for (const f of batch) dispatch(f); // React 18 batches these into one render
    };
    es.onmessage = (ev) => {
      const frame = JSON.parse(ev.data) as ApplyFrame;
      pending.push(frame);
      // A live `done` (sync's done events are nested, never land here): the skill
      // edited files + flipped statuses on disk — refresh the cart and the source.
      if (frame.type === 'done') {
        window.dispatchEvent(new CustomEvent('vs:comments-changed'));
        window.dispatchEvent(new CustomEvent('vs:source-changed'));
      }
      if (raf == null) raf = requestAnimationFrame(flush);
    };
    return () => {
      es.close();
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, []);

  const running = state.phase === 'running';

  // Report run state up so the header can paint its full-width progress line.
  useEffect(() => {
    onRunningChange?.(running);
  }, [running, onRunningChange]);

  // Stick the feed to the newest row.
  useEffect(() => {
    if (view === 'activity' && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [state.rows.length, view]);

  // Click-outside closes the popover (the SSE subscription stays connected regardless).
  useEffect(() => {
    if (view === 'closed') return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setView('closed');
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [view]);

  const start = (ids?: string[]) => {
    setView('activity');
    void fetch('/__vs/apply/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ids ? { ids } : {}),
    }).catch(() => {}); // activity arrives via the stream
  };
  const cancel = () => void fetch('/__vs/apply/cancel', { method: 'POST' }).catch(() => {});

  // Button click: while there's a run (live or finished) toggle the activity panel;
  // otherwise open the scope chooser to pick what to apply.
  const onButton = () => {
    if (running || state.rows.length || state.summary) setView((v) => (v === 'closed' ? 'activity' : 'closed'));
    else setView((v) => (v === 'scope' ? 'closed' : 'scope'));
  };

  const titles: Record<ApplyPhase, string> = { running: 'Applying comments', done: 'Done', cancelled: 'Cancelled', error: 'Stopped', idle: 'Apply' };
  const title = titles[state.phase];

  /*
   * P2 — the button names what it is about to do to, rather than naming the verb.
   *
   * "Apply" beside a separate count chip asks the reader to join two controls into one
   * sentence, and the join is where the mistake lives: this is the control that lets an
   * agent edit files, so how many of them it is about to act on belongs in its own
   * label. With none there is no count to state and the bare verb is the honest form —
   * the button is disabled there anyway.
   */
  const applyLabel = openCount === 0 ? 'Apply' : `Apply ${openCount} comment${openCount === 1 ? '' : 's'}`;

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={onButton}
        disabled={openCount === 0 && state.phase === 'idle'}
        title="Apply the open comments with claude (runs the apply-comments skill)"
        style={{ ...applyBtn, opacity: openCount === 0 && state.phase === 'idle' ? 0.5 : 1 }}
      >
        {running ? <PulseDot /> : '✨'}{' '}
        {running ? (
          <>
            Applying · <ElapsedTimer startedAt={state.startedAt} running={running} />
          </>
        ) : (
          applyLabel
        )}
      </button>

      {view === 'scope' && (
        <ScopeChooser
          workspaceCount={openCount}
          activeFile={activeFile}
          file={file}
          onClose={() => setView('closed')}
          onRun={start}
        />
      )}

      {view === 'activity' && (
        <div style={applyPop}>
          <div style={applyPopHead}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <StatusDot phase={state.phase} />
              <span style={{ fontWeight: 700 }}>{title}</span>
              {(running || state.startedAt) && (
                <span style={timerPill}>
                  <ElapsedTimer startedAt={state.startedAt} running={running} />
                </span>
              )}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {running ? (
                <button type="button" onClick={cancel} style={cancelBtn} title="Stop the run (kills claude)">
                  ■ Cancel
                </button>
              ) : (
                <button type="button" onClick={() => setView('scope')} disabled={openCount === 0} style={{ ...rerunBtn, opacity: openCount === 0 ? 0.5 : 1 }} title="Run again">
                  ↻ Run again
                </button>
              )}
              <button type="button" onClick={() => setView('closed')} style={closeBtn} title="Close" aria-label="Close">
                ✕
              </button>
            </span>
          </div>

          {state.summary && (
            <div style={{ ...summaryLine, color: state.phase === 'error' ? '#b91c1c' : state.phase === 'cancelled' ? '#b45309' : '#15803d' }}>
              {state.summary}
            </div>
          )}

          {state.applied.length > 0 && <AppliedList applied={state.applied} />}

          {(running || state.agents.length > 0) && <AgentStrip phase={state.phase} agents={state.agents} />}

          <div ref={feedRef} style={feedScroll}>
            {state.rows.length === 0 ? (
              <div style={{ padding: '14px 12px', color: '#94a3b8', fontSize: 12.5 }}>Waiting for claude…</div>
            ) : (
              <ul style={feedList}>
                {state.rows.map((row, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: append-only feed
                  <ActivityRow key={i} row={row} />
                ))}
              </ul>
            )}
          </div>
          <div style={modelNote}>Runs with your default Claude model.</div>
        </div>
      )}
    </div>
  );
}

/** Pre-run scope picker: whole workspace, the active file, or a hand-picked subset. */
function ScopeChooser({
  workspaceCount,
  activeFile,
  file,
  onClose,
  onRun,
}: {
  workspaceCount: number;
  activeFile: CommentRecord[];
  file: string;
  onClose: () => void;
  onRun: (ids?: string[]) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const fileName = file ? basename(file) : '';
  // R-4.1 — the branch belongs HERE, not only in the header corner. The failure
  // this feature exists to fix is "comment, run apply, and the edits land on
  // whichever branch happened to be checked out", and this popover is where the
  // user commits to the run. R-4.2: where no branch is known — state `none`, or
  // the first read has not come back — nothing is shown and nothing is blocked.
  // The whole context is read, not just the branch string: R-4.3 needs `detached`,
  // and believing you are on a branch when you are not matters MORE here than in
  // the chip — the chip is orientation, this is consent to let an agent edit files.
  const ctx = useGitContext();
  const head = ctx && ctx.state !== 'none' ? ctx : null;
  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div style={applyPop}>
      <div style={applyPopHead}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontWeight: 700 }}>Apply comments…</span>
          {head && (
            <span
              style={head.detached ? { ...scopeBranch, ...scopeBranchDetached } : scopeBranch}
              data-testid="scope-branch"
              title={
                head.detached
                  ? `${DETACHED_TITLE} — edits will land on this commit, not on a branch`
                  : 'Edits will land on this branch'
              }
            >
              on {headText(head.branch, head.detached)}
            </span>
          )}
        </span>
        <button type="button" onClick={onClose} style={closeBtn} title="Close" aria-label="Close">
          ✕
        </button>
      </div>

      {!picking ? (
        <div style={{ padding: 8 }}>
          <button type="button" onClick={() => onRun()} disabled={workspaceCount === 0} style={scopeRow}>
            <span style={scopeTitle}>Whole workspace</span>
            <span style={scopeCount}>{workspaceCount}</span>
          </button>
          <button
            type="button"
            onClick={() => onRun(activeFile.map((c) => c.id))}
            disabled={activeFile.length === 0}
            style={{ ...scopeRow, opacity: activeFile.length === 0 ? 0.5 : 1 }}
            title={fileName ? `Apply comments on ${fileName}` : 'Open a file to scope to it'}
          >
            <span style={scopeTitle}>This file{fileName ? <span style={scopeSub}> · {fileName}</span> : ''}</span>
            <span style={scopeCount}>{activeFile.length}</span>
          </button>
          <button
            type="button"
            onClick={() => setPicking(true)}
            disabled={activeFile.length === 0}
            style={{ ...scopeRow, opacity: activeFile.length === 0 ? 0.5 : 1 }}
          >
            <span style={scopeTitle}>Pick comments…</span>
            <span style={{ ...scopeCount, background: 'transparent', color: '#94a3b8' }}>›</span>
          </button>
        </div>
      ) : (
        <>
          <ul style={{ ...feedList, maxHeight: 280, overflow: 'auto' }}>
            {activeFile.map((c) => (
              <li key={c.id} style={pickItem}>
                <label style={pickLabel}>
                  <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggle(c.id)} style={{ marginTop: 3 }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ fontSize: 11, opacity: 0.55, display: 'block' }}>
                      {c.target.heading ?? '(top)'}
                      {c.target.startLine != null ? ` · L${c.target.startLine}` : ''}
                    </span>
                    <span>{c.comment}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div style={pickFooter}>
            <button type="button" onClick={() => setPicking(false)} style={rerunBtn}>
              ‹ Back
            </button>
            <button
              type="button"
              onClick={() => onRun([...checked])}
              disabled={checked.size === 0}
              style={{ ...applyBtn, minWidth: 0, padding: '6px 12px', opacity: checked.size === 0 ? 0.5 : 1 }}
            >
              ✨ Apply selected ({checked.size})
            </button>
          </div>
        </>
      )}
      <div style={modelNote}>Runs with your default Claude model.</div>
    </div>
  );
}

/** Structured list of the comments that flipped to "applied" this run. */
function AppliedList({ applied }: { applied: AppliedComment[] }) {
  return (
    <div style={appliedWrap}>
      <div style={appliedHead}>
        ✅ Applied {applied.length} comment{applied.length === 1 ? '' : 's'}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {applied.map((c) => (
          <li key={c.id} style={appliedItem}>
            <code style={appliedPath} title={c.path}>
              {basename(c.path)}
            </code>
            {c.workflow !== 'visual-spec' && <span style={appliedFlow}>{c.workflow}</span>}
            <span style={appliedText} title={c.comment}>
              {c.comment}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const AGENT_GLYPH = (type: string) => (type === 'main' ? '✦' : '⚇');

/** Compact strip of agents: the main session + each spawned sub-agent, with status. */
function AgentStrip({ phase, agents }: { phase: ApplyPhase; agents: Agent[] }) {
  const mainStatus: 'running' | 'done' = phase === 'running' ? 'running' : 'done';
  const chips = [{ id: 'main', type: 'apply-comments', status: mainStatus }, ...agents];
  return (
    <div style={agentStrip}>
      {chips.map((a) => (
        <span key={a.id} style={agentChip} title={('task' in a && a.task) || a.type}>
          <span style={{ opacity: 0.7 }}>{AGENT_GLYPH(a.id === 'main' ? 'main' : a.type)}</span>
          <span style={{ fontWeight: 600 }}>{a.type}</span>
          {a.status === 'running' ? <PulseAgentDot /> : <span style={{ color: '#16a34a' }}>✓</span>}
        </span>
      ))}
    </div>
  );
}

/** A small purple pulse for an in-flight agent chip. */
function PulseAgentDot() {
  return <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#7c3aed', animation: 'vs-pulse 1.1s ease-in-out infinite' }} />;
}

/**
 * One row of the activity feed — a glyph chip + content tuned to the kind.
 * Memoized: row objects keep identity across renders (the reducer never mutates
 * them), so an incoming frame only re-renders the new row, not the whole list.
 */
const ActivityRow = memo(function ActivityRow({ row }: { row: Row }) {
  if (row.kind === 'tool') {
    const display = row.target ? (row.tool === 'Bash' ? row.target.slice(0, 80) : basename(row.target)) : '';
    return (
      <li style={rowLi}>
        <span style={{ ...glyphChip, background: '#ede9fe', color: '#6d28d9' }}>{toolGlyph(row.tool)}</span>
        <div style={rowBody}>
          <span style={{ fontWeight: 600, color: '#3730a3' }}>{row.tool}</span>
          {display && (
            <code style={targetChip} title={row.target}>
              {display}
            </code>
          )}
        </div>
      </li>
    );
  }
  const tone =
    row.kind === 'error'
      ? { dot: { background: '#fee2e2', color: '#b91c1c' }, text: { color: '#b91c1c' } }
      : row.kind === 'result'
        ? { dot: { background: '#dcfce7', color: '#15803d' }, text: { color: '#0f172a', fontWeight: 600 } }
        : { dot: { background: '#f1f5f9', color: '#94a3b8' }, text: { color: '#64748b', fontStyle: 'italic' as const } };
  return (
    <li style={rowLi}>
      <span style={{ ...glyphChip, ...tone.dot }}>{kindGlyph(row.kind)}</span>
      <div style={{ ...rowBody, ...tone.text }}>{row.text}</div>
    </li>
  );
});

/** A pulsing dot for the button while a run is in flight. */
function PulseDot() {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'white', animation: 'vs-pulse 1.1s ease-in-out infinite' }} />;
}

/** Header status indicator, colour-coded per phase. */
function StatusDot({ phase }: { phase: ApplyPhase }) {
  const color = phase === 'running' ? '#7c3aed' : phase === 'done' ? '#16a34a' : phase === 'error' ? '#dc2626' : phase === 'cancelled' ? '#d97706' : '#94a3b8';
  return (
    <span
      style={{
        display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: color,
        ...(phase === 'running' ? { animation: 'vs-pulse 1.1s ease-in-out infinite' } : {}),
      }}
    />
  );
}

/** Toggles a popover listing applied comments for the current document (read-only history). */
function HistoryButton({ file, comments }: { file: string; comments: CommentRecord[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-label="History"
        onClick={() => setOpen((v) => !v)}
        title="Applied comment history for this document"
        style={secondary}
      >
        History
      </button>
      {open && (
        <div style={historyPop}>
          <div style={applyPopHead}>
            <span style={{ fontWeight: 700 }}>Applied history</span>
            <button type="button" onClick={() => setOpen(false)} style={closeBtn} title="Close" aria-label="Close">
              ✕
            </button>
          </div>
          <div style={{ overflow: 'auto', maxHeight: 380 }}>
            <CommentHistoryList path={toPath(file)} comments={comments} />
          </div>
        </div>
      )}
    </div>
  );
}

/** The inspector on/off toggle — only meaningful for markdown (needs InspectorProvider). */
function InspectorToggle() {
  const { active, setActive } = useInspector();
  return (
    <button type="button" onClick={() => setActive(!active)} title="Same as pressing I" style={active ? startBtnActive : startBtn}>
      <CommentIcon /> {active ? 'Commenting…' : 'Start comments'}
    </button>
  );
}

/**
 * The document id derived from the open file's name, sanitized into `DOCUMENT_ID_RE`.
 *
 * The id names the branch (`visual-spec/<id>`) and the record, so it cannot be the raw
 * file name: spaces, dots and accents are all legal in a file name and none of them is
 * legal here. A run of anything the id may not contain collapses to a single `-`, and
 * the leading characters are trimmed until an alphanumeric because the pattern anchors
 * on one.
 *
 * The result may be empty (`___.md`, `---.md`), and that is deliberate: the caller asks
 * for one rather than inventing a name the author never chose.
 */
export function documentIdFromPath(path: string): string {
  const base = (path.split(/[\\/]/).pop() ?? '').replace(/\.[^.]+$/, '');
  return base
    .toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
}

type PrStatus = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string } | { kind: 'ok'; message: string };

/** The bytes on disk for the open file — what the create job commits to the branch. */
async function readMarkdown(path: string): Promise<string> {
  const res = await fetch(`/__vs/tree/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Could not read ${path} (HTTP ${res.status}).`);
  const body = (await res.json()) as { content?: unknown };
  if (typeof body.content !== 'string') throw new Error(`${path} has no text content to commit.`);
  return body.content;
}

/**
 * R-8.5 from the file that is already open — "put *this* under review".
 *
 * `CollabOpenPanel`'s own author entry creates a NEW, EMPTY document at
 * `documents/<id>.md`. That is the wrong shape for the only thing an author ever
 * actually wants to do first: they have written a file, it is on screen, and they want a
 * pull request for it. So this posts the same `POST /__vs/collab/start` with the two
 * fields that route has always accepted and nothing sent until now — the *open file's*
 * `documentPath` and its `markdown`.
 *
 * THE FILE KEEPS THE PATH IT ALREADY HAS. `documentPath` is `test/javier/for-comment.md`,
 * not `documents/for-comment.md`. It breaks the convention that every document lives
 * under `documents/`, on purpose: copying the bytes to a second path would leave the same
 * document in two places on the branch, and the author would sooner or later edit the one
 * the pull request is not about. One file, one path, wherever the author put it.
 *
 * IT DOES NOT OFFER WHAT THE SERVER WILL REFUSE. `create` is author-only, and
 * `GET /__vs/collab` already says whether this credential can write. On a definite `false`
 * the form is replaced by the server's own reason (R-12.5) rather than by a button that
 * exists to fail. An *absent* `canPublish` means the server could not determine write
 * access; the form is shown, because the route refuses server-side regardless (R-9.11).
 *
 * IT IS LABELLED "Start collaboration". This control CREATES — a branch, a commit and a
 * pull request. It was briefly relabelled "Open pull request" during the P2 header pass,
 * which was wrong twice over: "open a pull request" is how people say *go look at one
 * that exists*, and the git chip two zones away opens a popover titled "Open pull
 * requests" that does exactly that. The author reported the create action as missing —
 * it was on screen the whole time, wearing the name of the thing beside it.
 *
 * "Collaboration" rather than "pull request" because that is the object this makes: a
 * collaboration document, which happens to be carried by a pull request. The popover
 * below still says what it will do to the repository, so nobody has to infer the
 * mechanics from the verb.
 */
function StartPullRequestButton({
  file,
  ready = false,
  candidates = [],
  onStarted,
}: {
  file: string;
  /** The caller's verdict that this document's notes are worked through — see `readyToShare`. */
  ready?: boolean;
  /** R-8.34 — other local files that carry notes, offerable on the same pull request. */
  candidates?: string[];
  onStarted?: (documentId: string) => void;
}) {
  const client = useMemo(() => createCollabClient(), []);
  const [availability, setAvailability] = useState<CollabAvailabilitySnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [id, setId] = useState(() => documentIdFromPath(file));
  const [title, setTitle] = useState('');
  const [prStatus, setPrStatus] = useState<PrStatus>({ kind: 'idle' });
  /**
   * R-8.34 — the companions the author has ticked. Empty by default: the open file alone
   * is the request, and a file joins a pull request only because someone chose it
   * (R-8.35). Holding only the *extras* is what makes that default impossible to get
   * wrong — there is no state in which the document itself is unticked.
   */
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void client.availability().then((res) => {
      // A failed probe is not a verdict: leave `availability` null and render nothing,
      // rather than claim collaboration is off.
      if (live && res.ok) setAvailability(res.value);
    });
    return () => {
      live = false;
    };
  }, [client]);

  // A different file is a different document. The id follows it, and last file's error
  // must not sit over this one's form.
  useEffect(() => {
    setId(documentIdFromPath(file));
    setTitle('');
    setPrStatus({ kind: 'idle' });
    setOpen(false);
    // A different document is a different selection. Carrying the ticks across would put
    // files on a pull request the author chose them for a *different* document.
    setChosen(new Set());
  }, [file]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!availability?.available) return null;
  const blocked = availability.canPublish === false;

  async function start() {
    const documentId = id.trim();
    if (!documentId) {
      setPrStatus({ kind: 'error', message: 'Enter a document id — it names the branch and the record, e.g. for-comment.' });
      return;
    }
    if (!DOCUMENT_ID_RE.test(documentId)) {
      // The route's own refusal, said before the round trip rather than after it.
      setPrStatus({ kind: 'error', message: `invalid documentId: ${documentId} — letters, digits, "-" and "_" only, starting with a letter or digit.` });
      return;
    }
    setPrStatus({ kind: 'busy' });
    /*
     * R-8.35 — the selection, read at the moment of sending rather than when it was
     * ticked. A file the author ticked and then edited must go up as they left it.
     *
     * The document is read first and separately because its failure is fatal in a way a
     * companion's is not — but both are fatal here, and deliberately: a pull request that
     * quietly contains three of the four files someone chose is worse than one that was
     * never opened, because nothing afterwards says a file is missing.
     */
    const selection = [file, ...candidates.filter((p) => chosen.has(p))];
    let files: { path: string; markdown: string }[];
    try {
      files = await Promise.all(selection.map(async (path) => ({ path, markdown: await readMarkdown(path) })));
    } catch (err) {
      setPrStatus({ kind: 'error', message: (err as Error).message });
      return;
    }
    const markdown = files[0]!.markdown;
    const trimmedTitle = title.trim();
    const res = await client.start({
      documentId,
      documentPath: file,
      markdown,
      // R-8.28 — a single-file start sends no `files` at all, so it is byte-for-byte the
      // request it always was and cannot regress on the server's new branch.
      ...(files.length > 1 ? { files } : {}),
      ...(trimmedTitle ? { title: trimmedTitle } : {}),
    });
    if (!res.ok) {
      // The server's own words, as `CollabOpenPanel` does — a 403 here names write access.
      setPrStatus({ kind: 'error', message: res.message });
      return;
    }
    setPrStatus({ kind: 'ok', message: `Creating ${documentId} — opening a pull request…` });
    onStarted?.(documentId);
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-vs-start-pr-ready={ready && !blocked ? 'true' : undefined}
        title={
          blocked
            ? 'This session cannot create a pull request'
            : ready
              ? `Your notes on ${file} are all applied — start a collaboration, which creates a branch and a pull request`
              : `Start a collaboration on ${file} — creates a branch and a pull request`
        }
        style={blocked ? { ...secondary, color: '#94a3b8' } : ready ? startPrimary : secondary}
      >
        {ready && !blocked && <CheckIcon />}
        Start collaboration
      </button>
      {open && (
        <div style={historyPop} data-vs-start-pr>
          <div style={applyPopHead}>
            <span style={{ fontWeight: 700 }}>Start collaboration</span>
            <button type="button" onClick={() => setOpen(false)} style={closeBtn} title="Close" aria-label="Close">
              ✕
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12 }}>
            {blocked ? (
              <p data-vs-start-pr-blocked style={prNote}>
                {availability.publishBlocked?.message ??
                  `Your credential has no write access to ${availability.repo.owner}/${availability.repo.repo}, so this session cannot open a pull request.`}
              </p>
            ) : (
              <>
                <p style={prNote}>
                  Commits {chosen.size > 0 ? <strong>{chosen.size + 1} files</strong> : <code>{file}</code>} to{' '}
                  <code>visual-spec/&lt;id&gt;</code> at {chosen.size > 0 ? 'their same paths' : 'that same path'} and
                  opens one pull request against {availability.repo.owner}/{availability.repo.repo}.
                </p>
                {/*
                  R-8.34 / R-8.35 — the other files the author has been noting on, offered
                  and unticked. Absent entirely when there are none: an empty "also
                  include" list is a control that explains a capability nobody can use
                  here, and it would sit in the popover every single time.
                */}
                {candidates.length > 0 && (
                  <fieldset style={prFieldset} data-vs-start-pr-companions>
                    <legend style={prLegend}>Also include</legend>
                    {/* The document, stated and not offered — it is not the author's to untick. */}
                    <p style={prCompanionDoc}>
                      <code>{file}</code> — the document
                    </p>
                    {candidates.map((path) => (
                      <label key={path} style={prCompanionRow}>
                        <input
                          type="checkbox"
                          checked={chosen.has(path)}
                          onChange={(e) => {
                            const next = new Set(chosen);
                            if (e.target.checked) next.add(path);
                            else next.delete(path);
                            setChosen(next);
                          }}
                        />
                        <code style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{path}</code>
                      </label>
                    ))}
                  </fieldset>
                )}
                <label style={prRow}>
                  <span style={prLabel}>Document id</span>
                  <input value={id} onChange={(e) => setId(e.target.value)} placeholder="for-comment" style={prInput} />
                </label>
                <label style={prRow}>
                  <span style={prLabel}>Title</span>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Optional — defaults to the document id"
                    style={prInput}
                  />
                </label>
                <button type="button" onClick={() => void start()} disabled={prStatus.kind === 'busy'} style={rerunBtn}>
                  {prStatus.kind === 'busy' ? 'Creating…' : 'Create pull request'}
                </button>
              </>
            )}
            {(prStatus.kind === 'error' || prStatus.kind === 'ok') && (
              <p data-vs-start-pr-status style={prStatus.kind === 'error' ? prError : prOk}>
                {prStatus.message}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * P2 — the header as three zones and an overflow.
 *
 * The bar used to be eight controls at one weight in one row: Help, History,
 * View/Edit, Start comments, Start pull request, the count, Copy prompt, Apply. Three
 * of them read as the primary action and none of them was grouped, so the row offered
 * no answer to "where do I start" — the reader had to read all eight and infer the
 * three jobs they belong to.
 *
 * The zones ARE those three jobs, in the order the work happens: what the document is
 * (Document), what is being said about it (Review), what an agent does with that
 * (Agent). Only dividers mark them. Rendering the zone names as labels was rejected:
 * three words of chrome to explain seven controls costs more room than the grouping
 * saves, and grouping that has to be captioned has not worked.
 * ------------------------------------------------------------------ */
type HeaderZone = { name: string; label: string; content: ReactNode };

/**
 * An empty zone contributes no divider. A rule with nothing on one side of it does not
 * separate anything, and both Document (markdown only) and Review (inspector only)
 * genuinely empty out depending on what is open.
 */
function HeaderZones({ zones }: { zones: HeaderZone[] }) {
  const filled = zones.filter((z) => z.content !== null);
  return (
    <>
      {filled.map((z, i) => (
        <Fragment key={z.name}>
          {i > 0 && <span style={zoneDivider} data-vs-header-divider aria-hidden="true" />}
          {/*
            The divider is decoration, so it is hidden — a screen reader announcing
            "separator" three times says nothing about what was separated. The grouping
            itself is not decoration, and a rule on screen is invisible to a reader who
            is not looking at it, so each zone names itself to assistive technology.
            That name is deliberately NOT rendered: on screen the spacing and the rule
            already group these, and a caption over three controls costs more room than
            the grouping saves.
          */}
          <div style={zoneRow} data-vs-header-zone={z.name} role="group" aria-label={z.label}>
            {z.content}
          </div>
        </Fragment>
      ))}
    </>
  );
}

/**
 * Help and History, behind one control at the far right.
 *
 * Neither is part of doing the work — one explains the app and one reads what already
 * happened — so at full weight in the bar they competed with the controls that are.
 *
 * R-5.1 SURVIVES THIS. "History is always available, in both modes" is a claim about
 * gating, and nothing here gates it: `HistoryButton` is rendered unconditionally, in
 * every mode, exactly as before — it is one click further away, not conditional. The
 * panel's own History tab, which is the route most readers take, is untouched.
 *
 * THE PANEL IS HIDDEN, NOT UNMOUNTED, AND THAT IS LOAD-BEARING. `HelpButton` owns the
 * full-screen help overlay it opens, and the overlay renders as that button's sibling.
 * Unmounting the panel on dismiss would take the open overlay down with it — the user
 * would click Help, click anywhere in the page it opened, and watch it vanish.
 * `display: none` also takes the two buttons out of the tab order while closed, which
 * a hidden-but-mounted panel otherwise would not.
 */
function OverflowMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="More: help and history"
        aria-expanded={open}
        aria-controls="vs-header-more"
        title="More: help and history"
        style={overflowBtn}
      >
        ⋯
      </button>
      <div id="vs-header-more" style={{ ...overflowPop, display: open ? 'grid' : 'none' }}>
        {children}
      </div>
    </div>
  );
}

export type ViewMode = 'view' | 'edit';

/** Segmented View / Edit switch — shown only for markdown files. */
function ModeToggle({ mode, onModeChange }: { mode: ViewMode; onModeChange: (m: ViewMode) => void }) {
  return (
    <div style={segWrap} role="tablist" aria-label="View or edit">
      {(['view', 'edit'] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={mode === m}
          onClick={() => onModeChange(m)}
          style={mode === m ? segBtnActive : segBtn}
          title={m === 'view' ? 'Read & comment' : 'Edit the markdown source'}
        >
          {m === 'view' ? 'View' : 'Edit'}
        </button>
      ))}
    </div>
  );
}

export function MainHeader({
  file,
  onNavigate,
  withInspector = false,
  isMarkdown = false,
  mode = 'view',
  onModeChange,
  actions,
}: {
  file: string;
  onNavigate?: (f: string) => void;
  withInspector?: boolean;
  isMarkdown?: boolean;
  mode?: ViewMode;
  onModeChange?: (m: ViewMode) => void;
  actions?: HeaderActions;
}) {
  const { comments } = useComments(); // all files = the cart
  const open = comments.filter((c) => c.status === 'open');
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [applying, setApplying] = useState(false);
  const cartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showAll) return;
    const onDown = (e: MouseEvent) => {
      if (cartRef.current && !cartRef.current.contains(e.target as Node)) setShowAll(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showAll]);

  const copy = async () => {
    if (open.length === 0) return;
    try {
      await navigator.clipboard.writeText(buildPrompt(open));
    } catch {
      // clipboard may be blocked; fall back to a prompt window
      window.prompt('Copy this prompt for your agent:', buildPrompt(open));
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /*
   * P3 — the count chip, when the panel is already showing what it would list.
   *
   * `AllComments` renders over the Comments panel, and on the ordinary screen — a
   * markdown file open, the panel beside it — the two showed the same comments at the
   * same time, one on top of the other. The popover is not deleted, because it is still
   * the only surface that lists OTHER files' comments and navigates to them, which is
   * exactly the case where no panel can answer: `revealInCommentPanel` returns false
   * when nothing on screen is listing a comment, and the popover opens as it always did.
   */
  const panelListening = useSyncExternalStore(subscribeCommentPanel, isCommentPanelListening, () => false);

  /*
   * WHEN "Start collaboration" IS THE NEXT THING TO DO, AND ONLY THEN.
   *
   * The draft loop is: leave notes, let the agent apply them, share the result. The
   * header rendered the last step at the same weight throughout — `secondary`,
   * unconditionally — so nothing on screen ever marked the moment the document became
   * shareable. The author had to decide that for themselves, and the UI read identically
   * whether they had a page of unaddressed notes or a finished document.
   *
   * The condition is the honest reading of "done with my notes": this file has notes
   * that were applied, and none still open. Both halves matter. Without the first, a
   * file nobody has commented on would promote the instant it opened — a claim of
   * readiness about a document that has been through nothing. Without the second, it
   * would promote over outstanding work.
   *
   * It is a promotion, never a gate: the button is in the same place, with the same
   * label and the same behaviour, at every other moment. Nothing here disables it,
   * because "I want to share this now" is always a legitimate thing to mean.
   */
  const readyToShare = useMemo(() => {
    const mine = comments.filter((c) => c.target.path === file);
    return mine.some((c) => c.status === 'applied') && !mine.some((c) => c.status === 'open');
  }, [comments, file]);

  /*
   * R-8.34 — which OTHER files the author may put on the same pull request.
   *
   * "Every markdown file in the tree" would be a file picker, and a file picker is a
   * worse answer than the file tree the author already has. The useful set is much
   * smaller and the sidecar already knows it: the files they have been leaving notes on.
   * That is the honest reading of "files I am working on together" — it is derived from
   * what they did, not from a folder they have to remember.
   *
   * Sorted, because the sidecar's order is the order comments were written in, which is
   * not an order anyone is looking for a filename in.
   */
  const companionCandidates = useMemo(() => {
    const paths = new Set<string>();
    for (const c of comments) {
      if (c.target.path !== file && c.target.path.endsWith('.md')) paths.add(c.target.path);
    }
    return [...paths].sort();
  }, [comments, file]);

  const pickCount = () => {
    if (open.length === 0) return;
    if (revealInCommentPanel()) {
      setShowAll(false);
      return;
    }
    setShowAll((v) => !v);
  };

  return (
    <header style={bar}>
      <Brand file={file} actions={actions} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <HeaderZones
          zones={[
            { name: 'document', label: 'Document', content: isMarkdown && onModeChange ? <ModeToggle mode={mode} onModeChange={onModeChange} /> : null },
            {
              name: 'review',
              label: 'Review',
              content: (
                <>
                  {withInspector && mode === 'view' && <InspectorToggle />}
                  <div ref={cartRef} style={{ position: 'relative' }}>
                    <button
                      type="button"
                      onClick={pickCount}
                      title={panelListening ? 'Show these comments in the panel' : 'View all collected comments'}
                      style={{ ...cart, border: 'none', cursor: open.length > 0 ? 'pointer' : 'default' }}
                    >
                      <CommentIcon size={13} /> {open.length}
                    </button>
                    {showAll && open.length > 0 && (
                      <AllComments
                        open={open}
                        onPick={(f) => { onNavigate?.(f); setShowAll(false); }}
                      />
                    )}
                  </div>
                  {/*
                    R-8.5 — the open file's own way onto a pull request. Markdown only: the create
                    job commits the bytes as the document (R-0.1), and `actions.onResumeCollab` is
                    the same landing `CollabOpenPanel`'s `onOpened` reaches — the document pane.
                  */}
                  {isMarkdown && file && (
                    <StartPullRequestButton
                      file={file}
                      ready={readyToShare}
                      candidates={companionCandidates}
                      {...(actions?.onResumeCollab ? { onStarted: actions.onResumeCollab } : {})}
                    />
                  )}
                </>
              ),
            },
            {
              name: 'agent',
              label: 'Agent',
              content: (
                <>
                  {copied && <span style={toast}>✓ Copied</span>}
                  <button
                    type="button"
                    onClick={copy}
                    disabled={open.length === 0}
                    title="Copy a prompt for your agent to apply these comments"
                    style={{ ...secondary, display: 'inline-flex', alignItems: 'center', gap: 6, opacity: open.length === 0 ? 0.5 : 1 }}
                  >
                    {/*
                      `CopyIcon` rather than 📋. Every other glyph in this header is an
                      inline SVG that inherits `currentColor`, so the emoji was the one
                      mark that ignored the button's disabled colour and rendered in a
                      different family on every platform.
                    */}
                    <CopyIcon size={13} /> Copy prompt
                  </button>
                  <ApplyButton open={open} file={file} onRunningChange={setApplying} />
                </>
              ),
            },
          ]}
        />
        <OverflowMenu>
          <HelpButton />
          <HistoryButton file={file} comments={comments} />
        </OverflowMenu>
      </div>
      {applying && <ApplyProgressLine />}
      <style>{'@keyframes vs-pulse{0%,100%{opacity:1}50%{opacity:0.35}}@keyframes vs-apply-flow{0%{background-position:0% 0}100%{background-position:-200% 0}}'}</style>
    </header>
  );
}

/**
 * Indeterminate progress line pinned to the header's bottom edge, shown only while
 * an apply run is in flight. A multi-stop colour gradient (2× width) slides its
 * background-position left→right on a loop — reads as a colour band flowing across
 * the header until "Applying comments" finishes.
 */
function ApplyProgressLine() {
  return (
    <div style={progressTrack} aria-hidden>
      <div style={progressFlow} />
    </div>
  );
}

/** Dropdown listing every collected comment, grouped by file. Click jumps to the file. */
function AllComments({ open, onPick }: { open: CommentRecord[]; onPick: (surfaceId: string) => void }) {
  const byPath = new Map<string, CommentRecord[]>();
  for (const c of open) (byPath.get(c.target.path) ?? byPath.set(c.target.path, []).get(c.target.path)!).push(c);

  return (
    <div style={allPop}>
      <div style={allTitle}>{open.length} comment{open.length === 1 ? '' : 's'} collected</div>
      <div style={{ overflow: 'auto', maxHeight: 420 }}>
        {[...byPath.entries()].map(([p, cs]) => (
          <div key={p} style={{ padding: '6px 0' }}>
            <button type="button" onClick={() => onPick(p)} style={allFile} title={`Open ${p}`}>
              {p} <span style={{ opacity: 0.5, fontWeight: 400 }}>({cs.length})</span>
            </button>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {cs.map((c) => (
                <li key={c.id} style={allItem}>
                  {/* Same guard as the picker above: a whole-file comment has no line. */}
                  <div style={{ fontSize: 11, opacity: 0.55 }}>
                    {c.target.heading ?? '(top)'}
                    {c.target.startLine != null ? ` · L${c.target.startLine}` : ''}
                  </div>
                  <div>{c.comment}</div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Brand-only header for the empty state (no specs loaded → no comment controls).
 *
 * It still takes the actions: there is no document open to have unsaved work in, but
 * the sidebar behind it is showing a file tree, and R-6.7 does not stop applying
 * because nothing is selected.
 */
export function BrandHeader({ actions }: { actions?: HeaderActions } = {}) {
  return (
    <header style={bar}>
      <Brand file="" actions={actions} />
      <div style={{ flexShrink: 0 }}>
        <HelpButton />
      </div>
    </header>
  );
}

const DISPLAY = "'Bricolage Grotesque', system-ui, sans-serif";

const bar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  padding: '12px 18px',
  borderBottom: '1px solid #e5e7eb',
  background: 'linear-gradient(180deg, #ffffff 0%, #fbfaff 100%)',
  font: '13px system-ui',
  flexShrink: 0,
  // Establish a stacking context above the content below so header popovers
  // (Apply activity, all-comments) paint over the editor + inspector instead of
  // being overlapped by them. Below the full-screen help modal (zIndex 100).
  position: 'relative',
  zIndex: 60,
};
const wordmarkRow: React.CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8, lineHeight: 1 };
const wordmark: React.CSSProperties = {
  font: `700 18px ${DISPLAY}`,
  letterSpacing: '-0.02em',
  background: 'linear-gradient(92deg, #4f46e5 0%, #8b5cf6 70%)',
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  color: '#4f46e5',
};
const byline: React.CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: '#a78bca',
  background: '#f3f0fc',
  border: '1px solid #ece6fb',
  borderRadius: 5,
  padding: '2px 6px',
};
const pathBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  border: '1px solid transparent',
  background: 'transparent',
  borderRadius: 7,
  padding: '2px 6px 2px 2px',
  cursor: 'pointer',
  color: '#64748b',
};
const changeBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, padding: '2px 8px', border: '1px solid #d1d5db', borderRadius: 6, background: 'white', color: '#475569', cursor: 'pointer', font: '11px system-ui', fontWeight: 600 };
const pathText: React.CSSProperties = { font: '11.5px ui-monospace, "SF Mono", monospace', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
const pathSep: React.CSSProperties = { color: '#cbd5e1', fontSize: 13, flexShrink: 0 };
const pathFile: React.CSSProperties = { font: '600 11.5px ui-monospace, "SF Mono", monospace', color: '#7c3aed', flexShrink: 0 };
// ---- The git context chip. One shape, four tones — the tone carries the state
// alongside the icon, never instead of it.
/*
 * WHAT GIVES WAY WHEN THE ROW RUNS OUT OF ROOM.
 *
 * These were one pill. Everything in it had the same claim on one width, so
 * `metuur-ai/visual-spec-collaboration-test · spike/anchor-test · 3 open` rendered the
 * repository in full and cut the branch AND the count off the clipped right edge — both
 * still in the accessibility tree, neither on screen. The count is a button, so that was
 * a control that existed and could not be pressed, on exactly the repositories whose
 * names are long enough to hide it.
 *
 * Three pills cannot do that to each other: each clips its own content, so the worst a
 * long repository name can now do is ellipsize itself. The order of sacrifice still
 * matters for the row as a whole, and it is the reverse of reading order — the repository
 * is the most expendable, being also the link and the tooltip, so it shrinks first and the
 * count never shrinks at all.
 */
const gitGroup: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 };
const gitChip: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  flexShrink: 1,
  // Per pill now, not for the three of them together.
  maxWidth: 260,
  minWidth: 0,
  overflow: 'hidden',
  padding: '2px 8px',
  borderRadius: 999,
  border: '1px solid transparent',
  font: '11px system-ui',
  fontWeight: 600,
  whiteSpace: 'nowrap',
};
// Pending: no colour that reads as a verdict, because no verdict has been reached.
const gitTonePending: React.CSSProperties = { background: '#f8fafc', border: '1px solid #eef2f7', color: '#cbd5e1' };
const gitToneNone: React.CSSProperties = { background: '#f1f5f9', border: '1px solid #e2e8f0', color: '#64748b' };
const gitToneLocal: React.CSSProperties = { background: '#fffbeb', border: '1px solid #fde68a', color: '#b45309' };
const gitToneRemote: React.CSSProperties = { background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#15803d' };
/**
 * The count wears violet, not the git states' green.
 *
 * It is the one pill in the row that is not describing git: the others say where you are,
 * this one is a control that opens a list of pull requests. Violet is what the rest of
 * this product uses for collaboration — the sidebar's "Pull requests" item, the resume
 * buttons, the apply run — so the colour is the categorical difference, and it matches the
 * surface the pill actually opens.
 */
const gitTonePulls: React.CSSProperties = { background: '#f5f3ff', border: '1px solid #ddd6fe', color: '#6d28d9' };
// A bar rather than a spinner or an ellipsis: it occupies the chip's width so the
// header does not reflow when the first read lands.
const gitPlaceholderBar: React.CSSProperties = { display: 'inline-block', width: 68, height: 8, borderRadius: 999, background: '#e2e8f0' };
/**
 * The branch. It shrinks before the count does but after the repository has, and it
 * carries its own ceiling so a long branch name cannot do to the count what the long
 * repository name was doing.
 */
const gitBranchText: React.CSSProperties = { font: '600 11px ui-monospace, "SF Mono", monospace', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, maxWidth: 160 };
/** First to yield: it is also the link's text, its own tooltip, and the least surprising fact on the chip. */
const gitRepoText: React.CSSProperties = { font: '700 11px ui-monospace, "SF Mono", monospace', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flexShrink: 1 };
const gitRepoLink: React.CSSProperties = { ...gitRepoText, color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 2 };
/** A separator that shrank would render as a half dot. */
const gitDot: React.CSSProperties = { opacity: 0.5, flexShrink: 0 };
// The positioned parent for both chip popovers. `gitChip` itself clips its overflow,
// so a popover inside it would be cut off at the pill's edge.
const gitChipWrap: React.CSSProperties = { position: 'relative', display: 'inline-flex', flexShrink: 0, minWidth: 0 };
// The switcher wears the branch's own type, not a button's: it is the same text Unit 3
// renders, and only the affordance is new.
const branchBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 200, font: '600 11px ui-monospace, "SF Mono", monospace', cursor: 'pointer', whiteSpace: 'nowrap' };
/** The branch name inside the switcher: it truncates, and the ▾ beside it does not. */
const branchBtnLabel: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 };
/**
 * The count never yields. It is the only control in the chip, and a control clipped to
 * nothing is worse than one that was never rendered — nothing on screen says it is there.
 */
const pullCountBtn: React.CSSProperties = { flexShrink: 0, whiteSpace: 'nowrap', cursor: 'pointer', font: '600 11px system-ui' };
/** R-8.1's disclosure. Prose, so it may shrink — but only after the count is safe. */
const pullRepoNote: React.CSSProperties = { font: '11px ui-monospace, "SF Mono", monospace', opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flexShrink: 1 };

/* The tooltip. Dark, so it reads as an overlay rather than as another chip. */
const tipWrap: React.CSSProperties = { position: 'relative', display: 'inline-flex', minWidth: 0, maxWidth: '100%' };
const tipAnchor: React.CSSProperties = { display: 'inline-flex', minWidth: 0, maxWidth: '100%' };
const tipBubble: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 7px)',
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 60,
  // Wide enough for `owner/repo · git@github.com:owner/repo.git`, and it wraps past that
  // rather than truncating — a tooltip that elided its own text would have no purpose.
  maxWidth: 380,
  width: 'max-content',
  padding: '5px 9px',
  borderRadius: 7,
  background: '#0f172a',
  color: '#f8fafc',
  font: '500 11px/1.45 system-ui',
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  boxShadow: '0 8px 24px rgba(15,23,42,0.28)',
  pointerEvents: 'none',
};
// Left-aligned, unlike the right-hand popovers: this one hangs off a chip that sits at
// the left edge of the header.
const gitPop: React.CSSProperties = { position: 'absolute', left: 0, top: 'calc(100% + 6px)', width: 340, maxWidth: '82vw', background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, boxShadow: '0 16px 48px rgba(76,29,149,0.18)', zIndex: 41, overflow: 'hidden', color: '#334155', font: '13px system-ui', fontWeight: 400 };
const branchMeta: React.CSSProperties = { flexShrink: 0, font: '11px ui-monospace, "SF Mono", monospace', color: '#94a3b8' };
const refusalBox: React.CSSProperties = { padding: '9px 12px', borderBottom: '1px solid #fde68a', background: '#fffbeb', color: '#92400e', fontSize: 12.5 };
const refusalList: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 4 };
const pullRow: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 10px', margin: '2px 0', border: '1px solid #ece6fb', borderRadius: 9, background: '#fbfaff', fontSize: 12.5 };
const collabBadge: React.CSSProperties = { flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: '#6d28d9', background: '#ede9fe', borderRadius: 5, padding: '1px 6px' };
const scopeBranch: React.CSSProperties = { flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '600 11px ui-monospace, "SF Mono", monospace', color: '#15803d', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 999, padding: '1px 8px' };
// Detached overrides the green pill with the same amber the chip's `local` tone
// uses (R-4.3). Green here reads as "settled, a branch, safe to run"; a detached
// HEAD is none of those, and the tone must not contradict the words beside it.
// Tone alone never carries the fact — the label already says "detached HEAD".
const scopeBranchDetached: React.CSSProperties = { color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a' };
// P2's grouping, and the whole of it: a zone is a row of its own controls, and the
// divider is a hairline the same slate as the header's own bottom border. Tighter gaps
// inside a zone than between zones is what makes the grouping readable before the
// divider is even noticed.
const zoneRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const zoneDivider: React.CSSProperties = { width: 1, alignSelf: 'stretch', minHeight: 24, background: '#e5e7eb', flexShrink: 0 };
const overflowBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 32, padding: 0, border: '1px solid #d1d5db', borderRadius: 8, background: 'white', color: '#475569', cursor: 'pointer', font: '16px system-ui', fontWeight: 700, lineHeight: 1, flexShrink: 0 };
const overflowPop: React.CSSProperties = { position: 'absolute', right: 0, top: 'calc(100% + 6px)', gap: 6, padding: 8, background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 12px 40px rgba(76,29,149,0.16)', zIndex: 41, justifyItems: 'stretch' };
const cart: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, background: '#f1f5f9', borderRadius: 99, padding: '3px 10px', fontSize: 13, color: '#475569' };
const segWrap: React.CSSProperties = { display: 'inline-flex', padding: 2, gap: 2, background: '#f1f5f9', border: '1px solid #e5e7eb', borderRadius: 9 };
const segBtn: React.CSSProperties = { padding: '5px 12px', border: 'none', borderRadius: 7, background: 'transparent', color: '#64748b', cursor: 'pointer', font: '13px system-ui', fontWeight: 600 };
const segBtnActive: React.CSSProperties = { ...segBtn, background: 'white', color: '#4f46e5', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' };
const startBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: 8, background: 'white', color: '#334155', cursor: 'pointer', font: '13px system-ui', fontWeight: 600 };
const startBtnActive: React.CSSProperties = { ...startBtn, border: '1px solid #2563eb', background: '#eff6ff', color: '#1d4ed8' };
const secondary: React.CSSProperties = { padding: '7px 14px', border: '1px solid #d1d5db', borderRadius: 8, background: 'white', color: '#334155', cursor: 'pointer', font: '13px system-ui', fontWeight: 600 };
/**
 * "Start collaboration", promoted — tinted fill, coloured border, coloured text.
 *
 * Deliberately NOT `applyBtn`'s solid violet. Apply sits in the next zone along and is
 * solid violet already; a second solid violet button beside it would put two primary
 * actions in one row, and the reader would have to work out which of the two the header
 * meant. This is the same idiom `startBtnActive` above uses for "the live control" —
 * clearly lifted above `secondary`, without claiming the row.
 */
const startPrimary: React.CSSProperties = { ...secondary, display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid #7c3aed', background: '#f5f3ff', color: '#6d28d9' };
const applyBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 14px', border: 'none', borderRadius: 8, background: '#7c3aed', color: 'white', cursor: 'pointer', font: '13px system-ui', fontWeight: 600, minWidth: 92, justifyContent: 'center' };
const applyPop: React.CSSProperties = { position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 440, maxWidth: '82vw', background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, boxShadow: '0 16px 48px rgba(76,29,149,0.18)', zIndex: 41, overflow: 'hidden' };
const historyPop: React.CSSProperties = { position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 380, maxWidth: '82vw', background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, boxShadow: '0 16px 48px rgba(76,29,149,0.18)', zIndex: 41, overflow: 'hidden' };
const applyPopHead: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '9px 11px', borderBottom: '1px solid #f1f5f9', fontSize: 13, background: 'linear-gradient(180deg,#ffffff,#fbfaff)' };
const rerunBtn: React.CSSProperties = { padding: '3px 9px', border: '1px solid #d1d5db', borderRadius: 6, background: 'white', color: '#475569', cursor: 'pointer', font: '12px system-ui', fontWeight: 600, flexShrink: 0 };
const cancelBtn: React.CSSProperties = { padding: '3px 10px', border: '1px solid #fecaca', borderRadius: 6, background: '#fef2f2', color: '#dc2626', cursor: 'pointer', font: '12px system-ui', fontWeight: 700, flexShrink: 0 };
const closeBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, padding: 0, border: '1px solid #e5e7eb', borderRadius: 6, background: 'white', color: '#64748b', cursor: 'pointer', font: '12px system-ui', fontWeight: 700, flexShrink: 0 };
const prNote: React.CSSProperties = { margin: 0, fontSize: 12, color: '#64748b', lineHeight: 1.5, overflowWrap: 'anywhere' };
const prRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };
const prLabel: React.CSSProperties = { fontSize: 11, color: '#64748b', width: 84, flexShrink: 0 };
const prInput: React.CSSProperties = { font: '12px ui-monospace, monospace', padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4, flex: 1, minWidth: 0 };
/** The companion picker. A real fieldset/legend, so the group is named to a screen reader. */
const prFieldset: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, margin: 0, padding: '6px 8px 8px', border: '1px solid #e5e7eb', borderRadius: 6, maxHeight: 168, overflowY: 'auto' };
const prLegend: React.CSSProperties = { padding: '0 4px', font: '600 11px system-ui', color: '#64748b' };
/** The document's own row: a statement, not a control, because it cannot be unticked. */
const prCompanionDoc: React.CSSProperties = { margin: 0, font: '11px ui-monospace, monospace', color: '#94a3b8', overflowWrap: 'anywhere' };
const prCompanionRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, minHeight: 24, font: '11px ui-monospace, monospace', color: '#475569', cursor: 'pointer' };
const prOk: React.CSSProperties = { margin: 0, fontSize: 12, color: '#0f766e' };
const prError: React.CSSProperties = { margin: 0, fontSize: 12, color: '#b91c1c', overflowWrap: 'anywhere' };
const modelNote: React.CSSProperties = { padding: '7px 12px', borderTop: '1px solid #f1f5f9', color: '#94a3b8', fontSize: 11, fontStyle: 'italic', background: '#fbfaff' };
const scopeRow: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', textAlign: 'left', padding: '10px 11px', margin: '2px 0', border: '1px solid #ece6fb', borderRadius: 9, background: '#fbfaff', color: '#1e293b', cursor: 'pointer', font: '13px system-ui' };
const scopeTitle: React.CSSProperties = { fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const scopeSub: React.CSSProperties = { fontWeight: 400, color: '#7c3aed', font: '12px ui-monospace, monospace' };
const scopeCount: React.CSSProperties = { flexShrink: 0, minWidth: 22, textAlign: 'center', background: '#ede9fe', color: '#6d28d9', borderRadius: 999, padding: '1px 8px', fontSize: 12, fontWeight: 700 };
const pickItem: React.CSSProperties = { padding: '6px 12px', borderTop: '1px solid #f6f4fd' };
const pickLabel: React.CSSProperties = { display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer', fontSize: 12.5, color: '#334155', lineHeight: 1.4 };
const pickFooter: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 11px', borderTop: '1px solid #f1f5f9' };
const appliedWrap: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #f1f5f9', background: '#f7fdf9' };
const appliedHead: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: '#15803d', marginBottom: 5 };
const appliedItem: React.CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 7, padding: '2px 0', fontSize: 12.5, color: '#334155', overflow: 'hidden' };
const appliedPath: React.CSSProperties = { flexShrink: 0, font: '600 11px ui-monospace, monospace', color: '#15803d', background: '#dcfce7', borderRadius: 5, padding: '1px 6px' };
const appliedFlow: React.CSSProperties = { flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: '#7c3aed', background: '#ede9fe', borderRadius: 5, padding: '1px 6px' };
const appliedText: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const agentStrip: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 12px', borderBottom: '1px solid #f1f5f9', background: '#faf9ff' };
const agentChip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', border: '1px solid #ece6fb', borderRadius: 999, background: 'white', fontSize: 11.5, color: '#475569' };
const timerPill: React.CSSProperties = { font: '11.5px ui-monospace, "SF Mono", monospace', color: '#6d28d9', background: '#f3f0fc', border: '1px solid #ece6fb', borderRadius: 999, padding: '1px 8px' };
const summaryLine: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, padding: '6px 12px 8px' };
const feedScroll: React.CSSProperties = { maxHeight: 300, overflow: 'auto', background: '#fbfaff' };
const feedList: React.CSSProperties = { listStyle: 'none', margin: 0, padding: '6px 0' };
const rowLi: React.CSSProperties = { display: 'flex', gap: 9, alignItems: 'flex-start', padding: '4px 12px', lineHeight: 1.45 };
const glyphChip: React.CSSProperties = { flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, marginTop: 1, borderRadius: 6, fontSize: 11, fontWeight: 700, fontFamily: 'ui-monospace, monospace' };
const rowBody: React.CSSProperties = { minWidth: 0, fontSize: 12.5, display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap', overflowWrap: 'anywhere' };
const targetChip: React.CSSProperties = { font: '11.5px ui-monospace, "SF Mono", monospace', color: '#475569', background: '#f1f5f9', borderRadius: 5, padding: '1px 6px' };
const toast: React.CSSProperties = { color: '#16a34a', fontWeight: 600, fontSize: 13 };
const allPop: React.CSSProperties = { position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 340, background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.16)', padding: 10, zIndex: 41 };
const allTitle: React.CSSProperties = { fontSize: 12, opacity: 0.6, padding: '2px 4px 8px', borderBottom: '1px solid #f1f5f9', marginBottom: 4 };
const allFile: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', padding: '2px 4px', cursor: 'pointer', font: '12px ui-monospace, monospace', color: '#1d4ed8', fontWeight: 600 };
const allItem: React.CSSProperties = { padding: '4px 4px 4px 10px', borderLeft: '2px solid #e5e7eb', margin: '4px 0 4px 4px', fontSize: 13, color: '#334155' };
const progressTrack: React.CSSProperties = { position: 'absolute', left: 0, right: 0, bottom: -1, height: 3, overflow: 'hidden', zIndex: 61, pointerEvents: 'none' };
const progressFlow: React.CSSProperties = {
  height: '100%',
  width: '100%',
  backgroundImage: 'linear-gradient(90deg, #8b5cf6, #6366f1, #06b6d4, #10b981, #f59e0b, #ec4899, #8b5cf6)',
  backgroundSize: '200% 100%',
  animation: 'vs-apply-flow 1.6s linear infinite',
};
