/**
 * visual-spec — browse any directory in the browser and comment on files, line
 * ranges, and folders; an agent applies the comments via the bundled skills.
 *
 *   visual-spec <dir> [--port 5180] [--no-open]   start the browser on <dir> (default cmd)
 *   visual-spec init <dir> [--name <pkg>]         scaffold a new surface project
 *   visual-spec install-skills [--dest <dir>]     copy the agent skills (default ~/.claude/skills)
 *
 * Single self-contained binary: the engine (core) is bundled in, the UI ships
 * prebuilt as static assets, and the skills travel inside the package.
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVisualSpecServer } from './server';

const here = dirname(fileURLToPath(import.meta.url));
// dist/cli.js → assets sit next to it: dist/ui, dist/skills, dist/template.
const UI_DIR = resolve(here, 'ui');
const SKILLS_DIR = resolve(here, 'skills');
const TEMPLATE_DIR = resolve(here, 'template');

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
}

async function serve(args: string[]) {
  const target = args.find((a) => !a.startsWith('-')) ?? '.';
  const contentDir = isAbsolute(target) ? target : resolve(process.cwd(), target);
  if (!existsSync(contentDir)) {
    console.error(`Directory not found: ${contentDir}`);
    process.exit(1);
  }
  const requestedPort = Number(flag(args, '--port') ?? 5180);
  const explicitPort = args.includes('--port');
  const noOpen = args.includes('--no-open');

  const { server, commentsPath } = createVisualSpecServer({ contentDir, uiDir: UI_DIR, port: requestedPort });

  server.on('listening', () => {
    // The real bound port — differs from requestedPort after a port-0 fallback.
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : requestedPort;
    const url = `http://localhost:${port}`;
    console.log(`\n  visual-spec`);
    console.log(`  ➜  dir:      ${contentDir}`);
    console.log(`  ➜  comments: ${commentsPath}`);
    console.log(`  ➜  open:     ${url}\n`);
    if (!noOpen) openBrowser(url);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // An explicit --port is a hard request → fail loudly. Otherwise the
      // preferred port is taken, so let the OS hand us a guaranteed-free one
      // (listen on 0) rather than colliding or guessing.
      if (explicitPort) {
        console.error(`Port ${requestedPort} is already in use. Try a different --port.`);
        process.exit(1);
      }
      console.warn(`Port ${requestedPort} is in use — falling back to a free port…`);
      setTimeout(() => server.listen(0), 0);
      return;
    }
    console.error(`Server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(requestedPort);
}

async function init(args: string[]) {
  const target = args.find((a) => !a.startsWith('-'));
  if (!target) {
    console.error('Usage: visual-spec init <dir> [--name <pkg-name>]');
    process.exit(1);
  }
  const dest = resolve(process.cwd(), target);
  const pkgName = flag(args, '--name') ?? target.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  if (existsSync(dest) && (await readdir(dest)).length > 0) {
    console.error(`Refusing to scaffold into non-empty directory: ${dest}`);
    process.exit(1);
  }
  await cp(TEMPLATE_DIR, dest, { recursive: true });
  const pkgPath = join(dest, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { name?: string };
    pkg.name = pkgName;
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  }
  if (existsSync(SKILLS_DIR)) {
    await cp(SKILLS_DIR, join(dest, '.agents', 'skills'), { recursive: true });
  }
  console.log(`Scaffolded ${pkgName} at ${dest}`);
}

async function installSkills(args: string[]) {
  if (!existsSync(SKILLS_DIR)) {
    console.error('No skills bundled in this build — skills live in a separate repo. Nothing to install.');
    process.exit(1);
  }
  const dest = resolve(process.cwd(), flag(args, '--dest') ?? join(homedir(), '.claude', 'skills'));
  await mkdir(dest, { recursive: true });
  await cp(SKILLS_DIR, dest, { recursive: true });
  console.log(`Installed skills → ${dest}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'init') return init(rest);
  if (cmd === 'install-skills') return installSkills(rest);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`visual-spec — browse a directory in the browser and comment on files, line ranges, and folders

  visual-spec <dir> [--port 5180] [--no-open]   open the browser on a directory
  visual-spec init <dir> [--name <pkg>]         scaffold a new surface project
  visual-spec install-skills [--dest <dir>]     install the agent skills

  Filtering: a .visualspecignore at the directory root is honored (gitignore
  syntax). .git/, node_modules/, and the comments sidecar are always hidden;
  common build/dep/cache/secret cruft (dist/, target/, *.log, .env, …) is hidden
  by default — negate any default in .visualspecignore (e.g. !dist/).`);
    return;
  }
  // Default command: serve. `cmd` (if present and not a flag) is the directory.
  return serve(cmd ? [cmd, ...rest] : rest);
}

void main();
