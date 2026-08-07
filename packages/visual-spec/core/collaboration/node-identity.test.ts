/**
 * node-identity.test.ts — task 2.2's acceptance suite (R-2.6, R-2.7, R-2.8, R-2.12).
 *
 * The headline item is the property test at the bottom: random edit scripts
 * (insert / delete / move / edit / no-op edit) driven through `reconcileDocumentIdentity`,
 * asserting id stability and version monotonicity over every revision. Seeds are fixed
 * so a failure reproduces, and the failing seed plus the operation log is printed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CollaborationDocument } from './document-protocol';
import { type DocumentStore, fsDocumentStore } from './document-store';
import {
  NODE_IDENTITY_EXCLUDED_TYPES,
  NodeIdentityError,
  collectBlocks,
  isAddressableBlockType,
  nodeContentSignature,
  nodeTextContent,
  reconcileDocumentIdentity,
  withNodeIdentity,
} from './node-identity';

type Json = Record<string, unknown>;

const text = (value: string, format = 0): Json => ({ type: 'text', text: value, format });

const paragraph = (value: string, over: Json = {}): Json => ({
  type: 'paragraph',
  children: [text(value)],
  ...over,
});

const withId = (node: Json, nodeId: string): Json => ({ ...node, $: { nodeId } });

const envelope = (root: Json, over: Partial<CollaborationDocument> = {}): CollaborationDocument => ({
  documentId: 'd-11112222',
  documentPath: 'docs/tasks/post-it-notes.md',
  title: 'Post-it Notes',
  frontmatter: {},
  nodes: [],
  doc: { root: { type: 'root', ...root } },
  ...over,
});

/** A generator that hands out predictable ids, so assertions can name them. */
const seqGenerator = (prefix = 'g') => {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
};

const versionOf = (doc: CollaborationDocument, id: string): number | undefined =>
  doc.nodes.find((node) => node.id === id)?.version;

describe('node-identity — blocks', () => {
  it('treats the root and inline nodes as non-addressable', () => {
    for (const type of NODE_IDENTITY_EXCLUDED_TYPES) expect(isAddressableBlockType(type)).toBe(false);
    for (const type of ['paragraph', 'heading', 'quote', 'list', 'listitem', 'code', 'table'])
      expect(isAddressableBlockType(type)).toBe(true);
    expect(isAddressableBlockType(undefined)).toBe(false);
  });

  it('collects nested blocks in document order and skips inline nodes', () => {
    const doc = envelope({
      children: [
        paragraph('one'),
        {
          type: 'quote',
          children: [paragraph('two'), { type: 'link', url: 'x', children: [text('three')] }],
        },
      ],
    }).doc;
    expect(collectBlocks(doc).map((node) => node.type)).toEqual(['paragraph', 'quote', 'paragraph']);
  });

  it('reads a block’s plain text through its children', () => {
    expect(nodeTextContent({ type: 'quote', children: [paragraph('a b'), paragraph('c')] })).toBe('a bc');
  });
});

describe('node-identity — R-2.6 content change bumps version, never nodeId', () => {
  it('bumps the edited block and leaves its neighbour alone', () => {
    const before = reconcileDocumentIdentity(
      envelope({ children: [withId(paragraph('one'), 'a'), withId(paragraph('two'), 'b')] }),
    ).document;

    const after = reconcileDocumentIdentity(
      envelope({ children: [withId(paragraph('one EDITED'), 'a'), withId(paragraph('two'), 'b')] }),
      { previous: before },
    );

    expect(after.bumpedNodeIds).toEqual(['a']);
    expect(versionOf(after.document, 'a')).toBe(2);
    expect(versionOf(after.document, 'b')).toBe(1);
    expect(after.document.nodes.map((node) => node.id)).toEqual(['a', 'b']);
  });

  it('keeps bumping the same id across successive edits (version is monotonic)', () => {
    let current = reconcileDocumentIdentity(envelope({ children: [withId(paragraph('v1'), 'a')] })).document;
    for (const value of ['v2', 'v3', 'v4']) {
      current = reconcileDocumentIdentity(envelope({ children: [withId(paragraph(value), 'a')] }), {
        previous: current,
      }).document;
    }
    expect(versionOf(current, 'a')).toBe(4);
  });

  it('counts a formatting mark as a content change', () => {
    const before = reconcileDocumentIdentity(envelope({ children: [withId(paragraph('one'), 'a')] })).document;
    const bolded = { ...paragraph('one'), children: [text('one', 1)] };
    const after = reconcileDocumentIdentity(envelope({ children: [withId(bolded, 'a')] }), { previous: before });
    expect(after.bumpedNodeIds).toEqual(['a']);
  });

  it('counts a block attribute change as a content change', () => {
    const before = reconcileDocumentIdentity(
      envelope({ children: [withId({ type: 'heading', tag: 'h1', children: [text('T')] }, 'a')] }),
    ).document;
    const after = reconcileDocumentIdentity(
      envelope({ children: [withId({ type: 'heading', tag: 'h2', children: [text('T')] }, 'a')] }),
      { previous: before },
    );
    expect(after.bumpedNodeIds).toEqual(['a']);
  });

  it('bumps a parent when only its child changed, because the parent contains it', () => {
    const quote = (value: string): Json => ({
      type: 'quote',
      children: [withId(paragraph(value), 'child')],
    });
    const before = reconcileDocumentIdentity(envelope({ children: [withId(quote('x'), 'parent')] })).document;
    const after = reconcileDocumentIdentity(envelope({ children: [withId(quote('y'), 'parent')] }), {
      previous: before,
    });
    expect(new Set(after.bumpedNodeIds)).toEqual(new Set(['parent', 'child']));
  });
});

describe('node-identity — R-2.7 unchanged content does not bump', () => {
  // A caret move, a selection change, or a re-render round-trips the identical JSON.
  it('does not bump when the identical document is written back', () => {
    const before = reconcileDocumentIdentity(
      envelope({ children: [withId(paragraph('one'), 'a'), withId(paragraph('two'), 'b')] }),
    ).document;
    const after = reconcileDocumentIdentity(structuredClone(before), { previous: before });
    expect(after.bumpedNodeIds).toEqual([]);
    expect(versionOf(after.document, 'a')).toBe(1);
  });

  // Select-all then retype the same text: the editor rebuilds the nodes from scratch,
  // so the JSON is structurally equal but not object-identical, and key order differs.
  it('does not bump after a select-all + retype of the same text (no-op edit)', () => {
    const before = reconcileDocumentIdentity(
      envelope({ children: [withId(paragraph('the user can pin a note'), 'a')] }),
    ).document;

    const retyped: Json = {
      $: { nodeId: 'a' },
      children: [{ format: 0, text: 'the user can pin a note', type: 'text' }],
      type: 'paragraph',
    };
    const after = reconcileDocumentIdentity(envelope({ children: [retyped] }), { previous: before });

    expect(after.bumpedNodeIds).toEqual([]);
    expect(versionOf(after.document, 'a')).toBe(1);
  });

  it('does not bump when a block only moves', () => {
    const before = reconcileDocumentIdentity(
      envelope({ children: [withId(paragraph('one'), 'a'), withId(paragraph('two'), 'b')] }),
    ).document;
    const after = reconcileDocumentIdentity(
      envelope({ children: [withId(paragraph('two'), 'b'), withId(paragraph('one'), 'a')] }),
      { previous: before },
    );
    expect(after.bumpedNodeIds).toEqual([]);
    expect(after.document.nodes.map((node) => node.id)).toEqual(['b', 'a']);
  });

  it('ignores the `$` state when comparing content, so re-issuing an id is not an edit', () => {
    expect(nodeContentSignature(withId(paragraph('one'), 'a'))).toBe(nodeContentSignature(withId(paragraph('one'), 'z')));
  });
});

describe('node-identity — R-2.8 backfill on load, recorded', () => {
  it('assigns an id to every unidentified block and records the fact on the envelope', () => {
    const result = reconcileDocumentIdentity(
      envelope({
        children: [
          withId(paragraph('kept'), 'a'),
          paragraph('missing'),
          { type: 'quote', children: [paragraph('nested')] },
        ],
      }),
      { generateNodeId: seqGenerator(), now: () => new Date('2026-01-02T03:04:05.000Z') },
    );

    expect(result.backfilledNodeIds).toEqual(['g1', 'g2', 'g3']);
    expect(result.document.nodes.map((node) => node.id)).toEqual(['a', 'g1', 'g2', 'g3']);
    expect(result.document.identity).toEqual({
      backfill: { at: '2026-01-02T03:04:05.000Z', nodeIds: ['g1', 'g2', 'g3'] },
    });
  });

  // Backfill runs on every load (R-2.8 as amended), so it must be idempotent: the
  // second pass finds nothing missing, writes no new record and moves no version.
  it('does not churn versions or the record on a second pass', () => {
    const first = reconcileDocumentIdentity(envelope({ children: [paragraph('missing')] }), {
      generateNodeId: seqGenerator(),
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    });
    const second = reconcileDocumentIdentity(first.document, {
      generateNodeId: seqGenerator('later'),
      now: () => new Date('2026-06-06T00:00:00.000Z'),
    });

    expect(second.backfilledNodeIds).toEqual([]);
    expect(second.bumpedNodeIds).toEqual([]);
    expect(second.document.identity).toEqual(first.document.identity);
    expect(versionOf(second.document, 'g1')).toBe(1);
  });

  it('accumulates the record across separate backfills', () => {
    const first = reconcileDocumentIdentity(envelope({ children: [paragraph('one')] }), {
      generateNodeId: seqGenerator('x'),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const second = reconcileDocumentIdentity(
      envelope({ children: [withId(paragraph('one'), 'x1'), paragraph('two')] }, { identity: first.document.identity }),
      { generateNodeId: seqGenerator('y'), now: () => new Date('2026-02-02T00:00:00.000Z') },
    );
    expect(second.document.identity).toEqual({
      backfill: { at: '2026-02-02T00:00:00.000Z', nodeIds: ['x1', 'y1'] },
    });
  });

  it('leaves no `identity` field on a document that never needed backfill', () => {
    const result = reconcileDocumentIdentity(envelope({ children: [withId(paragraph('one'), 'a')] }));
    expect(result.document.identity).toBeUndefined();
  });

  it('never assigns an id to an inline node', () => {
    const result = reconcileDocumentIdentity(
      envelope({ children: [{ type: 'paragraph', children: [text('a'), { type: 'linebreak' }] }] }),
      { generateNodeId: seqGenerator() },
    );
    const [para] = (result.document.doc.root as Json).children as Json[];
    expect((para.children as Json[]).every((child) => child.$ === undefined)).toBe(true);
  });

  it('does not mutate the document it was given', () => {
    const input = envelope({ children: [paragraph('one')] });
    const snapshot = JSON.stringify(input);
    reconcileDocumentIdentity(input, { generateNodeId: seqGenerator() });
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('node-identity — R-2.12 a write that cannot produce unique ids fails', () => {
  it('rejects a document whose blocks share a nodeId', () => {
    const doc = envelope({ children: [withId(paragraph('one'), 'dup'), withId(paragraph('two'), 'dup')] });
    expect(() => reconcileDocumentIdentity(doc)).toThrow(NodeIdentityError);
    try {
      reconcileDocumentIdentity(doc);
    } catch (err) {
      expect((err as NodeIdentityError).nodeIds).toEqual(['dup']);
      expect((err as Error).message).toContain('R-2.12');
    }
  });

  it('rejects a generator that cannot produce an id unique against the live document', () => {
    expect(() =>
      reconcileDocumentIdentity(envelope({ children: [withId(paragraph('one'), 'a'), paragraph('two')] }), {
        generateNodeId: () => 'a',
      }),
    ).toThrow(NodeIdentityError);
  });

  it('rejects a generator that returns an empty id', () => {
    expect(() =>
      reconcileDocumentIdentity(envelope({ children: [paragraph('one')] }), { generateNodeId: () => '' }),
    ).toThrow(NodeIdentityError);
  });

  it('does not call the underlying store when identity cannot be established', async () => {
    const inner: DocumentStore = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      resolveNode: vi.fn(async () => ({ found: false as const })),
    };
    const store = withNodeIdentity(inner);
    await expect(
      store.write(envelope({ children: [withId(paragraph('one'), 'dup'), withId(paragraph('two'), 'dup')] })),
    ).rejects.toBeInstanceOf(NodeIdentityError);
    expect(inner.write).not.toHaveBeenCalled();
  });
});

describe('node-identity — withNodeIdentity', () => {
  const tmpStore = async (): Promise<DocumentStore> => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    return fsDocumentStore(await mkdtemp(join(tmpdir(), 'vs-node-identity-')));
  };

  it('backfills on read and bumps on write, leaving the plain store untouched', async () => {
    const inner = await tmpStore();
    const store = withNodeIdentity(inner, { generateNodeId: seqGenerator() });

    await inner.write(envelope({ children: [paragraph('one')] })); // written out of band, no ids
    const loaded = await store.read('d-11112222');
    expect(loaded?.nodes).toEqual([{ id: 'g1', type: 'paragraph', version: 1, content: 'one' }]);
    expect(loaded?.identity).toBeDefined();
    // The repair is in memory only — the file on disk is still unidentified.
    expect((await inner.read('d-11112222'))?.nodes).toEqual([]);

    await store.write(envelope({ children: [withId(paragraph('one'), 'g1')] }));
    await store.write(envelope({ children: [withId(paragraph('one EDITED'), 'g1')] }));
    expect(versionOf((await inner.read('d-11112222')) as CollaborationDocument, 'g1')).toBe(2);
  });

  it('resolves a backfilled node through the wrapped store (R-3.4 stays intact)', async () => {
    const inner = await tmpStore();
    const store = withNodeIdentity(inner, { generateNodeId: seqGenerator() });
    await inner.write(envelope({ children: [paragraph('one')] }));
    const hit = await store.resolveNode('d-11112222', 'g1');
    expect(hit.found).toBe(true);
    expect(await store.list()).toEqual(['d-11112222']);
    expect(await store.read('d-nope')).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * Property test — random edit scripts (the task's named verification).
 * ------------------------------------------------------------------------- */

/** mulberry32 — small, seeded, deterministic. No `Math.random()` anywhere. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The authoring model the generator edits. `marker` is the out-of-band logical
 * identity the assertions track — the test must not use `nodeId` to decide which
 * block is which, or id stability would be true by construction. It rides under the
 * `$` key, which `nodeContentSignature` strips, so it never counts as content.
 */
type BlockSpec = { marker: string; kind: 'paragraph' | 'heading' | 'quote'; text: string; child?: BlockSpec };

const specToJson = (spec: BlockSpec, ids: Map<string, string>): Json => {
  const state: Json = { marker: spec.marker };
  const id = ids.get(spec.marker);
  if (id) state.nodeId = id;
  if (spec.kind === 'quote') {
    return { type: 'quote', $: state, children: [specToJson(spec.child as BlockSpec, ids)] };
  }
  if (spec.kind === 'heading') {
    return { type: 'heading', tag: 'h2', $: state, children: [text(spec.text)] };
  }
  return { type: 'paragraph', $: state, children: [text(spec.text)] };
};

const flatten = (specs: BlockSpec[]): BlockSpec[] =>
  specs.flatMap((spec) => (spec.child ? [spec, spec.child] : [spec]));

/** marker → { nodeId, signature } for every block of a reconciled document. */
const indexByMarker = (doc: CollaborationDocument): Map<string, { id: string; signature: string }> => {
  const out = new Map<string, { id: string; signature: string }>();
  for (const block of collectBlocks(doc.doc)) {
    const state = block.$ as Json | undefined;
    const marker = state?.marker;
    if (typeof marker === 'string') {
      out.set(marker, { id: String(state?.nodeId ?? ''), signature: nodeContentSignature(block) });
    }
  }
  return out;
};

describe('node-identity — property: random edit scripts (R-2.6, R-2.7, R-2.12)', () => {
  const CASES = 200;
  const STEPS = 12;

  it(`holds id stability and version monotonicity over ${CASES} seeded edit scripts`, () => {
    for (let seed = 1; seed <= CASES; seed += 1) {
      const rng = mulberry32(seed);
      const log: string[] = [];
      const fail = (message: string): never => {
        throw new Error(`seed=${seed} step=${log.length} ops=[${log.join(', ')}]\n${message}`);
      };
      const pick = <T>(items: T[]): T => items[Math.floor(rng() * items.length)] as T;
      let markerCounter = 0;
      const newSpec = (): BlockSpec => {
        const marker = `m${(markerCounter += 1)}`;
        const kind = pick(['paragraph', 'heading', 'quote'] as const);
        const spec: BlockSpec = { marker, kind, text: `t${Math.floor(rng() * 1000)}` };
        if (kind === 'quote') {
          spec.child = { marker: `${marker}c`, kind: 'paragraph', text: `t${Math.floor(rng() * 1000)}` };
        }
        return spec;
      };

      let specs: BlockSpec[] = [newSpec(), newSpec(), newSpec()];
      // Assigned ids, by marker. A block only gets one here when the editor would have
      // assigned it; otherwise it arrives unidentified and backfill must cover it.
      const ids = new Map<string, string>();
      const generateNodeId = seqGenerator(`s${seed}-`);

      let current = reconcileDocumentIdentity(envelope({ children: specs.map((s) => specToJson(s, ids)) }), {
        generateNodeId,
      }).document;
      for (const [marker, entry] of indexByMarker(current)) ids.set(marker, entry.id);

      for (let step = 0; step < STEPS; step += 1) {
        const before = indexByMarker(current);
        const beforeVersions = new Map(current.nodes.map((node) => [node.id, node.version]));
        const op = pick(['insert', 'delete', 'move', 'edit', 'noop'] as const);
        log.push(op);

        if (op === 'insert') {
          const spec = newSpec();
          specs = [...specs];
          specs.splice(Math.floor(rng() * (specs.length + 1)), 0, spec);
          // Half the inserts arrive unidentified, exercising backfill mid-script.
          if (rng() < 0.5) {
            ids.set(spec.marker, generateNodeId());
            if (spec.child) ids.set(spec.child.marker, generateNodeId());
          }
        } else if (op === 'delete' && specs.length > 1) {
          const victim = Math.floor(rng() * specs.length);
          specs = specs.filter((_, index) => index !== victim);
        } else if (op === 'move' && specs.length > 1) {
          specs = [...specs];
          const [moved] = specs.splice(Math.floor(rng() * specs.length), 1) as [BlockSpec];
          specs.splice(Math.floor(rng() * (specs.length + 1)), 0, moved);
        } else if (op === 'edit') {
          const target = pick(flatten(specs));
          const edited = { ...target, text: `${target.text}+` };
          const replace = (list: BlockSpec[]): BlockSpec[] =>
            list.map((spec) => {
              if (spec.marker === target.marker) return edited;
              if (spec.child?.marker === target.marker) return { ...spec, child: edited };
              return spec;
            });
          specs = replace(specs);
        }
        // 'noop' rebuilds the identical JSON from the same specs — the select-all +
        // retype case, and the caret-move case.

        const result = reconcileDocumentIdentity(
          envelope({ children: specs.map((s) => specToJson(s, ids)) }, { nodes: current.nodes, identity: current.identity }),
          { previous: current, generateNodeId },
        );
        const next = result.document;
        const after = indexByMarker(next);

        // Every block is identified, and no two share an id (R-2.12 never trips here).
        const seen = new Set<string>();
        for (const [marker, entry] of after) {
          if (!entry.id) fail(`block ${marker} has no nodeId`);
          if (seen.has(entry.id)) fail(`nodeId ${entry.id} is held by two blocks`);
          seen.add(entry.id);
        }
        if (after.size !== flatten(specs).length) fail('block count drifted from the authoring model');
        if (next.nodes.length !== after.size) fail('the nodes projection does not cover every block');

        const bumped = new Set(result.bumpedNodeIds);
        for (const [marker, entry] of after) {
          const prior = before.get(marker);
          const version = next.nodes.find((node) => node.id === entry.id)?.version;
          if (version === undefined) fail(`block ${marker} is missing from the nodes projection`);
          if (!prior) {
            // R-2.8 — a block that arrived unidentified must appear in the record.
            if (!ids.has(marker) && !(next.identity as { backfill?: { nodeIds: string[] } })?.backfill?.nodeIds.includes(entry.id)) {
              fail(`backfilled id ${entry.id} (${marker}) is not in the identity record`);
            }
            if (version !== 1) fail(`new block ${marker} started at version ${version}`);
            continue;
          }
          // R-2.6 — identity is stable across every edit, including moves.
          if (prior.id !== entry.id) fail(`block ${marker} changed nodeId ${prior.id} -> ${entry.id}`);
          const priorVersion = beforeVersions.get(prior.id) as number;
          // Monotonic: never decreases.
          if ((version as number) < priorVersion) fail(`block ${marker} version went ${priorVersion} -> ${version}`);
          // R-2.6 / R-2.7 — bumps exactly when the content signature changed.
          const changed = prior.signature !== entry.signature;
          const expected = changed ? priorVersion + 1 : priorVersion;
          if (version !== expected) {
            fail(`block ${marker} content ${changed ? 'changed' : 'unchanged'}: version ${priorVersion} -> ${version}`);
          }
          if (changed !== bumped.has(entry.id)) fail(`bumpedNodeIds disagrees with the signature for ${marker}`);
        }

        for (const [marker, entry] of after) ids.set(marker, entry.id);
        current = next;
      }
    }
  });
});
