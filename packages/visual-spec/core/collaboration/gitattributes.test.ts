/**
 * gitattributes.test.ts — O-2. Publish must ensure `.gitattributes` marks the
 * document path `linguist-generated=true -diff` on the PR head branch, without
 * clobbering unrelated content, without duplicating on a second publish, without
 * ever failing the publish, and without mis-writing a path that needs escaping.
 */
import { describe, expect, it, vi } from 'vitest';
import type { GitHubAdapter, RepoRef } from './github-adapter';
import {
  appendGitAttributesEntry,
  ensureLinguistGeneratedEntry,
  escapeGitAttributesPattern,
  hasGitAttributesEntry,
} from './gitattributes';

const repo: RepoRef = { owner: 'acme', repo: 'docs' };
const BRANCH = 'visual-spec/doc-1';

/** A minimal in-memory `.gitattributes`-only adapter, recording every call. */
function fakeAdapter(seed?: string): {
  adapter: GitHubAdapter;
  files: Map<string, string>;
  getCalls: string[];
  commitCalls: { path: string; content: string; sha?: string }[];
} {
  const files = new Map<string, string>();
  if (seed !== undefined) files.set('.gitattributes', seed);
  const getCalls: string[] = [];
  const commitCalls: { path: string; content: string; sha?: string }[] = [];

  const adapter: Partial<GitHubAdapter> = {
    async getFile(_repo, path, _ref) {
      getCalls.push(path);
      const content = files.get(path);
      if (content === undefined) return null;
      return { path, sha: `sha:${content.length}`, content };
    },
    async commitFile(_repo, input) {
      commitCalls.push({ path: input.path, content: input.content, sha: input.sha });
      files.set(input.path, input.content);
      return { path: input.path, commitSha: 'c0ffee', contentSha: `sha:${input.content.length}` };
    },
  };
  return { adapter: adapter as GitHubAdapter, files, getCalls, commitCalls };
}

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

describe('escapeGitAttributesPattern', () => {
  it('leaves a plain repo-relative path untouched', () => {
    expect(escapeGitAttributesPattern('documents/doc-1.json')).toBe('documents/doc-1.json');
  });

  it('escapes a space and a `#`', () => {
    expect(escapeGitAttributesPattern('documents/weird #1 doc.json')).toBe('documents/weird\\ \\#1\\ doc.json');
  });

  it('escapes glob metacharacters so the pattern matches literally', () => {
    expect(escapeGitAttributesPattern('documents/a[1]?*.json')).toBe('documents/a\\[1\\]\\?\\*.json');
  });

  it('escapes a leading `#` so the line is not read as a comment', () => {
    expect(escapeGitAttributesPattern('#leading.json')).toBe('\\#leading.json');
  });

  it('escapes a leading `!` so the line is not read as a negation', () => {
    expect(escapeGitAttributesPattern('!leading.json')).toBe('\\!leading.json');
  });

  it('refuses an empty path', () => {
    expect(escapeGitAttributesPattern('')).toBeNull();
  });

  it('refuses a path with an embedded newline — a line-injection attempt', () => {
    expect(escapeGitAttributesPattern('documents/doc.json\n*.env merge=ours')).toBeNull();
  });

  it('refuses a path with an embedded carriage return', () => {
    expect(escapeGitAttributesPattern('documents/doc.json\r\nignored.json')).toBeNull();
  });

  it('refuses a path containing a literal backslash — ambiguous with the escape char', () => {
    expect(escapeGitAttributesPattern('documents\\doc.json')).toBeNull();
  });
});

describe('hasGitAttributesEntry', () => {
  it('is false on an empty file', () => {
    expect(hasGitAttributesEntry('', 'documents/doc-1.json')).toBe(false);
  });

  it('finds an exact existing pattern among unrelated rules', () => {
    const content = '*.png binary\ndocuments/doc-1.json linguist-generated=true -diff\n*.lock -diff\n';
    expect(hasGitAttributesEntry(content, 'documents/doc-1.json')).toBe(true);
  });

  it('does not match a different path that merely shares a prefix', () => {
    const content = 'documents/doc-10.json linguist-generated=true -diff\n';
    expect(hasGitAttributesEntry(content, 'documents/doc-1.json')).toBe(false);
  });

  it('skips comment lines rather than reading them as patterns', () => {
    const content = '# documents/doc-1.json linguist-generated=true -diff\n';
    expect(hasGitAttributesEntry(content, 'documents/doc-1.json')).toBe(false);
  });

  it('matches an escaped-space pattern only against the same escaped pattern', () => {
    const escaped = 'documents/weird\\ \\#1\\ doc.json';
    const content = `${escaped} linguist-generated=true -diff\n`;
    expect(hasGitAttributesEntry(content, escaped)).toBe(true);
  });
});

describe('appendGitAttributesEntry', () => {
  it('creates a fresh file when there is none', () => {
    expect(appendGitAttributesEntry(null, 'documents/doc-1.json')).toBe(
      'documents/doc-1.json linguist-generated=true -diff\n',
    );
  });

  it('appends after existing content, adding a trailing newline first if missing', () => {
    expect(appendGitAttributesEntry('*.png binary', 'documents/doc-1.json')).toBe(
      '*.png binary\ndocuments/doc-1.json linguist-generated=true -diff\n',
    );
  });

  it('does not touch a file that already ends with a newline', () => {
    expect(appendGitAttributesEntry('*.png binary\n', 'documents/doc-1.json')).toBe(
      '*.png binary\ndocuments/doc-1.json linguist-generated=true -diff\n',
    );
  });
});

/* ------------------------------------------------------------------ *
 * ensureLinguistGeneratedEntry — the orchestration publish.ts calls
 * ------------------------------------------------------------------ */

describe('ensureLinguistGeneratedEntry', () => {
  it('creates `.gitattributes` when none exists', async () => {
    const { adapter, files } = fakeAdapter();
    await ensureLinguistGeneratedEntry({ adapter, repo, branch: BRANCH, documentPath: 'documents/doc-1.json' });
    expect(files.get('.gitattributes')).toBe('documents/doc-1.json linguist-generated=true -diff\n');
  });

  it('does not clobber unrelated existing rules — appends after them', async () => {
    const { adapter, files } = fakeAdapter('*.png binary\n*.lock -diff\n');
    await ensureLinguistGeneratedEntry({ adapter, repo, branch: BRANCH, documentPath: 'documents/doc-1.json' });
    expect(files.get('.gitattributes')).toBe(
      '*.png binary\n*.lock -diff\ndocuments/doc-1.json linguist-generated=true -diff\n',
    );
  });

  it('is idempotent: a second call for the same path makes no commit', async () => {
    const { adapter, commitCalls } = fakeAdapter();
    await ensureLinguistGeneratedEntry({ adapter, repo, branch: BRANCH, documentPath: 'documents/doc-1.json' });
    expect(commitCalls).toHaveLength(1);
    await ensureLinguistGeneratedEntry({ adapter, repo, branch: BRANCH, documentPath: 'documents/doc-1.json' });
    expect(commitCalls).toHaveLength(1);
  });

  it('does not duplicate the line when it is already present verbatim', async () => {
    const { adapter, files } = fakeAdapter('documents/doc-1.json linguist-generated=true -diff\n');
    await ensureLinguistGeneratedEntry({ adapter, repo, branch: BRANCH, documentPath: 'documents/doc-1.json' });
    expect(files.get('.gitattributes')).toBe('documents/doc-1.json linguist-generated=true -diff\n');
  });

  it('never reorders or rewrites existing lines when adding a new one', async () => {
    const before = 'z-rule -diff\na-rule binary\n';
    const { adapter, files } = fakeAdapter(before);
    await ensureLinguistGeneratedEntry({ adapter, repo, branch: BRANCH, documentPath: 'documents/doc-2.json' });
    const after = files.get('.gitattributes') as string;
    expect(after.startsWith(before)).toBe(true);
  });

  it('writes a correctly escaped pattern for a path with a space and a `#`', async () => {
    const { adapter, files } = fakeAdapter();
    await ensureLinguistGeneratedEntry({
      adapter,
      repo,
      branch: BRANCH,
      documentPath: 'documents/weird #1 doc.json',
    });
    expect(files.get('.gitattributes')).toBe('documents/weird\\ \\#1\\ doc.json linguist-generated=true -diff\n');
  });

  it('publishing the same space-and-hash path twice stays idempotent', async () => {
    const { adapter, commitCalls } = fakeAdapter();
    const documentPath = 'documents/weird #1 doc.json';
    await ensureLinguistGeneratedEntry({ adapter, repo, branch: BRANCH, documentPath });
    await ensureLinguistGeneratedEntry({ adapter, repo, branch: BRANCH, documentPath });
    expect(commitCalls).toHaveLength(1);
  });

  it('skips the write and logs why for a path it cannot safely express', async () => {
    const { adapter, commitCalls } = fakeAdapter();
    const logs: [string, string | undefined][] = [];
    await ensureLinguistGeneratedEntry({
      adapter,
      repo,
      branch: BRANCH,
      documentPath: 'documents/doc.json\n*.env merge=ours',
      log: (text, kind) => logs.push([text, kind]),
    });
    expect(commitCalls).toHaveLength(0);
    expect(logs.some(([text, kind]) => kind === 'error' && text.includes('cannot be safely expressed'))).toBe(true);
  });

  it('R: never fails the publish — a `getFile` rejection is swallowed and logged', async () => {
    const adapter: Partial<GitHubAdapter> = {
      getFile: vi.fn().mockRejectedValue(new Error('boom: network down')),
      commitFile: vi.fn(),
    };
    const logs: [string, string | undefined][] = [];
    await expect(
      ensureLinguistGeneratedEntry({
        adapter: adapter as GitHubAdapter,
        repo,
        branch: BRANCH,
        documentPath: 'documents/doc-1.json',
        log: (text, kind) => logs.push([text, kind]),
      }),
    ).resolves.toBeUndefined();
    expect(adapter.commitFile).not.toHaveBeenCalled();
    expect(logs.some(([text, kind]) => kind === 'error' && text.includes('boom: network down'))).toBe(true);
  });

  it('R: never fails the publish — a `commitFile` rejection (e.g. a stale sha) is swallowed and logged', async () => {
    const { adapter: base } = fakeAdapter();
    const adapter: GitHubAdapter = {
      ...base,
      commitFile: vi.fn().mockRejectedValue(new Error('409: sha mismatch')),
    };
    const logs: [string, string | undefined][] = [];
    await expect(
      ensureLinguistGeneratedEntry({
        adapter,
        repo,
        branch: BRANCH,
        documentPath: 'documents/doc-1.json',
        log: (text, kind) => logs.push([text, kind]),
      }),
    ).resolves.toBeUndefined();
    expect(logs.some(([text, kind]) => kind === 'error' && text.includes('409: sha mismatch'))).toBe(true);
  });

  it('reads and writes on the given branch, never the base', async () => {
    const { adapter, getCalls } = fakeAdapter();
    const calls: unknown[] = [];
    const spiedAdapter: GitHubAdapter = {
      ...adapter,
      getFile: (r, path, ref) => {
        calls.push(ref);
        return adapter.getFile(r, path, ref);
      },
      commitFile: (r, input) => {
        calls.push(input.branch);
        return adapter.commitFile(r, input);
      },
    };
    await ensureLinguistGeneratedEntry({ adapter: spiedAdapter, repo, branch: BRANCH, documentPath: 'documents/doc-1.json' });
    expect(getCalls).toEqual(['.gitattributes']);
    expect(calls.every((ref) => ref === BRANCH)).toBe(true);
  });
});
