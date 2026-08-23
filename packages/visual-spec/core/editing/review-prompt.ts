/**
 * review-prompt.ts — the proposal prompt and the proposal envelope for one
 * interactive review session.
 *
 * ---------------------------------------------------------------------------
 * THE PATCH IS THE PROPOSAL (R-4.5, R-6.2)
 * ---------------------------------------------------------------------------
 *
 * The defect this module exists to prevent: a proposal produced in plan mode
 * *describes* a change the model never made, and approving it re-derives that
 * change in a fresh process — so the user approves run A and receives run B, with
 * nothing able to detect the difference. The fix is structural rather than
 * procedural. `patch` is a first-class field of the envelope, it holds a unified
 * diff that `git apply` accepts, and approval writes by applying **that** text.
 * The approved artifact and the applied artifact are then the same object, and
 * "did the diff drift from what landed" stops being a question anyone can get
 * wrong.
 *
 * Everything else in the envelope — interpretation, strategy, reasoning,
 * assumptions, ambiguities, alternatives, impact — is what the user reads to
 * decide. None of it is parsed out of prose: the session runs with
 * `--json-schema PROPOSAL_SCHEMA`, so each turn's `result` frame carries a
 * `structured_output` object with these exact keys.
 *
 * Verified against `claude` 2.1.220 (`.devlocal/spikes/2.1-json-schema.mjs`):
 * `--json-schema` pins **every** turn's result frame on a persistent stream-json
 * session, not only the last one — which is what R-5.2 needs, since a refined
 * proposal is just the next turn's envelope. Both turns' `patch` fields were
 * accepted by `git apply --check` against the unmodified target.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE MODULE FROM `apply-prompt.ts`
 * ---------------------------------------------------------------------------
 *
 * Not for safety — the R-10.5 guard in `local-mode.regression.test.ts` is a fixed
 * module list, and this module is on it deliberately rather than by inheritance.
 * The reason is that the two prompts ask for different things: `buildApplyPrompt`
 * tells an agent to *apply* a batch and record the outcome, while this one asks
 * for a single reviewable proposal and forbids nothing (plan mode is the edit
 * gate, not the wording). The one genuinely shared thing is how a comment's
 * target is described — that ladder lives in `formatCommentEntry` and is imported,
 * because two copies of it would drift the moment either is corrected.
 */
import type { CommentRecord } from './comment-doc';
import { type ApplyPromptOptions, formatCommentEntry } from './apply-prompt';

/** R-3.8 — the origin decides the prompt arm, exactly as it does for the bulk apply. */
export type ReviewPromptOptions = ApplyPromptOptions;

/** One alternative the model actually identified (R-4.4) — never an invented one. */
export type ProposalAlternative = { summary: string; tradeoff: string };

/** The pinned proposal envelope. Every field is populated by the schema, not by parsing. */
export type Proposal = {
  /** R-4.1 — how the model read the comment. */
  interpretation: string;
  /** R-4.2 — what it proposes to do… */
  strategy: string;
  /** …and why (R-4.2 asks for both). */
  reasoning: string;
  /** R-4.3 — what it took for granted. */
  assumptions: string[];
  /** R-4.3 — what it could not settle from the comment alone. */
  ambiguities: string[];
  /** R-4.4 — empty when the model saw only one reasonable option. */
  alternatives: ProposalAlternative[];
  /** R-4.5 / R-6.2 — the applicable unified diff. This *is* the change. */
  patch: string;
  /** R-4.6 — knock-on effects on surrounding content or related files. */
  impact: string;
};

/**
 * The JSON Schema handed to `--json-schema`. `required` lists every key: a field
 * the model may omit is a field the UI has to defend against, and "no
 * alternatives" is expressible as `[]` without weakening the shape.
 * `additionalProperties: false` keeps the envelope closed so a stray key cannot
 * pass for a real one.
 */
export const PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['interpretation', 'strategy', 'reasoning', 'assumptions', 'ambiguities', 'alternatives', 'patch', 'impact'],
  properties: {
    interpretation: { type: 'string', description: 'How you understood the reviewer comment.' },
    strategy: { type: 'string', description: 'The implementation approach you propose.' },
    reasoning: { type: 'string', description: 'Why that approach rather than another.' },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'Anything you assumed. Empty if none.' },
    ambiguities: { type: 'array', items: { type: 'string' }, description: 'What the comment left unsettled. Empty if none.' },
    alternatives: {
      type: 'array',
      description: 'Only options you genuinely identified. Empty if you saw one reasonable approach.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'tradeoff'],
        properties: { summary: { type: 'string' }, tradeoff: { type: 'string' } },
      },
    },
    patch: { type: 'string', description: 'A unified diff that `git apply` accepts, and the only description of the change.' },
    impact: { type: 'string', description: 'Expected effect on surrounding content and related files.' },
  },
} as const;

/** The flags that pin the envelope, kept next to the schema so they cannot disagree. */
export const PROPOSAL_SCHEMA_ARGS: readonly string[] = ['--json-schema', JSON.stringify(PROPOSAL_SCHEMA)];

/* ------------------------------------------------------------------ *
 * The prompt
 * ------------------------------------------------------------------ */

/**
 * How the patch has to be written for `git apply` to take it. Spelled out because
 * every one of these is a way a plausible-looking diff fails to apply: paths
 * relative to the repo root rather than to the file, real context lines copied
 * from the file rather than remembered, hunk headers whose counts match the body,
 * and no elisions — `…` inside a hunk turns the patch into prose again.
 */
const PATCH_RULES =
  'The `patch` field is the proposal — it is what gets applied verbatim if I approve, so it must be a real unified diff that `git apply` accepts, not a sketch of one. Read the file first and copy context lines from it exactly. Use `diff --git a/PATH b/PATH` followed by `--- a/PATH` and `+++ b/PATH`, with PATH relative to the repository root. Every hunk header must be a correct `@@ -start,count +start,count @@` for the lines that follow, include at least three lines of unchanged context where they exist, and preserve the file\'s existing indentation, trailing whitespace and final newline. Never abbreviate, elide or summarise inside a hunk — no `...`, no `<unchanged>`, no placeholder text. If the change touches several files, put every file in the one patch.';

const LOCAL_INSTRUCTION =
  'Locate the target by SNIPPET (+ heading for markdown; the line number may have drifted, so do not trust it blindly), then propose how you would address the comment. This is a proposal for a person to read and approve — describe what you would change and why, in the fields below.';

function collabInstruction(documentPath: string): string {
  return `Source of truth is the review conversation, NOT visual-spec-comments.json — that sidecar is a non-authoritative cache in this mode, so do not read it, do not edit it, and do not trust it. The one and only file the patch may touch is the canonical JSON document ${documentPath}; the generated Markdown is write-only output and MUST NOT appear in the patch. Locate the target by its node identifier in ${documentPath} — that identifier names the node exactly, and there is no snippet or line-number fallback; a comment carrying none is document-level, so treat it as being about the document as a whole. This is a proposal for a person to read and approve. Do not record status or result anywhere, and do not publish.`;
}

const FIELD_GUIDANCE =
  'Fill every field of the required response structure. `alternatives` is for options you actually identified — if one approach is clearly right, leave it empty rather than inventing a rival to fill the slot. The same goes for `assumptions` and `ambiguities`: report what is really there, including nothing. `impact` should say what else in this file or in related files is affected, and say so plainly if the answer is nothing.';

/**
 * The opening turn of a review session: one comment, its target, and what the
 * proposal must contain.
 *
 * Structurally typed rather than taking a `CommentRecord`, because the hub's
 * resolved comment is not a store record — the collaborative arm's comment never
 * comes from the sidecar at all (R-9.1). The fields below are the union of what
 * either arm can supply.
 */
export type ReviewPromptComment = {
  id: string;
  comment: string;
  workflow: string;
  path: string;
  kind?: 'file' | 'range' | 'folder';
  startLine?: number;
  endLine?: number;
  snippet?: string;
  endSnippet?: string;
  heading?: string | null;
  /** Collaborative anchoring. Ignored in local mode, where the ladder is snippet+heading. */
  collab?: { nodeId?: string };
};

/** Adapt to the record shape `formatCommentEntry` renders, without inventing fields. */
function asRecord(c: ReviewPromptComment): CommentRecord {
  return {
    id: c.id,
    workflow: c.workflow,
    comment: c.comment,
    status: 'open',
    ts: '',
    target: {
      path: c.path,
      kind: c.kind ?? (c.startLine !== undefined ? 'range' : 'file'),
      ...(c.startLine !== undefined ? { startLine: c.startLine } : {}),
      ...(c.endLine !== undefined ? { endLine: c.endLine } : {}),
      ...(c.snippet !== undefined ? { snippet: c.snippet } : {}),
      ...(c.endSnippet !== undefined ? { endSnippet: c.endSnippet } : {}),
      ...(c.heading !== undefined ? { heading: c.heading } : {}),
    },
    ...(c.collab ? { collab: c.collab } : {}),
  } as CommentRecord;
}

/** The opening turn for a review session on one comment (R-4.1–R-4.6). */
export function buildReviewPrompt(comment: ReviewPromptComment, options: ReviewPromptOptions = {}): string {
  const collab = options.mode === 'collab' ? options : null;
  return [
    'A reviewer left one comment while browsing this project in the visual-spec viewer. Propose how you would address it. Do not apply anything — I will review your proposal and approve it, and the patch you produce is what will be applied.',
    '',
    collab ? collabInstruction(collab.documentPath) : LOCAL_INSTRUCTION,
    '',
    'Comment:',
    '',
    ...formatCommentEntry(asRecord(comment), 0, options),
    '',
    PATCH_RULES,
    '',
    FIELD_GUIDANCE,
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Reading the envelope back
 * ------------------------------------------------------------------ */

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function alternativesOf(v: unknown): ProposalAlternative[] | null {
  if (!Array.isArray(v)) return null;
  const out: ProposalAlternative[] = [];
  for (const raw of v) {
    const a = raw as Record<string, unknown>;
    if (!a || typeof a.summary !== 'string' || typeof a.tradeoff !== 'string') return null;
    out.push({ summary: a.summary, tradeoff: a.tradeoff });
  }
  return out;
}

/**
 * Validate a `structured_output` payload against the envelope.
 *
 * Deliberately all-or-nothing: a payload missing a field, or carrying an empty
 * `patch`, is **not** a proposal. Accepting a partial one would put the UI back in
 * the business of showing a change with no applicable patch behind it, which is
 * the exact failure the schema exists to make impossible. `null` means "this turn
 * produced no proposal", which the session shows as ordinary activity.
 */
export function toProposal(payload: unknown): Proposal | null {
  const p = payload as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== 'object') return null;
  const alternatives = alternativesOf(p.alternatives);
  if (
    typeof p.interpretation !== 'string' ||
    typeof p.strategy !== 'string' ||
    typeof p.reasoning !== 'string' ||
    typeof p.impact !== 'string' ||
    typeof p.patch !== 'string' ||
    !p.patch.trim() ||
    !isStringArray(p.assumptions) ||
    !isStringArray(p.ambiguities) ||
    alternatives === null
  ) {
    return null;
  }
  return {
    interpretation: p.interpretation,
    strategy: p.strategy,
    reasoning: p.reasoning,
    assumptions: p.assumptions,
    ambiguities: p.ambiguities,
    alternatives,
    patch: p.patch,
    impact: p.impact,
  };
}

/**
 * Pull the proposal out of one stream-json line, if that line is a `result` frame
 * carrying one.
 *
 * This is a field accessor for a frame shape `summarize()` already reads for a
 * different purpose (its `log/result` row), the same arrangement `replayedUserText`
 * uses for replayed turns — not a second parser, and not a prose fallback. The
 * envelope arrives at `result.structured_output` as an object; spike 2.1 confirmed
 * the field is present on every turn's result frame, so there is nothing to scrape
 * out of `result` when it is absent — its absence means the turn produced no
 * proposal.
 */
export function proposalFromLine(raw: string): Proposal | null {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (ev.type !== 'result') return null;
  return toProposal(ev.structured_output);
}
