/**
 * document-protocol.ts — the typed vocabulary shared by every collaboration layer:
 * document, node, anchor, GitHub binding, collaborative comment target (R-1.1 … R-1.6).
 *
 * This module is deliberately separate from `core/editing/comment-doc.ts`, which keeps
 * serving local file/range/folder comments unchanged (R-1.7).
 *
 * It is reachable from the CLI, so it imports nothing at runtime — no `@lyfie/luthor`,
 * no react (R-3.3 / R-12.6). `JsonDocument` is declared here as a local structural type
 * (`{ root }`) rather than imported from Luthor.
 *
 * Frontmatter sits on the document envelope, not inside `JsonDocument` (LLD §1): the
 * persisted shape is `{ documentId, documentPath, title, frontmatter, doc: { root } }`.
 */

/** Anything JSON round-trippable. Unknown keys are carried, never interpreted. */
type JsonValue = unknown;

/**
 * Structural stand-in for Luthor's `JsonDocument` (`{ root }`). Declared locally so no
 * module on the CLI path has to import `@lyfie/luthor` (R-3.3).
 */
export type JsonDocument = {
  root: Record<string, JsonValue>;
  [key: string]: JsonValue;
};

/** YAML frontmatter, held on the envelope. `title` is authored content (see below). */
export type DocumentFrontmatter = {
  title?: string;
  [key: string]: JsonValue;
};

/** R-1.3 — one addressable block of the document. */
export type CollaborationNode = {
  id: string;
  type: string; // base Lexical type string ('paragraph', 'heading', …)
  version: number; // bumped when content changes; identity stays on `id`
  content: string;
  [key: string]: JsonValue; // R-1.8 — unrecognized node fields survive round-trip
};

/** R-1.5 — where a document or a comment lives on GitHub. */
export type GitHubBinding = {
  owner: string;
  repo: string;
  branch: string;
  pullNumber?: number; // absent until the PR is opened
  headSha?: string;
  issueCommentId?: number; // absent until the comment is posted
  replyToId?: number; // set on replies only
  resolved: boolean;
  [key: string]: JsonValue; // R-1.8
};

/**
 * R-1.4 — what a comment points at. Per LLD §6 there is no ladder: `nodeId` is the only
 * rung that locates anything, `nodeVersion` only flags the anchor as outdated. No
 * snippet, no heading, no line — those stay in local mode.
 */
export type CollaborationAnchor = {
  nodeId: string;
  nodeVersion: number;
  github: GitHubBinding;
  [key: string]: JsonValue; // R-1.8
};

/** R-1.6 — the collaborative counterpart of `CommentTarget`, which stays untouched. */
export type CollaborativeCommentTarget = {
  documentId: string;
  nodeId: string;
  [key: string]: JsonValue; // R-1.8
};

/**
 * R-1.2 — the persisted collaboration document. `frontmatter` is on this envelope, not
 * inside `doc` (LLD §1). `nodes` is the flattened projection of the addressable blocks
 * in `doc.root`. The index signature is what lets unrecognized fields survive a
 * read/write round-trip (R-1.8).
 */
export type CollaborationDocument = {
  documentId: string;
  documentPath: string; // posix path relative to the repo root
  title: string;
  frontmatter: DocumentFrontmatter;
  nodes: CollaborationNode[];
  doc: JsonDocument;
  [key: string]: JsonValue;
};

/**
 * Title precedence — decided here, closing the LLD "Open Questions" entry
 * ("Whether `title` on the collaboration document or `frontmatter.title` wins").
 *
 * **`frontmatter.title` wins when present.** The envelope `title` is a derived cache,
 * refreshed on write by `serializeCollaborationDocument`. Frontmatter is authored
 * content that gets published into the Markdown artifact, so letting the envelope
 * override it would let the UI disagree with the published document.
 */
export function resolveDocumentTitle(doc: {
  title?: string;
  frontmatter?: DocumentFrontmatter;
}): string {
  const fromFrontmatter = doc.frontmatter?.title;
  if (typeof fromFrontmatter === 'string' && fromFrontmatter.trim()) return fromFrontmatter;
  return doc.title ?? '';
}

/**
 * A valid, empty Lexical document: a root holding one empty paragraph. This is the
 * serialized shape, declared here rather than imported, for the same reason
 * `JsonDocument` is (R-3.3) — nothing on the CLI path may reach `@lyfie/luthor`.
 */
export function emptyDocument(): JsonDocument {
  return {
    root: {
      type: 'root',
      format: '',
      indent: 0,
      version: 1,
      direction: null,
      children: [{ type: 'paragraph', format: '', indent: 0, version: 1, direction: null, children: [] }],
    },
  };
}

/**
 * The envelope a document starts life as, before it has ever met GitHub.
 *
 * `create` (R-8.5) reads the document out of the store and commits it — it never authors
 * one, because the branch it commits to is derived from a document that must already
 * exist. Something has to write the first version, and this is that something. There is
 * deliberately no `github` binding: that field is what `create` adds once the branch
 * exists, and its absence is how an unbound document is recognised everywhere else.
 *
 * `doc` defaults to `EMPTY_DOCUMENT_ROOT` — one empty paragraph, not the bare `{ root: {} }`
 * that `parseCollaborationDocument` falls back to. The two differ deliberately: that
 * fallback exists to survive a malformed file, while this is content the editor has to
 * mount, and `injectJSON` on a root with no `type` or `children` throws. The browser
 * cannot supply the content itself — `markdownToInjectable` is forbidden on the
 * collaboration path because it reparses Markdown and drops every `nodeId` — so the
 * empty document is authored here, in the module that already declares the shape.
 */
export function newCollaborationDocument(input: {
  documentId: string;
  documentPath: string;
  title?: string;
  frontmatter?: DocumentFrontmatter;
  doc?: JsonDocument;
}): CollaborationDocument {
  const frontmatter = input.frontmatter ?? {};
  return {
    documentId: input.documentId,
    documentPath: input.documentPath,
    // Same precedence as every other write: `frontmatter.title` wins when present.
    title: resolveDocumentTitle({ title: input.title, frontmatter }),
    frontmatter,
    nodes: [],
    doc: input.doc ?? emptyDocument(),
  };
}

/**
 * R-1.8 — read a persisted collaboration document. Known fields are defaulted; every
 * other key on the envelope (and inside nodes) is carried through untouched.
 */
export function parseCollaborationDocument(raw: string | null | undefined): CollaborationDocument {
  if (!raw || !raw.trim()) throw new Error('parseCollaborationDocument: empty input');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('parseCollaborationDocument: expected a JSON object');
  }
  const rec = parsed as Record<string, JsonValue>;
  return {
    ...rec, // unknown keys first, so the normalized fields below win
    documentId: String(rec.documentId ?? ''),
    documentPath: String(rec.documentPath ?? ''),
    title: typeof rec.title === 'string' ? rec.title : '',
    frontmatter: (rec.frontmatter as DocumentFrontmatter) ?? {},
    nodes: Array.isArray(rec.nodes) ? (rec.nodes as CollaborationNode[]) : [],
    doc: (rec.doc as JsonDocument) ?? { root: {} },
  };
}

/**
 * R-1.8 — write a collaboration document. Unknown keys are emitted as-is; `title` is
 * refreshed from `frontmatter.title` per `resolveDocumentTitle`.
 */
export function serializeCollaborationDocument(doc: CollaborationDocument): string {
  return `${JSON.stringify({ ...doc, title: resolveDocumentTitle(doc) }, null, 2)}\n`;
}
