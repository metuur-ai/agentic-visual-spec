/**
 * github-executor.ts — the one process seam every GitHub call goes through.
 *
 * R-4.1 / R-4.2: there is no HTTP or GraphQL client in this package. Every GitHub
 * operation is a `gh api` invocation, so auth, rate limiting and retries stay the
 * CLI's problem. R-4.8 / R-12.3: the spawn is injectable, mirroring the
 * `spawnClaude` seam in `core/vite/routes/apply.ts` — tests replay recorded
 * `gh api` responses instead of touching the network.
 *
 * The executor is deliberately *buffered*: it hands back stdout/stderr/exit code
 * and nothing else. Response headers are not observable, which is why the adapter
 * paginates with an explicit `page=` loop rather than by following `Link`
 * (see `github-adapter.ts`).
 *
 * `core/` is Node-reachable from the CLI, so this module imports only node
 * builtins — no Luthor, no react.
 */
import { spawn } from 'node:child_process';

/** Everything the adapter is allowed to observe about a `gh` run. */
export interface GhResult {
  stdout: string;
  stderr: string;
  /** `null` when `gh` could not be executed at all (not on PATH, spawn failed). */
  exitCode: number | null;
}

/**
 * Run `gh` with `args`, optionally writing `input` to its stdin. Never rejects:
 * a failed spawn is reported as `exitCode: null` so the adapter can classify it
 * as an unavailable execution path (R-4.10) rather than an operation failure.
 */
export type GhExecutor = (args: string[], input?: string) => Promise<GhResult>;

/** Spawn the real `gh` CLI. Auth rides on the CLI itself; no token is read here. */
export const defaultExecGh: GhExecutor = (args, input) =>
  new Promise<GhResult>((resolve) => {
    const child = spawn('gh', args, {
      env: process.env,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err: Error) => resolve({ stdout, stderr: err.message, exitCode: null }));
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });

/**
 * Token-shaped material that must never reach a log, an SSE frame or an error
 * message (R-4.9). `gh` echoes request context into stderr on some failures, so
 * everything coming back from the process is scrubbed before it is surfaced.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g, // classic PATs: ghp_, gho_, ghu_, ghs_, ghr_
  /github_pat_[A-Za-z0-9_]{16,}/g, // fine-grained PATs
  /\bBearer\s+\S+/gi,
  /\btoken\s+\S+/gi,
  /Authorization:\s*\S+/gi,
];

/** Replace anything token-shaped with a fixed marker. */
export function scrubCredentials(text: string): string {
  let out = text;
  for (const re of CREDENTIAL_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}
