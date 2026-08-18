import { describe, expect, it } from 'vitest';

import { parseArgs } from './cliArgs';

describe('parseArgs — lane globals', () => {
  it('defaults to the single-workspace run', () => {
    const p = parseArgs(['run', 'pnpm', 'test']);
    expect(p.lane).toBeUndefined();
    expect(p.lanes).toBeUndefined();
    expect(p.ref).toBeUndefined();
    expect(p.returnFlow).toBe(false);
    expect(p.rest).toEqual(['run', 'pnpm', 'test']);
  });

  it('strips lane globals from the remote argv', () => {
    // Everything after "run" becomes argv on the remote, so a global that leaked through would be
    // handed to pnpm.
    const p = parseArgs([
      '--yes',
      'run',
      '--lane',
      'auto',
      '--lanes',
      '6',
      '--ref',
      'feat/a',
      '--return-flow',
      'pnpm',
      'validate',
    ]);
    expect(p.rest).toEqual(['run', 'pnpm', 'validate']);
    expect(p.lane).toBe('auto');
    expect(p.lanes).toBe(6);
    expect(p.ref).toBe('feat/a');
    expect(p.returnFlow).toBe(true);
    expect(p.autoYes).toBe(true);
  });

  it('accepts a named lane', () => {
    expect(parseArgs(['run', '--lane', '2', 'pnpm', 'test']).lane).toBe('2');
  });

  it('requires a value for each value-taking flag', () => {
    expect(() => parseArgs(['run', '--lane'])).toThrow(/--lane requires/);
    expect(() => parseArgs(['run', '--lanes'])).toThrow(/--lanes requires/);
    expect(() => parseArgs(['run', '--ref'])).toThrow(/--ref requires/);
    expect(() => parseArgs(['--pm'])).toThrow(/--pm requires/);
  });

  it('rejects a following flag as a value', () => {
    expect(() => parseArgs(['run', '--lane', '--yes'])).toThrow(/--lane requires/);
  });

  it('rejects a non-integer pool size', () => {
    expect(() => parseArgs(['run', '--lanes', 'many'])).toThrow(/--lanes requires/);
    expect(() => parseArgs(['run', '--lanes', '2.5'])).toThrow(/--lanes requires/);
  });

  it('leaves an unrelated flag for the remote', () => {
    const p = parseArgs(['run', 'pnpm', 'test', '--changed']);
    expect(p.rest).toEqual(['run', 'pnpm', 'test', '--changed']);
  });
});
