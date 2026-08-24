/**
 * review-prompt.test.ts — the proposal prompt and the pinned proposal envelope.
 *
 * The assertion that carries the feature is `git apply --check` accepting the `patch`
 * field of a real envelope. R-4.5 and R-6.2 both rest on the diff being the thing that
 * gets applied rather than a description of it, and the only way to know a string is a
 * patch is to hand it to the patcher. The envelope used there is a verbatim capture from
 * a live `claude` 2.1.220 run (`.devlocal/spikes/2.1-json-schema.mjs`) — not a fixture
 * written to pass, which would test this file's idea of a diff instead of the CLI's.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildReviewPrompt,
  PROPOSAL_SCHEMA,
  PROPOSAL_SCHEMA_ARGS,
  type Proposal,
  proposalFromLine,
  type ReviewPromptComment,
  toProposal,
} from './review-prompt';

const comment: ReviewPromptComment = {
  id: 'c-1',
  workflow: 'visual-spec',
  comment: 'Say HOW fast — give a number.',
  path: 'notes.md',
  kind: 'range',
  startLine: 3,
  snippet: 'The widget is fast.',
  heading: 'Notes',
};

/* ================================================================== *
 * R-4.1 — the comment, located the way the apply flow locates it
 * ================================================================== */
describe('buildReviewPrompt targets the comment (R-4.1)', () => {
  it('carries the comment, its file, and its snippet+heading anchor', () => {
    const prompt = buildReviewPrompt(comment);
    expect(prompt).toContain('Say HOW fast — give a number.');
    expect(prompt).toContain('File: notes.md');
    expect(prompt).toContain('Where: Notes · line 3');
    expect(prompt).toContain('Context: "The widget is fast."');
  });

  it('uses the same anchor ladder as the bulk apply, including ranges', () => {
    const prompt = buildReviewPrompt({
      ...comment,
      startLine: 3,
      endLine: 9,
      endSnippet: 'It has three modes.',
    });
    expect(prompt).toContain('Where: Notes · lines 3–9');
    expect(prompt).toContain('From: "The widget is fast."');
    expect(prompt).toContain('Through: "It has three modes."');
  });

  it('says the line number may have drifted, so the snippet is the anchor', () => {
    expect(buildReviewPrompt(comment)).toMatch(/snippet/i);
    expect(buildReviewPrompt(comment)).toMatch(/drift/i);
  });

  it('renders a whole-file comment without inventing a line', () => {
    const prompt = buildReviewPrompt({ id: 'c-2', workflow: 'visual-spec', comment: 'tighten this', path: 'notes.md' });
    expect(prompt).toContain('Where: whole file');
    expect(prompt).not.toMatch(/line \d/);
  });
});

/* ================================================================== *
 * R-4.2 … R-4.6 — what the proposal must contain
 * ================================================================== */
describe('buildReviewPrompt elicits the proposal envelope (R-4.2–R-4.6)', () => {
  const prompt = buildReviewPrompt(comment);

  it('asks for a patch `git apply` accepts, not a narration of one (R-4.5, R-6.2)', () => {
    expect(prompt).toContain('git apply');
    expect(prompt).toContain('unified diff');
    // The specific ways a plausible-looking diff fails to apply.
    expect(prompt).toMatch(/diff --git a\/PATH b\/PATH/);
    expect(prompt).toMatch(/@@ -start,count \+start,count @@/);
    expect(prompt).toMatch(/repository root/);
    expect(prompt).toMatch(/never abbreviate, elide or summarise/i);
    // …and that the patch is the thing being approved, not a preview of it.
    expect(prompt).toMatch(/applied verbatim/i);
  });

  it('surfaces alternatives faithfully rather than demanding them (R-4.4)', () => {
    expect(prompt).toMatch(/leave it empty rather than inventing/i);
    expect(prompt).toMatch(/report what is really there, including nothing/i);
  });

  it('names every envelope field as required output (R-4.1–R-4.6)', () => {
    // The prompt does not enumerate the fields in prose — the schema does, and it is the
    // schema the CLI enforces. What the prompt must do is point at it.
    expect(prompt).toMatch(/required response structure/i);
    expect(PROPOSAL_SCHEMA.required).toEqual([
      'interpretation',
      'strategy',
      'reasoning',
      'assumptions',
      'ambiguities',
      'alternatives',
      'patch',
      'impact',
    ]);
    expect(PROPOSAL_SCHEMA.additionalProperties).toBe(false);
  });

  it('ships the schema to the CLI as `--json-schema` (deterministic, not prose-parsed)', () => {
    expect(PROPOSAL_SCHEMA_ARGS[0]).toBe('--json-schema');
    expect(JSON.parse(PROPOSAL_SCHEMA_ARGS[1] as string)).toEqual(PROPOSAL_SCHEMA);
  });
});

/* ================================================================== *
 * R-10.5 / the `:377-383` shape — the local arm stays local
 * ================================================================== */
describe('mode selection (R-3.8)', () => {
  it('the local prompt never mentions GitHub, a PR, or a collaboration document', () => {
    // The same pin `local-mode.regression.test.ts:377-383` puts on `buildApplyPrompt`,
    // asserted here too because the two prompts now share the manifest formatter and a
    // collab field escaping the mode branch would break both at once.
    const prompt = buildReviewPrompt({ ...comment, collab: { nodeId: 'n-1' } });
    expect(prompt).not.toMatch(/github|pull request|\bPR\b|documentId|nodeId/i);
  });

  it('the collab arm edits only the canonical document and never the generated Markdown', () => {
    const prompt = buildReviewPrompt({ ...comment, collab: { nodeId: 'n-1' } }, { mode: 'collab', documentPath: 'docs/x.json' });
    expect(prompt).toContain('docs/x.json');
    expect(prompt).toContain('MUST NOT appear in the patch');
    expect(prompt).toContain('Node: n-1');
    expect(prompt).not.toContain('Context: "The widget is fast."');
  });

  it('defaults to local — omitting options matches passing local explicitly', () => {
    expect(buildReviewPrompt(comment)).toBe(buildReviewPrompt(comment, { mode: 'local' }));
  });
});

/* ================================================================== *
 * The envelope, as it really arrives from the CLI
 * ================================================================== */

/** Verbatim `structured_output` from turn 1 of the live spike run. */
const CAPTURED = {
  interpretation: 'The reviewer wants the vague claim "fast" replaced with a concrete figure.',
  strategy: 'Replace the sentence with one carrying a measured latency and its conditions.',
  reasoning: 'A number without conditions is as unfalsifiable as "fast".',
  assumptions: ['The measurement will be supplied by the author.'],
  ambiguities: ['Which metric counts as "fast" here — render time, or time to interactive.'],
  alternatives: [],
  patch: `diff --git a/notes.md b/notes.md
--- a/notes.md
+++ b/notes.md
@@ -1,5 +1,5 @@
 # Notes

-The widget is fast.
+The widget renders in under NN ms (p95).

 It has three modes.
`,
  impact: 'Only the one sentence changes; the modes paragraph is untouched.',
};

const ORIGINAL = '# Notes\n\nThe widget is fast.\n\nIt has three modes.\n';

describe('the proposal patch is machine-applicable (R-4.5, R-6.2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-review-patch-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  writeFileSync(join(dir, 'notes.md'), ORIGINAL);
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');

  /** `git apply --check` against the unmodified target: does the patcher take it? */
  const applies = (patch: string) => {
    const file = join(dir, `${Math.random().toString(16).slice(2)}.patch`);
    writeFileSync(file, patch.endsWith('\n') ? patch : `${patch}\n`);
    const r = spawnSync('git', ['apply', '--check', file], { cwd: dir, encoding: 'utf8' });
    return { ok: r.status === 0, stderr: r.stderr.trim() };
  };

  it('`git apply --check` accepts the patch field of a real envelope', () => {
    const proposal = toProposal(CAPTURED) as Proposal;
    expect(proposal).not.toBeNull();
    expect(applies(proposal.patch)).toEqual({ ok: true, stderr: '' });
  });

  it('and rejects a narrated description of the same change — the check is not vacuous', () => {
    // R-4.5 exists because this is what a proposal used to be: a paragraph about a diff.
    // If `git apply --check` accepted it, the test above would prove nothing.
    const narrated = 'In notes.md, replace the line "The widget is fast." with a sentence giving the p95 render time.';
    expect(applies(narrated).ok).toBe(false);
  });

  it('survives the wire: the same patch applies after a round trip through a result frame', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', structured_output: CAPTURED });
    const proposal = proposalFromLine(line) as Proposal;
    expect(proposal.patch).toBe(CAPTURED.patch);
    expect(applies(proposal.patch).ok).toBe(true);
  });
});

describe('reading the envelope off the stream (R-4.5)', () => {
  const frame = (payload: unknown, type = 'result') => JSON.stringify({ type, structured_output: payload });

  it('reads a complete envelope from a result frame', () => {
    expect(proposalFromLine(frame(CAPTURED))).toEqual(CAPTURED);
  });

  it('is null for anything that is not a result frame carrying one', () => {
    expect(proposalFromLine(frame(CAPTURED, 'assistant'))).toBe(null);
    expect(proposalFromLine(JSON.stringify({ type: 'result', result: 'here is what I would do…' }))).toBe(null);
    expect(proposalFromLine('not json')).toBe(null);
  });

  it('rejects a partial envelope rather than surfacing half a proposal', () => {
    for (const key of Object.keys(CAPTURED)) {
      const partial = { ...CAPTURED } as Record<string, unknown>;
      delete partial[key];
      expect(toProposal(partial), `${key} missing must not pass`).toBe(null);
    }
  });

  it('rejects an envelope whose patch is empty — a proposal with no patch is not a proposal', () => {
    expect(toProposal({ ...CAPTURED, patch: '' })).toBe(null);
    expect(toProposal({ ...CAPTURED, patch: '   \n' })).toBe(null);
  });

  it('rejects malformed field types, including a half-shaped alternative', () => {
    expect(toProposal({ ...CAPTURED, assumptions: 'one string' })).toBe(null);
    expect(toProposal({ ...CAPTURED, alternatives: [{ summary: 'a' }] })).toBe(null);
    expect(toProposal({ ...CAPTURED, alternatives: [{ summary: 'a', tradeoff: 'b' }] })?.alternatives).toHaveLength(1);
  });

  it('accepts an empty `alternatives` — no alternatives is a valid answer (R-4.4)', () => {
    expect(toProposal(CAPTURED)?.alternatives).toEqual([]);
  });
});
