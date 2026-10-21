import { describe, expect, it } from 'vitest';

import {
  PARALLEL_SEPARATOR,
  joinCommandsForDisplay,
  looksLikeOldParallelForm,
  splitParallelCommands,
} from './commandSeparator';

describe('splitParallelCommands', () => {
  it('leaves one command alone', () => {
    expect(splitParallelCommands(['pnpm', 'test'])).toEqual([['pnpm', 'test']]);
  });

  it('splits on --also, not on --', () => {
    expect(
      splitParallelCommands(['pnpm', 'lint', PARALLEL_SEPARATOR, 'pnpm', 'typecheck']),
    ).toEqual([
      ['pnpm', 'lint'],
      ['pnpm', 'typecheck'],
    ]);
  });

  it('hands `--` to the program, which is what it means everywhere else', () => {
    // The bug this file exists for: bica ran `cargo run --release -p worldgen-preview` with no
    // arguments and `1 1024` as a second command, and exited 0 because the binary's defaults
    // happened to match the values that had been dropped.
    expect(
      splitParallelCommands(['cargo', 'run', '-p', 'worldgen-preview', '--', '1', '1024']),
    ).toEqual([['cargo', 'run', '-p', 'worldgen-preview', '--', '1', '1024']]);
  });

  it('passes a flag through after `--` rather than refusing it', () => {
    expect(splitParallelCommands(['pnpm', 'test', '--', '--coverage'])).toEqual([
      ['pnpm', 'test', '--', '--coverage'],
    ]);
    // And the case the old guard's advice got wrong: `--help` after `--` is cargo's, and dropping
    // the `--` as it suggested would have passed it to cargo instead of to the binary.
    expect(splitParallelCommands(['cargo', 'run', '-p', 'x', '--', '--help'])).toEqual([
      ['cargo', 'run', '-p', 'x', '--', '--help'],
    ]);
  });

  it('keeps both separators straight when the line uses each', () => {
    expect(
      splitParallelCommands([
        'cargo',
        'run',
        '-p',
        'x',
        '--',
        '1',
        PARALLEL_SEPARATOR,
        'pnpm',
        'test',
      ]),
    ).toEqual([
      ['cargo', 'run', '-p', 'x', '--', '1'],
      ['pnpm', 'test'],
    ]);
  });

  it('still refuses a command that starts with a flag', () => {
    expect(() =>
      splitParallelCommands(['pnpm', 'lint', PARALLEL_SEPARATOR, '--coverage']),
    ).toThrow(/cannot start a command/);
  });

  it('refuses the old two-command form rather than running it as one', () => {
    // Running it as one would make `pnpm lint` receive `pnpm typecheck` as arguments and fail
    // somewhere that says nothing about the separator having changed.
    expect(() => splitParallelCommands(['pnpm', 'lint', '--', 'pnpm', 'typecheck'])).toThrow(
      /no longer separates commands/,
    );
    const message = (() => {
      try {
        splitParallelCommands(['pnpm', 'lint', '--', 'pnpm', 'typecheck']);
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(message).toContain('bica run pnpm lint --also pnpm typecheck');
  });

  it('refuses the old form when the second command repeats the first program', () => {
    expect(() => splitParallelCommands(['./x', 'build', '--', './x', 'test'])).toThrow(
      /no longer separates commands/,
    );
  });

  it('says nothing about a `--` the user has already disambiguated with --also', () => {
    expect(
      splitParallelCommands(['pnpm', 'test', '--', 'pnpm', PARALLEL_SEPARATOR, 'pnpm', 'lint']),
    ).toEqual([
      ['pnpm', 'test', '--', 'pnpm'],
      ['pnpm', 'lint'],
    ]);
  });
});

describe('looksLikeOldParallelForm', () => {
  it('is false for arguments, which is the common case', () => {
    expect(looksLikeOldParallelForm(['cargo', 'run'], '1')).toBe(false);
    expect(looksLikeOldParallelForm(['pnpm', 'test'], '--coverage')).toBe(false);
    expect(looksLikeOldParallelForm(['pnpm', 'test'], undefined)).toBe(false);
    expect(looksLikeOldParallelForm(['cargo', 'run'], 'seed.json')).toBe(false);
  });

  it('is true only where the next word names a program', () => {
    expect(looksLikeOldParallelForm(['pnpm', 'lint'], 'pnpm')).toBe(true);
    expect(looksLikeOldParallelForm(['pnpm', 'lint'], 'cargo')).toBe(true);
    expect(looksLikeOldParallelForm(['./x', 'build'], './x')).toBe(true);
  });
});

describe('joinCommandsForDisplay', () => {
  // What a busy workspace quotes back. It joined with ` -- ` after 0.7.0 stopped accepting that,
  // so the refusal handed the reader a command line bica would refuse.
  it('joins commands with --also, never a bare --', () => {
    const line = joinCommandsForDisplay([
      ['pnpm', 'test:run', 'A', 'B', '--coverage'],
      ['pnpm', 'validate'],
      ['pnpm', 'lint:changed'],
      ['pnpm', 'format:check'],
    ]);
    expect(line).toBe(
      'pnpm test:run A B --coverage --also pnpm validate --also pnpm lint:changed --also pnpm format:check',
    );
    expect(line).toContain(PARALLEL_SEPARATOR);
    // No ` -- ` acting as a separator anywhere in it.
    expect(line).not.toMatch(/\s--\s/);
  });

  it('leaves a `--` that belongs to one of the programs exactly where it is', () => {
    const line = joinCommandsForDisplay([
      ['cargo', 'run', '-p', 'x', '--', '1', '1024'],
      ['pnpm', 'lint'],
    ]);
    expect(line).toBe('cargo run -p x -- 1 1024 --also pnpm lint');
  });

  it('round-trips: what it prints is what bica would accept back', () => {
    const commands = [
      ['pnpm', 'lint'],
      ['pnpm', 'typecheck'],
    ];
    const line = joinCommandsForDisplay(commands);
    expect(splitParallelCommands(line.split(' '))).toEqual(commands);
  });

  it('says a single command plainly', () => {
    expect(joinCommandsForDisplay([['pnpm', 'test']])).toBe('pnpm test');
  });
});
