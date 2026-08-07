import { describe, expect, it } from 'vitest';
import type { CommentRecord } from './comment-doc';
import { PUBLISH_HANDOFF_PREFIX, buildApplyPrompt } from './apply-prompt';

function rec(id: string): CommentRecord {
  return { id, workflow: 'visual-spec', target: { path: 'a.md', kind: 'file' }, comment: 'fix the title', status: 'open', ts: '' };
}

describe('buildApplyPrompt', () => {
  it('includes the comment count and each comment entry', () => {
    const prompt = buildApplyPrompt([rec('c-1'), rec('c-2')]);
    expect(prompt).toContain('2 review comment');
    expect(prompt).toContain('fix the title');
  });

  it('instructs the agent to write a result field in the same edit as the status flip (R-1.1–R-1.4)', () => {
    const prompt = buildApplyPrompt([rec('c-1')]);
    // R-1.1: agent must write a concise non-empty result summary
    expect(prompt).toMatch(/result/i);
    // R-1.2 + R-1.3: result and status set together in a single atomic edit, not a second pass
    expect(prompt).toMatch(/same.*edit|single.*atomic/i);
    // R-1.4: all other fields must be preserved
    expect(prompt).toMatch(/preserve.*field|existing.*field/i);
  });

  it('instructs the agent to keep the JSON valid', () => {
    const prompt = buildApplyPrompt([rec('c-1')]);
    expect(prompt).toMatch(/json.*valid|valid.*json/i);
  });
});

// ---------------------------------------------------------------------------
// R-5.10 — the mode parameter (task 5.3)
// ---------------------------------------------------------------------------

const collabRec = (id: string, nodeId?: string): CommentRecord =>
  ({ ...rec(id), ...(nodeId ? { collab: { documentId: 'doc-1', nodeId } } : {}) }) as CommentRecord;

describe('buildApplyPrompt mode (R-5.10)', () => {
  it('defaults to local — omitting options is byte-identical to passing local', () => {
    const open = [rec('c-1'), rec('c-2')];
    expect(buildApplyPrompt(open, {})).toBe(buildApplyPrompt(open));
    expect(buildApplyPrompt(open, { mode: 'local' })).toBe(buildApplyPrompt(open));
  });

  it('local mode names the sidecar as source of truth', () => {
    expect(buildApplyPrompt([rec('c-1')], { mode: 'local' })).toContain('Source of truth is visual-spec-comments.json.');
  });

  it('collab mode names the canonical JSON document as the edit target', () => {
    const prompt = buildApplyPrompt([collabRec('c-1', 'n-7')], { mode: 'collab', documentPath: 'documents/doc-1.json' });

    expect(prompt).toContain('the canonical JSON document documents/doc-1.json');
    expect(prompt).not.toContain('Source of truth is visual-spec-comments.json.');
  });

  it('collab mode forbids editing the generated Markdown (R-2.10)', () => {
    const prompt = buildApplyPrompt([collabRec('c-1', 'n-7')], { mode: 'collab', documentPath: 'documents/doc-1.json' });

    expect(prompt).toContain('the generated Markdown is write-only output and MUST NOT be edited');
  });

  it('collab mode demotes the sidecar to a cache rather than truth (R-5.3 / R-5.9)', () => {
    const prompt = buildApplyPrompt([collabRec('c-1', 'n-7')], { mode: 'collab', documentPath: 'documents/doc-1.json' });

    expect(prompt).toContain('Source of truth is the review conversation listed below, NOT visual-spec-comments.json');
    expect(prompt).toContain('non-authoritative cache in this mode, so do not read it, do not edit it');
  });

  it('collab mode locates by nodeId, and says so instead of by snippet', () => {
    const withSnippet = { ...collabRec('c-1', 'n-7'), target: { path: 'a.md', kind: 'range' as const, startLine: 3, snippet: 'drifted' } };
    const prompt = buildApplyPrompt([withSnippet as CommentRecord], { mode: 'collab', documentPath: 'documents/doc-1.json' });

    expect(prompt).toContain('Node: n-7');
    expect(prompt).toContain('there is no snippet or line-number fallback');
    // The manifest must not offer the snippet/line data the instruction just disowned.
    expect(prompt).not.toContain('Context: "drifted"');
    expect(prompt).not.toContain('Where:');
  });

  it('collab mode marks a comment with no nodeId as document-level (R-5.7)', () => {
    const prompt = buildApplyPrompt([collabRec('c-1')], { mode: 'collab', documentPath: 'documents/doc-1.json' });

    expect(prompt).toContain('Node: (document-level — no nodeId)');
  });

  it('keeps the count header and comment text in both modes', () => {
    for (const prompt of [
      buildApplyPrompt([collabRec('c-1', 'n-7')]),
      buildApplyPrompt([collabRec('c-1', 'n-7')], { mode: 'collab', documentPath: 'documents/doc-1.json' }),
    ]) {
      expect(prompt).toContain('1 review comment');
      expect(prompt).toContain('fix the title');
    }
  });

  it('collab mode ends by handing back to a human instead of publishing', () => {
    const prompt = buildApplyPrompt([collabRec('c-1', 'n-7')], { mode: 'collab', documentPath: 'documents/doc-1.json' });

    expect(prompt).toContain(`${PUBLISH_HANDOFF_PREFIX}documents/doc-1.json`);
    expect(prompt).toMatch(/MUST NOT attempt/);
  });

  it('local mode has no publish hand-back (R-10.1 — the shipped prompt is unchanged)', () => {
    expect(buildApplyPrompt([rec('c-1')])).not.toContain(PUBLISH_HANDOFF_PREFIX);
  });
});
