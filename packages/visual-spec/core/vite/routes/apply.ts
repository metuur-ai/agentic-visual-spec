/**
 * routes/apply.ts — the shared "apply comments" job + its HTTP surface.
 *
 * Applying comments is a SINGLE server-side job, not something a browser tab
 * owns. Every tab pointed at the same directory subscribes to the same live
 * activity stream, can start a run (when none is in flight), and can cancel it —
 * so two browsers on the same path watch the exact same activity. The run drives
 * the apply-comments skill headlessly via `claude -p … --output-format
 * stream-json`; claude (through the skill) edits the artifacts and flips each
 * comment's status to "applied". This module owns the process, the broadcast,
 * and the audit of what changed.
 *
 *   GET  /__vs/apply/events  → text/event-stream: a `sync` snapshot, then live frames
 *   POST /__vs/apply/start   → begin a run (409 if one is already running)
 *   POST /__vs/apply/cancel  → SIGKILL the running claude
 *   GET  /__vs/apply         → { running, startedAt } status snapshot
 */
import { spawn } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import { buildApplyPrompt } from '../../editing/apply-prompt';
import type { CommentDocStore } from './comments';

/** Category of a streamed activity row — drives the icon + styling in the UI. */
export type ApplyLogKind = 'system' | 'tool' | 'assistant' | 'result' | 'error';

/** A comment that flipped to "applied" during a run — shown in the result modal. */
export type AppliedComment = { id: string; path: string; comment: string; workflow: string };

/** A frame pushed to subscribers as it happens. */
export type ApplyEvent =
  | { type: 'start'; openCount: number; startedAt: number }
  | { type: 'log'; kind: ApplyLogKind; text?: string; tool?: string; target?: string; agentId?: string }
  | { type: 'agent-start'; agentId: string; agentType: string; task?: string }
  | { type: 'agent-done'; agentId: string }
  | { type: 'done'; ok: boolean; applied: number; appliedComments: AppliedComment[]; exitCode: number | null; cancelled?: boolean }
  | { type: 'error'; message: string };

/** The first frame a subscriber receives: the run so far, so a tab that joins
 *  mid-run (or after) catches up to the same activity + timer. */
export type ApplySync = { type: 'sync'; running: boolean; startedAt: number | null; events: ApplyEvent[] };

/** A run that hangs holds the apply lock forever — bound it. Generous: a real
 *  batch (many comments, sub-agents, a headless cold start) legitimately runs
 *  past five minutes, so give it room before SIGKILL. */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/** Minimal child-process shape used here — lets tests inject a fake. */
export interface ClaudeChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  /** Kill on timeout / cancel. Optional so test fakes need not implement it. */
  kill?(signal?: NodeJS.Signals): void;
}

export type ClaudeSpawn = (prompt: string, cwd: string) => ClaudeChild;

export interface ApplyDeps {
  /** Directory claude runs in — the project root, where the sidecar + skill live. */
  cwd: string;
  comments: CommentDocStore;
  /** Override the spawn for tests; defaults to the real `claude` CLI. */
  spawnClaude?: ClaudeSpawn;
  /** Hard ceiling before the child is SIGKILLed (default 5 min). */
  timeoutMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

/**
 * Spawn the real Claude Code CLI in headless print mode, streaming JSON events.
 * stdin is ignored (print mode takes the prompt as an arg — never let claude
 * block waiting on stdin). Auth rides on the CLI itself; no API key here.
 */
export const defaultSpawnClaude: ClaudeSpawn = (prompt, cwd) =>
  spawn(
    'claude',
    ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--add-dir', cwd],
    { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );

/** Turn one stream-json line into zero or more structured activity frames. */
export function summarize(line: string): ApplyEvent[] {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return []; // partial / non-JSON line
  }
  if (ev.type === 'system' && ev.subtype === 'init') return [{ type: 'log', kind: 'system', text: 'Session started' }];
  if (ev.type === 'assistant') {
    // Sub-agent events carry `parent_tool_use_id` pointing at the Task that spawned
    // them — attribute their rows so the UI can group sub-agent activity.
    const agentId = typeof ev.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : undefined;
    const content = (ev.message as { content?: unknown[] } | undefined)?.content ?? [];
    const out: ApplyEvent[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ type: 'log', kind: 'assistant', text: block.text.trim().slice(0, 2000), ...(agentId ? { agentId } : {}) });
      } else if (block.type === 'tool_use') {
        const input = (block.input ?? {}) as Record<string, unknown>;
        // A Task spawns a sub-agent — surface it as an agent lane, not a plain row.
        if (block.name === 'Task') {
          out.push({
            type: 'agent-start',
            agentId: String(block.id ?? input.subagent_type ?? 'agent'),
            agentType: String(input.subagent_type ?? 'agent'),
            ...(input.description ? { task: String(input.description).slice(0, 200) } : {}),
          });
          continue;
        }
        const tool = String(block.name ?? 'tool');
        const raw = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.description;
        const target = raw ? String(raw).slice(0, 300) : undefined;
        out.push({ type: 'log', kind: 'tool', tool, ...(target ? { target } : {}), ...(agentId ? { agentId } : {}) });
      }
    }
    return out;
  }
  // A tool_result closes its tool_use; for a Task id this ends the sub-agent. We emit
  // agent-done for every result and let the consumer ignore ids it isn't tracking.
  if (ev.type === 'user') {
    const content = (ev.message as { content?: unknown[] } | undefined)?.content ?? [];
    const out: ApplyEvent[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        out.push({ type: 'agent-done', agentId: block.tool_use_id });
      }
    }
    return out;
  }
  if (ev.type === 'result' && typeof ev.result === 'string' && ev.result.trim()) {
    return [{ type: 'log', kind: 'result', text: ev.result.trim().slice(0, 4000) }];
  }
  return [];
}

/**
 * Run the apply once, emitting events as they happen. Resolves when the child
 * exits. `signal` cancels the run (SIGKILL). Never throws for an empty comment
 * set — emits a no-op `done` instead.
 */
export async function runApply(deps: ApplyDeps, emit: (e: ApplyEvent) => void, signal?: AbortSignal, ids?: string[]): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const before = await deps.comments.read();
  // `ids` scopes the run (a subset of open comments the user picked); absent → all open.
  // Everything downstream — prompt, openCount, applied diff — derives from this set.
  const wanted = ids ? new Set(ids) : null;
  const open = before.comments.filter((c) => c.status === 'open' && (!wanted || wanted.has(c.id)));
  if (open.length === 0) {
    emit({ type: 'done', ok: true, applied: 0, appliedComments: [], exitCode: 0 });
    return;
  }
  emit({ type: 'start', openCount: open.length, startedAt: now() });

  const spawnClaude = deps.spawnClaude ?? defaultSpawnClaude;
  let child: ClaudeChild;
  try {
    child = spawnClaude(buildApplyPrompt(open), deps.cwd);
  } catch (err) {
    emit({ type: 'error', message: `Could not start claude: ${(err as Error).message}` });
    emit({ type: 'done', ok: false, applied: 0, appliedComments: [], exitCode: null });
    return;
  }

  let buf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: streaming line split
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      for (const frame of summarize(line)) emit(frame);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (text) emit({ type: 'log', kind: 'error', text: text.slice(0, 1000) });
  });

  let cancelled = false;
  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      emit({ type: 'error', message: `claude timed out after ${Math.round((deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s` });
      child.kill?.('SIGKILL');
    }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => {
      cancelled = true;
      emit({ type: 'log', kind: 'system', text: 'Cancelling…' });
      child.kill?.('SIGKILL');
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      emit({ type: 'error', message: err.message.includes('ENOENT') ? 'claude CLI not found on PATH' : err.message });
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(code);
    });
  });

  // Re-read the sidecar: the skill flipped applied comments to status "applied".
  const after = await deps.comments.read();
  const stillOpen = new Set(after.comments.filter((c) => c.status === 'open').map((c) => c.id));
  const appliedComments: AppliedComment[] = open
    .filter((c) => !stillOpen.has(c.id))
    .map((c) => ({ id: c.id, path: c.target.path, comment: c.comment, workflow: c.workflow }));
  emit({ type: 'done', ok: !cancelled && exitCode === 0, applied: appliedComments.length, appliedComments, exitCode, ...(cancelled ? { cancelled } : {}) });
}

export type RouteResult = { status: number; json: unknown };

/** The shared job: one run at a time, many subscribers, replayable history. */
export interface ApplyHub {
  /** Attach an SSE subscriber (writes headers + a `sync` snapshot, then streams). */
  subscribe(res: ServerResponse): void;
  /** Begin a run. `ids` scopes it to a subset of open comments; omit for all open. */
  start(ids?: string[]): RouteResult;
  cancel(): RouteResult;
  status(): RouteResult;
}

/**
 * Build the hub. `getDeps` is a thunk so the hub always runs against the current
 * directory even after a runtime "change directory" (the deps are mutable lets).
 */
export function createApplyHub(getDeps: () => ApplyDeps): ApplyHub {
  let events: ApplyEvent[] = []; // the current/last run — replayed to new subscribers
  let running = false;
  let startedAt: number | null = null;
  let abort: AbortController | null = null;
  const subs = new Set<ServerResponse>();

  const frame = (res: ServerResponse, f: ApplyEvent | ApplySync) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(f)}\n\n`);
  };
  const broadcast = (e: ApplyEvent) => {
    if (e.type === 'start') startedAt = e.startedAt;
    events.push(e);
    for (const res of subs) frame(res, e);
  };

  return {
    subscribe(res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      frame(res, { type: 'sync', running, startedAt, events });
      subs.add(res);
      res.on('close', () => subs.delete(res));
    },
    start(ids) {
      if (running) return { status: 409, json: { error: 'an apply is already running' } };
      running = true;
      events = [];
      startedAt = null;
      abort = new AbortController();
      void runApply(getDeps(), broadcast, abort.signal, ids)
        .catch((err) => {
          broadcast({ type: 'error', message: (err as Error).message });
          broadcast({ type: 'done', ok: false, applied: 0, appliedComments: [], exitCode: null });
        })
        .finally(() => {
          running = false;
          abort = null;
        });
      return { status: 200, json: { ok: true } };
    },
    cancel() {
      if (!running || !abort) return { status: 409, json: { error: 'nothing to cancel' } };
      abort.abort();
      return { status: 200, json: { ok: true } };
    },
    status() {
      return { status: 200, json: { running, startedAt } };
    },
  };
}
