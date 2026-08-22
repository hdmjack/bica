import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildGeneratedProbeScript,
  isNegatedGeneratedPath,
  parseMissing,
  validateGeneratedPath,
} from './generatedPaths';

let ws: string;

/** Run the probe against a real directory, exactly as the remote shell would. */
function probe(paths: readonly string[]): string[] {
  const r = spawnSync('/bin/sh', ['-s'], {
    input: buildGeneratedProbeScript(ws, paths),
    encoding: 'utf8',
    shell: false,
  });
  expect(r.status).toBe(0);
  return parseMissing(r.stdout ?? '');
}

function touch(rel: string): void {
  const f = path.join(ws, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '');
}

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-generated-'));
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('the probe, executed against a real workspace', () => {
  it('reports nothing when every declared path is present', () => {
    touch('ui/src/icons/essentials/IconActivity.tsx');
    expect(probe(['ui/src/icons/essentials/Icon*.tsx'])).toEqual([]);
  });

  it('reports a glob that matches nothing', () => {
    // The worktree case: the directory may even exist, with only the tracked files in it.
    touch('ui/src/icons/essentials/IconSpinner.tsx.keep');
    expect(probe(['ui/src/icons/essentials/Icon*.tsx'])).toEqual([
      'ui/src/icons/essentials/Icon*.tsx',
    ]);
  });

  it('reports a plain path that does not exist', () => {
    expect(probe(['ui/generated/manifest.json'])).toEqual([
      'ui/generated/manifest.json',
    ]);
  });

  it('reports a missing path whose parent directory is absent entirely', () => {
    expect(probe(['nowhere/at/all/*.ts'])).toEqual(['nowhere/at/all/*.ts']);
  });

  it('checks each declaration independently', () => {
    touch('a/present.txt');
    expect(probe(['a/present.txt', 'b/absent.txt', 'c/*.js'])).toEqual([
      'b/absent.txt',
      'c/*.js',
    ]);
  });

  it('treats a directory as present', () => {
    fs.mkdirSync(path.join(ws, 'generated'), { recursive: true });
    expect(probe(['generated'])).toEqual([]);
  });

  it('reports nothing when nothing is declared', () => {
    expect(probe([])).toEqual([]);
  });

  it('does not fail the run when the workspace does not exist yet', () => {
    // A workspace about to be created is not evidence of missing output, and the probe must not
    // turn that into a forced install or a hard error.
    const gone = path.join(ws, 'not-created');
    const r = spawnSync('/bin/sh', ['-s'], {
      input: buildGeneratedProbeScript(gone, ['x/*.ts']),
      encoding: 'utf8',
      shell: false,
    });
    expect(r.status).toBe(0);
    expect(parseMissing(r.stdout ?? '')).toEqual([]);
  });
});

describe('validateGeneratedPath', () => {
  it('accepts a relative path with globs', () => {
    expect(validateGeneratedPath('ui/src/icons/essentials/Icon*.tsx')).toBe(
      'ui/src/icons/essentials/Icon*.tsx',
    );
  });

  it('accepts character classes and single-character globs', () => {
    expect(validateGeneratedPath('gen/v[0-9]/f?.ts')).toBe('gen/v[0-9]/f?.ts');
  });

  it('trims surrounding whitespace rather than rejecting it', () => {
    expect(validateGeneratedPath('  a/b.ts  ')).toBe('a/b.ts');
  });

  it('refuses an absolute path', () => {
    expect(() => validateGeneratedPath('/etc/passwd')).toThrow(/relative/);
  });

  it('refuses a home-relative path', () => {
    expect(() => validateGeneratedPath('~/x')).toThrow(/relative/);
  });

  it('refuses traversal out of the workspace', () => {
    expect(() => validateGeneratedPath('../../etc/passwd')).toThrow(/\.\./);
  });

  it('refuses a path that only contains traversal mid-way', () => {
    expect(() => validateGeneratedPath('ui/../../x')).toThrow(/\.\./);
  });

  it('refuses an empty entry', () => {
    expect(() => validateGeneratedPath('   ')).toThrow(/non-empty/);
  });

  it.each([
    ['a b.ts', 'whitespace'],
    ["a';touch pwned;'", 'quote and semicolon'],
    ['a$(touch pwned)', 'command substitution'],
    ['a`touch pwned`', 'backticks'],
    ['a;touch pwned', 'semicolon'],
    ['a|b', 'pipe'],
    ['a&b', 'background'],
    ['a>b', 'redirect'],
    ['a\\b', 'backslash'],
  ])('refuses %s (%s), which the probe cannot quote around', (bad) => {
    expect(() => validateGeneratedPath(bad)).toThrow();
  });
});

describe('injection, executed rather than argued', () => {
  it('cannot run a command through a declared path', () => {
    // The pattern is single-quoted into a `find -path` argument, so a stray quote would end that
    // argument and the rest would be shell. If the validator ever regressed, the marker would appear.
    const marker = path.join(ws, 'PWNED');
    expect(() => buildGeneratedProbeScript(ws, [`x;touch ${marker}`])).toThrow();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('cannot escape the workspace through the path', () => {
    expect(() => buildGeneratedProbeScript(ws, ['../../../etc/passwd'])).toThrow();
  });
});

describe('parseMissing', () => {
  it('ignores blank lines and trims', () => {
    expect(parseMissing('a\n\n  b  \n')).toEqual(['a', 'b']);
  });

  it('returns nothing for empty output, which is the healthy case', () => {
    expect(parseMissing('')).toEqual([]);
  });
});

describe('negated declarations', () => {
  it('recognises a negation', () => {
    expect(isNegatedGeneratedPath('!IconSpinner*.tsx')).toBe(true);
    expect(isNegatedGeneratedPath('Icon*.tsx')).toBe(false);
  });

  it('validates the path inside a negation and keeps the marker', () => {
    expect(validateGeneratedPath('!ui/src/IconSpinner*.tsx')).toBe(
      '!ui/src/IconSpinner*.tsx',
    );
  });

  it('rejects a negation that escapes the workspace', () => {
    expect(() => validateGeneratedPath('!../../etc/passwd')).toThrow(/\.\./);
  });

  it('rejects a bare negation with nothing after it', () => {
    expect(() => validateGeneratedPath('!')).toThrow(/non-empty/);
  });

  it('is not probed for, since a negation declares something is NOT generated', () => {
    // The concrete failure this prevents: `Icon*.tsx` is generated but `IconSpinner*` is committed,
    // so probing for the negation would report a permanent, unfixable "missing".
    touch('ui/src/icons/essentials/IconActivity.tsx');
    expect(
      probe([
        'ui/src/icons/essentials/Icon*.tsx',
        '!ui/src/icons/essentials/IconSpinner*.tsx',
      ]),
    ).toEqual([]);
  });
});

describe('a negation must not satisfy the pattern it is carved out of', () => {
  it('still reports missing when only the negated file is present', () => {
    // The regression that shipped for one run: `IconSpinner.tsx` is committed and matches
    // `Icon*.tsx`, so its presence answered a question about 346 generated files it says nothing
    // about. A remote typecheck then failed with 192 errors and no repair was attempted.
    touch('ui/src/icons/essentials/IconSpinner.tsx');
    expect(
      probe([
        'ui/src/icons/essentials/Icon*.tsx',
        '!ui/src/icons/essentials/IconSpinner*.tsx',
      ]),
    ).toEqual(['ui/src/icons/essentials/Icon*.tsx']);
  });

  it('reports satisfied once a genuinely generated file appears alongside it', () => {
    touch('ui/src/icons/essentials/IconSpinner.tsx');
    touch('ui/src/icons/essentials/IconActivity.tsx');
    expect(
      probe([
        'ui/src/icons/essentials/Icon*.tsx',
        '!ui/src/icons/essentials/IconSpinner*.tsx',
      ]),
    ).toEqual([]);
  });
});
