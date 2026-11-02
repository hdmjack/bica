import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCommandEndScript,
  commandPidFileExpr,
  commandTagFor,
  parseCommandEndOutcome,
} from './remoteCommandEnd';
import { buildRemoteRunScript } from './runRemote';

/**
 * As reported against 0.9.3: one command of a six-command run lost its ssh to a SIGTERM, bica said it
 * was "unknown" whether it was still running, and twenty of its processes went on loading a shared
 * machine. The other five commands had finished, or had connections of their own and still do.
 */
describe('commandTagFor', () => {
  it('makes a label safe for a path, and names a lone command', () => {
    expect(commandTagFor('pnpm-test-ci-changed')).toBe('pnpm-test-ci-changed');
    expect(commandTagFor('a b/../c')).toBe('a_b____c');
    expect(commandTagFor(undefined)).toBe('run');
    expect(commandTagFor('')).toBe('run');
  });
});

describe('the run script publishes a command\'s group for the client to find', () => {
  const script = (commandTag: string | undefined): string =>
    buildRemoteRunScript({
      preamble: '',
      cdExpr: 'cd /w',
      command: 'true',
      runId: 'run1',
      claimPathExpr: '"$HOME/.claim"',
      commandTag,
    });

  it('writes its pid beside the claim when given a tag', () => {
    expect(script('lint')).toContain(`> ${commandPidFileExpr('"$HOME/.claim"', 'lint')}`);
  });

  it('writes nothing extra without one', () => {
    expect(script(undefined)).not.toContain('.pid.');
  });
});

describe('parseCommandEndOutcome', () => {
  it('reads what the script said, and treats a failed connection as unreachable', () => {
    expect(parseCommandEndOutcome(0, 'BICA_ENDED\n')).toBe('ended');
    expect(parseCommandEndOutcome(0, 'BICA_GONE\n')).toBe('gone');
    expect(parseCommandEndOutcome(0, 'BICA_NOT_MINE\n')).toBe('not-mine');
    expect(parseCommandEndOutcome(255, '')).toBe('unreachable');
    expect(parseCommandEndOutcome(0, '')).toBe('unreachable');
  });
});

describe('ending one command of a run', () => {
  const marker = `sleep 92${String(process.pid % 1000).padStart(3, '0')}`;
  const dirs: string[] = [];
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
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  /** A shell leading a group of its own, with a child that has left it: `timeout`'s situation. */
  async function command(): Promise<{ leader: number; child: number }> {
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

  function workspace(owner: string): { claim: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-end-'));
    dirs.push(dir);
    const claim = path.join(dir, 'claim');
    fs.writeFileSync(claim, `${owner} host 1 t=1`);
    return { claim };
  }

  const run = (claim: string, runId: string, tag: string): string =>
    spawnSync('sh', ['-s'], {
      input: buildCommandEndScript(claim, `'${runId}'`, tag),
      encoding: 'utf8',
    }).stdout;

  it('ends that command and its escaped child, and leaves the other commands alone', async () => {
    const { claim } = workspace('run1');
    const dropped = await command();
    const other = await command();
    expect(dropped.child).toBeGreaterThan(0);
    fs.writeFileSync(commandPidFileExpr(claim, 'dropped'), String(dropped.leader));
    fs.writeFileSync(commandPidFileExpr(claim, 'other'), String(other.leader));

    expect(parseCommandEndOutcome(0, run(claim, 'run1', 'dropped'))).toBe('ended');
    await sleep(300);
    expect(alive(dropped.leader)).toBe(false);
    expect(alive(dropped.child)).toBe(false);
    expect(alive(other.leader)).toBe(true);
    expect(alive(other.child)).toBe(true);
    expect(fs.existsSync(commandPidFileExpr(claim, 'dropped'))).toBe(false);
    expect(fs.existsSync(commandPidFileExpr(claim, 'other'))).toBe(true);
  });

  it('touches nothing once the workspace belongs to another run', async () => {
    const { claim } = workspace('somebody-else');
    const mine = await command();
    fs.writeFileSync(commandPidFileExpr(claim, 'cmd'), String(mine.leader));

    expect(parseCommandEndOutcome(0, run(claim, 'run1', 'cmd'))).toBe('not-mine');
    await sleep(200);
    expect(alive(mine.leader)).toBe(true);
  });

  it('says so when nothing of the command is left', () => {
    const { claim } = workspace('run1');
    expect(parseCommandEndOutcome(0, run(claim, 'run1', 'never-started'))).toBe('gone');
    fs.writeFileSync(commandPidFileExpr(claim, 'finished'), '2147483000');
    expect(parseCommandEndOutcome(0, run(claim, 'run1', 'finished'))).toBe('gone');
  });
});
