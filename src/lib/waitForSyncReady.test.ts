import { describe, expect, it } from 'vitest';

import { waitForSyncReady } from './mutagenSession';
import type { SessionListParse } from './mutagenSession';
import { describeSyncStall, parseSyncProgress } from './syncProgress';
import type { SyncProgress } from './syncProgress';

/**
 * The report's own expectation, tested at the decision rather than through Mutagen: "bica waits until
 * the tree is on the remote, then the command runs. If it truly cannot wait, it refuses with one of
 * the 'not a verdict' codes and says why, without running the command."
 *
 * The first half is what these cover -- that waiting is now governed by whether the sync is moving
 * and not by a clock, so a first transfer of 180,633 files is waited out rather than abandoned at
 * sixty seconds. Reading the status and reading the progress are injected, because each shells out
 * to Mutagen once per poll; everything in between is the real function.
 */

/** A status reader that answers from a script rather than from Mutagen. */
function statusAfter(
  polls: number,
  before: string,
  after: string,
): (name: string) => SessionListParse {
  let reads = 0;
  return () => {
    reads += 1;
    return { exists: true, status: reads > polls ? after : before };
  };
}

/** A clock the test moves by hand, so a sixty-second stall costs no real time. */
function fakeClock(stepMs: number): { now: () => number; sleep: () => void } {
  let t = 0;
  return {
    now: () => t,
    sleep: () => {
      t += stepMs;
    },
  };
}

function staging(receivedFiles: number): SyncProgress {
  return {
    status: 'staging-beta',
    receivedFiles,
    expectedFiles: 180_633,
    totalReceivedSize: receivedFiles * 16_000,
  };
}

describe('waitForSyncReady, a scan that keeps starting over', () => {
  it('gives up with a cause instead of waiting for ever', () => {
    // The incident: Mutagen scanned, finished a cycle with different counts, and scanned again, about
    // twenty times over three hours. Each change reset the stall clock, so neither budget was ever
    // reached and `bica run` never exited. Nothing was ever staged.
    const clock = fakeClock(500);
    let cycle = 0;
    let polls = 0;
    const result = waitForSyncReady('s', {
      ...clock,
      readStatus: () => ({ exists: true, status: 'Scanning files' }),
      readProgress: () => {
        polls += 1;
        // The counts step every 100 polls (50 s), well inside the 600 s quiet budget, and each cycle
        // is a scan, a reconcile, a wait, and a scan again.
        if (polls % 100 === 0) {
          cycle += 1;
        }
        const phase = polls % 100 < 80 ? 'scanning' : polls % 100 < 90 ? 'reconciling' : 'waiting-for-rescan';
        return { status: phase, alphaFiles: 181_000 + cycle, betaFiles: 181_000 };
      },
    });
    expect(result.ready).toBe(false);
    expect(result.neverStaged).toBe(true);
    expect(result.restarts).toBeGreaterThan(10);
    expect(clock.now()).toBeLessThanOrEqual(1800 * 1000 + 1000);
  });

  it('is not triggered by a transfer that is still staging files', () => {
    const clock = fakeClock(500);
    let staged = 0;
    const result = waitForSyncReady('s', {
      ...clock,
      readStatus: statusAfter(5000, 'Staging files on beta', 'Watching for changes'),
      readProgress: () => {
        staged += 1;
        return staging(staged);
      },
    });
    expect(result.ready).toBe(true);
    expect(result.neverStaged).toBeUndefined();
  });

  it('counts a scan that is followed by staging as progress, however long the scan took', () => {
    const clock = fakeClock(500);
    let polls = 0;
    const result = waitForSyncReady('s', {
      ...clock,
      readStatus: statusAfter(3000, 'Scanning files', 'Watching for changes'),
      readProgress: () => {
        polls += 1;
        // 25 minutes of scan with moving counts, then files begin to go across and keep going.
        return polls < 3000
          ? { status: 'scanning', alphaFiles: polls }
          : staging(polls);
      },
    });
    expect(result.ready).toBe(true);
  });
});

describe('waitForSyncReady', () => {
  it('keeps waiting for a transfer that is still moving, far past a minute', () => {
    // Not ready for six hundred polls: this is the llvm-project case, where the old sixty-second
    // budget expired while the sync was working perfectly well.
    const readStatus = statusAfter(600, 'Staging files on beta', 'Watching for changes');
    const clock = fakeClock(500);
    let staged = 0;
    const result = waitForSyncReady('s', {
      ...clock,
      readStatus,
      readProgress: () => {
        staged += 7;
        return staging(staged);
      },
    });
    expect(result.ready).toBe(true);
    // 600 polls at half a second is five minutes of waiting, which the old version could not do.
    expect(clock.now()).toBeGreaterThan(60_000 * 4);
  });

  it('gives up once nothing has changed for the stall window', () => {
    const clock = fakeClock(500);
    const result = waitForSyncReady('s', {
      ...clock,
      readStatus: () => ({ exists: true, status: 'Staging files on beta' }),
      stallSeconds: 60,
      readProgress: () => staging(42),
    });
    expect(result.ready).toBe(false);
    expect(result.lastStatus).toBe('Staging files on beta');
    expect(result.progress?.receivedFiles).toBe(42);
    expect(clock.now()).toBeGreaterThanOrEqual(60_000);
    expect(clock.now()).toBeLessThan(75_000);
  });

  it('does not count a sync that is still scanning as stalled', () => {
    // Scanning publishes no counts, so only the status moves. A huge tree scans for minutes before
    // it sends a single byte, and calling that a stall would fail the exact repositories at issue.
    const clock = fakeClock(500);
    let flip = 0;
    const result = waitForSyncReady('s', {
      ...clock,
      readStatus: statusAfter(400, 'Scanning', 'Watching for changes'),
      readProgress: () => {
        flip += 1;
        // Alternating between the two states a scan actually passes through.
        return { status: flip % 2 === 0 ? 'scanning' : 'connecting' };
      },
    });
    expect(result.ready).toBe(true);
  });

  it('gives up on a session that never appears at all', () => {
    const result = waitForSyncReady('s', {
      ...fakeClock(500),
      readStatus: () => ({ exists: false, status: null }),
      stallSeconds: 60,
      readProgress: () => null,
    });
    expect(result.ready).toBe(false);
    expect(result.lastStatus).toBeNull();
  });

  it('says where it has got to while a long sync runs', () => {
    const said: string[] = [];
    let staged = 0;
    waitForSyncReady('s', {
      ...fakeClock(500),
      readStatus: statusAfter(120, 'Staging files on beta', 'Watching for changes'),
      onProgress: (line) => said.push(line),
      readProgress: () => {
        staged += 11;
        return staging(staged);
      },
    });
    // A minute of silence on a transfer that takes ten is indistinguishable from a hang.
    expect(said.length).toBeGreaterThan(2);
    expect(said[0]).toContain('files');
  });

  it('stops as soon as the sync is ready, without waiting out any window', () => {
    const clock = fakeClock(500);
    const result = waitForSyncReady('s', {
      ...clock,
      readStatus: () => ({ exists: true, status: 'Watching for changes' }),
      readProgress: () => null,
    });
    expect(result.ready).toBe(true);
    expect(clock.now()).toBe(0);
  });
});

/**
 * Captured from `mutagen sync list --template '{{json .}}'` (0.18.1) for a session whose beta root is a
 * symbolic link that loops, which is the error the report's run showed against the mini. Only the
 * fields bica reads are kept; the rest of the real output is identifiers, paths and empty objects.
 */
const REAL_UNOPENABLE_ROOT = JSON.stringify([
  {
    alpha: { protocol: 'local', connected: true, scanned: false },
    beta: { protocol: 'local', connected: true, scanned: false },
    mode: 'one-way-replica',
    name: 'bica-fixture-loop',
    paused: false,
    status: 'waiting-for-rescan',
    lastError:
      'beta scan error: unable to open synchronization root: too many levels of symbolic links',
  },
]);

describe('waitForSyncReady, a session that cannot open its root', () => {
  it('reads the error out of what Mutagen really prints', () => {
    const progress = parseSyncProgress(REAL_UNOPENABLE_ROOT);
    expect(progress?.status).toBe('waiting-for-rescan');
    expect(progress?.lastError).toContain('too many levels of symbolic links');
  });

  it('stops on the error, names it, and does not call it a scan that restarted', () => {
    // The report's run: `bica run true` printed "Scanning the tree ... restarted N times" for five
    // minutes while Mutagen retried an unopenable root every five seconds and said why on every poll.
    const clock = fakeClock(500);
    const progress = parseSyncProgress(REAL_UNOPENABLE_ROOT);
    const result = waitForSyncReady('s', {
      ...clock,
      readStatus: () => ({ exists: true, status: 'Waiting 5 seconds for rescan' }),
      readProgress: () => progress,
    });
    expect(result.ready).toBe(false);
    expect(result.persistentError).toContain('too many levels of symbolic links');
    expect(result.restarts).toBe(0);
    expect(result.neverStaged).toBeUndefined();
    expect(clock.now()).toBeGreaterThanOrEqual(45_000);
    expect(clock.now()).toBeLessThan(60_000);

    const message = describeSyncStall({
      lastStatus: result.lastStatus,
      progress: result.progress,
      stallSeconds: result.stalledSeconds ?? 0,
      persistentError: result.persistentError,
    });
    expect(message).toContain('too many levels of symbolic links');
    expect(message).toContain('remotePath');
    expect(message).toContain('exit 94 is not a verdict');
    expect(message).not.toContain('large repository');
  });

  it('says so while it is happening, not only at the end', () => {
    const said: string[] = [];
    const progress = parseSyncProgress(REAL_UNOPENABLE_ROOT);
    waitForSyncReady('s', {
      ...fakeClock(500),
      readStatus: () => ({ exists: true, status: 'Waiting 5 seconds for rescan' }),
      readProgress: () => progress,
      onProgress: (line) => said.push(line),
    });
    expect(said[0]).toContain('retrying after an error');
    expect(said[0]).toContain('too many levels of symbolic links');
    expect(said.join('\n')).not.toContain('Scanning the tree');
  });

  it('waits out an error that clears, as a dropped connection does', () => {
    const clock = fakeClock(500);
    let polls = 0;
    const result = waitForSyncReady('s', {
      ...clock,
      readStatus: statusAfter(150, 'Waiting 5 seconds for rescan', 'Watching for changes'),
      readProgress: () => {
        polls += 1;
        // Thirty seconds of error, then a normal cycle: under the 45 s window.
        return polls < 60
          ? { status: 'waiting-for-rescan', lastError: 'beta scan error: connection reset' }
          : { status: 'scanning' };
      },
    });
    expect(result.ready).toBe(true);
    expect(result.persistentError).toBeUndefined();
  });

  it('starts the window again when the error changes', () => {
    const clock = fakeClock(500);
    let polls = 0;
    const result = waitForSyncReady('s', {
      ...clock,
      readStatus: statusAfter(220, 'Waiting 5 seconds for rescan', 'Watching for changes'),
      readProgress: () => {
        polls += 1;
        // A different message every 40 s: no one of them stands for 45 s.
        return {
          status: 'waiting-for-rescan',
          lastError: `beta scan error: attempt ${String(Math.floor(polls / 80))}`,
        };
      },
    });
    expect(result.ready).toBe(true);
  });
});

describe('waitForSyncReady, counting scan restarts', () => {
  it('counts scans that begin again, not changes in the counters', () => {
    // Three scans in a row, with the counts changing all the while: two restarts.
    const clock = fakeClock(500);
    const script = [
      ...Array<string>(40).fill('scanning'),
      ...Array<string>(20).fill('reconciling'),
      ...Array<string>(40).fill('scanning'),
      ...Array<string>(20).fill('waiting-for-rescan'),
      ...Array<string>(40).fill('scanning'),
    ];
    let polls = 0;
    const result = waitForSyncReady('s', {
      ...clock,
      readStatus: statusAfter(script.length, 'Scanning', 'Watching for changes'),
      readProgress: () => {
        const status = script[Math.min(polls, script.length - 1)];
        polls += 1;
        return { status, alphaFiles: polls, betaFiles: polls };
      },
    });
    expect(result.ready).toBe(true);
    expect(result.restarts).toBe(2);
  });

  it('reports no restarts for a tree that was scanned once', () => {
    const clock = fakeClock(500);
    const result = waitForSyncReady('s', {
      ...clock,
      readStatus: statusAfter(100, 'Scanning', 'Watching for changes'),
      readProgress: () => ({ status: 'scanning' }),
    });
    expect(result.ready).toBe(true);
    expect(result.restarts).toBe(0);
  });
});
