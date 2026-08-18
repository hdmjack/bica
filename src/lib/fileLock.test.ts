import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireLockWithWait,
  describeLockHolder,
  isProcessAlive,
  readLockHolder,
  tryAcquireLock,
} from './fileLock';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-lock-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Under a not-yet-created `locks/` subdirectory, so acquisition has to create parents. */
function lockPath(name = 'lane.lock'): string {
  return path.join(dir, 'locks', name);
}

describe('tryAcquireLock', () => {
  it('creates the lock file, including missing parents', () => {
    const p = lockPath();
    const lock = tryAcquireLock(p);
    expect(lock).not.toBeNull();
    expect(fs.existsSync(p)).toBe(true);
    lock?.release();
    expect(fs.existsSync(p)).toBe(false);
  });

  it('records this process as the holder', () => {
    const p = lockPath();
    const lock = tryAcquireLock(p);
    expect(readLockHolder(p)?.pid).toBe(process.pid);
    lock?.release();
  });

  it('refuses a lock held by a live process', () => {
    const p = lockPath();
    const first = tryAcquireLock(p);
    expect(first).not.toBeNull();
    // Same pid, but the point is the file exists with a live owner recorded.
    expect(tryAcquireLock(p)).toBeNull();
    first?.release();
  });

  it('takes over a lock whose holder is gone', () => {
    const p = lockPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // pid 2^31-1 is above every platform's pid_max, so it can never be running.
    fs.writeFileSync(
      p,
      JSON.stringify({ pid: 2147483647, acquiredAt: 'then', command: 'dead' }),
      'utf8',
    );
    const lock = tryAcquireLock(p);
    expect(lock).not.toBeNull();
    expect(readLockHolder(p)?.pid).toBe(process.pid);
    lock?.release();
  });

  it('reclaims an unparseable lock file immediately, with no waiting', () => {
    // A lock is published complete in one atomic link, so unparseable content cannot be one of ours
    // mid-write; it is debris or a foreign file, and no elapsed time would change that. Deciding by
    // structure rather than by age is what removed the grace period from this path.
    const p = lockPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'not json at all', 'utf8');
    const lock = tryAcquireLock(p);
    expect(lock).not.toBeNull();
    expect(readLockHolder(p)?.pid).toBe(process.pid);
    lock?.release();
  });

  it('reclaims an empty lock file immediately', () => {
    const p = lockPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf8');
    const lock = tryAcquireLock(p);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  it('leaves only the lock file behind after reclaiming', () => {
    // Every extra file kind is something a reader has to understand, so the lock directory should hold
    // exactly one file per lock and nothing else.
    const p = lockPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'junk', 'utf8');
    const lock = tryAcquireLock(p);
    expect(fs.readdirSync(path.dirname(p))).toEqual([path.basename(p)]);
    lock?.release();
  });

  it('leaves a lock alone once another process has taken it over', () => {
    const p = lockPath();
    const lock = tryAcquireLock(p);
    // Simulate losing it: someone else rewrote the file after a stale takeover.
    fs.writeFileSync(
      p,
      JSON.stringify({ pid: process.pid + 1, acquiredAt: 'now', command: 'other' }),
      'utf8',
    );
    lock?.release();
    expect(fs.existsSync(p)).toBe(true);
    expect(readLockHolder(p)?.pid).toBe(process.pid + 1);
  });

  it('releases idempotently', () => {
    const p = lockPath();
    const lock = tryAcquireLock(p);
    lock?.release();
    expect(() => {
      lock?.release();
    }).not.toThrow();
  });
});

describe('isProcessAlive', () => {
  it('recognises this process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('rejects impossible pids', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(2147483647)).toBe(false);
  });
});

describe('acquireLockWithWait', () => {
  it('returns null once the timeout passes with a live holder', async () => {
    const p = lockPath();
    const held = tryAcquireLock(p);
    const queued = await acquireLockWithWait(p, { timeoutMs: 60, pollMs: 20 });
    expect(queued).toBeNull();
    held?.release();
  });

  it('acquires as soon as the lock is free', async () => {
    const p = lockPath();
    const queued = await acquireLockWithWait(p, { timeoutMs: 200, pollMs: 20 });
    expect(queued).not.toBeNull();
    queued?.release();
  });
});

describe('describeLockHolder', () => {
  it('names the pid so the user can find the run that holds the lane', () => {
    const p = lockPath();
    const lock = tryAcquireLock(p);
    expect(describeLockHolder(p)).toContain(String(process.pid));
    lock?.release();
  });

  it('degrades gracefully with no lock file', () => {
    expect(describeLockHolder(lockPath('missing.lock'))).toBe(
      'an unidentified process',
    );
  });
});
