/**
 * cli-args.ts — the positional-argument scanner shared by `src/cli.ts`.
 *
 * A naive `args.find((a) => !a.startsWith('-'))` takes the first non-dash token, which
 * is the *value* of a preceding value-taking flag whenever the positional is omitted:
 * `visual-spec --repo acme/docs` then tries to serve a directory called `acme/docs`.
 * Scanning with the flag table in hand skips those values.
 *
 * Deliberately no `--flag=value` support: `flag()` in the CLI does not understand that
 * form either, and one parser guessing differently from the other is how this class of
 * bug comes back.
 */

/** Flags of `visual-spec <dir>` (the default serve command) that consume the next token. */
export const SERVE_VALUE_FLAGS = ['--port', '--assets-dir', '--repo', '--base-branch'] as const;

/** Flags of `visual-spec init <dir>` that consume the next token. */
export const INIT_VALUE_FLAGS = ['--name'] as const;

/**
 * The tokens that are not flags and not the value of one, in order.
 *
 * With no flags present this is exactly `args.filter((a) => !a.startsWith('-'))`, so
 * `visual-spec .` and `visual-spec /some/dir` behave as they always have.
 */
export function positionalArgs(args: string[], valueFlags: readonly string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      // Skip the value unconditionally — `flag()` reads `args[i + 1]` whatever it
      // looks like, so a value that itself starts with `-` is still a value here.
      if (valueFlags.includes(arg)) i += 1;
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
}

/** The first positional, or `undefined` when the command was given none. */
export function firstPositional(args: string[], valueFlags: readonly string[]): string | undefined {
  return positionalArgs(args, valueFlags)[0];
}
