import { describe, expect, it } from 'vitest';

import { waitForSyncReady } from './mutagenSession';
import type { SessionListParse } from './mutagenSession';
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
        // The counts step every 100 polls (50 s), well inside the 600 s quiet budget.
        if (polls % 100 === 0) {
          cycle += 1;
        }
        return { status: 'scanning', alphaFiles: 181_000 + cycle, betaFiles: 181_000 };
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
