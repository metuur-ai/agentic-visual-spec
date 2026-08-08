// @vitest-environment jsdom
/**
 * collab-editor.test.tsx — the author's edit surface (R-8.9 / R-8.12).
 *
 * The suite this replaces was written against a Lexical mount over a canonical
 * `JsonDocument`, and almost all of it pinned the *negative* space of dirty detection:
 * clicking into a paragraph, arrowing through it and clicking a pill all mark Lexical
 * nodes dirty without changing anything, so a naive `getJSON()` comparison reported an
 * edit nobody made. None of that risk exists once the buffer is a string — a caret has
 * no representation in it — so those tests describe a hazard that is gone rather than one
 * that is still guarded.
 *
 * What is worth pinning now is smaller and different: the publish payload must be the
 * buffer verbatim (R-8.12 — the server treats it as opaque bytes and verifies them, so a
 * client that normalized on the way out would break byte verification), and the dirty
 * verdict must track the baseline in both directions.
 *
 * CodeMirror is stubbed out rather than mounted: jsdom has no layout, and what is under
 * test is this module's buffer bookkeeping, not `@codemirror/view`.
 */
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CollaborationRecord } from '../core/collaboration/document-record';
import { CollabEditor, type CollabEditorHandle } from './collab-editor';

/** The last props `SourceEditor` was rendered with — the seam edits are driven through. */
const lastProps: { value: string; onChange: (next: string) => void }[] = [];

vi.mock('./source-editor', () => ({
  SourceEditor: (props: { value: string; onChange: (next: string) => void; onSave: () => void }) => {
    lastProps.push(props);
    return <textarea data-testid="source" readOnly value={props.value} />;
  },
}));

const MARKDOWN = '# Spec\n\nFirst paragraph.\n';

const record = (over: Partial<CollaborationRecord> = {}): CollaborationRecord => ({
  documentId: 'doc-1',
  documentPath: 'docs/spec.md',
  title: 'Spec',
  markdown: MARKDOWN,
  ...over,
});

function mount(doc = record()) {
  lastProps.length = 0;
  let handle: CollabEditorHandle | undefined;
  const dirtyTransitions: boolean[] = [];
  const emitted: string[] = [];
  render(
    <CollabEditor
      document={doc}
      onDirtyChange={(d) => dirtyTransitions.push(d)}
      onMarkdownChange={(md) => emitted.push(md)}
      onEditorReady={(h) => {
        handle = h;
      }}
    />,
  );
  const type = (next: string) =>
    act(() => {
      lastProps[lastProps.length - 1]!.onChange(next);
    });
  return { handle: handle as CollabEditorHandle, dirtyTransitions, emitted, type };
}

describe('the buffer is the document', () => {
  it('mounts with the record’s Markdown and reports nothing dirty', () => {
    const { handle, dirtyTransitions } = mount();
    expect(handle.readMarkdown()).toBe(MARKDOWN);
    expect(handle.isDirty()).toBe(false);
    // No transition at all — a load is not an edit.
    expect(dirtyTransitions).toEqual([]);
  });

  it('R-8.12 — publish hands back the buffer verbatim, with no second artifact', () => {
    const { handle, type } = mount();
    type('# Spec\n\nFirst paragraph, tightened.\n');
    expect(handle.publish()).toEqual({ markdown: '# Spec\n\nFirst paragraph, tightened.\n' });
  });

  it('does not normalize, reformat or re-parse what the author typed', () => {
    const ragged = '#   Spec\r\n\r\n\r\n*  a bullet   \n';
    const { handle, type } = mount();
    type(ragged);
    expect(handle.publish().markdown).toBe(ragged);
  });
});

describe('dirty tracking', () => {
  it('reports dirty on an edit, and only on the transition', () => {
    const { handle, dirtyTransitions, type } = mount();
    type(`${MARKDOWN}more\n`);
    type(`${MARKDOWN}more and more\n`);
    expect(handle.isDirty()).toBe(true);
    expect(dirtyTransitions).toEqual([true]);
  });

  it('an edit that restores the baseline is not an edit', () => {
    const { handle, dirtyTransitions, type } = mount();
    type(`${MARKDOWN}more\n`);
    type(MARKDOWN);
    expect(handle.isDirty()).toBe(false);
    expect(dirtyTransitions).toEqual([true, false]);
  });

  it('markClean adopts the current buffer, which is what a successful publish means', () => {
    const { handle, dirtyTransitions, type } = mount();
    type(`${MARKDOWN}published\n`);
    act(() => handle.markClean());
    expect(handle.isDirty()).toBe(false);
    expect(dirtyTransitions).toEqual([true, false]);
    // And the new baseline is the published text, not the one it was loaded with.
    act(() => {
      lastProps[lastProps.length - 1]!.onChange(MARKDOWN);
    });
    expect(handle.isDirty()).toBe(true);
  });

  it('emits every edit to the caller', () => {
    const { emitted, type } = mount();
    type('a');
    type('ab');
    expect(emitted).toEqual(['a', 'ab']);
  });
});

describe('a different document is a different buffer', () => {
  it('re-seeds and resets the dirty state when the document id changes', () => {
    lastProps.length = 0;
    let handle: CollabEditorHandle | undefined;
    const { rerender } = render(
      <CollabEditor
        document={record()}
        onEditorReady={(h) => {
          handle = h;
        }}
      />,
    );
    act(() => {
      lastProps[lastProps.length - 1]!.onChange(`${MARKDOWN}unsaved\n`);
    });
    expect(handle!.isDirty()).toBe(true);

    rerender(
      <CollabEditor
        document={record({ documentId: 'doc-2', markdown: '# Другой\n' })}
        onEditorReady={(h) => {
          handle = h;
        }}
      />,
    );
    expect(handle!.readMarkdown()).toBe('# Другой\n');
    expect(handle!.isDirty()).toBe(false);
  });
});
