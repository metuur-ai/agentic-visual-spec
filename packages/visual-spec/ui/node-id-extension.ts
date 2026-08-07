/**
 * node-id-extension.ts — the owned-node layer for collaborative documents
 * (R-2.2 … R-2.5, R-12.2).
 *
 * Every block in a collaboration document needs a stable key so a review comment
 * can point at it. Serialized Lexical nodes have none. This module supplies one,
 * using the mechanism task 0.1 proved against a live `ExtensiveEditor` mount:
 *
 *   - **Carrier: Lexical NodeState.** `createState` / `$setState` / `$getState`
 *     store `nodeId` on the node itself and Lexical serializes it under the `$`
 *     key — `{"type":"paragraph", …, "$":{"nodeId":"…"}}`. `importJSON` restores
 *     it for every node class with no extra code, and the node's `type` stays the
 *     base string (R-2.3), so `MARKDOWN_SUPPORTED_NODE_TYPES`, the Markdown
 *     transformers and the toolbar all keep matching. An owned subclass cannot do
 *     this: on Lexical 0.40 a subclass must own a distinct `getType()`, which
 *     forfeits R-2.3 (see `node-identity.contract.test.tsx` for the proof).
 *   - **Interception point: `registerNodeTransform`, one call per concrete class.**
 *     Transforms run before an update commits, so they cover every node the editor
 *     creates — on Enter, on paste, on list toggle. `registerNodeTransform`
 *     rejects an abstract base such as `ElementNode`, hence one registration per
 *     class; the classes are resolved from the editor's own node registry because
 *     several of them (`image`, `iframe-embed`, `youtube-embed`) are not exported
 *     under a stable name by Luthor.
 *
 * Transforms do **not** run on `injectJSON()` — `setEditorState` swaps the node
 * map wholesale — so a freshly loaded document still needs the R-2.8 backfill
 * (task 2.2). This module owns assignment for editor-created nodes only.
 *
 * This file imports Luthor/Lexical and therefore must stay under `ui/`;
 * `core/bundle-guard.test.ts` fails the build if Luthor becomes reachable from the
 * CLI or Vite-plugin host entrypoints.
 */
import { headless } from '@lyfie/luthor';
import {
  $getNodeByKey,
  $getRoot,
  $getState,
  $isElementNode,
  $setState,
  createState,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';

/**
 * The `nodeId` carrier. Serialized as `"$": { "nodeId": "…" }` next to an
 * untouched `type`. `parse` coerces anything that is not a string to `''`, which
 * is also the "unset" value NodeState reports for a node that never had one.
 */
export const nodeIdState = createState('nodeId', {
  parse: (value: unknown) => (typeof value === 'string' ? value : ''),
});

/**
 * Types in `MARKDOWN_SUPPORTED_NODE_TYPES` that deliberately do **not** carry a
 * `nodeId`, each with the reason. Everything else in that constant is treated as
 * an addressable block and MUST be covered by a transform — see
 * `NODE_ID_BLOCK_TYPES` below and the R-12.2 test. Keeping the exclusions as data
 * (rather than a hardcoded block list) means a block type added by a future Luthor
 * release joins `NODE_ID_BLOCK_TYPES` automatically and fails loudly if it cannot
 * be resolved, instead of being silently skipped.
 */
export const NODE_ID_EXCLUDED_TYPES: Readonly<Record<string, string>> = {
  root: 'the document root is not a block; the document itself is identified by `documentId`',
  text: 'inline text run — split and merged on every formatting change, never a comment target',
  linebreak: 'inline soft break inside a block',
  tab: 'inline whitespace run (a TextNode subclass)',
  'code-highlight': 'inline token inside a code block (a TextNode subclass); the `code` block carries the id',
  link: 'inline element — lives inside a block, which carries the id',
  autolink: 'inline element (a LinkNode subclass)',
};

/**
 * Every addressable block type, derived from Luthor's own constant so the list
 * cannot drift from it (R-12.2). Every one of these gets a transform.
 */
export const NODE_ID_BLOCK_TYPES: readonly string[] = [...headless.MARKDOWN_SUPPORTED_NODE_TYPES].filter(
  (type) => !(type in NODE_ID_EXCLUDED_TYPES),
);

/**
 * Block types whose transform assigns a `nodeId` in memory but whose id does
 * **not** survive serialization, because Luthor 2.9's node class builds its
 * `exportJSON()` result as an object literal instead of spreading
 * `super.exportJSON()` — and `LexicalNode.exportJSON()` is where Lexical writes
 * the `$` state key. Their `importJSON()` likewise constructs a fresh node instead
 * of going through `updateFromJSON`, so neither direction round-trips.
 *
 * Lexical's own decorator nodes are unaffected (`horizontalrule` round-trips
 * fine); this is specific to the three block types Luthor authors itself.
 *
 * Consequence for the reviewer UI: an image or an embed cannot be a durable
 * comment target until Luthor spreads `super.exportJSON()`. The R-12.2 test pins
 * both halves — coverage by a transform, and the serialization gap — so the day
 * Luthor fixes it the test fails and this list shrinks.
 */
export const NODE_ID_UNSERIALIZABLE_TYPES: Readonly<Record<string, string>> = {
  image: "Luthor's ImageNode.exportJSON() does not spread super.exportJSON(), so the `$` state key is dropped",
  'iframe-embed': "Luthor's IframeEmbedNode.exportJSON() does not spread super.exportJSON()",
  'youtube-embed': "Luthor's YouTubeEmbedNode.exportJSON() does not spread super.exportJSON()",
};

/** Read a node's `nodeId`; `''` when it has none yet. */
export function $getNodeId(node: LexicalNode): string {
  return $getState(node, nodeIdState);
}

/**
 * Read a `nodeId` back out of a **serialized** node — NodeState puts it under the
 * `$` key, so a stored `JsonDocument` node reads as `node.$.nodeId`, not
 * `node.id` / `node.nodeId`.
 */
export function getSerializedNodeId(serializedNode: unknown): string | undefined {
  const state = (serializedNode as { $?: Record<string, unknown> } | null | undefined)?.$;
  const id = state?.nodeId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export type NodeIdGenerator = () => string;

/**
 * Default generator. Random rather than a counter on purpose: a counter restarts
 * at 1 on every reload while the loaded document already holds ids from previous
 * sessions, so it would collide with live nodes on the very first edit.
 */
export function createRandomNodeId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Resolve one concrete node class per addressable block type from the editor's
 * own registry. Throws rather than skipping: a block type with no registered
 * class means `nodeId` coverage would be incomplete, and a partially identified
 * document is exactly what R-2.12 forbids persisting.
 */
export function resolveNodeIdTransformClasses(editor: LexicalEditor): Map<string, Klass<LexicalNode>> {
  const resolved = new Map<string, Klass<LexicalNode>>();
  const missing: string[] = [];
  for (const type of NODE_ID_BLOCK_TYPES) {
    const klass = editor._nodes.get(type)?.klass;
    if (klass) resolved.set(type, klass);
    else missing.push(type);
  }
  if (missing.length > 0) {
    throw new Error(
      `node-id-extension: no node class is registered for block type(s) ${missing.join(', ')}; ` +
        'nodeId coverage would be incomplete (R-12.2)',
    );
  }
  return resolved;
}

/**
 * Register the `nodeId`-assigning transforms on a live editor. Returns the
 * unregister function.
 *
 * Uniqueness (R-2.4) is enforced against a live index of `nodeId → nodeKey`, not
 * just "assign when absent". A paste of blocks copied from the *same* document
 * carries the originals' ids in the `application/x-lexical-editor` clipboard
 * payload, so an absent-only check would produce two live nodes sharing one id
 * and silently mis-anchor every comment on it. **The copy is re-issued a fresh
 * id; the node that already held it keeps it** — losing identity on the original
 * would break comments that are already anchored to it.
 */
export function registerNodeIdTransforms(
  editor: LexicalEditor,
  generateNodeId: NodeIdGenerator = createRandomNodeId,
): () => void {
  /** nodeId → the key of the node currently entitled to it. */
  const owners = new Map<string, string>();
  // `injectJSON` replaces the node map without running transforms, so the index
  // has to be rebuilt from the document rather than maintained incrementally.
  // Rebuilding on the first transform call of each update keeps it a single walk.
  let indexStale = true;

  const reindex = (): void => {
    owners.clear();
    const visit = (node: LexicalNode): void => {
      const id = $getState(node, nodeIdState);
      // First in document order wins the id; any later holder is a copy.
      if (id && !owners.has(id)) owners.set(id, node.getKey());
      if ($isElementNode(node)) for (const child of node.getChildren()) visit(child);
    };
    for (const child of $getRoot().getChildren()) visit(child);
    indexStale = false;
  };

  const freshNodeId = (): string => {
    let id = generateNodeId();
    while (owners.has(id)) id = generateNodeId();
    return id;
  };

  const assign = (node: LexicalNode): void => {
    if (indexStale) reindex();
    const key = node.getKey();
    const id = $getState(node, nodeIdState);
    if (id) {
      const ownerKey = owners.get(id);
      if (ownerKey === undefined || ownerKey === key) {
        owners.set(id, key);
        return;
      }
      const owner = $getNodeByKey(ownerKey);
      if (owner === null || $getState(owner, nodeIdState) !== id) {
        owners.set(id, key); // the previous holder is gone or moved on
        return;
      }
      // Duplicate: another live node already holds this id — `node` is a copy.
    }
    const next = freshNodeId();
    $setState(node, nodeIdState, next);
    owners.set(next, key);
  };

  const unregister = [...resolveNodeIdTransformClasses(editor).values()].map((klass) =>
    editor.registerNodeTransform(klass, assign),
  );
  unregister.push(
    editor.registerUpdateListener(() => {
      indexStale = true;
    }),
  );
  return () => unregister.forEach((fn) => fn());
}

/**
 * The Luthor extension to hand to `ExtensiveEditorProps.extraExtensions`. The
 * collaboration mount must NOT set `markdownSourceOfTruth`: under that flag Luthor
 * implements `getJSON()` as `markdownToJSON(getMarkdown())`, which re-parses the
 * document from Markdown and drops every `nodeId`.
 */
export function createNodeIdExtension(options: { generateNodeId?: NodeIdGenerator } = {}) {
  return headless.createExtension({
    name: 'vs-node-id',
    initialize: (editor: LexicalEditor) => registerNodeIdTransforms(editor, options.generateNodeId),
  });
}
