/**
 * routes/apply.ts — the /__vs/apply endpoint. Drives the apply-comments skill
 * headlessly: reads the open comments from the sidecar, builds the instruction,
 * spawns `claude -p … --output-format stream-json`, and streams a digest of the
 * run back to the browser over Server-Sent Events. Claude (via the skill) is what
 * edits the artifacts and flips each comment's status to "applied"; this route
 * just drives the process and reports what changed.
 *
 *   GET /__vs/apply  → text/event-stream of ApplyEvent JSON frames
 */
import { spawn } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import { buildApplyPrompt } from '../../editing/apply-prompt';
import type { CommentDocStore } from './comments';

/** A frame pushed to the browser as it happens. */
export type ApplyEvent =
  | { type: 'start'; openCount: number }
  | { type: 'log'; level: 'info' | 'tool' | 'assistant' | 'error'; text: string }
  | { type: 'done'; ok: boolean; applied: number; exitCode: number | null }
  | { type: 'error'; message: string };

/** A run that hangs holds the apply lock forever — bound it. Generous: applying
 *  a batch of comments can legitimately take a few minutes. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Minimal child-process shape used here — lets tests inject a fake. */
export interface ClaudeChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  /** Kill on timeout. Optional so test fakes need not implement it. */
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

/** Turn one stream-json line into a friendly log frame, or null to ignore it. */
export function summarize(line: string): ApplyEvent | null {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null; // partial / non-JSON line
  }
  if (ev.type === 'system' && ev.subtype === 'init') return { type: 'log', level: 'info', text: 'Session started…' };
  if (ev.type === 'assistant') {
    const content = (ev.message as { content?: unknown[] } | undefined)?.content ?? [];
    const out: string[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push(block.text.trim());
      } else if (block.type === 'tool_use') {
        const name = String(block.name ?? 'tool');
        const input = (block.input ?? {}) as Record<string, unknown>;
        const target = input.file_path ?? input.path ?? input.command ?? '';
        out.push(`→ ${name}${target ? ` ${String(target)}` : ''}`);
      }
    }
    const text = out.join('\n').slice(0, 2000);
    return text ? { type: 'log', level: 'assistant', text } : null;
  }
  if (ev.type === 'result' && typeof ev.result === 'string' && ev.result.trim()) {
    return { type: 'log', level: 'assistant', text: ev.result.trim().slice(0, 4000) };
  }
  return null;
}

/**
 * Run the apply once, emitting events as they happen. Resolves when the child
 * exits. Never throws for an empty comment set — emits a no-op `done` instead.
 */
export async function runApply(deps: ApplyDeps, emit: (e: ApplyEvent) => void): Promise<void> {
  const before = await deps.comments.read();
  const open = before.comments.filter((c) => c.status === 'open');
  if (open.length === 0) {
    emit({ type: 'done', ok: true, applied: 0, exitCode: 0 });
    return;
  }
  emit({ type: 'start', openCount: open.length });

  const spawnClaude = deps.spawnClaude ?? defaultSpawnClaude;
  let child: ClaudeChild;
  try {
    child = spawnClaude(buildApplyPrompt(open), deps.cwd);
  } catch (err) {
    emit({ type: 'error', message: `Could not start claude: ${(err as Error).message}` });
    emit({ type: 'done', ok: false, applied: 0, exitCode: null });
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
      const frame = summarize(line);
      if (frame) emit(frame);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (text) emit({ type: 'log', level: 'error', text: text.slice(0, 1000) });
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      emit({ type: 'error', message: `claude timed out after ${Math.round((deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s` });
      child.kill?.('SIGKILL');
    }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      emit({ type: 'error', message: err.message.includes('ENOENT') ? 'claude CLI not found on PATH' : err.message });
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  // Re-read the sidecar: the skill flipped applied comments to status "applied".
  const after = await deps.comments.read();
  const stillOpen = new Set(after.comments.filter((c) => c.status === 'open').map((c) => c.id));
  const applied = open.filter((c) => !stillOpen.has(c.id)).length;
  emit({ type: 'done', ok: exitCode === 0, applied, exitCode });
}

/** SSE adapter: stream a single apply run to `res` as `data:` frames. */
export async function serveApply(deps: ApplyDeps, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const write = (e: ApplyEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  try {
    await runApply(deps, write);
  } catch (err) {
    write({ type: 'error', message: (err as Error).message });
    write({ type: 'done', ok: false, applied: 0, exitCode: null });
  } finally {
    res.end();
  }
}
