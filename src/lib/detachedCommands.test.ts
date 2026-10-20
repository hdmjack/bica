import { describe, expect, it } from 'vitest';

import { cmdWait, readDetachedRunState } from './detachedCommands';
import {
  readDetachedRunRecord,
  removeDetachedRunRecord,
  writeDetachedRunRecord,
} from './detachedRun';
import type { DetachedRunRecord } from './detachedRun';

/**
 * How `bica wait` and `bica runs` read a detached run's state.
 *
 * The distinction that matters is the third one. A finished run leaves its exit code on the claim and
 * nothing clears it until `wait` does -- but a later `bica run` will break a lease whose process is
 * gone, which takes the exit code with it. Reporting whatever is on the claim at that point would
 * hand back a stranger's exit code, so "mine" is checked before anything else.
 */

const record: DetachedRunRecord = {
  runId: '4242',
  sshHost: 'mini',
  remoteWorkspacePath: '~/code/llvm',
  repoRoot: '/l',
  command: ['ninja'],
  startedAt: new Date().toISOString(),
  remoteLogPath: '~/.bica/runs/4242.log',
};

describe('readDetachedRunState', () => {
  it('is running while the claim is ours and has no exit code yet', () => {
    const state = readDetachedRunState(record, () => ({
      exitCode: null,
      mine: true,
      unreachable: false,
    }));
    expect(state.state).toBe('running');
  });

  it('is finished once the run has recorded its code', () => {
    const state = readDetachedRunState(record, () => ({
      exitCode: 7,
      mine: true,
      unreachable: false,
    }));
    expect(state).toMatchObject({ state: 'finished', exitCode: 7 });
  });

  it('reports exit 0 as finished, not as nothing', () => {
    // A falsy exit code is the successful case and the easiest one to drop.
    expect(
      readDetachedRunState(record, () => ({ exitCode: 0, mine: true, unreachable: false })).state,
    ).toBe('finished');
  });

  it('is gone when the workspace now belongs to another run', () => {
    const state = readDetachedRunState(record, () => ({
      exitCode: 3,
      mine: false,
      unreachable: false,
    }));
    expect(state.state).toBe('gone');
    expect(state.exitCode).toBeNull();
  });

  it('does not call a run gone when the claim could not be read', () => {
    // The bug this is here for: a 15-minute LLVM build, still compiling and still holding its claim,
    // declared gone on one failed poll.
    const state = readDetachedRunState(record, () => ({
      exitCode: null,
      mine: false,
      unreachable: true,
    }));
    expect(state.state).toBe('unreachable');
  });
});

describe('cmdWait through a failed probe', () => {
  function sequence(
    results: readonly { exitCode: number | null; mine: boolean; unreachable: boolean }[],
  ): () => { exitCode: number | null; mine: boolean; unreachable: boolean } {
    let i = 0;
    return () => results[Math.min(i++, results.length - 1)];
  }

  it('keeps waiting, and keeps the record, when a poll cannot reach the host', async () => {
    writeDetachedRunRecord(record);
    const code = await cmdWait(record.runId, {
      pollMs: 0,
      release: () => undefined,
      finish: () => undefined,
      read: sequence([
        { exitCode: null, mine: false, unreachable: true },
        { exitCode: null, mine: true, unreachable: false },
        { exitCode: 0, mine: true, unreachable: false },
      ]),
    });
    expect(code).toBe(0);
  });

  it('leaves the record behind when the run finishes, so `bica logs` can still find it', async () => {
    // `wait` ends with "its output is in `bica logs <id>`" and then used to delete the only thing
    // that knows which host holds that log. The log is on the remote either way.
    writeDetachedRunRecord(record);
    const code = await cmdWait(record.runId, {
      pollMs: 0,
      release: () => undefined,
      finish: () => undefined,
      read: () => ({ exitCode: 3, mine: true, unreachable: false }),
    });
    expect(code).toBe(3);
    const after = readDetachedRunRecord(record.runId);
    expect(after).toMatchObject({ exitCode: 3, sshHost: 'mini' });
    expect(after?.finishedAt).toBeDefined();
    // And it reads as history from then on, without asking the remote about a workspace that has
    // moved on.
    expect(
      readDetachedRunState(after as DetachedRunRecord, () => {
        throw new Error('should not probe a finished run');
      }),
    ).toMatchObject({ state: 'finished', exitCode: 3 });
    removeDetachedRunRecord(record.runId);
  });

  it('keeps the record when the workspace changed hands, which is where the log still is', async () => {
    writeDetachedRunRecord(record);
    const code = await cmdWait(record.runId, {
      pollMs: 0,
      release: () => undefined,
      finish: () => undefined,
      read: () => ({ exitCode: 9, mine: false, unreachable: false }),
    });
    expect(code).toBe(1);
    expect(readDetachedRunRecord(record.runId)).toMatchObject({ exitCode: null });
    removeDetachedRunRecord(record.runId);
  });

  it('gives up with 96 after the grace period, leaving the record in place', async () => {
    writeDetachedRunRecord(record);
    let clock = 0;
    const code = await cmdWait(record.runId, {
      pollMs: 0,
      unreachableGraceMs: 10,
      now: () => (clock += 20),
      read: () => ({ exitCode: null, mine: false, unreachable: true }),
    });
    expect(code).toBe(96);
    // The whole point: the handle on the run survives, so `bica wait <id>` works once the host is back.
    expect(readDetachedRunRecord(record.runId)).not.toBeNull();
    removeDetachedRunRecord(record.runId);
  });
});
