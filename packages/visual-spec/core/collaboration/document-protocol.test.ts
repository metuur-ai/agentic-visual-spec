import { describe, expect, expectTypeOf, it } from 'vitest';
import { type CommentTarget, type CommentTargetKind, parseDoc } from '../editing/comment-doc';
import {
  type CollaborationAnchor,
  type CollaborationDocument,
  type CollaborationNode,
  type CollaborativeCommentTarget,
  type GitHubBinding,
  parseCollaborationDocument,
  resolveDocumentTitle,
  serializeCollaborationDocument,
} from './document-protocol';

const github = (over: Partial<GitHubBinding> = {}): GitHubBinding => ({
  owner: 'metuur',
  repo: 'agentic-visual-spec',
  branch: 'vs/doc-1',
  pullNumber: 42,
  headSha: 'abc1234',
  issueCommentId: 999,
  replyToId: 998,
  resolved: false,
  ...over,
});

const doc = (over: Partial<CollaborationDocument> = {}): CollaborationDocument => ({
  documentId: 'd-11112222',
  documentPath: 'docs/tasks/post-it-notes.md',
  title: 'Post-it Notes',
  frontmatter: { status: 'draft' },
  nodes: [{ id: 'n-1', type: 'paragraph', version: 1, content: 'The user can pin a note' }],
  doc: { root: { type: 'root', children: [] } },
  ...over,
});

describe('document-protocol', () => {
  // R-1.2 — document envelope carries documentId/documentPath/title/frontmatter/nodes,
  // with frontmatter on the envelope, not inside JsonDocument.
  it('document envelope carries the R-1.2 fields, frontmatter outside `doc` (R-1.2)', () => {
    const d = doc();
    expect(Object.keys(d).sort()).toEqual([
      'doc',
      'documentId',
      'documentPath',
      'frontmatter',
      'nodes',
      'title',
    ]);
    expect(d.doc).toEqual({ root: { type: 'root', children: [] } });
    expect('frontmatter' in d.doc).toBe(false);
    expectTypeOf<CollaborationDocument['documentId']>().toEqualTypeOf<string>();
    expectTypeOf<CollaborationDocument['documentPath']>().toEqualTypeOf<string>();
    expectTypeOf<CollaborationDocument['title']>().toEqualTypeOf<string>();
    expectTypeOf<CollaborationDocument['nodes']>().toEqualTypeOf<CollaborationNode[]>();
  });

  // R-1.3
  it('node carries id/type/version/content (R-1.3)', () => {
    const n: CollaborationNode = { id: 'n-1', type: 'heading', version: 3, content: 'Acceptance' };
    expect(Object.keys(n).sort()).toEqual(['content', 'id', 'type', 'version']);
    expectTypeOf<CollaborationNode['id']>().toEqualTypeOf<string>();
    expectTypeOf<CollaborationNode['type']>().toEqualTypeOf<string>();
    expectTypeOf<CollaborationNode['version']>().toEqualTypeOf<number>();
    expectTypeOf<CollaborationNode['content']>().toEqualTypeOf<string>();
  });

  // R-1.4
  it('anchor carries nodeId/nodeVersion/github and nothing line-based (R-1.4)', () => {
    const a: CollaborationAnchor = { nodeId: 'n-1', nodeVersion: 2, github: github() };
    expect(Object.keys(a).sort()).toEqual(['github', 'nodeId', 'nodeVersion']);
    expectTypeOf<CollaborationAnchor['nodeId']>().toEqualTypeOf<string>();
    expectTypeOf<CollaborationAnchor['nodeVersion']>().toEqualTypeOf<number>();
    expectTypeOf<CollaborationAnchor['github']>().toEqualTypeOf<GitHubBinding>();
  });

  // R-1.5
  it('github binding carries the eight R-1.5 fields (R-1.5)', () => {
    expect(Object.keys(github()).sort()).toEqual([
      'branch',
      'headSha',
      'issueCommentId',
      'owner',
      'pullNumber',
      'replyToId',
      'repo',
      'resolved',
    ]);
    expectTypeOf<GitHubBinding['owner']>().toEqualTypeOf<string>();
    expectTypeOf<GitHubBinding['repo']>().toEqualTypeOf<string>();
    expectTypeOf<GitHubBinding['branch']>().toEqualTypeOf<string>();
    expectTypeOf<GitHubBinding['pullNumber']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<GitHubBinding['headSha']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<GitHubBinding['issueCommentId']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<GitHubBinding['replyToId']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<GitHubBinding['resolved']>().toEqualTypeOf<boolean>();
  });

  // R-1.6
  it('collaborative target carries documentId + nodeId (R-1.6)', () => {
    const t: CollaborativeCommentTarget = { documentId: 'd-1', nodeId: 'n-1' };
    expect(Object.keys(t).sort()).toEqual(['documentId', 'nodeId']);
    expectTypeOf<CollaborativeCommentTarget['documentId']>().toEqualTypeOf<string>();
    expectTypeOf<CollaborativeCommentTarget['nodeId']>().toEqualTypeOf<string>();
  });

  // R-1.7 — the existing local CommentTarget must be exactly what it was.
  it('local CommentTarget shape is unchanged (R-1.7)', () => {
    type ExpectedCommentTarget = {
      path: string;
      kind: 'file' | 'range' | 'folder';
      startLine?: number;
      endLine?: number;
      snippet?: string;
      endSnippet?: string;
      heading?: string | null;
    };
    expectTypeOf<CommentTarget>().toEqualTypeOf<ExpectedCommentTarget>();
    expectTypeOf<CommentTargetKind>().toEqualTypeOf<'file' | 'range' | 'folder'>();

    // Structural: a parsed local comment still yields exactly the legacy target keys,
    // with no collaboration field leaking in.
    const legacy = JSON.stringify({
      version: 1,
      comments: [
        {
          id: 'c-old',
          file: 'tasks/post-it-notes',
          anchor: { heading: 'Acceptance Criteria', line: 42, snippet: 'pin a note' },
          comment: 'cover the shortcut',
          status: 'open',
          ts: '2026-06-20T00:00:00Z',
        },
      ],
    });
    const target = parseDoc(legacy).comments[0]!.target;
    expect(Object.keys(target).sort()).toEqual(['heading', 'kind', 'path', 'snippet', 'startLine']);
    expect(target).not.toHaveProperty('documentId');
    expect(target).not.toHaveProperty('nodeId');
  });

  // R-1.8
  it('preserves unrecognized envelope and node fields across a read/write round-trip (R-1.8)', () => {
    const raw = JSON.stringify({
      documentId: 'd-1',
      documentPath: 'docs/a.md',
      title: 'A',
      frontmatter: { status: 'draft', futureKey: [1, 2] },
      nodes: [{ id: 'n-1', type: 'paragraph', version: 1, content: 'hi', futureNodeKey: 'keep me' }],
      doc: { root: { type: 'root' }, futureDocKey: true },
      futureEnvelopeKey: { nested: 'keep me too' },
    });
    const parsed = parseCollaborationDocument(raw);
    expect(parsed.futureEnvelopeKey).toEqual({ nested: 'keep me too' });

    const reread = parseCollaborationDocument(serializeCollaborationDocument(parsed));
    expect(reread.futureEnvelopeKey).toEqual({ nested: 'keep me too' });
    expect(reread.frontmatter.futureKey).toEqual([1, 2]);
    expect(reread.nodes[0]!.futureNodeKey).toBe('keep me');
    expect(reread.doc.futureDocKey).toBe(true);
    expect(reread).toEqual(parsed);
  });

  it('parse defaults missing known fields and rejects non-object input (R-1.8)', () => {
    const d = parseCollaborationDocument('{"documentId":"d-1"}');
    expect(d).toEqual({
      documentId: 'd-1',
      documentPath: '',
      title: '',
      frontmatter: {},
      nodes: [],
      doc: { root: {} },
    });
    expect(() => parseCollaborationDocument('')).toThrow();
    expect(() => parseCollaborationDocument(null)).toThrow();
    expect(() => parseCollaborationDocument('[]')).toThrow();
  });

  // Title precedence — frontmatter.title wins; envelope title is a derived cache.
  it('resolveDocumentTitle prefers frontmatter.title when present', () => {
    expect(resolveDocumentTitle(doc({ title: 'Envelope', frontmatter: { title: 'Frontmatter' } }))).toBe(
      'Frontmatter'
    );
  });

  it('resolveDocumentTitle falls back to the envelope title when frontmatter has none', () => {
    expect(resolveDocumentTitle(doc({ title: 'Envelope', frontmatter: {} }))).toBe('Envelope');
    expect(resolveDocumentTitle(doc({ title: 'Envelope', frontmatter: { title: '  ' } }))).toBe('Envelope');
    expect(resolveDocumentTitle(doc({ title: '', frontmatter: {} }))).toBe('');
  });

  it('serialize refreshes the envelope title cache from frontmatter.title', () => {
    const stale = doc({ title: 'Stale', frontmatter: { title: 'Authored' } });
    expect(parseCollaborationDocument(serializeCollaborationDocument(stale)).title).toBe('Authored');
  });

  it('serialize leaves the envelope title alone when frontmatter has no title', () => {
    const d = doc({ title: 'Only Envelope', frontmatter: { status: 'draft' } });
    expect(parseCollaborationDocument(serializeCollaborationDocument(d)).title).toBe('Only Envelope');
  });
});
