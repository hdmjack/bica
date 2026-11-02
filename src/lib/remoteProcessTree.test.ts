import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { PROCESS_TREE_SH } from './remoteProcessTree';

/**
 * As reported against 0.9.1: a run cancelled under `timeout 900 ./viewer` left the viewer running.
 * GNU `timeout` puts itself and its child in a new process group, so a signal to the shell's group
 * never reached them. `set -m` makes a shell do the same to its background jobs, which is the same
 * escape without needing coreutils.
 */
describe('ending a process tree', () => {
  // A duration nobody else sleeps for, so cleanup can find these and only these.
  const marker = `sleep 91${String(process.pid % 1000).padStart(3, '0')}`;
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  afterEach(() => {
    spawnSync('pkill', ['-KILL', '-f', marker]);
  });

  /** A shell leading its own group, with a child that has moved to another: `timeout`'s situation. */
  async function leaderWithEscapedChild(): Promise<{ leader: number; child: number }> {
    const leader = spawn('sh', ['-c', `set -m; ${marker} & wait`], {
      detached: true,
      stdio: 'ignore',
    });
    leader.unref();
    const pid = leader.pid as number;
    let child = 0;
    for (let i = 0; i < 40 && child === 0; i++) {
      await sleep(50);
      const found = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim();
      child = Number(found.split('\n')[0] || 0);
    }
    return { leader: pid, child };
  }

  const group = (pid: number): string =>
    spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();

  it('ends a child that left the shell\'s process group, which signalling the group does not', async () => {
    const { leader, child } = await leaderWithEscapedChild();
    expect(child).toBeGreaterThan(0);
    // The premise: the child really is in a group of its own.
    expect(group(child)).not.toBe(group(leader));

    const ended = spawnSync('sh', ['-c', `${PROCESS_TREE_SH}_bica_end_tree ${String(leader)}`]);
    expect(ended.status).toBe(0);
    await sleep(300);
    expect(alive(leader)).toBe(false);
    expect(alive(child)).toBe(false);
  });

  it('is what the old group-only signal fails to do', async () => {
    const { leader, child } = await leaderWithEscapedChild();
    spawnSync('sh', ['-c', `kill -TERM -${String(leader)}`]);
    await sleep(300);
    expect(alive(leader)).toBe(false);
    expect(alive(child)).toBe(true);
  });

  // The login shell is `zsh`, and it does not split an unquoted variable into words: 0.9.2 and 0.9.3
  // ended `timeout`'s child under `sh` in their tests and not under the shell that runs the command.
  for (const shell of ['sh', 'zsh']) {
    it(`ends several escaped children when the script runs under ${shell}`, async () => {
      // Two, because one pid has no list to split: zsh handled that case all along.
      const leader = spawn('sh', ['-c', `set -m; ${marker} & ${marker} & wait`], {
        detached: true,
        stdio: 'ignore',
      });
      leader.unref();
      const pid = leader.pid as number;
      let children: number[] = [];
      for (let i = 0; i < 40 && children.length < 2; i++) {
        await sleep(50);
        const found = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim();
        children = found === '' ? [] : found.split('\n').map(Number);
      }
      expect(children).toHaveLength(2);
      const ended = spawnSync(shell, ['-c', `${PROCESS_TREE_SH}_bica_end_tree ${String(pid)}`]);
      expect(ended.status).toBe(0);
      await sleep(300);
      expect(alive(pid)).toBe(false);
      for (const child of children) {
        expect(alive(child)).toBe(false);
      }
    });
  }

  it('reports the group as gone when it is, so a caller can tell', () => {
    const r = spawnSync('sh', ['-c', `${PROCESS_TREE_SH}_bica_end_tree 2147483000`]);
    expect(r.status).not.toBe(0);
  });
});
