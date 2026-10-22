import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import { describe, expect, it } from 'vitest';

import {
  claimFileName,
  claimIsStale,
  claimPredatesBoot,
  describeAge,
  describeClaim,
  parseHeldReport,
  describeSelfAsOwner,
  formatOwner,
  parseOwner,
  REMOTE_BOOT_REPORT,
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
    expect(claimFileName('~/code/web-app-lane-1')).not.toBe(
      claimFileName('~/code/web-app-5-lane-1'),
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
      remotePids: [7788],
    });
  });

  it('reads every remote pid, for a run of several commands at once', () => {
    // One connection per command, each publishing the group it leads. `remotePid` stays as the first
    // so that a reader written before concurrent runs existed still finds what it expects.
    const owner = parseOwner('r1 h1 42 rpid=7788 rpid=7799 rpid=7801');
    expect(owner?.remotePids).toEqual([7788, 7799, 7801]);
    expect(owner?.remotePid).toBe(7788);
  });

  it('a run is alive while any of its groups is', () => {
    // This machine's hostname: a claim from another machine is never judged stale, so a fake one
    // would make the assertion pass for a reason that has nothing to do with process groups.
    const owner = parseOwner(`r1 ${os.hostname()} 42 rpid=10 rpid=11`);
    const dead = () => false;
    const onlySecondAlive = (pid: number) => pid === 11;
    // Judging by the first group alone would free the workspace while the second was still writing.
    expect(claimIsStale(owner, dead, onlySecondAlive)).toBe(false);
    expect(claimIsStale(owner, dead, dead)).toBe(true);
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

describe('describeAge', () => {
  it('reads as a duration at every scale a run reaches', () => {
    expect(describeAge(0)).toBe('0s');
    expect(describeAge(45)).toBe('45s');
    expect(describeAge(60)).toBe('1m');
    expect(describeAge(6 * 60 + 30)).toBe('6m');
    expect(describeAge(3600)).toBe('1h0m');
    expect(describeAge(3600 + 25 * 60)).toBe('1h25m');
  });

  it('does not invent a duration from a negative difference', () => {
    // Both readings come from the remote clock, so this should not happen — but a claim written by an
    // older bica, or one whose stamp was recorded some other way, must not produce "-3s".
    expect(describeAge(-3)).toBe('an unknown time');
  });
});

describe('describeClaim', () => {
  it('says how long the holder has been running, and what', () => {
    // "Wait for it to finish" is open-ended without these. One incident waited six minutes on a run
    // it could not see.
    const msg = describeClaim({
      ok: false,
      heldBy: {
        runId: 'r1',
        host: 'mac',
        pid: 42,
        remotePid: 7788,
        startedAt: 1000,
      },
      raw: '',
      now: 1270,
      command: 'pnpm test:run common/src',
    });
    expect(msg).toContain('for 4m');
    expect(msg).toContain('pnpm test:run common/src');
  });

  it('omits the age rather than guessing when the claim predates the stamp', () => {
    const msg = describeClaim({
      ok: false,
      heldBy: { runId: 'r1', host: 'mac', pid: 42 },
      raw: '',
      now: 1270,
    });
    expect(msg).not.toContain('for ');
    expect(msg).toContain('run r1 from mac');
  });
});

describe('parseHeldReport', () => {
  it('reads the owner, command and clock out of one reply', () => {
    const r = parseHeldReport('HELD r1 mac 42 t=900 rpid=7788\nNOW 1200\nCMD pnpm lint\n');
    expect(r.heldBy?.startedAt).toBe(900);
    expect(r.heldBy?.remotePid).toBe(7788);
    expect(r.now).toBe(1200);
    expect(r.command).toBe('pnpm lint');
  });

  it('still yields the owner when the decorative parts are missing', () => {
    // A claim taken by an older bica has no stamp and no sidecar. Label-matched parsing degrades to
    // the owner rather than to nothing.
    const r = parseHeldReport('HELD r1 mac 42\nNOW 1200\nCMD \n');
    expect(r.heldBy?.runId).toBe('r1');
    expect(r.command).toBeUndefined();
  });
});

describe('describeClaim, identifiers', () => {
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

/**
 * A claim from before the remote's last restart. The incident: a hard reboot left seven, one naming
 * process groups 798 to 801 while the freshly booted remote was handing out pid 539.
 */
describe('a claim from before the remote restarted', () => {
  const here = os.hostname();
  const BOOT = 1_792_692_016;
  const beforeReboot = {
    runId: 'r',
    host: here,
    pid: 999,
    remotePids: [798, 799, 800, 801],
    remotePid: 798,
    startedAt: BOOT - 3 * 60 * 60,
  };

  it('is void even when one of its numbers now belongs to a live process', () => {
    expect(claimIsStale(beforeReboot, dead, alive, BOOT)).toBe(true);
  });

  it('is void from another machine too, since nothing of it can be running', () => {
    expect(claimIsStale({ ...beforeReboot, host: 'other-host' }, alive, alive, BOOT)).toBe(true);
  });

  it('is judged by its pids as before when the boot time or its own stamp is unknown', () => {
    expect(claimIsStale(beforeReboot, dead, alive)).toBe(false);
    expect(claimIsStale({ ...beforeReboot, startedAt: undefined }, dead, alive, BOOT)).toBe(false);
  });

  it('leaves a claim taken after the boot, or within the margin around it, to the pid checks', () => {
    // The margin is on the side of honouring: reading a live claim as void would sync over a build.
    expect(claimPredatesBoot({ ...beforeReboot, startedAt: BOOT + 60 }, BOOT)).toBe(false);
    expect(claimPredatesBoot({ ...beforeReboot, startedAt: BOOT - 10 }, BOOT)).toBe(false);
    expect(claimPredatesBoot({ ...beforeReboot, startedAt: BOOT - 31 }, BOOT)).toBe(true);
  });

  it('reads the boot time the remote reports beside its clock', () => {
    const report = parseHeldReport(
      `HELD r ${here} 999 t=${String(BOOT - 100)} rpid=798\nNOW ${String(BOOT + 300)}\nBOOT ${String(BOOT)}\nCMD pnpm test\n`,
    );
    expect(report.bootedAt).toBe(BOOT);
    expect(parseHeldReport(`HELD r ${here} 999\nBOOT \n`).bootedAt).toBeUndefined();
  });

  it("asks the shell for this machine's boot time and gets it", () => {
    // Run for real, because the `sed` that picks `sec` out of macOS's `{ sec = …, usec = … }` is the
    // part that can be quietly wrong -- matching `usec` would give a number of microseconds.
    const { stdout } = spawnSync('sh', ['-c', REMOTE_BOOT_REPORT], { encoding: 'utf8' });
    const reported = parseHeldReport(stdout).bootedAt;
    const expected = Date.now() / 1000 - os.uptime();
    expect(reported).toBeDefined();
    expect(Math.abs((reported ?? 0) - expected)).toBeLessThan(5);
  });
});

