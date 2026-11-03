import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLocalBicaSettings, writeLocalBicaSettings } from '../localBicaSettings';
import {
  buildQueueGate,
  buildQueueStatusScript,
  describeQueue,
  parseQueueLimit,
  parseQueueStatus,
  PRELUDE_SH,
  QUEUE_GATE_SH,
  resolveQueueLimit,
} from './runQueue';
import { buildRemoteRunScript } from './runRemote';

/**
 * The queue is a few dozen lines of `sh`, and the part that has to be right -- deciding who goes next
 * while several of them are deciding at once -- is the part a mock cannot show. These run the real
 * script under `/bin/sh` against a temp directory, as the lease tests do. Nothing is stubbed: what is
 * executed is what the remote receives.
 *
 * "Holding a slot" is a live process, as it is in production, so the tests start real `sleep`
 * processes and end them to give a slot back.
 */

let dir: string;
const spawned: ChildProcess[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-queue-'));
});

afterEach(() => {
  for (const c of spawned.splice(0)) {
    if (c.pid !== undefined) {
      try {
        process.kill(-c.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A process that stands for a running command: alive until killed, leading its own group. */
function liveProcess(): number {
  const child = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' });
  child.unref();
  spawned.push(child);
  return child.pid as number;
}

function endProcess(pid: number): void {
  process.kill(-pid, 'SIGKILL');
}

interface Gate {
  done: Promise<{ code: number | null; stderr: string; ms: number }>;
  exited: () => boolean;
}

/** Run the gate as the remote would, without waiting for it. */
function gate(options: {
  runId: string;
  pid: number;
  limit: number | 'auto';
  claim?: string;
  /** Seconds between its looks at the queue. */
  poll?: string;
}): Gate {
  const started = Date.now();
  const child = spawn(
    '/bin/sh',
    ['-s', '--', dir, options.runId, String(options.pid), String(options.limit), options.claim ?? 'ws'],
    { env: { ...process.env, BICA_QUEUE_POLL: options.poll ?? '0.2' }, stdio: ['pipe', 'ignore', 'pipe'] },
  );
  spawned.push(child);
  let stderr = '';
  let finished = false;
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  child.stdin.end(QUEUE_GATE_SH);
  const done = new Promise<{ code: number | null; stderr: string; ms: number }>((resolve) => {
    child.on('close', (code) => {
      finished = true;
      resolve({ code, stderr, ms: Date.now() - started });
    });
  });
  return { done, exited: () => finished };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function held(): string[] {
  return fs.existsSync(path.join(dir, 'held')) ? fs.readdirSync(path.join(dir, 'held')).sort() : [];
}

function waiting(): string[] {
  return fs.existsSync(path.join(dir, 'wait')) ? fs.readdirSync(path.join(dir, 'wait')).sort() : [];
}

describe('the queue gate, executed', () => {
  it('admits a run at once when a slot is free, and records it as holding one', async () => {
    const pid = liveProcess();
    const r = await gate({ runId: '100', pid, limit: 2 }).done;
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(''); // no wait, nothing to say
    expect(held()).toEqual([`100.${String(pid)}`]);
    expect(waiting()).toEqual([]);
  });

  it('holds a run back at the limit, tells it where it stands, and admits it when a slot comes free', async () => {
    const holder = liveProcess();
    await gate({ runId: '1', pid: holder, limit: 1 }).done;

    const second = gate({ runId: '2', pid: liveProcess(), limit: 1 });
    await sleep(700);
    expect(second.exited()).toBe(false);
    expect(waiting()).toHaveLength(1);

    endProcess(holder);
    const r = await second.done;
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/Queued: 1 of 1 run slots busy, 0 ahead of this run/);
    expect(r.stderr).toMatch(/Slot free after \d+s; starting\./);
    expect(waiting()).toEqual([]);
  });

  it('admits runs in the order they arrived, and not the one that happens to look first', async () => {
    const holder = liveProcess();
    await gate({ runId: '1', pid: holder, limit: 1 }).done;

    // A arrives first but looks rarely; B arrives second and looks constantly. When the slot comes
    // free B will see it long before A does, and must still not take it.
    const aPid = liveProcess();
    const a = gate({ runId: 'A', pid: aPid, limit: 1, poll: '1.5' });
    await sleep(400);
    const b = gate({ runId: 'B', pid: liveProcess(), limit: 1, poll: '0.1' });
    await sleep(400);

    endProcess(holder);
    await sleep(900);
    expect(b.exited()).toBe(false);

    await a.done;
    expect(held()).toEqual([`A.${String(aPid)}`]);
    await sleep(500);
    expect(b.exited()).toBe(false);

    endProcess(aPid);
    expect((await b.done).code).toBe(0);
  });

  it('lets the commands of one run share its slot', async () => {
    const p1 = liveProcess();
    const p2 = liveProcess();
    await gate({ runId: '7', pid: p1, limit: 1 }).done;
    const r = await gate({ runId: '7', pid: p2, limit: 1 }).done;
    expect(r.code).toBe(0);
    expect(held()).toHaveLength(2);
  });

  it('keeps a queued run from being stranded behind a waiter that has died', async () => {
    const holder = liveProcess();
    await gate({ runId: '1', pid: holder, limit: 1 }).done;

    const deadPid = liveProcess();
    const dead = gate({ runId: 'X', pid: deadPid, limit: 1 });
    await sleep(400);
    const live = gate({ runId: 'Y', pid: liveProcess(), limit: 1 });
    await sleep(400);
    // X is first in line; its run is killed outright, with nothing running to tidy up after it.
    endProcess(deadPid);
    endProcess(holder);

    expect((await live.done).code).toBe(0);
    void dead;
  });

  it('gives a slot back when its holder is killed without any cleanup running', async () => {
    const holder = liveProcess();
    await gate({ runId: '1', pid: holder, limit: 1 }).done;
    endProcess(holder);
    const r = await gate({ runId: '2', pid: liveProcess(), limit: 1 }).done;
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(held().map((f) => f.split('.')[0])).toEqual(['2']);
  });

  it('does not count an entry written before the remote last restarted', async () => {
    fs.mkdirSync(path.join(dir, 'held'), { recursive: true });
    // A live pid -- after a restart any number belongs to something -- under a boot stamp from long ago.
    fs.writeFileSync(path.join(dir, 'held', `old.${String(process.pid)}`), `${String(process.pid)} 1000000000 1000000000 ws\n`);
    const booted = spawnSync('/bin/sh', ['-s'], {
      input: `${PRELUDE_SH}echo "$BOOT"\n`,
      encoding: 'utf8',
    });
    if (!/^\d+$/.test(booted.stdout.trim())) {
      return; // a host that reports no boot time cannot make the distinction, and falls back to pids
    }
    const r = await gate({ runId: 'new', pid: liveProcess(), limit: 1 }).done;
    expect(r.stderr).toBe('');
    expect(held().map((f) => f.split('.')[0])).toEqual(['new']);
  });

  it('resolves auto to at least one run', async () => {
    const r = await gate({ runId: '1', pid: liveProcess(), limit: 'auto' }).done;
    expect(r.code).toBe(0);
    expect(held()).toHaveLength(1);
  });

  it('lets a run through, saying so, when it cannot keep its own books', async () => {
    const blocker = path.join(dir, 'blocked');
    fs.writeFileSync(blocker, '');
    const r = spawnSync('/bin/sh', ['-s', '--', path.join(blocker, 'q'), '1', '1', '1', 'ws'], {
      input: QUEUE_GATE_SH,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/running without the queue/);
  });

  it('survives being embedded in the login shell script that runs the command, with its stdin intact', () => {
    const zsh = spawnSync('which', ['zsh'], { encoding: 'utf8' });
    if (zsh.status !== 0) {
      return;
    }
    const block = buildQueueGate({ runId: '55', limit: 1, claimName: 'ws', dir });
    // The command after the gate reads what the caller sends, which a here-document that leaked into
    // it would have replaced.
    const r = spawnSync('zsh', ['-c', `${block}cat\n`], { input: 'from the caller', encoding: 'utf8' });
    expect(r.stdout).toBe('from the caller');
    expect(held()).toHaveLength(1);
  });
});

describe('where the gate sits in a run', () => {
  const base = {
    preamble: '',
    cdExpr: 'cd /w',
    command: 'THE_COMMAND',
    runId: '42',
    claimPathExpr: '~/.bica/claims/code_repo',
    heartbeat: true,
  } as const;

  it('comes after the lease is published and the heartbeat is watching, and before the command', () => {
    const script = buildRemoteRunScript({ ...base, queueLimit: 3 });
    const at = (s: string): number => script.indexOf(s);
    expect(at('rpid=')).toBeGreaterThan(-1);
    expect(at('BICA_QUEUE_EOF')).toBeGreaterThan(at('rpid='));
    expect(at('BICA_QUEUE_EOF')).toBeGreaterThan(at('_bica_sup=$!'));
    expect(at('THE_COMMAND')).toBeGreaterThan(script.lastIndexOf('BICA_QUEUE_EOF'));
    expect(script).toContain("'42'");
    expect(script).toContain("'code_repo'");
  });

  it('is absent without a limit, and for a run that holds no lease', () => {
    expect(buildRemoteRunScript({ ...base })).not.toContain('BICA_QUEUE_EOF');
    expect(
      buildRemoteRunScript({ ...base, runId: undefined, claimPathExpr: undefined, queueLimit: 3 }),
    ).not.toContain('BICA_QUEUE_EOF');
  });

  it('keeps a run id from putting anything but a name into the files', () => {
    expect(buildQueueGate({ runId: 'a.b/c d', limit: 1, claimName: 'ws' })).toContain("'a_b_c_d'");
  });
});

describe('the limit', () => {
  it('reads numbers, auto, and the ways of saying no limit', () => {
    expect(parseQueueLimit('4', 'x')).toBe(4);
    expect(parseQueueLimit(' AUTO ', 'x')).toBe('auto');
    for (const off of ['0', 'off', 'Unlimited']) {
      expect(parseQueueLimit(off, 'x')).toBeNull();
    }
  });

  it('refuses a value it cannot read, naming where it came from', () => {
    expect(() => parseQueueLimit('lots', 'BICA_MAX_RUNS')).toThrow(/BICA_MAX_RUNS must be a whole number/);
    expect(() => parseQueueLimit('-2', 'x')).toThrow();
    expect(() => parseQueueLimit('1.5', 'x')).toThrow();
  });

  it('prefers the environment to the checkout, and defaults to auto', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-queue-repo-'));
    try {
      expect(resolveQueueLimit(repo, {})).toBe('auto');
      fs.mkdirSync(path.join(repo, '.bica'));
      fs.writeFileSync(path.join(repo, '.bica', 'local.yml'), 'maxRuns: 5\n');
      expect(resolveQueueLimit(repo, {})).toBe(5);
      expect(resolveQueueLimit(repo, { BICA_MAX_RUNS: 'off' })).toBeNull();
      expect(resolveQueueLimit(repo, { BICA_MAX_RUNS: '2' })).toBe(2);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('the setting in .bica/local.yml', () => {
  it('survives `bica init` rewriting the file', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-queue-settings-'));
    try {
      writeLocalBicaSettings(repo, { sshHost: 'mini', maxRuns: '4' });
      expect(readLocalBicaSettings(repo)).toMatchObject({ sshHost: 'mini', maxRuns: '4' });
      // A bare number is what a person types, and YAML reads it as one.
      fs.writeFileSync(path.join(repo, '.bica', 'local.yml'), 'sshHost: mini\nmaxRuns: 0\n');
      expect(readLocalBicaSettings(repo).maxRuns).toBe('0');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('bica queue', () => {
  it('lists, from a real queue directory, who is running and who is waiting in order', async () => {
    const holder = liveProcess();
    await gate({ runId: '10', pid: holder, limit: 1, claim: 'code_a' }).done;
    const w1 = gate({ runId: '20', pid: liveProcess(), limit: 1, claim: 'code_b' });
    await sleep(400);
    const w2 = gate({ runId: '30', pid: liveProcess(), limit: 1, claim: 'code_c' });
    await sleep(400);

    const quoted = `'${dir}'`;
    const r = spawnSync('/bin/sh', ['-s'], { input: buildQueueStatusScript(quoted), encoding: 'utf8' });
    const state = parseQueueStatus(r.stdout);
    expect(state.running.map((e) => [e.runId, e.workspace])).toEqual([['10', 'code_a']]);
    expect(state.waiting.map((e) => e.runId)).toEqual(['20', '30']);
    expect(state.autoLimit).toBeGreaterThanOrEqual(1);
    void w1;
    void w2;
  });

  it('groups the commands of a run into one entry, and describes it plainly', () => {
    const state = parseQueueStatus(
      [
        'NOW\t1000',
        'AUTO\t3',
        'held\t7.11\t940\tcode_repo\tpnpm lint',
        'held\t7.12\t941\tcode_repo\tpnpm lint',
        'wait\t0000000002.8.13\t970\tcode_other\t',
      ].join('\n'),
    );
    expect(state.running).toHaveLength(1);
    expect(state.running[0]?.pids).toEqual([11, 12]);
    const text = describeQueue(state, 'auto');
    expect(text).toContain('Executing: 1 (3 allowed)');
    expect(text).toContain('• run 7  code_repo  1m  pnpm lint');
    expect(text).toContain('1. run 8  code_other  30s');
    expect(describeQueue(state, null)).toContain('no limit');
  });
});
