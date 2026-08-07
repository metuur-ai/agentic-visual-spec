/**
 * gitattributes.ts — best-effort `.gitattributes` upkeep for O-2.
 *
 * When `publish.ts` lands a document's JSON on the PR branch, the diff GitHub renders
 * for reviewers is a wall of JSON unless the repository marks that path
 * `linguist-generated=true -diff`. This module makes `publish` add that one line to
 * the target repo's root `.gitattributes` — on the **PR head branch**, the only branch
 * publish ever writes to. GitHub computes a PR diff's linguist attributes from the tree
 * being diffed (the head branch's own tree), so an entry that lands in the same commit
 * sequence as the document applies to that document's own PR without needing any base-
 * branch write, which publish has no mandate or credentials to attempt.
 *
 * THREE HARD RULES, all enforced here rather than left to the call site:
 *
 *   1. Don't clobber. `.gitattributes` may carry unrelated rules, or already cover this
 *      exact path. Read first; append only when no equivalent line exists; never rewrite
 *      or reorder what's already there.
 *   2. Idempotent. Publishing the same document twice must not duplicate the line or
 *      produce a second commit when nothing changed — `hasGitAttributesEntry` is the
 *      guard, checked before any write.
 *   3. Never fail the publish. This is a presentation nicety, not an integrity
 *      requirement (unlike the document/markdown commits `publish.ts` verifies byte-for-
 *      byte). `ensureLinguistGeneratedEntry` therefore catches everything itself and
 *      reports failure through `log`, never through a rejected promise.
 *
 * PATTERN ESCAPING (R: arbitrary `documentPath`)
 * -----------------------------------------------------------------------------------
 * `.gitattributes` patterns share gitignore's fnmatch syntax: a bare space or tab ends
 * the pattern field, a leading `#` starts a comment, and `*`, `?`, `[`, `]` are
 * wildcards. `escapeGitAttributesPattern` backslash-escapes each of those so the
 * pattern matches `documentPath` literally, character for character — never as a
 * glob. A `documentPath` containing a literal backslash, or a CR/LF (which would let
 * an attacker-controlled path inject a second attribute line), is refused outright:
 * `null` means "cannot safely express this as one line," and the caller skips the
 * write rather than guess.
 */
import type { GitHubAdapter, RepoRef } from './github-adapter';

const GITATTRIBUTES_PATH = '.gitattributes';
const LINGUIST_GENERATED_ATTRS = 'linguist-generated=true -diff';

/** Characters that are structurally special in a gitattributes pattern line. */
const SPECIAL_CHARS = new Set([' ', '\t', '#', '!', '*', '?', '[', ']']);

/**
 * Turn a repo-relative document path into a gitattributes pattern that matches it,
 * and only it, literally. Returns `null` when the path cannot be expressed safely on
 * one line: empty, containing a newline/carriage return (line-injection risk), or
 * containing a literal backslash (ambiguous with the escape character this function
 * itself introduces).
 */
export function escapeGitAttributesPattern(documentPath: string): string | null {
  if (documentPath.length === 0) return null;
  if (/[\r\n]/.test(documentPath)) return null;
  if (documentPath.includes('\\')) return null;

  let pattern = '';
  for (const ch of documentPath) {
    pattern += SPECIAL_CHARS.has(ch) ? `\\${ch}` : ch;
  }
  return pattern;
}

/** The first whitespace-delimited token of a pattern line, respecting `\`-escapes. */
function firstToken(line: string): string {
  let token = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (ch === '\\' && i + 1 < line.length) {
      token += ch + line[i + 1];
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) break;
    token += ch;
  }
  return token;
}

/**
 * Whether `content` already has a line whose pattern (the first token, decoded the
 * same way git would) equals `pattern` exactly. Comment lines (`#…`) and blank lines
 * are skipped. Used both to decide whether a write is needed at all (idempotency) and
 * to leave every other line — including a differently-attributed rule for the same
 * pattern — untouched (non-clobbering: this module only *adds*, never rewrites).
 */
export function hasGitAttributesEntry(content: string, pattern: string): boolean {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (firstToken(line) === pattern) return true;
  }
  return false;
}

/**
 * Append the linguist-generated line for `pattern` to `content`. `content` is `null`
 * when the file does not exist yet, producing a single-line file. Existing content is
 * preserved verbatim — including its own trailing newline, if any — with the new line
 * appended after it.
 */
export function appendGitAttributesEntry(content: string | null, pattern: string): string {
  const line = `${pattern} ${LINGUIST_GENERATED_ATTRS}`;
  if (content === null || content.length === 0) return `${line}\n`;
  const withTrailingNewline = content.endsWith('\n') ? content : `${content}\n`;
  return `${withTrailingNewline}${line}\n`;
}

export type EnsureLinguistGeneratedEntryInput = {
  adapter: GitHubAdapter;
  repo: RepoRef;
  /** The PR head branch — the only branch `publish.ts` ever commits to. */
  branch: string;
  documentPath: string;
  /** Optional; `publish.ts` passes `ctx.log` so a subscriber sees what happened. */
  log?: (text: string, kind?: 'progress' | 'error') => void;
};

/**
 * Ensure the target repo's root `.gitattributes`, on `branch`, marks `documentPath`
 * `linguist-generated=true -diff`. Never throws — every failure mode (an
 * unsafe-to-escape path, a `getFile`/`commitFile` error) is caught and reported
 * through `log`, because this is a presentation nicety layered on top of a publish
 * that must still succeed even when it can't be applied (R: never fail the publish).
 */
export async function ensureLinguistGeneratedEntry(input: EnsureLinguistGeneratedEntryInput): Promise<void> {
  const { adapter, repo, branch, documentPath, log } = input;
  const note = (text: string, kind: 'progress' | 'error' = 'progress') => log?.(text, kind);

  try {
    const pattern = escapeGitAttributesPattern(documentPath);
    if (pattern === null) {
      note(
        `gitattributes: skipped — "${documentPath}" cannot be safely expressed as a single gitattributes pattern`,
        'error',
      );
      return;
    }

    const existing = await adapter.getFile(repo, GITATTRIBUTES_PATH, branch);
    if (existing && hasGitAttributesEntry(existing.content, pattern)) {
      note(`gitattributes: ${GITATTRIBUTES_PATH} already marks ${documentPath} as linguist-generated`);
      return;
    }

    const nextContent = appendGitAttributesEntry(existing?.content ?? null, pattern);
    await adapter.commitFile(repo, {
      path: GITATTRIBUTES_PATH,
      content: nextContent,
      message: `visual-spec: mark ${documentPath} as linguist-generated`,
      branch,
      ...(existing ? { sha: existing.sha } : {}),
    });
    note(`gitattributes: marked ${documentPath} as linguist-generated in ${GITATTRIBUTES_PATH} on ${branch}`);
  } catch (err) {
    // R: never fail the publish. This is caught here, not left to bubble to publish.ts,
    // so the body factory does not need its own try/catch around this call.
    note(
      `gitattributes: failed to update ${GITATTRIBUTES_PATH} on ${branch} — ${err instanceof Error ? err.message : String(err)}; publish continues`,
      'error',
    );
  }
}
