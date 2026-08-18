import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLockHolder, tryAcquireLock } from './fileLock';
import { acquireLaneForRun } from './laneRun';
import { defaultLaneIdentity, laneIdentity } from './lanes';
import type { HeldLock } from './fileLock';

let repoRoot = '';
const opened: HeldLock[] = [];

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-lane-run-'));
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

function acquire(laneArg: string | undefined, poolSize = 3): ReturnType<typeof acquireLaneForRun> {
  const result = acquireLaneForRun({ repoRoot, laneArg, poolSize });
  opened.push(result.lock);
  return result;
}

describe('acquireLaneForRun — default workspace', () => {
  it('claims the default lane and holds its lock', () => {
    const { lane } = acquire(undefined);
    expect(lane.isDefault).toBe(true);
    expect(readLockHolder(lane.lockFilePath)?.pid).toBe(process.pid);
  });

  it('refuses when another run already owns the checkout, and points at lanes', () => {
    // Two default runs would sync different trees into one remote directory and each would report a
    // result derived from the other's files. An upfront error is the whole point of the lock.
    take(defaultLaneIdentity(repoRoot).lockFilePath);
    expect(() => acquire(undefined)).toThrow(/--lane auto/);
  });
});

describe('acquireLaneForRun — explicit lane', () => {
  it('claims the named lane', () => {
    const { lane } = acquire('2');
    expect(lane.id).toBe('2');
  });

  it('refuses a busy lane and names the holder', () => {
    take(laneIdentity(repoRoot, '2').lockFilePath);
    expect(() => acquire('2')).toThrow(/Lane "2" is already in use/);
    expect(() => acquire('2')).toThrow(new RegExp(String(process.pid)));
  });

  it('rejects an invalid lane id before anything is created', () => {
    expect(() => acquire('../escape')).toThrow(/Invalid lane id/);
  });

  it('does not treat a busy lane as blocking a different one', () => {
    take(laneIdentity(repoRoot, '1').lockFilePath);
    expect(acquire('2').lane.id).toBe('2');
  });
});

describe('acquireLaneForRun — auto', () => {
  it('takes the first lane in the pool', () => {
    expect(acquire('auto').lane.id).toBe('1');
  });

  it('advances past busy lanes', () => {
    take(laneIdentity(repoRoot, '1').lockFilePath);
    take(laneIdentity(repoRoot, '2').lockFilePath);
    expect(acquire('auto').lane.id).toBe('3');
  });

  it('hands concurrent callers different lanes', () => {
    const ids = [acquire('auto').lane.id, acquire('auto').lane.id, acquire('auto').lane.id];
    expect(new Set(ids).size).toBe(3);
  });

  it('errors with the pool size when every lane is busy', () => {
    for (const id of ['1', '2', '3']) {
      take(laneIdentity(repoRoot, id).lockFilePath);
    }
    expect(() => acquire('auto')).toThrow(/All 3 lanes are busy/);
  });

  it('respects the pool size it is given', () => {
    take(laneIdentity(repoRoot, '1').lockFilePath);
    expect(() => acquire('auto', 1)).toThrow(/All 1 lanes are busy/);
  });

  it('reuses a lane whose previous holder died', () => {
    const lane = laneIdentity(repoRoot, '1');
    fs.mkdirSync(path.dirname(lane.lockFilePath), { recursive: true });
    fs.writeFileSync(
      lane.lockFilePath,
      JSON.stringify({ pid: 2147483647, acquiredAt: 'then', command: 'killed run' }),
      'utf8',
    );
    // A hard-killed run must not retire its lane permanently.
    expect(acquire('auto').lane.id).toBe('1');
  });
});
