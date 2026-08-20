import { describe, expect, it } from 'vitest';

import { splitOnDoubleDash } from './cli';

describe('splitOnDoubleDash', () => {
  it('treats a single command as one command', () => {
    expect(splitOnDoubleDash(['pnpm', 'test'])).toEqual([['pnpm', 'test']]);
  });

  it('splits several commands on --', () => {
    expect(
      splitOnDoubleDash(['pnpm', 'lint', '--', 'pnpm', 'typecheck']),
    ).toEqual([
      ['pnpm', 'lint'],
      ['pnpm', 'typecheck'],
    ]);
  });

  it('keeps flags that belong to a command', () => {
    expect(splitOnDoubleDash(['pnpm', 'test', '--coverage'])).toEqual([
      ['pnpm', 'test', '--coverage'],
    ]);
  });

  it('ignores empty segments from doubled or trailing separators', () => {
    expect(splitOnDoubleDash(['a', '--', '--', 'b', '--'])).toEqual([
      ['a'],
      ['b'],
    ]);
  });

  it('refuses the passthrough habit rather than failing confusingly on the remote', () => {
    // `-- --coverage` is muscle memory from tools where `--` means "rest goes to the inner command".
    // Here it means "a second command", and the remote reports `--coverage: command not found` (127),
    // which reads as a broken workspace rather than a misused separator.
    expect(() => splitOnDoubleDash(['pnpm', 'test', '--', '--coverage'])).toThrow(
      /cannot start a command/,
    );
  });

  it('tells the user both of the things they might have meant', () => {
    try {
      splitOnDoubleDash(['pnpm', 'test', '--', '--coverage']);
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('pnpm test --coverage');
      expect(msg).toContain('pnpm lint -- pnpm typecheck');
    }
  });

  it('allows a command whose later arguments are flags', () => {
    expect(
      splitOnDoubleDash(['pnpm', 'lint', '--fix', '--', 'pnpm', 'test', '-u']),
    ).toEqual([
      ['pnpm', 'lint', '--fix'],
      ['pnpm', 'test', '-u'],
    ]);
  });
});
