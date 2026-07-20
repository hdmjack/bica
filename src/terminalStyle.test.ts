import chalk from 'chalk';
import { describe, expect, it } from 'vitest';

import { remoteExitStatusLine } from './terminalStyle';

describe('remoteExitStatusLine', () => {
  it('reports a zero exit', () => {
    expect(remoteExitStatusLine(0)).toContain('remote command exited 0');
  });

  it('reports a non-zero exit', () => {
    expect(remoteExitStatusLine(1)).toContain('remote command exited 1');
  });

  it('dims success and warns on failure when color is enabled', () => {
    const prevLevel = chalk.level;
    chalk.level = 3; // force ANSI so dim (success) vs warn (failure) is observable
    try {
      expect(remoteExitStatusLine(0)).toBe(chalk.dim('[bica] remote command exited 0'));
      expect(remoteExitStatusLine(1)).toBe(
        chalk.yellow('[bica] remote command exited 1'),
      );
    } finally {
      chalk.level = prevLevel;
    }
  });
});
