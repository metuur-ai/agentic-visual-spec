/**
 * anchor-resolution.test.ts — R-6.1 … R-6.5 and R-6.7.
 *
 * The three states are driven from one table (`CASES`), because they are one decision with
 * three outcomes and reading them apart is how a rule quietly grows a fourth branch.
 * Everything else here is about the degraded states: what an orphan still knows, and what
 * re-anchoring is allowed to produce.
 *
 * R-6.1 and R-6.7 are asserted twice — behaviourally (a document and a comment record
 * stuffed with line/snippet/heading fields change nothing) and against the module's own
 * source with comments stripped, because the cheapest way to reintroduce a rung is to
 * write one.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COLLAB_TARGET_TEXT_KEY,
  TARGET_TEXT_MAX,
  captureTargetText,
  collabNodeVersion,
  orphanedAnchors,
  reanchorCollabAnchor,
  resolveCollabAnchor,
} from './anchor-resolution';
import type { CollaborationAnchor, CollaborationDocument } from './document-protocol';

/**
 * Two blocks with ids under the NodeState `$` key — the spelling task 2.1's extension
 * writes and task 3.1's `resolveNodeIn` reads. `n-2` sits inside a quote so the returned
 * `path` is more than one level deep. The `nodes` projection carries the versions and the
 * text, exactly as task 2.2 maintains it and task 7.1's renderer reads it.
 */
function makeDoc(): CollaborationDocument {
  return {
    documentId: 'doc-1',
    documentPath: 'docs/a.md',
    title: 'A',
    frontmatter: {},
    nodes: [
      { id: 'n-1', type: 'paragraph', version: 3, content: 'First paragraph.' },
      { id: 'n-2', type: 'paragraph', version: 1, content: 'Quoted paragraph.' },
    ],
    doc: {
      root: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            version: 1, // Lexical's node-CLASS schema version — never the content version.
            $: { nodeId: 'n-1' },
            children: [{ type: 'text', text: 'First paragraph.' }],
          },
          {
            type: 'quote',
            children: [
              {
                type: 'paragraph',
                version: 1,
                $: { nodeId: 'n-2' },
                children: [{ type: 'text', text: 'Quoted paragraph.' }],
              },
            ],
          },
        ],
      },
    },
  };
}

const github = { owner: 'o', repo: 'r', branch: 'b', resolved: false };
const anchor = (nodeId: string, nodeVersion: number): CollaborationAnchor => ({ nodeId, nodeVersion, github });

describe('resolveCollabAnchor — the three states (R-6.2 / R-6.3 / R-6.4)', () => {
  /** state ⇄ input, in one place. `anchored` is part of the outcome, not a detail. */
  const CASES: {
    name: string;
    ref: { documentId: string; nodeId: string; nodeVersion?: number; targetText?: string };
    state: 'exact' | 'outdated' | 'orphaned';
    anchored: boolean;
    path?: number[];
    targetText: string;
  }[] = [
    {
      name: 'R-6.2 — node resolves, versions agree ⇒ exact',
      ref: { documentId: 'doc-1', nodeId: 'n-1', nodeVersion: 3 },
      state: 'exact',
      anchored: true,
      path: [0],
      targetText: 'First paragraph.',
    },
    {
      name: 'R-6.2 — nested node resolves ⇒ exact, with the deep path',
      ref: { documentId: 'doc-1', nodeId: 'n-2', nodeVersion: 1 },
      state: 'exact',
      anchored: true,
      path: [1, 0],
      targetText: 'Quoted paragraph.',
    },
    {
      name: 'R-6.3 — node resolves, versions differ ⇒ outdated, still anchored',
      ref: { documentId: 'doc-1', nodeId: 'n-1', nodeVersion: 1 },
      state: 'outdated',
      anchored: true,
      path: [0],
      targetText: 'First paragraph.',
    },
    {
      name: 'R-6.2 — no recorded version ⇒ exact, not falsely outdated',
      ref: { documentId: 'doc-1', nodeId: 'n-1' },
      state: 'exact',
      anchored: true,
      path: [0],
      targetText: 'First paragraph.',
    },
    {
      name: 'R-6.4 — unknown nodeId ⇒ orphaned, keeping its last-known text',
      ref: { documentId: 'doc-1', nodeId: 'n-gone', nodeVersion: 2, targetText: 'A deleted paragraph.' },
      state: 'orphaned',
      anchored: false,
      targetText: 'A deleted paragraph.',
    },
    {
      name: 'R-6.1 — a nodeId from another document ⇒ orphaned, never cross-anchored',
      ref: { documentId: 'doc-2', nodeId: 'n-1', nodeVersion: 3 },
      state: 'orphaned',
      anchored: false,
      targetText: '',
    },
  ];

  for (const c of CASES) {
    it(c.name, () => {
      const r = resolveCollabAnchor(c.ref, makeDoc());
      expect(r.state).toBe(c.state);
      expect(r.anchored).toBe(c.anchored);
      expect(r.targetText).toBe(c.targetText);
      expect(r.nodeId).toBe(c.ref.nodeId);
      if (r.anchored) {
        expect(r.path).toEqual(c.path);
        expect(r.node).toMatchObject({ type: 'paragraph' });
      }
    });
  }

  it('R-6.3 — compares against the `nodes` projection, not the serialized `version`', () => {
    const doc = makeDoc();
    // The tree node's own `version` is 1 (Lexical's schema version); the projection says 3.
    const r = resolveCollabAnchor({ documentId: 'doc-1', nodeId: 'n-1', nodeVersion: 1 }, doc);
    expect(r.state).toBe('outdated');
    if (!r.anchored) throw new Error('expected anchored');
    expect(r.nodeVersion).toBe(3);
    expect(r.anchorVersion).toBe(1);
  });

  it('R-6.2 — an unprojected node is exact, not a fabricated mismatch', () => {
    const doc = makeDoc();
    doc.nodes = [];
    const r = resolveCollabAnchor({ documentId: 'doc-1', nodeId: 'n-1', nodeVersion: 99 }, doc);
    expect(r.state).toBe('exact');
    if (!r.anchored) throw new Error('expected anchored');
    expect(r.nodeVersion).toBeNull();
    expect(r.targetText).toBe('First paragraph.'); // falls back to the subtree's text
  });

  it('R-6.4 — a missing document orphans rather than throwing', () => {
    expect(resolveCollabAnchor({ documentId: 'doc-1', nodeId: 'n-1' }, null).state).toBe('orphaned');
    expect(resolveCollabAnchor({ documentId: 'doc-1', nodeId: 'n-1' }, undefined).state).toBe('orphaned');
  });
});

describe('R-6.1 — nothing but documentId + nodeId is consulted', () => {
  it('ignores line, snippet and heading even when the record carries them', () => {
    const doc = makeDoc();
    // A record shaped like a *local* comment: every legacy rung present and every one of
    // them wrong. Resolution must not improve, degrade, or notice.
    const noisy = {
      documentId: 'doc-1',
      nodeId: 'n-2',
      nodeVersion: 1,
      startLine: 999,
      endLine: 1200,
      snippet: 'text that appears nowhere in the document',
      endSnippet: 'nor this',
      heading: 'A heading that does not exist',
    };
    const r = resolveCollabAnchor(noisy, doc);
    expect(r.state).toBe('exact');
    if (!r.anchored) throw new Error('expected anchored');
    expect(r.path).toEqual([1, 0]);

    // …and removing them changes nothing at all.
    const clean = resolveCollabAnchor({ documentId: 'doc-1', nodeId: 'n-2', nodeVersion: 1 }, doc);
    expect(clean).toEqual(r);
  });

  it('a nodeId that does not resolve stays orphaned however good the snippet is', () => {
    const doc = makeDoc();
    const r = resolveCollabAnchor(
      // The snippet matches a real block verbatim; the nodeId does not exist. Local mode
      // would anchor this. Collaboration must not (LLD §6 — the snippet rung is deleted).
      { documentId: 'doc-1', nodeId: 'n-gone', snippet: 'First paragraph.', heading: 'A' } as never,
      doc,
    );
    expect(r.state).toBe('orphaned');
  });

  it('R-6.1 / R-6.7 — the module never names a line, snippet or heading field', () => {
    const source = readModuleSource('anchor-resolution.ts');
    for (const banned of ['startLine', 'endLine', 'snippet', 'endSnippet', 'heading']) {
      expect(source).not.toContain(banned);
    }
  });
});

describe('R-6.7 — no line/snippet/heading field is required', () => {
  it('type-level: a complete CollaborationAnchor is nodeId + nodeVersion + github', () => {
    // This object compiles: `tsc --noEmit` is the assertion. If any of the five fields
    // became required on the anchor, this would stop compiling.
    const complete: CollaborationAnchor = { nodeId: 'n-1', nodeVersion: 3, github };
    expect(Object.keys(complete).sort()).toEqual(['github', 'nodeId', 'nodeVersion']);
  });

  it('runtime: the minimum ref resolves exactly', () => {
    const r = resolveCollabAnchor({ documentId: 'doc-1', nodeId: 'n-1' }, makeDoc());
    expect(r.state).toBe('exact');
  });
});

describe('R-6.5 — orphans keep their last-known target text', () => {
  it('collects orphans in input order, with their text and an explicit marker', () => {
    const doc = makeDoc();
    const refs = [
      { documentId: 'doc-1', nodeId: 'n-1', nodeVersion: 3 },
      { documentId: 'doc-1', nodeId: 'n-gone', nodeVersion: 2, targetText: 'Removed intro.' },
      { documentId: 'doc-1', nodeId: 'n-2', nodeVersion: 9 },
      { documentId: 'doc-1', nodeId: 'n-also-gone', nodeVersion: 1 },
    ];
    const orphans = orphanedAnchors(refs, doc);
    expect(orphans.map((o) => o.ref.nodeId)).toEqual(['n-gone', 'n-also-gone']);
    expect(orphans[0]?.resolution).toEqual({
      state: 'orphaned',
      documentId: 'doc-1',
      nodeId: 'n-gone',
      anchored: false,
      targetText: 'Removed intro.',
    });
    // R-6.4 — nothing was discarded and nothing else was reclassified.
    expect(resolveCollabAnchor(refs[2] as never, doc).state).toBe('outdated');
  });

  it('an orphan with no recorded text says so instead of guessing', () => {
    const r = resolveCollabAnchor({ documentId: 'doc-1', nodeId: 'n-gone' }, makeDoc());
    expect(r.targetText).toBe('');
  });

  it('captureTargetText reads the projection, flattens and clamps it', () => {
    const doc = makeDoc();
    expect(captureTargetText(doc, 'n-1')).toBe('First paragraph.');
    expect(captureTargetText(doc, 'n-gone')).toBe('');
    expect(captureTargetText(null, 'n-1')).toBe('');

    doc.nodes[0] = { id: 'n-1', type: 'paragraph', version: 3, content: `  a\n b  ${'x'.repeat(400)}` };
    const captured = captureTargetText(doc, 'n-1');
    expect(captured.length).toBe(TARGET_TEXT_MAX);
    expect(captured.startsWith('a b x')).toBe(true);
  });

  it('the trailer key is a plain lower-case token — task 5.1 carries it untouched', () => {
    expect(COLLAB_TARGET_TEXT_KEY).toBe('text');
    expect(COLLAB_TARGET_TEXT_KEY).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
  });

  it('collabNodeVersion reports the projection, or null', () => {
    const doc = makeDoc();
    expect(collabNodeVersion(doc, 'n-1')).toBe(3);
    expect(collabNodeVersion(doc, 'n-gone')).toBeNull();
    expect(collabNodeVersion(null, 'n-1')).toBeNull();
  });
});

describe('R-6.5 — manual re-anchoring', () => {
  it('moves an orphaned anchor onto a chosen block, at that block’s current version', () => {
    const doc = makeDoc();
    const orphaned: CollaborationAnchor = {
      nodeId: 'n-gone',
      nodeVersion: 2,
      github: { ...github, issueCommentId: 42 },
      note: 'unknown field', // R-1.8
    };
    const next = reanchorCollabAnchor(orphaned, doc, 'n-2');
    expect(next).toEqual({
      nodeId: 'n-2',
      nodeVersion: 1,
      github: { ...github, issueCommentId: 42 },
      note: 'unknown field',
    });
    // …and the result resolves exactly, which is the whole point of the operation.
    const r = resolveCollabAnchor({ documentId: 'doc-1', nodeId: next?.nodeId ?? '', nodeVersion: next?.nodeVersion }, doc);
    expect(r.state).toBe('exact');
  });

  it('refuses a target that does not resolve, rather than making a fresh orphan', () => {
    const doc = makeDoc();
    expect(reanchorCollabAnchor(anchor('n-gone', 2), doc, 'n-also-gone')).toBeNull();
    expect(reanchorCollabAnchor(anchor('n-gone', 2), doc, '')).toBeNull();
    expect(reanchorCollabAnchor(anchor('n-gone', 2), null, 'n-1')).toBeNull();
  });

  it('refuses a target the projection has no version for — it could never be compared', () => {
    const doc = makeDoc();
    doc.nodes = doc.nodes.filter((n) => n.id !== 'n-2');
    expect(reanchorCollabAnchor(anchor('n-gone', 2), doc, 'n-2')).toBeNull();
  });

  it('does not mutate the anchor it was given', () => {
    const doc = makeDoc();
    const original = anchor('n-gone', 2);
    reanchorCollabAnchor(original, doc, 'n-1');
    expect(original).toEqual({ nodeId: 'n-gone', nodeVersion: 2, github });
  });
});

describe('R-6.6 — local resolution is not involved', () => {
  it('does not reach ui/anchor-resolver, and reuses task 3.1’s resolver rather than adding one', () => {
    const source = readModuleSource('anchor-resolution.ts');
    expect(source).not.toContain('anchor-resolver');
    expect(source).not.toContain('resolveMarkdownAnchors');
    expect(source).toContain('resolveNodeIn');
  });
});

/** Module source with block comments stripped — prose about the deleted rungs is not a rung. */
function readModuleSource(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, file), 'utf8').replace(/\/\*[^]*?\*\//g, '');
}
