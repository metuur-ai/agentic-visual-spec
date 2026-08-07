/**
 * apply-prompt.ts — build the natural-language instruction that drives the
 * apply-comments skill. Pure (no node deps) so it is shared by both the browser
 * (the "Copy prompt" button) and the server (`claude -p` invocation behind
 * /__vs/apply). The placeholder header that the copy-to-chat flow prepends lives
 * in the UI; this returns just the task body.
 *
 * ---------------------------------------------------------------------------
 * MODE (R-5.10, task 5.3)
 * ---------------------------------------------------------------------------
 *
 * The prompt has two edit targets and they are not interchangeable:
 *
 * - `local` (**the default**) — the sidecar `visual-spec-comments.json` is the
 *   source of truth and the agent edits the file the comment points at, located
 *   by snippet. This is the shipped product; every existing caller passes no
 *   options and gets a byte-identical prompt, which is what R-10.1 and
 *   `local-mode.regression.test.ts` pin.
 * - `collab` — the sidecar is only a non-authoritative cache (R-5.3), so the
 *   prompt must not name it as truth. The edit target is the **canonical JSON
 *   document on the branch**; the generated Markdown is write-only output
 *   (R-2.10) and the prompt says so explicitly, because an agent handed both will
 *   otherwise edit whichever it finds first. Targets are located by `nodeId`, not
 *   by snippet — collaborative anchoring is a direct lookup with no ladder
 *   (LLD §6).
 *
 * The mode is a parameter rather than a second function so the manifest, the
 * counts and the traceability instruction stay in one place.
 *
 * **This module stays remote-free on purpose.** `local-mode.regression.test.ts`
 * (R-10.5) scans its source and fails on any remote-service or collaboration
 * identifier, and the collab prompt needs none: everything the agent must be told
 * is about which document to edit and which file not to trust. Where the
 * conversation itself lives is the caller's business, not the prompt's.
 */
import type { CommentRecord } from './comment-doc';

/**
 * R-5.10 — which document the apply flow edits. `documentPath` is required in
 * `collab` mode: an agent told "edit the canonical JSON" without being told which
 * file that is will guess, and guessing wrong means editing generated Markdown.
 */
export type ApplyPromptOptions = { mode?: 'local' } | { mode: 'collab'; documentPath: string };

const LOCAL_INSTRUCTION =
  'Source of truth is visual-spec-comments.json. Take only status:"open" and GROUP BY workflow. For each comment, locate the target by SNIPPET (+ heading for markdown; the line number may have drifted, do not trust it blindly). For workflow "visual-spec", apply the change in place and keep the file well-formed; for any other workflow, hand the resolved comment to that workflow skill. Then, in a SINGLE atomic edit per comment record, set status to "applied" AND write a concise non-empty result field (1–2 lines summarising what was applied or handed off) on the SAME record in the SAME edit — do not make a second pass. Preserve all other existing fields on the record and keep the output JSON valid. Finish with a traceability table: id · workflow · target · what changed / handed off.';

function collabInstruction(documentPath: string): string {
  return `Source of truth is the review conversation listed below, NOT visual-spec-comments.json — that sidecar is a non-authoritative cache in this mode, so do not read it, do not edit it, and do not trust it anywhere it disagrees with this list. The one and only file you may edit is the canonical JSON document ${documentPath}; the generated Markdown is write-only output and MUST NOT be edited. Take only status:"open" and GROUP BY workflow. For each comment, locate the target by its nodeId in ${documentPath} — the nodeId identifies the node exactly, and there is no snippet or line-number fallback; a comment with no nodeId is document-level, so treat it as being about the document as a whole. For workflow "visual-spec", apply the change to that node in place and keep the output JSON valid; for any other workflow, hand the resolved comment to that workflow skill. Do not write status or result into any file — resolution is recorded on the conversation, not on disk. Finish with a traceability table: id · workflow · nodeId · what changed / handed off.`;
}

/** The instruction + comment manifest an agent needs to apply the open comments. */
export function buildApplyPrompt(open: CommentRecord[], options: ApplyPromptOptions = {}): string {
  const collab = options.mode === 'collab' ? options : null;
  const lines: string[] = [];
  lines.push(`Apply ${open.length} review comment(s) I left in the visual-spec browser using the "apply-comments" skill.`);
  lines.push('');
  lines.push(collab ? collabInstruction(collab.documentPath) : LOCAL_INSTRUCTION);
  lines.push('');
  lines.push(`Comments (${open.length}):`);
  open.forEach((c, i) => {
    const t = c.target;
    const isRange = t.endLine != null && t.endLine > (t.startLine ?? 0);
    lines.push('');
    lines.push(`${i + 1}. [${c.workflow}] ${t.kind === 'folder' ? 'Folder' : 'File'}: ${t.path}`);
    if (collab) {
      // Read structurally so this module keeps its zero dependencies; the field is
      // `ProjectedCommentRecord.collab` from core/collaboration/comment-projection.ts.
      const nodeId = (c as { collab?: { nodeId?: string } }).collab?.nodeId;
      lines.push(`   Node: ${nodeId ?? '(document-level — no nodeId)'}`);
    } else if (t.kind !== 'folder') {
      const where = t.startLine != null ? (isRange ? `lines ${t.startLine}–${t.endLine}` : `line ${t.startLine}`) : 'whole file';
      lines.push(`   Where: ${t.heading ? `${t.heading} · ` : ''}${where}`);
      if (t.snippet) lines.push(`   ${isRange ? 'From' : 'Context'}: "${t.snippet}"`);
      if (isRange && t.endSnippet) lines.push(`   Through: "${t.endSnippet}"`);
    }
    lines.push(`   Comment: ${c.comment}`);
  });
  return lines.join('\n');
}
