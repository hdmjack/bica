import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimFileName } from './remoteClaim';
import { followRun } from './followRun';
import type { FollowOptions } from './followRun';

/**
 * The remote half runs for real, under `sh` with a throwaway HOME, so that what is tested is what a
 * remote's shell, `awk`, `tail` and `head` do with the script. What stands in for ssh only decides
 * where that script runs and, in the drop tests, cuts the connection at a chosen byte.
 */
const WS = '~/code/work';
const RUN = '4242';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-follow-'));
  fs.mkdirSync(path.join(home, '.bica/runs'), { recursive: true });
  fs.mkdirSync(path.join(home, '.bica/claims'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const logFile = (): string => path.join(home, '.bica/runs', `${RUN}.log`);
const claimFile = (): string => path.join(home, '.bica/claims', claimFileName(WS));

function writeLog(text: string): void {
  fs.appendFileSync(logFile(), text);
}
function claim(...fields: string[]): void {
  fs.writeFileSync(claimFile(), `${fields.join(' ')}\n`);
}

type Spawn = NonNullable<FollowOptions['spawnSsh']>;

/** Runs the script the follower sends locally. `cutAfterBytes` kills the first N connections that far in. */
function localSsh(cutAfter: number[] = []): { spawnSsh: Spawn; attempts: () => number } {
  let attempts = 0;
  const spawnSsh: Spawn = (_cmd, _args, options) => {
    const cut = cutAfter[attempts];
    attempts += 1;
    const script =
      cut === undefined
        ? 'sh -s'
        : // `head -c` closes the pipe after the chosen byte, which is how a link breaks mid-chunk.
          `sh -s | head -c ${String(cut)}; exit 255`;
    return spawn('sh', ['-c', script], {
      ...options,
      env: { ...process.env, HOME: home },
    });
  };
  return { spawnSsh, attempts: () => attempts };
}

async function follow(
  spawnSsh: Spawn,
  extra: Partial<FollowOptions> = {},
): Promise<{ outcome: string; out: string; said: string[] }> {
  const chunks: Buffer[] = [];
  const said: string[] = [];
  const outcome = await followRun({
    sshHost: 'mini',
    remoteWorkspacePath: WS,
    runId: RUN,
    out: (c) => chunks.push(c),
    say: (l) => said.push(l),
    backoffMs: () => 10,
    spawnSsh,
    ...extra,
  });
  return { outcome, out: Buffer.concat(chunks).toString('utf8'), said };
}

describe('followRun', () => {
  it('shows the whole log of a run that has finished, and says it finished', async () => {
    writeLog('line one\nline two\n');
    claim(RUN, 'mini', '1', 'rpid=9', '0');
    const r = await follow(localSsh().spawnSsh);
    expect(r.outcome).toBe('finished');
    expect(r.out).toBe('line one\nline two\n');
  });

  it('keeps following a run that is still going, and stops when its exit code lands', async () => {
    claim(RUN, 'mini', '1', 'rpid=9');
    writeLog('start\n');
    const later = setTimeout(() => {
      writeLog('middle\n');
      setTimeout(() => {
        writeLog('end\n');
        claim(RUN, 'mini', '1', 'rpid=9', '3');
      }, 300);
    }, 300);
    const r = await follow(localSsh().spawnSsh);
    clearTimeout(later);
    expect(r.outcome).toBe('finished');
    expect(r.out).toBe('start\nmiddle\nend\n');
  });

  it('carries on from the byte it reached after the connection drops, with nothing lost or repeated', async () => {
    const text = Array.from({ length: 50 }, (_, i) => `row ${String(i)}\n`).join('');
    writeLog(text);
    claim(RUN, 'mini', '1', 'rpid=9', '0');
    // Cut the first connection 7 bytes in (inside a line) and the second 100 bytes in.
    const ssh = localSsh([7, 100]);
    const r = await follow(ssh.spawnSsh);
    expect(r.outcome).toBe('finished');
    expect(r.out).toBe(text);
    expect(ssh.attempts()).toBe(3);
    expect(r.said.join('\n')).toContain('Lost the connection to mini');
    expect(r.said.join('\n')).toContain('Reconnected');
  });

  it('does not call a run finished while output written just before its exit code is unsent', async () => {
    writeLog('first\n');
    claim(RUN, 'mini', '1', 'rpid=9', '0');
    writeLog('last words\n');
    const r = await follow(localSsh().spawnSsh);
    expect(r.out).toBe('first\nlast words\n');
  });

  it('reads a claim with tags before the exit code, and does not take a tag for it', async () => {
    writeLog('out\n');
    claim(RUN, 'mini', '1', 'rpid=9', 'queued=1');
    // No exit code yet: it must keep waiting, so end it by recording one.
    setTimeout(() => {
      claim(RUN, 'mini', '1', 'rpid=9', 'queued=1', '17');
    }, 400);
    const r = await follow(localSsh().spawnSsh);
    expect(r.outcome).toBe('finished');
  });

  it('reports a claim that now names another run, rather than waiting for ever', async () => {
    writeLog('out\n');
    claim('9999', 'other', '1', 'rpid=9');
    const r = await follow(localSsh().spawnSsh);
    expect(r.outcome).toBe('claim-gone');
    expect(r.out).toBe('out\n');
  });

  it('reports a claim that has been cleared', async () => {
    writeLog('out\n');
    const r = await follow(localSsh().spawnSsh);
    expect(r.outcome).toBe('claim-gone');
  });

  it('gives up, saying the run may still be going, when the host stays unreachable', async () => {
    let t = 0;
    const dead: Spawn = (_c, _a, options) =>
      spawn('sh', ['-c', 'cat >/dev/null; exit 255'], options);
    const r = await follow(dead, {
      graceMs: 60_000,
      now: () => {
        t += 5_000;
        return t;
      },
    });
    expect(r.outcome).toBe('gave-up');
    expect(r.said.join('\n')).toContain('still running there');
  });

  it('starts counting the grace again after a connection that worked', async () => {
    writeLog('some output\n');
    claim(RUN, 'mini', '1', 'rpid=9', '0');
    // First connection delivers bytes then drops; the grace window must not be spent by the time it
    // reconnects even though the clock has moved a long way.
    let t = 0;
    const ssh = localSsh([5]);
    const r = await follow(ssh.spawnSsh, {
      graceMs: 30_000,
      now: () => {
        t += 25_000;
        return t;
      },
    });
    expect(r.outcome).toBe('finished');
    expect(r.out).toBe('some output\n');
  });
});
