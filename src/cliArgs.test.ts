import { describe, expect, it } from 'vitest';

import { parseArgs } from './cliArgs';

describe('parseArgs — globals', () => {
  it('defaults to the single-workspace run', () => {
    const p = parseArgs(['run', 'pnpm', 'test']);
    expect(p.ref).toBeUndefined();
    expect(p.returnFlow).toBe(false);
    expect(p.rest).toEqual(['run', 'pnpm', 'test']);
  });

  it('strips globals from the remote argv', () => {
    // Everything after "run" becomes argv on the remote, so a global that leaked through would be
    // handed to pnpm.
    const p = parseArgs([
      '--yes',
      'run',
      '--ref',
      'feat/a',
      '--return-flow',
      'pnpm',
      'validate',
    ]);
    expect(p.rest).toEqual(['run', 'pnpm', 'validate']);
    expect(p.ref).toBe('feat/a');
    expect(p.returnFlow).toBe(true);
    expect(p.autoYes).toBe(true);
  });

  it('requires a value for each value-taking flag', () => {
    expect(() => parseArgs(['run', '--ref'])).toThrow(/--ref requires/);
    expect(() => parseArgs(['--pm'])).toThrow(/--pm requires/);
  });

  it('rejects a following flag as a value', () => {
    expect(() => parseArgs(['run', '--ref', '--yes'])).toThrow(/--ref requires/);
  });

  it('leaves an unrelated flag for the remote', () => {
    const p = parseArgs(['run', 'pnpm', 'test', '--changed']);
    expect(p.rest).toEqual(['run', 'pnpm', 'test', '--changed']);
  });
});
