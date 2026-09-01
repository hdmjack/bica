import * as os from 'node:os';
import { describe, expect, it } from 'vitest';

import {
  claimFileName,
  claimIsStale,
  describeClaim,
  describeSelfAsOwner,
  formatOwner,
  parseOwner,
} from './remoteClaim';

const alive = (): boolean => true;
const dead = (): boolean => false;

/** Fails the test if consulted: proves the cheap local answer short-circuits the ssh round-trip. */
const remoteNeverAsked = (): boolean => {
  throw new Error('the remote should not have been probed');
};

describe('claimFileName', () => {
  it('gives one claim per remote directory', () => {
    expect(claimFileName('~/code/repo-lane-1')).not.toBe(
      claimFileName('~/code/repo-lane-2'),
    );
  });

  it('is stable regardless of a trailing slash', () => {
    expect(claimFileName('~/code/repo-lane-1/')).toBe(
      claimFileName('~/code/repo-lane-1'),
    );
  });

  it('produces a flat, safe filename', () => {
    // It is used unquoted inside a remote shell path, so nothing exotic may survive.
    expect(claimFileName('~/code/re po/../lane-1')).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('distinguishes clones that differ only deep in the path', () => {
    expect(claimFileName('~/code/float-javascript-lane-1')).not.toBe(
      claimFileName('~/code/float-javascript-5-lane-1'),
    );
  });
});

describe('formatOwner', () => {
  it('writes run id, host and pid in that order', () => {
    expect(formatOwner({ runId: 'r1', host: 'h1', pid: 42 })).toBe('r1 h1 42');
  });

  it('rejects a run id containing whitespace', () => {
    // The remote reads field 1 with `cut -d' '`, so a spaced id would compare against a fragment of
    // itself and every check would fail — silently, and in the direction of refusing everything.
    expect(() => formatOwner({ runId: 'a b', host: 'h', pid: 1 })).toThrow(
      /whitespace/,
    );
    expect(() => formatOwner({ runId: '', host: 'h', pid: 1 })).toThrow();
  });

  it('round-trips through parseOwner', () => {
    const owner = describeSelfAsOwner('run-7');
    expect(parseOwner(formatOwner(owner))).toEqual(owner);
  });
});

describe('parseOwner', () => {
  it('ignores a trailing exit code, which the run appends when it finishes', () => {
    expect(parseOwner('r1 h1 42 0')).toEqual({ runId: 'r1', host: 'h1', pid: 42 });
  });

  it('reads the remote pid the run script publishes', () => {
    expect(parseOwner('r1 h1 42 rpid=7788')).toEqual({
      runId: 'r1',
      host: 'h1',
      pid: 42,
      remotePid: 7788,
    });
  });

  it('keeps the remote pid distinct from the exit code that follows it', () => {
    // Both are optional trailing fields. Untagged, an exit code of 0 would be read as a pid — and
    // `kill -0 0` succeeds, so a finished run would look live and hold the workspace forever.
    expect(parseOwner('r1 h1 42 rpid=7788 0')?.remotePid).toBe(7788);
  });

  it('returns null for content that is not a claim', () => {
    expect(parseOwner('')).toBeNull();
    expect(parseOwner('garbage')).toBeNull();
    expect(parseOwner('r1 h1 not-a-pid')).toBeNull();
  });
});

describe('claimIsStale', () => {
  const here = os.hostname();

  it('treats a claim from this machine with a dead pid and no remote pid as stale', () => {
    // Nothing ever reached the remote, so there is nothing in the workspace to protect. This is what
    // unwedges a workspace after a run is killed — no clock involved.
    expect(claimIsStale({ runId: 'r', host: here, pid: 999 }, dead, dead)).toBe(
      true,
    );
  });

  it('honours a claim from this machine whose owner is alive', () => {
    expect(
      claimIsStale({ runId: 'r', host: here, pid: 999 }, alive, remoteNeverAsked),
    ).toBe(false);
  });

  it('honours a claim whose client is gone but whose remote command is still running', () => {
    // The bug this check exists for. The client and the remote command have different lifetimes —
    // the remote one follows the ssh — so a `pkill` that matches only the client leaves the command
    // executing. Judged on the client pid alone, this claim reads as stale and the next run rsyncs
    // over a live one.
    expect(
      claimIsStale(
        { runId: 'r', host: here, pid: 999, remotePid: 4242 },
        dead,
        alive,
      ),
    ).toBe(false);
  });

  it('treats a claim as stale once both the client and the remote command are gone', () => {
    expect(
      claimIsStale(
        { runId: 'r', host: here, pid: 999, remotePid: 4242 },
        dead,
        dead,
      ),
    ).toBe(true);
  });

  it('does not pay for a remote probe when the local answer already settles it', () => {
    // The probe is an ssh round-trip, and the common contended case — a holder that is plainly alive —
    // must not need one.
    expect(
      claimIsStale({ runId: 'r', host: here, pid: 999 }, alive, remoteNeverAsked),
    ).toBe(false);
    expect(
      claimIsStale({ runId: 'r', host: 'other-host', pid: 999 }, dead, remoteNeverAsked),
    ).toBe(false);
  });

  it('honours a claim from another machine, which it cannot interrogate', () => {
    // Refusing costs a re-run; guessing costs a wrong answer.
    expect(
      claimIsStale({ runId: 'r', host: 'other-host', pid: 999 }, dead, dead),
    ).toBe(false);
  });

  it('treats unreadable content as stale, since a claim is published complete', () => {
    expect(claimIsStale(null, alive, alive)).toBe(true);
  });
});

describe('describeClaim', () => {
  it('names the holder so the refusal is actionable', () => {
    const msg = describeClaim({
      ok: false,
      heldBy: { runId: 'r9', host: 'box', pid: 12 },
      raw: 'r9 box 12',
    });
    expect(msg).toContain('r9');
    expect(msg).toContain('box');
    expect(msg).toContain('12');
  });

  it('degrades to the raw text when the claim cannot be parsed', () => {
    expect(describeClaim({ ok: false, heldBy: null, raw: 'junk' })).toBe('junk');
  });
});
