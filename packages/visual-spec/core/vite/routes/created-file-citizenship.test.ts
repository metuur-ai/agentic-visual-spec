/**
 * created-file-citizenship.test.ts — R-5.10. A file created from the tree must be
 * an ordinary citizen of the workspace, not a second-class one.
 *
 * The HLD names the apply flow as a stakeholder: a review comment can point at a
 * document that did not exist when the review started. A create that satisfied
 * every other requirement but produced a path the comment sidecar or the apply
 * prompt treated differently would miss the point entirely — so this drives the
 * real routes over a real temp directory, and ends at the open set the apply
 * prompt is built from.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommentDoc, CommentRecord } from '../../editing/comment-doc';
import { buildApplyPrompt } from '../../editing/apply-prompt';
import { treeStore } from '../tree-store';
import { type CommentDocStore, fileCommentStore, handleCommentsRequest } from './comments';
import { type FileWriteStore, handleFilesRequest } from './files';

let base: string;
let comments: CommentDocStore;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vs-citizen-'));
  comments = fileCommentStore(join(base, 'visual-spec-comments.json'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const writeStore = (): FileWriteStore => treeStore(base);

const create = (path: string) => handleFilesRequest(writeStore(), comments, 'POST', '/create', { path });

const addComment = (path: string, comment: string, id: string) =>
  handleCommentsRequest(comments, 'POST', '/add', {}, { path, kind: 'range', startLine: 1, snippet: '# ', comment, id });

const listFor = async (path: string) => (await handleCommentsRequest(comments, 'GET', '', { path }, {})).json as CommentRecord[];

describe('R-5.10 — comments against a created file, on the same terms as a pre-existing one', () => {
  it('accepts, stores and reads back a comment on a path that did not exist a moment ago', async () => {
    // The control: a file that was already on disk before anything was created.
    await writeFile(join(base, 'preexisting.md'), '# preexisting\n\n');

    const created = await create('notes/2026/kickoff');
    expect(created.status).toBe(200);
    expect((created.json as { path: string }).path).toBe('notes/2026/kickoff.md');
    expect(await readFile(join(base, 'notes/2026/kickoff.md'), 'utf8')).toBe('# kickoff\n\n');

    const onCreated = await addComment('notes/2026/kickoff.md', 'expand the goals section', 'c-created1');
    const onExisting = await addComment('preexisting.md', 'this one was always here', 'c-existing');
    expect(onCreated.status).toBe(200);
    expect(onExisting.status).toBe(onCreated.status);

    // Read back scoped to the created path: the same shape the pre-existing file gets.
    const scoped = await listFor('notes/2026/kickoff.md');
    expect(scoped.map((c) => c.id)).toEqual(['c-created1']);
    expect(scoped[0]).toMatchObject({
      workflow: 'visual-spec',
      status: 'open',
      comment: 'expand the goals section',
      target: { path: 'notes/2026/kickoff.md', kind: 'range', startLine: 1 },
    });
    // Scoping still discriminates — the created path is a path like any other.
    expect((await listFor('preexisting.md')).map((c) => c.id)).toEqual(['c-existing']);

    // It survived to the sidecar on disk, which is what the apply run reads.
    const sidecar = JSON.parse(await readFile(join(base, 'visual-spec-comments.json'), 'utf8')) as CommentDoc;
    expect(sidecar.comments.map((c) => c.target.path).sort()).toEqual(['notes/2026/kickoff.md', 'preexisting.md']);

    // And it reaches the apply prompt indistinguishably from the pre-existing file.
    const all = (await handleCommentsRequest(comments, 'GET', '/all', {}, {})).json as CommentDoc;
    const open = all.comments.filter((c) => c.status === 'open');
    const prompt = buildApplyPrompt(open);
    expect(prompt).toContain('Apply 2 review comment(s)');
    expect(prompt).toContain('File: notes/2026/kickoff.md');
    expect(prompt).toContain('File: preexisting.md');
  });
});
