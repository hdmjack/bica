import * as os from 'node:os';
import { describe, expect, it } from 'vitest';

import { acquireWorkspace, WorkspaceInUseError } from './pinnedRun';
import type { LeaseOps } from './pinnedRun';
import type { ClaimOwner, ClaimResult } from './remoteClaim';

const WS = '~/code/repo';

/** Stand-in for the remote: which run, if any, currently holds each workspace path. */
function fakeLease(
  initial: Record<string, ClaimOwner> = {},
  remoteAlive: (pid: number) => boolean = () => false,
): LeaseOps & { held: Record<string, ClaimOwner> } {
  const held: Record<string, ClaimOwner> = { ...initial };
  return {
    held,
    remotePidAlive: remoteAlive,
    acquire(p, owner): ClaimResult {
      const cur = held[p];
      if (cur !== undefined) {
        return { ok: false, heldBy: cur, raw: 'held' };
      }
      held[p] = owner;
      return { ok: true };
    },
    break(p, expected) {
      if (held[p]?.runId === expected.runId) delete held[p];
    },
    release(p, owner) {
      if (held[p]?.runId === owner.runId) delete held[p];
    },
  };
}

/**
 * A competing run that is genuinely alive. It must use a real live pid: a claim from this host is
 * checked with `kill -0`, so a made-up pid reads as dead and the test would exercise takeover while
 * appearing to exercise contention.
 */
const liveRun = (tag: string): ClaimOwner => ({
  runId: tag,
  host: os.hostname(),
  pid: process.pid,
});

const acquire = (lease: LeaseOps, runId = 'mine') =>
  acquireWorkspace({ remoteWorkspacePath: WS, runId, lease });

describe('acquireWorkspace', () => {
  it('takes a free workspace', () => {
    const lease = fakeLease();
    expect(acquire(lease).owner.runId).toBe('mine');
    expect(lease.held[WS]).toBeDefined();
  });

  it('refuses a workspace another run holds, naming it', () => {
    // This is the case a local lock could never see: the other run may be from a sibling clone.
    const lease = fakeLease({ [WS]: liveRun('someone-else') });
    expect(() => acquire(lease)).toThrow(WorkspaceInUseError);
    expect(() => acquire(lease)).toThrow(/someone-else/);
  });

  it('carries exit 98, so callers need not parse the message', () => {
    const lease = fakeLease({ [WS]: liveRun('other') });
    try {
      acquire(lease);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as WorkspaceInUseError).exitCode).toBe(98);
    }
  });

  it('breaks a lease whose owner is gone, rather than wedging', () => {
    // A killed run must cost the next one a round-trip, not the workspace. No clock involved: the
    // claim names a pid, and the pid either exists or does not.
    const dead: ClaimOwner = { runId: 'dead', host: os.hostname(), pid: 2147483647 };
    const lease = fakeLease({ [WS]: dead });
    expect(acquire(lease).owner.runId).toBe('mine');
  });

  it('honours a live lease from another machine, which it cannot interrogate', () => {
    const remote: ClaimOwner = { runId: 'far', host: 'other-box', pid: 2147483647 };
    expect(() => acquire(fakeLease({ [WS]: remote }))).toThrow(WorkspaceInUseError);
  });

  it('honours a lease whose client is dead but whose remote command is still running', () => {
    // The whole point of recording the remote pid. A `pkill` that matches the client leaves the ssh —
    // and so the command — alive; without this the workspace gets rsynced out from under it, which is
    // the exact collision the lease was built to prevent.
    const orphaned: ClaimOwner = {
      runId: 'orphaned',
      host: os.hostname(),
      pid: 2147483647,
      remotePid: 4242,
    };
    const lease = fakeLease({ [WS]: orphaned }, () => true);
    expect(() => acquire(lease)).toThrow(WorkspaceInUseError);
    expect(lease.held[WS]?.runId).toBe('orphaned');
  });

  it('breaks the lease once the remote command has gone too', () => {
    const finished: ClaimOwner = {
      runId: 'finished',
      host: os.hostname(),
      pid: 2147483647,
      remotePid: 4242,
    };
    expect(
      acquire(fakeLease({ [WS]: finished }, () => false)).owner.runId,
    ).toBe('mine');
  });

  const refusalFor = (held: ClaimOwner): string => {
    const lease = fakeLease({ [WS]: held }, () => true);
    try {
      acquireWorkspace({
        remoteWorkspacePath: WS,
        runId: 'mine',
        lease,
        sshHost: 'mini',
      });
    } catch (e) {
      return (e as Error).message;
    }
    return '';
  };

  it('points an orphaned lease at `bica cancel`, not at a raw ssh kill', () => {
    // The message used to print `ssh <host> kill -TERM -<pgid>` and nothing else. It is correct and
    // nearly unusable: negative pids, and a sandboxed caller often cannot run ssh at all.
    const orphan: ClaimOwner = {
      runId: 'stuck',
      host: os.hostname(),
      pid: 2147483647,
      remotePid: 4242,
    };
    const msg = refusalFor(orphan);
    expect(msg).toMatch(/`bica cancel`/);
    // The by-hand form stays, as a parenthetical, for someone who wants to see what it does.
    expect(msg).toContain('ssh mini kill -TERM -4242');
  });

  it('sends a live holder back to its own terminal before offering --force', () => {
    // Ctrl-C there stops both halves, and it is the only route that lets whoever is watching the
    // output decide. Cancelling someone's live run from another shell should take more intent.
    const msg = refusalFor(liveRun('watched'));
    expect(msg).toMatch(/Ctrl-C/);
    expect(msg).toMatch(/bica cancel --force/);
    expect(msg).not.toMatch(/`bica cancel`/);
  });

  it('offers nothing to act on for a run on another machine', () => {
    // Its pids mean nothing here, and this host cannot tell whether it is healthy.
    const far: ClaimOwner = { runId: 'far', host: 'other-box', pid: 2147483647 };
    expect(() => acquire(fakeLease({ [WS]: far }))).toThrow(
      /Wait for it to finish, or run from a checkout/,
    );
    expect(() => acquire(fakeLease({ [WS]: far }))).not.toThrow(/cancel|kill/);
  });

  it('frees the workspace on release', () => {
    const lease = fakeLease();
    acquire(lease).release();
    expect(lease.held[WS]).toBeUndefined();
    expect(() => acquire(lease)).not.toThrow();
  });
});
