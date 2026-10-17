import { describe, expect, it } from 'vitest';

import { readDetachedRunState } from './detachedCommands';
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
    }));
    expect(state.state).toBe('running');
  });

  it('is finished once the run has recorded its code', () => {
    const state = readDetachedRunState(record, () => ({
      exitCode: 7,
      mine: true,
    }));
    expect(state).toMatchObject({ state: 'finished', exitCode: 7 });
  });

  it('reports exit 0 as finished, not as nothing', () => {
    // A falsy exit code is the successful case and the easiest one to drop.
    expect(
      readDetachedRunState(record, () => ({ exitCode: 0, mine: true })).state,
    ).toBe('finished');
  });

  it('is gone when the workspace now belongs to another run', () => {
    const state = readDetachedRunState(record, () => ({
      exitCode: 3,
      mine: false,
    }));
    expect(state.state).toBe('gone');
    expect(state.exitCode).toBeNull();
  });
});
