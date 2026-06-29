/**
 * apply-prompt.ts — build the natural-language instruction that drives the
 * apply-comments skill. Pure (no node deps) so it is shared by both the browser
 * (the "Copy prompt" button) and the server (`claude -p` invocation behind
 * /__vs/apply). The placeholder header that the copy-to-chat flow prepends lives
 * in the UI; this returns just the task body.
 */
import type { CommentRecord } from './comment-doc';

/** The instruction + comment manifest an agent needs to apply the open comments. */
export function buildApplyPrompt(open: CommentRecord[]): string {
  const lines: string[] = [];
  lines.push(`Apply ${open.length} review comment(s) I left in the visual-spec browser using the "apply-comments" skill.`);
  lines.push('');
  lines.push(
    'Source of truth is visual-spec-comments.json. Take only status:"open" and GROUP BY workflow. For each comment, locate the target by SNIPPET (+ heading for markdown; the line number may have drifted, do not trust it blindly). For workflow "visual-spec", apply the change in place and keep the file well-formed; for any other workflow, hand the resolved comment to that workflow skill. Then set each handled comment\'s status to "applied" (audit trail — do not delete). Finish with a traceability table: id · workflow · target · what changed / handed off.',
  );
  lines.push('');
  lines.push(`Comments (${open.length}):`);
  open.forEach((c, i) => {
    const t = c.target;
    const isRange = t.endLine != null && t.endLine > (t.startLine ?? 0);
    lines.push('');
    lines.push(`${i + 1}. [${c.workflow}] ${t.kind === 'folder' ? 'Folder' : 'File'}: ${t.path}`);
    if (t.kind !== 'folder') {
      const where = t.startLine != null ? (isRange ? `lines ${t.startLine}–${t.endLine}` : `line ${t.startLine}`) : 'whole file';
      lines.push(`   Where: ${t.heading ? `${t.heading} · ` : ''}${where}`);
      if (t.snippet) lines.push(`   ${isRange ? 'From' : 'Context'}: "${t.snippet}"`);
      if (isRange && t.endSnippet) lines.push(`   Through: "${t.endSnippet}"`);
    }
    lines.push(`   Comment: ${c.comment}`);
  });
  return lines.join('\n');
}
