/**
 * cli-args.test.ts — the positional scanner behind `visual-spec <dir>` and
 * `visual-spec init <dir>`.
 *
 * The defect being pinned: scanning for "the first token that does not start with -"
 * picks up the value of a preceding flag, so `visual-spec --repo acme/docs` served the
 * directory `acme/docs` and `visual-spec --port 5180` served `5180`.
 */
import { describe, expect, it } from 'vitest';
import { INIT_VALUE_FLAGS, SERVE_VALUE_FLAGS, firstPositional, positionalArgs } from './cli-args';

describe('positionalArgs', () => {
  it('returns non-flag tokens unchanged when no flags are present', () => {
    expect(positionalArgs([], SERVE_VALUE_FLAGS)).toEqual([]);
    expect(positionalArgs(['.'], SERVE_VALUE_FLAGS)).toEqual(['.']);
    expect(positionalArgs(['/some/dir'], SERVE_VALUE_FLAGS)).toEqual(['/some/dir']);
    expect(positionalArgs(['a', 'b'], SERVE_VALUE_FLAGS)).toEqual(['a', 'b']);
  });

  it('treats a value that itself looks like a flag as a value, matching flag()', () => {
    // `flag()` reads args[i + 1] blindly, so `--repo --port` gives --repo the value
    // "--port"; the scanner must consume the same token, not resurrect it as a flag.
    expect(positionalArgs(['--repo', '--port'], SERVE_VALUE_FLAGS)).toEqual([]);
  });

  it('does not understand --flag=value (neither does flag()), so the token is just a flag', () => {
    expect(positionalArgs(['--repo=acme/docs'], SERVE_VALUE_FLAGS)).toEqual([]);
  });
});

describe('firstPositional — serve (`visual-spec <dir>`)', () => {
  for (const [valueFlag, value] of [
    ['--port', '5180'],
    ['--assets-dir', 'images'],
    ['--repo', 'acme/docs'],
    ['--base-branch', 'release'],
  ] as const) {
    it(`does not mistake the value of ${valueFlag} for the directory`, () => {
      expect(firstPositional([valueFlag, value], SERVE_VALUE_FLAGS)).toBeUndefined();
    });

    it(`still finds an explicit directory given after ${valueFlag}`, () => {
      expect(firstPositional([valueFlag, value, 'docs'], SERVE_VALUE_FLAGS)).toBe('docs');
    });
  }

  it('every serve value flag is covered by the cases above', () => {
    expect([...SERVE_VALUE_FLAGS].sort()).toEqual(['--assets-dir', '--base-branch', '--port', '--repo']);
  });

  it('an explicit directory before the flags still wins', () => {
    expect(firstPositional(['.', '--repo', 'acme/docs'], SERVE_VALUE_FLAGS)).toBe('.');
    expect(firstPositional(['/some/dir', '--port', '5180', '--no-open'], SERVE_VALUE_FLAGS)).toBe('/some/dir');
  });

  it('defaults to nothing (caller substitutes ".") when only flags are given', () => {
    expect(firstPositional(['--repo', 'acme/docs', '--base-branch', 'release', '--no-open'], SERVE_VALUE_FLAGS)).toBeUndefined();
    expect(firstPositional(['--no-open'], SERVE_VALUE_FLAGS)).toBeUndefined();
  });

  it('boolean flags do not swallow the next token', () => {
    expect(firstPositional(['--no-open', 'docs'], SERVE_VALUE_FLAGS)).toBe('docs');
    expect(firstPositional(['--no-open', '--repo', 'acme/docs', 'docs'], SERVE_VALUE_FLAGS)).toBe('docs');
  });

  it('unchanged for the plain invocations', () => {
    expect(firstPositional(['.'], SERVE_VALUE_FLAGS)).toBe('.');
    expect(firstPositional(['/some/dir'], SERVE_VALUE_FLAGS)).toBe('/some/dir');
    expect(firstPositional([], SERVE_VALUE_FLAGS)).toBeUndefined();
  });
});

describe('firstPositional — init (`visual-spec init <dir>`)', () => {
  it('does not mistake the value of --name for the target directory', () => {
    expect(firstPositional(['--name', 'my-pkg'], INIT_VALUE_FLAGS)).toBeUndefined();
  });

  it('finds the directory whichever side of --name it sits on', () => {
    expect(firstPositional(['--name', 'my-pkg', 'surface'], INIT_VALUE_FLAGS)).toBe('surface');
    expect(firstPositional(['surface', '--name', 'my-pkg'], INIT_VALUE_FLAGS)).toBe('surface');
  });

  it('every init value flag is covered by the cases above', () => {
    expect([...INIT_VALUE_FLAGS]).toEqual(['--name']);
  });
});
