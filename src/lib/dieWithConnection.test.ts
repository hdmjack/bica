import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { wrapCommandToDieWithConnection } from './runRemote';

/**
 * As reported against 0.9.3: one `--also` command's ssh was killed and its `timeout`-wrapped command
 * went on running on the remote. The watchdog that ends a command when its connection closes ran under
 * `zsh`, where it signalled nothing, and its tests had only ever run it under `sh`.
 */
describe('a command that dies with its connection', () => {
  const marker = `sleep 94${String(process.pid % 1000).padStart(3, '0')}`;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const running = (): string =>
    spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.trim();

  afterEach(() => {
    spawnSync('pkill', ['-KILL', '-f', marker]);
  });

  for (const shell of ['sh', 'zsh']) {
    it(`ends a timeout-wrapped command when the connection closes, under ${shell}`, async () => {
      // `detached`: the watchdog signals its own process group, which sshd makes a session of its own.
      const run = spawn(shell, ['-c', wrapCommandToDieWithConnection(`timeout 150 ${marker}`)], {
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: true,
      });
      run.unref();
      await sleep(1500);
      expect(running()).not.toBe('');

      run.stdin.end();
      for (let i = 0; i < 40 && running() !== ''; i++) {
        await sleep(250);
      }
      expect(running()).toBe('');
    });
  }
});
