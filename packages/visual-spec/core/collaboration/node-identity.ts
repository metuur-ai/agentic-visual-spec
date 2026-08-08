/**
 * node-identity.ts — version bumping, `nodeId` backfill, and the uniqueness gate
 * (R-2.6, R-2.7, R-2.8, R-2.12).
 *
 * Task 2.1 (`ui/node-id-extension.ts`) assigns `nodeId` to nodes the **editor**
 * creates. It cannot cover a loaded document: `injectJSON()` swaps the node map
 * wholesale and never runs node transforms, so every load arrives with whatever ids
 * the persisted JSON happened to carry — which is why R-2.8 was amended to run
 * backfill on *every* load rather than only on legacy documents. This module is the
 * other half: it operates on the persisted JSON at the store boundary and answers
 * three questions about a document as a whole — which blocks lack an id, whether the
 * ids it does have are unique, and which blocks' content changed since the previous
 * revision.
 *
 * **Pure JSON, so it lives in `core/`.** Nothing here needs a `LexicalEditor`: a
 * serialized node is a plain object, `nodeId` is `node.$.nodeId`, and content
 * comparison is a structural comparison of the subtree. Putting it under `ui/` would
 * make version bumping unreachable from the CLI and the Vite host, which is where
 * writes actually happen (`core/bundle-guard.test.ts` enforces the direction:
 * `core/` must not import `ui/` or Luthor).
 *
 * **Where bumping runs: at the store/serialization boundary, not as an editor
 * transform.** A node transform fires on every editor update, including updates that
 * change no content at all — a caret move, a selection change, a re-render — so a
 * transform-based bump would inflate `version` for edits a reviewer never made and
 * flag every anchored comment outdated. The boundary sees exactly two revisions and
 * compares them, so a bump means the persisted content actually differs.
 *
 * **Version lives on the envelope's `nodes` projection** (`CollaborationNode.version`,
 * R-1.3 / LLD §1), not inside the Lexical tree. The tree is Luthor's format; adding a
 * field to it would either be dropped on the next `importJSON` or, if carried under
 * `$`, would be editable from inside the editor. The projection is rebuilt here on
 * every reconcile and is the single place `version` is defined.
 */
import type { CollaborationDocument, CollaborationNode, JsonDocument } from './document-protocol';
import type { DocumentStore } from './document-store';
// Pure module: this file is reachable from the browser via `ui/collab-editor.tsx`.
import { resolveNodeIn } from './node-location';

/**
 * Node types that are **not** addressable blocks, so they neither carry a `nodeId`
 * nor appear in the `nodes` projection: the document root plus the inline nodes.
 *
 * This mirrors `Object.keys(NODE_ID_EXCLUDED_TYPES)` in `ui/node-id-extension.ts`,
 * where the reasons are documented per type. The list is duplicated rather than
 * imported because that module imports Luthor and this one is CLI-reachable
 * (R-3.3). `ui/node-identity-parity.test.ts` fails if the two ever drift.
 */
export const NODE_IDENTITY_EXCLUDED_TYPES: readonly string[] = [
  'root',
  'text',
  'linebreak',
  'tab',
  'code-highlight',
  'link',
  'autolink',
];

const EXCLUDED = new Set(NODE_IDENTITY_EXCLUDED_TYPES);

/** Everything that is not the root or an inline node is an addressable block. */
export function isAddressableBlockType(type: unknown): boolean {
  return typeof type === 'string' && type.length > 0 && !EXCLUDED.has(type);
}

/** R-2.8 — the record left on the envelope when backfill assigned ids. */
export type NodeIdentityBackfillRecord = {
  /** ISO timestamp of the most recent backfill. */
  at: string;
  /** Every id this module has ever machine-assigned for this document, sorted. */
  nodeIds: string[];
};

/** The `identity` field this module owns on the envelope. */
export type NodeIdentityRecord = {
  backfill?: NodeIdentityBackfillRecord;
};

/** R-2.12 — a write that cannot produce a unique id for every block. */
export class NodeIdentityError extends Error {
  /** The offending ids: duplicated, or the ones the generator could not make unique. */
  readonly nodeIds: string[];

  constructor(message: string, nodeIds: string[]) {
    super(message);
    this.name = 'NodeIdentityError';
    this.nodeIds = nodeIds;
  }
}

export type ReconcileOptions = {
  /**
   * The previously persisted revision, used to decide which blocks changed. Omit on
   * load: the document is then compared against itself, so backfill runs but nothing
   * bumps.
   */
  previous?: CollaborationDocument | null;
  /** Injected for deterministic tests; defaults to `crypto.randomUUID()`. */
  generateNodeId?: () => string;
  /** Injected for deterministic tests; defaults to `new Date()`. */
  now?: () => Date;
};

export type ReconcileResult = {
  /** A new envelope — the input is never mutated. */
  document: CollaborationDocument;
  /** Ids assigned by this call, in document order. */
  backfilledNodeIds: string[];
  /** Ids whose `version` this call incremented, in document order. */
  bumpedNodeIds: string[];
};

/** How many times the generator may collide before the write fails (R-2.12). */
const MAX_ID_ATTEMPTS = 50;

function randomNodeId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type SerializedNode = Record<string, unknown>;

function readNodeId(node: SerializedNode): string {
  const state = node.$;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const id = (state as Record<string, unknown>).nodeId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return '';
}

function writeNodeId(node: SerializedNode, nodeId: string): void {
  const state = node.$;
  const next = state && typeof state === 'object' && !Array.isArray(state) ? (state as Record<string, unknown>) : {};
  next.nodeId = nodeId;
  node.$ = next;
}

/**
 * Every addressable block in document order. Recursion continues through excluded
 * nodes (a block nested inside a quote or a list item is still addressable), it just
 * does not yield them.
 */
export function collectBlocks(doc: JsonDocument | null | undefined): SerializedNode[] {
  const out: SerializedNode[] = [];
  const visit = (node: SerializedNode): void => {
    if (isAddressableBlockType(node.type)) out.push(node);
    const children = node.children;
    if (!Array.isArray(children)) return;
    for (const child of children) {
      if (child && typeof child === 'object' && !Array.isArray(child)) visit(child as SerializedNode);
    }
  };
  const root = doc?.root;
  if (root && typeof root === 'object' && !Array.isArray(root)) visit(root as SerializedNode);
  return out;
}

/**
 * **The definition of "content" for R-2.6 / R-2.7.**
 *
 * A block's content is its whole serialized subtree — text, formatting marks,
 * attributes (`tag`, `listType`, `format`, `indent`, …) and child structure — with
 * every `$` key stripped at every depth and object keys sorted so key order cannot
 * masquerade as a change.
 *
 * Two consequences worth stating, because both are choices:
 *
 * - **Formatting counts.** Bolding the sentence a comment is attached to changes what
 *   the reviewer sees, so it marks the comment outdated. The alternative (text only)
 *   would let a visible change slip past a comment silently.
 * - **Identity does not count.** `$` holds `nodeId`, which is why a backfill on load
 *   cannot bump the very version it just assigned an id for, and why re-issuing an id
 *   is never mistaken for an edit.
 *
 * A parent's signature contains its children's, so editing a list item bumps both the
 * item and the list that holds it. That is intended: the list's content did change.
 */
export function nodeContentSignature(node: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(src).sort()) {
        if (key === '$') continue;
        out[key] = canonical(src[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(canonical(node));
}

/** The block's plain text, for `CollaborationNode.content`. */
export function nodeTextContent(node: unknown): string {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return '';
  const rec = node as SerializedNode;
  const own = typeof rec.text === 'string' ? rec.text : '';
  const children = Array.isArray(rec.children) ? rec.children.map(nodeTextContent).join('') : '';
  return own + children;
}

/**
 * R-2.6 / R-2.7 / R-2.8 / R-2.12 — bring a document's identity and versions up to
 * date, or fail.
 *
 * In order:
 *
 * 1. **Uniqueness gate (R-2.12).** Two live blocks holding the same `nodeId` fail the
 *    call. They are *not* silently re-issued: at this boundary there is no way to tell
 *    which of the two a comment was anchored to, and reassigning the wrong one
 *    mis-anchors it. `registerNodeIdTransforms` already de-duplicates inside the
 *    editor, where the copy *is* identifiable; anything that reaches here duplicated
 *    came from outside that path and is a bug, not a paste.
 * 2. **Backfill (R-2.8).** Blocks with no id get a fresh one, unique against every id
 *    already live in the document. The generator gets `MAX_ID_ATTEMPTS` tries before
 *    the call fails — an exhausted or constant generator is the second way a write
 *    cannot produce unique ids, and it also fails rather than persisting.
 * 3. **Versions (R-2.6 / R-2.7).** For each block, its content signature is compared
 *    against the same id's signature in `previous`. Different → `version + 1`. Equal,
 *    or absent from `previous` → carried, or `1` for a block seen for the first time.
 *
 * Nothing is mutated: the returned envelope holds a deep copy of `doc`.
 */
export function reconcileDocumentIdentity(
  document: CollaborationDocument,
  options: ReconcileOptions = {},
): ReconcileResult {
  const generateNodeId = options.generateNodeId ?? randomNodeId;
  const now = options.now ?? (() => new Date());
  // No `previous` means "load": compare the document against itself so backfill runs
  // and no version moves.
  const previous = options.previous ?? document;

  const doc = structuredClone(document.doc ?? { root: {} }) as JsonDocument;
  const blocks = collectBlocks(doc);

  // 1. Uniqueness gate (R-2.12).
  const live = new Set<string>();
  const duplicates: string[] = [];
  for (const block of blocks) {
    const id = readNodeId(block);
    if (!id) continue;
    if (live.has(id)) duplicates.push(id);
    else live.add(id);
  }
  if (duplicates.length > 0) {
    throw new NodeIdentityError(
      `node-identity: ${duplicates.length} block(s) share a nodeId with another block ` +
        `(${[...new Set(duplicates)].join(', ')}); refusing to persist a partially identified document (R-2.12)`,
      [...new Set(duplicates)],
    );
  }

  // 2. Backfill (R-2.8).
  const backfilledNodeIds: string[] = [];
  for (const block of blocks) {
    if (readNodeId(block)) continue;
    let id = '';
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const candidate = generateNodeId();
      if (typeof candidate === 'string' && candidate.length > 0 && !live.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) {
      throw new NodeIdentityError(
        `node-identity: could not generate a unique nodeId for a '${String(block.type)}' block after ` +
          `${MAX_ID_ATTEMPTS} attempts; refusing to persist a partially identified document (R-2.12)`,
        [],
      );
    }
    writeNodeId(block, id);
    live.add(id);
    backfilledNodeIds.push(id);
  }

  // 3. Versions (R-2.6 / R-2.7).
  const previousSignatures = new Map<string, string>();
  for (const block of collectBlocks(previous?.doc)) {
    const id = readNodeId(block);
    if (id && !previousSignatures.has(id)) previousSignatures.set(id, nodeContentSignature(block));
  }
  const previousVersions = new Map<string, number>();
  for (const node of previous?.nodes ?? []) {
    if (node && typeof node.id === 'string' && typeof node.version === 'number') {
      previousVersions.set(node.id, node.version);
    }
  }

  const bumpedNodeIds: string[] = [];
  const nodes: CollaborationNode[] = blocks.map((block) => {
    const id = readNodeId(block);
    const priorSignature = previousSignatures.get(id);
    const priorVersion = previousVersions.get(id) ?? 1;
    let version = priorVersion;
    if (priorSignature !== undefined && priorSignature !== nodeContentSignature(block)) {
      version = priorVersion + 1;
      bumpedNodeIds.push(id);
    }
    return { id, type: String(block.type), version, content: nodeTextContent(block) };
  });

  // R-2.8 — record the backfill on the envelope. The record is cumulative because a
  // machine-assigned id is not the id any earlier comment was anchored to, and that
  // stays true for the life of the document; a consumer investigating an orphaned
  // comment needs the whole set, not just the last batch. When nothing was backfilled
  // the existing record is carried untouched, so a reconcile on every load does not
  // churn the file.
  const identity: NodeIdentityRecord = { ...((document.identity as NodeIdentityRecord | undefined) ?? {}) };
  if (backfilledNodeIds.length > 0) {
    const known = new Set([...(identity.backfill?.nodeIds ?? []), ...backfilledNodeIds]);
    identity.backfill = { at: now().toISOString(), nodeIds: [...known].sort() };
  }

  return {
    document: { ...document, doc, nodes, ...(identity.backfill ? { identity } : {}) },
    backfilledNodeIds,
    bumpedNodeIds,
  };
}

/**
 * The wiring point: any `DocumentStore`, with R-2.6 … R-2.12 applied around it.
 *
 * - **`read` backfills (R-2.8)** so a caller never sees a block without an id, and
 *   carries the record on the envelope. It does *not* write the repaired document
 *   back: a read that commits is unacceptable for the PR-branch store, and backfill
 *   is a repair mechanism, not the identity mechanism (LLD §2). The repaired ids
 *   become durable on the next `write`, which is when the client hands them back.
 * - **`write` bumps (R-2.6 / R-2.7)** against the previously persisted revision, and
 *   fails the write on a duplicate or unusable id (R-2.12) — the store is never
 *   called, so nothing partially identified is persisted.
 *
 * A decorator rather than behaviour baked into `fsDocumentStore` because the same
 * rules have to hold for the GitHub-backed store (task 3.2) and for any future one.
 */
export function withNodeIdentity(
  store: DocumentStore,
  options: { generateNodeId?: () => string; now?: () => Date } = {},
): DocumentStore {
  const wrapped: DocumentStore = {
    /*
     * READ REPAIRS, AND THAT IS DELIBERATE.
     *
     * A document is not only written through this wrapper. An agent applying review
     * comments edits `documents/<id>.json` with ordinary file writes, so blocks arrive
     * with no `nodeId` at all. Reconciling on read already minted ids for them — but only
     * in the returned value, and `randomNodeId` is `crypto.randomUUID()`, so EVERY read
     * minted different ones. A comment anchored to such a block resolved to a node that
     * no longer existed by the next load: the anchor rotted between one page view and the
     * next, silently, and nothing in the suite could see it because each read was
     * internally consistent.
     *
     * Persisting the backfill makes the first read the one that decides, and every read
     * after it agrees. Only when something was actually minted, so an untouched document
     * is still a pure read.
     *
     * A failed repair does not fail the read: the caller asked for a document, the
     * document is correct in memory, and the next read tries again. What it must not do
     * is hand back ids it did not keep.
     */
    async read(documentId) {
      const doc = await store.read(documentId);
      if (doc === null) return null;
      const reconciled = reconcileDocumentIdentity(doc, options);
      if (reconciled.backfilledNodeIds.length > 0) {
        try {
          await store.write(reconciled.document);
        } catch {
          // Left deliberately silent: see above. The in-memory document is still correct.
        }
      }
      return reconciled.document;
    },

    async write(doc) {
      const previous = await store.read(doc.documentId);
      await store.write(reconcileDocumentIdentity(doc, { ...options, previous }).document);
    },

    list: () => store.list(),

    async resolveNode(documentId, nodeId) {
      const doc = await wrapped.read(documentId);
      return doc ? resolveNodeIn(doc, nodeId) : { found: false };
    },
  };
  return wrapped;
}
