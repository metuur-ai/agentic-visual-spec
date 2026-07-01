/**
 * native-pick.ts — open the OS-native "choose folder" dialog on the machine
 * running the server and resolve with the picked directory. Shared by the
 * production server (server.ts) and the Vite dev plugin (md-plugin.ts).
 *
 * Per-platform tool list is tried in order so a missing tool is skipped. A
 * genuine user cancel resolves as { cancelled: true }; any other non-zero exit
 * is surfaced as an error so it isn't silently swallowed. Only works where the
 * server shares a desktop session (i.e. local), not headless / over SSH.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

export type PickResult = { ok: true; path: string } | { ok: false; cancelled?: boolean; error?: string };

/**
 * Nearest existing directory at or above `dir`, falling back to $HOME. The
 * native pickers take a start/default location; passing one that doesn't exist
 * makes some of them (notably macOS `choose folder`) error out *before* showing
 * any dialog — which previously looked like "the button does nothing".
 */
function existingDir(dir: string): string {
  let d = dir;
  while (d && d !== dirname(d)) {
    try {
      if (statSync(d).isDirectory()) return d;
    } catch {
      /* keep walking up */
    }
    d = dirname(d);
  }
  return homedir();
}

/** Heuristic: does this stderr look like the user dismissing the dialog (vs a real failure)? */
function looksCancelled(stderr: string): boolean {
  // macOS AppleScript cancel is error -128 ("User canceled"); other tools print nothing on cancel.
  return stderr.trim() === '' || /-128|user cancell?ed|cancelled|canceled/i.test(stderr);
}

export function pickDirectoryNative(startDir: string): Promise<PickResult> {
  const platform = process.platform;
  const start = existingDir(startDir);
  const attempts: Array<{ cmd: string; args: string[] }> =
    platform === 'darwin'
      ? [{ cmd: 'osascript', args: ['-e', `POSIX path of (choose folder with prompt "Open a directory in Visual Specs" default location (POSIX file ${JSON.stringify(start)}))`] }]
      : platform === 'win32'
        ? [{ cmd: 'powershell', args: ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.SelectedPath = ${JSON.stringify(start)}; if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }`] }]
        : [
            { cmd: 'zenity', args: ['--file-selection', '--directory', '--title=Open a directory in Visual Specs', `--filename=${start.replace(/\/?$/, '/')}`] },
            { cmd: 'kdialog', args: ['--getexistingdirectory', start] },
          ];

  const run = (i: number): Promise<PickResult> =>
    new Promise((res) => {
      if (i >= attempts.length) return res({ ok: false, error: 'No native folder picker is available on this machine (tried the platform defaults).' });
      const { cmd, args } = attempts[i]!;
      const child = spawn(cmd, args);
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', () => void run(i + 1).then(res)); // command missing → try the next tool
      child.on('close', (code) => {
        const picked = out.trim().replace(/\/$/, '');
        if (code === 0 && picked) return res({ ok: true, path: picked });
        // Empty stdout: distinguish a user dismiss from a genuine failure so real
        // errors surface instead of masquerading as a silent "cancelled".
        if (looksCancelled(err)) return res({ ok: false, cancelled: true });
        res({ ok: false, error: `Folder picker failed (${cmd} exited ${code ?? 'null'}): ${err.trim() || 'no output'}` });
      });
    });

  return run(0);
}
