import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tryAcquireLock } from './fileLock';
import { countRunsInFlight, shouldPullReturnFlow } from './laneRun';
import { defaultLaneIdentity, laneIdentity, lockRootDir } from './lanes';
import type { HeldLock } from './fileLock';

let repoRoot = '';
const opened: HeldLock[] = [];

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-rf-'));
});

afterEach(() => {
  while (opened.length > 0) {
    opened.pop()?.release();
  }
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

function take(lockFilePath: string): void {
  const lock = tryAcquireLock(lockFilePath);
  if (lock === null) {
    throw new Error(`test setup could not take ${lockFilePath}`);
  }
  opened.push(lock);
}

function writeDeadLock(lockFilePath: string): void {
  fs.mkdirSync(path.dirname(lockFilePath), { recursive: true });
  fs.writeFileSync(
    lockFilePath,
    JSON.stringify({ pid: 2147483647, acquiredAt: 'then', command: 'killed' }),
    'utf8',
  );
}

describe('countRunsInFlight', () => {
  it('is zero with no locks at all', () => {
    expect(countRunsInFlight(repoRoot, 4)).toBe(0);
  });

  it('counts the default workspace run', () => {
    take(defaultLaneIdentity(repoRoot).lockFilePath);
    expect(countRunsInFlight(repoRoot, 4)).toBe(1);
  });

  it('counts each live lane', () => {
    take(laneIdentity(repoRoot, '1').lockFilePath);
    take(laneIdentity(repoRoot, '2').lockFilePath);
    expect(countRunsInFlight(repoRoot, 4)).toBe(2);
  });

  it('counts a lane outside the current pool', () => {
    // The pool may have shrunk since that run started; it is still a live run.
    take(laneIdentity(repoRoot, '9').lockFilePath);
    expect(countRunsInFlight(repoRoot, 2)).toBe(1);
  });

  it('ignores a lane whose holder died', () => {
    writeDeadLock(laneIdentity(repoRoot, '1').lockFilePath);
    expect(countRunsInFlight(repoRoot, 4)).toBe(0);
  });

  it('does not count phase locks as runs', () => {
    // These are held for a phase of one run, not for a run, so counting them would make a single
    // run look like several and needlessly suppress its return-flow pull.
    take(laneIdentity(repoRoot, '1').lockFilePath);
    for (const name of [
      '_return-flow.lock',
      '_git-worktree.lock',
      '_remote-install.lock',
    ]) {
      take(path.join(lockRootDir(repoRoot), name));
    }
    expect(countRunsInFlight(repoRoot, 4)).toBe(1);
  });

  it('still counts the default lock, whose name also begins with an underscore', () => {
    take(defaultLaneIdentity(repoRoot).lockFilePath);
    take(path.join(lockRootDir(repoRoot), '_return-flow.lock'));
    expect(countRunsInFlight(repoRoot, 4)).toBe(1);
  });

  it('does not steal a stale lock while counting', () => {
    const stale = laneIdentity(repoRoot, '1').lockFilePath;
    writeDeadLock(stale);
    countRunsInFlight(repoRoot, 4);
    // Counting is read-only: the file is left exactly as found, for acquisition to deal with.
    expect(fs.existsSync(stale)).toBe(true);
  });
});

describe('shouldPullReturnFlow', () => {
  it('pulls when this run is the only one — the ordinary case', () => {
    // Making lanes the default must not silently stop snapshots coming back.
    expect(
      shouldPullReturnFlow({ explicitOptIn: false, runsInFlight: 1 }),
    ).toBe(true);
  });

  it('skips when other runs are in flight', () => {
    expect(
      shouldPullReturnFlow({ explicitOptIn: false, runsInFlight: 2 }),
    ).toBe(false);
  });

  it('honours an explicit --return-flow even in a fan-out', () => {
    expect(shouldPullReturnFlow({ explicitOptIn: true, runsInFlight: 5 })).toBe(
      true,
    );
  });

  it('pulls when the count could not see this run', () => {
    // A zero count means lock inspection found nothing; treat it as "alone" rather than suppressing
    // return-flow on the strength of a reading we do not trust.
    expect(
      shouldPullReturnFlow({ explicitOptIn: false, runsInFlight: 0 }),
    ).toBe(true);
  });
});
