import { describe, expect, it } from 'vitest';

import { assignLabels, labelForArgv } from './parallelCommands';

describe('labelForArgv', () => {
  it('names a command by its first two words', () => {
    expect(labelForArgv(['pnpm', 'lint'])).toBe('pnpm-lint');
  });

  it('drops path arguments, which do not belong in a filename', () => {
    expect(labelForArgv(['pnpm', 'test:run', 'libs/src/acl'])).toBe(
      'pnpm-test-run',
    );
  });

  it('names the tool, not the runner that launched it', () => {
    // `pnpm-exec` tells a reader nothing, and two `pnpm exec` commands would collide on it.
    expect(labelForArgv(['pnpm', 'exec', 'eslint', 'libs/src'])).toBe('pnpm-eslint');
    expect(labelForArgv(['pnpm', 'run', 'lint'])).toBe('pnpm-lint');
  });

  it('produces something filename-safe from anything', () => {
    expect(labelForArgv(['sh', '-c', 'a | b > c'])).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(labelForArgv([])).toBe('cmd');
  });
});

describe('assignLabels', () => {
  it('keeps distinct commands distinct', () => {
    const out = assignLabels([['pnpm', 'lint'], ['pnpm', 'typecheck']]);
    expect(out.map((c) => c.label)).toEqual(['pnpm-lint', 'pnpm-typecheck']);
  });

  it('gives two pnpm exec commands distinct, meaningful labels', () => {
    const out = assignLabels([
      ['pnpm', 'exec', 'eslint', 'a'],
      ['pnpm', 'exec', 'tsc', '-p', 'b'],
    ]);
    expect(out.map((c) => c.label)).toEqual(['pnpm-eslint', 'pnpm-tsc']);
  });

  it('still disambiguates genuinely identical commands', () => {
    const out = assignLabels([['pnpm', 'lint'], ['pnpm', 'lint']]);
    expect(new Set(out.map((c) => c.label)).size).toBe(2);
  });
});
