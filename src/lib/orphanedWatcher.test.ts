import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { startOrphanedWatcher, stopOrphanedWatcher } from './orphanedWatcher';

const parentOf = (pid: number): number =>
  Number(spawnSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('startOrphanedWatcher', () => {
  it('is not a descendant of this process, so killing our tree cannot reach it', () => {
    // As reported: an agent's shell tool killed bica and every descendant, the detached watcher
    // included, and the run's command went on with nobody reading it.
    const pid = startOrphanedWatcher('sleep 30');
    expect(pid).toBeDefined();
    try {
      expect(alive(pid!)).toBe(true);
      expect(parentOf(pid!)).not.toBe(process.pid);
    } finally {
      stopOrphanedWatcher(pid);
    }
  });

  it('runs its script, and does not once stopped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-orphan-'));
    try {
      const ran = path.join(dir, 'ran');
      const stopped = path.join(dir, 'stopped');
      startOrphanedWatcher(`touch '${ran}'`);
      const pid = startOrphanedWatcher(`sleep 1; touch '${stopped}'`);
      stopOrphanedWatcher(pid);
      spawnSync('sleep', ['2']);
      expect(fs.existsSync(ran)).toBe(true);
      expect(fs.existsSync(stopped)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
