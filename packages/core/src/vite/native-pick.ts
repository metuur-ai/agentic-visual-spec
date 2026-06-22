/**
 * native-pick.ts — open the OS-native "choose folder" dialog on the machine
 * running the server and resolve with the picked directory. Shared by the
 * production server (server.ts) and the Vite dev plugin (md-plugin.ts).
 *
 * Per-platform tool list is tried in order so a missing tool is skipped; a
 * non-zero exit with no stdout means the user cancelled. Only works where the
 * server shares a desktop session (i.e. local), not headless / over SSH.
 */
import { spawn } from 'node:child_process';

export type PickResult = { ok: true; path: string } | { ok: false; cancelled?: boolean; error?: string };

export function pickDirectoryNative(startDir: string): Promise<PickResult> {
  const platform = process.platform;
  const attempts: Array<{ cmd: string; args: string[] }> =
    platform === 'darwin'
      ? [{ cmd: 'osascript', args: ['-e', `POSIX path of (choose folder with prompt "Open a directory in Visual Specs" default location (POSIX file ${JSON.stringify(startDir)}))`] }]
      : platform === 'win32'
        ? [{ cmd: 'powershell', args: ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.SelectedPath = ${JSON.stringify(startDir)}; if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }`] }]
        : [
            { cmd: 'zenity', args: ['--file-selection', '--directory', '--title=Open a directory in Visual Specs', `--filename=${startDir.replace(/\/?$/, '/')}`] },
            { cmd: 'kdialog', args: ['--getexistingdirectory', startDir] },
          ];

  const run = (i: number): Promise<PickResult> =>
    new Promise((res) => {
      if (i >= attempts.length) return res({ ok: false, error: 'No native folder picker is available on this machine (tried the platform defaults).' });
      const { cmd, args } = attempts[i]!;
      const child = spawn(cmd, args);
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('error', () => void run(i + 1).then(res)); // command missing → try the next tool
      child.on('close', (code) => {
        const picked = out.trim().replace(/\/$/, '');
        if (code === 0 && picked) return res({ ok: true, path: picked });
        res({ ok: false, cancelled: true }); // non-zero / empty → user dismissed the dialog
      });
    });

  return run(0);
}
