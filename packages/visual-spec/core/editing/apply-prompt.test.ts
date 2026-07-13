import { describe, expect, it } from 'vitest';
import type { CommentRecord } from './comment-doc';
import { buildApplyPrompt } from './apply-prompt';

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
