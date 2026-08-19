import * as os from 'node:os';
import { describe, expect, it } from 'vitest';

import { acquireLaneForRun } from './laneRun';
import type { LeaseOps } from './laneRun';
import type { ClaimOwner, ClaimResult } from './remoteClaim';

const REPO = '/repo';
const BASE = '~/code/repo';

/**
 * A stand-in for the remote host: a map of workspace path to its current holder. Selection is pure
 * decision-making over this, so it can be exercised without SSH — the round-trips themselves are
 * covered by the live checks.
 */
function fakeLease(initial: Record<string, ClaimOwner> = {}): LeaseOps & {
  held: Record<string, ClaimOwner>;
  calls: string[];
} {
  const held: Record<string, ClaimOwner> = { ...initial };
  const calls: string[] = [];
  return {
    held,
    calls,
    acquire(remotePath, owner): ClaimResult {
      calls.push(remotePath);
      const current = held[remotePath];
      if (current !== undefined) {
        return { ok: false, heldBy: current, raw: 'held' };
      }
      held[remotePath] = owner;
      return { ok: true };
    },
    break(remotePath, expected) {
      if (held[remotePath]?.runId === expected.runId) {
        delete held[remotePath];
      }
    },
    release(remotePath, owner) {
      if (held[remotePath]?.runId === owner.runId) {
        delete held[remotePath];
      }
    },
  };
}

/**
 * A run that is genuinely still alive. It has to use a real live pid: this host's own claims are
 * checked with `kill -0`, so a made-up pid would be judged dead, the lease broken, and the test would
 * be asserting the takeover path while appearing to assert contention.
 */
const otherRun = (tag: number): ClaimOwner => ({
  runId: `other-${String(tag)}`,
  host: os.hostname(),
  pid: process.pid,
});

function acquire(lease: LeaseOps, laneArg: string | undefined, poolSize = 3) {
  return acquireLaneForRun({
    repoRoot: REPO,
    baseRemotePath: BASE,
    laneArg,
    poolSize,
    runIdFor: (l) => `${l.label}-1`,
    lease,
  });
}

describe('acquireLaneForRun — auto', () => {
  it('takes the first lane whose workspace is free', () => {
    const lease = fakeLease();
    expect(acquire(lease, 'auto').lane.id).toBe('1');
  });

  it('advances past a lane held by another run, rather than refusing', () => {
    // The old lock-based selection refused here, because each checkout counted lanes on its own and
    // could not see a sibling clone holding lane 1. Advancing is the whole point of `auto`.
    const lease = fakeLease({ '~/code/repo-lane-1': otherRun(4242) });
    expect(acquire(lease, 'auto').lane.id).toBe('2');
  });

  it('advances past several held lanes', () => {
    const lease = fakeLease({
      '~/code/repo-lane-1': otherRun(1),
      '~/code/repo-lane-2': otherRun(2),
    });
    expect(acquire(lease, 'auto').lane.id).toBe('3');
  });

  it('hands successive callers different lanes', () => {
    const lease = fakeLease();
    const ids = [
      acquire(lease, 'auto').lane.id,
      acquire(lease, 'auto').lane.id,
      acquire(lease, 'auto').lane.id,
    ];
    expect(new Set(ids).size).toBe(3);
  });

  it('names every holder when the pool is exhausted', () => {
    const lease = fakeLease({
      '~/code/repo-lane-1': otherRun(1),
      '~/code/repo-lane-2': otherRun(2),
      '~/code/repo-lane-3': otherRun(3),
    });
    expect(() => acquire(lease, 'auto')).toThrow(/All 3 lanes are in use/);
    expect(() => acquire(lease, 'auto')).toThrow(/other-1/);
  });

  it('reclaims a lane whose holder is gone, without consuming a different lane', () => {
    // pid 2^31-1 is above every platform's pid_max, so it can never be running.
    const dead: ClaimOwner = { runId: 'dead', host: os.hostname(), pid: 2147483647 };
    const lease = fakeLease({ '~/code/repo-lane-1': dead });
    expect(acquire(lease, 'auto').lane.id).toBe('1');
  });

  it('honours a live lease from another machine, which it cannot interrogate', () => {
    const remote: ClaimOwner = { runId: 'far', host: 'some-other-box', pid: 2147483647 };
    const lease = fakeLease({ '~/code/repo-lane-1': remote });
    // Even though that pid is dead *here*, it says nothing about the machine that owns it.
    expect(acquire(lease, 'auto').lane.id).toBe('2');
  });
});

describe('acquireLaneForRun — explicit and default', () => {
  it('takes the named lane', () => {
    expect(acquire(fakeLease(), '2').lane.id).toBe('2');
  });

  it('refuses a named lane that is held, and says who holds it', () => {
    const lease = fakeLease({ '~/code/repo-lane-2': otherRun(77) });
    expect(() => acquire(lease, '2')).toThrow(/Lane "2" is in use/);
    expect(() => acquire(lease, '2')).toThrow(/other-77/);
  });

  it('leases the base workspace for the default run', () => {
    const lease = fakeLease();
    const got = acquire(lease, undefined);
    expect(got.lane.isDefault).toBe(true);
    expect(lease.held[BASE]).toBeDefined();
  });

  it('refuses the default workspace when another run holds it', () => {
    const lease = fakeLease({ [BASE]: otherRun(9) });
    expect(() => acquire(lease, undefined)).toThrow(/this checkout's remote workspace is in use/i);
  });

  it('rejects an invalid lane id before touching the host', () => {
    const lease = fakeLease();
    expect(() => acquire(lease, '../escape')).toThrow(/Invalid lane id/);
    expect(lease.calls).toEqual([]);
  });
});

describe('releasing', () => {
  it('frees the workspace for the next caller', () => {
    const lease = fakeLease();
    const first = acquire(lease, 'auto');
    first.release();
    expect(acquire(lease, 'auto').lane.id).toBe('1');
  });
});
