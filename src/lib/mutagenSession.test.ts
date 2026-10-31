import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildSyncWatchdogScript,
  parseSyncListTemplateLine,
  waitForSyncReady,
} from './mutagenSession';

describe('parseSyncListTemplateLine', () => {
  it('parses a 4-field session line', () => {
    const summary = parseSyncListTemplateLine(
      'web-app|sync_lJvWnsi5|/Users/me/code/web-app|mini:~/code/web-app',
    );
    expect(summary).toEqual({
      name: 'web-app',
      identifier: 'sync_lJvWnsi5',
      alpha: '/Users/me/code/web-app',
      beta: 'mini:~/code/web-app',
    });
  });

  it('returns null for malformed lines', () => {
    expect(parseSyncListTemplateLine('')).toBeNull();
    expect(parseSyncListTemplateLine('name|id|alpha')).toBeNull();
    expect(parseSyncListTemplateLine('|id|alpha|beta')).toBeNull();
    expect(parseSyncListTemplateLine('name||alpha|beta')).toBeNull();
  });
});

describe('a scan is not a stall', () => {
  // The reported failure: `bica run true` on an llvm-project checkout (181,755 files) at local
  // load 20 sat in "Scanning files" and was declared stalled after 60s, three times in a row,
  // while the remote was idle and reachable. Scanning publishes no number that moves, so the
  // fingerprint is byte-identical from one poll to the next however hard Mutagen is working.
  const scanning = {
    status: 'scanning',
    alphaFiles: 181755,
    betaFiles: 181755,
  };

  function clock(stepMs: number) {
    let t = 0;
    return () => (t += stepMs);
  }

  it('waits far longer than 60s while the status is one that publishes nothing', () => {
    let polls = 0;
    const out = waitForSyncReady('s', {
      stallSeconds: 60,
      quietStallSeconds: 600,
      now: clock(10_000),
      sleep: () => undefined,
      readProgress: () => scanning,
      readStatus: () => {
        polls += 1;
        return { exists: true, status: 'Scanning files' };
      },
    });
    expect(out.ready).toBe(false);
    expect(out.stalledSeconds).toBe(600);
    // 60s would have ended it after a handful of polls; it kept going for the larger budget.
    expect(polls).toBeGreaterThan(30);
  });

  it('becomes ready when the scan finishes, rather than being killed part-way', () => {
    let polls = 0;
    const out = waitForSyncReady('s', {
      stallSeconds: 60,
      quietStallSeconds: 600,
      now: clock(10_000),
      sleep: () => undefined,
      readProgress: () => scanning,
      readStatus: () => {
        polls += 1;
        return polls > 20
          ? { exists: true, status: 'Watching for changes' }
          : { exists: true, status: 'Scanning files' };
      },
    });
    // 20 polls at 10s of simulated time each is well past the 60s that used to end it.
    expect(out.ready).toBe(true);
  });

  it('still calls a stalled transfer stalled on the shorter budget', () => {
    // Staging publishes files and bytes that climb while it works, so stillness there is real
    // evidence and must not inherit the scan's patience.
    const out = waitForSyncReady('s', {
      stallSeconds: 60,
      quietStallSeconds: 600,
      now: clock(10_000),
      sleep: () => undefined,
      readProgress: () => ({
        status: 'staging-beta',
        receivedFiles: 10,
        expectedFiles: 1000,
        totalReceivedSize: 1024,
      }),
      readStatus: () => ({ exists: true, status: 'Staging files on beta' }),
    });
    expect(out.ready).toBe(false);
    expect(out.stalledSeconds).toBe(60);
  });
});

describe('the watchdog that ends a dead run\'s sync', () => {
  /**
   * Run the real script with a stand-in `mutagen` that records what it was asked, against a process
   * that is then killed the way the reported run was.
   */
  function runWatchdog(lockContent: string): {
    calls: string;
    lockLeft: boolean;
    markerLeft: boolean;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica watchdog '));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      const log = path.join(dir, 'calls');
      fs.writeFileSync(path.join(bin, 'mutagen'), `#!/bin/sh\necho "$@" >> '${log}'\n`, {
        mode: 0o755,
      });
      // A grandchild, so that once killed it is reaped by init as bica would be by its shell. A
      // direct child would linger as a zombie, which `kill -0` still counts as alive.
      const pid = Number(
        spawnSync('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim(),
      );
      const lockPath = path.join(dir, "project.yml.lock");
      const markerPath = path.join(dir, 'live-run');
      fs.writeFileSync(lockPath, lockContent);
      fs.writeFileSync(markerPath, `${String(pid)}\n`);
      process.kill(pid, 'SIGKILL');
      const result = spawnSync(
        'sh',
        ['-c', buildSyncWatchdogScript({ pid, projectId: 'proj_abc', lockPath, markerPath })],
        { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, timeout: 20_000 },
      );
      expect(result.status).toBe(0);
      return {
        calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
        lockLeft: fs.existsSync(lockPath),
        markerLeft: fs.existsSync(markerPath),
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('ends the run\'s project and clears its lock and marker once the run is gone', () => {
    const outcome = runWatchdog('proj_abc');
    expect(outcome.calls).toContain('sync terminate --label-selector io.mutagen.project=proj_abc\n');
    expect(outcome.lockLeft).toBe(false);
    expect(outcome.markerLeft).toBe(false);
  });

  it('leaves a lock a later run from the same checkout has taken', () => {
    const outcome = runWatchdog('proj_later');
    expect(outcome.calls).toContain('io.mutagen.project=proj_abc');
    expect(outcome.lockLeft).toBe(true);
  });
});

describe('the watchdog removes the session caches it leaves behind', () => {
  /**
   * The real script, with a stand-in `mutagen` that lists one session and a stand-in `ssh` that
   * records what it was asked to run, in a data directory of its own.
   */
  function runWatchdogWithCaches(betaHost: string): {
    localLeft: string[];
    sshCalls: string;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica watchdog caches '));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      const data = path.join(dir, 'mutagen data');
      const caches = path.join(data, 'caches');
      fs.mkdirSync(caches, { recursive: true });
      for (const name of ['sync_AAA_alpha', 'sync_AAA_beta', 'sync_BBB_alpha']) {
        fs.writeFileSync(path.join(caches, name), '');
      }
      const sshLog = path.join(dir, 'ssh calls');
      fs.writeFileSync(
        path.join(bin, 'mutagen'),
        `#!/bin/sh\n[ "$2" = list ] && printf '%s\\n' 'sync_AAA|${betaHost}' 'bad id;rm -rf /|${betaHost}'\nexit 0\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\necho "$@" >> '${sshLog}'\n`, {
        mode: 0o755,
      });
      const pid = Number(
        spawnSync('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim(),
      );
      process.kill(pid, 'SIGKILL');
      const result = spawnSync(
        'sh',
        [
          '-c',
          buildSyncWatchdogScript({
            pid,
            projectId: 'proj_abc',
            lockPath: path.join(dir, 'project.yml.lock'),
            markerPath: path.join(dir, 'live-run'),
          }),
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            MUTAGEN_DATA_DIRECTORY: data,
          },
          timeout: 20_000,
        },
      );
      expect(result.status).toBe(0);
      return {
        localLeft: fs.readdirSync(caches).sort(),
        sshCalls: fs.existsSync(sshLog) ? fs.readFileSync(sshLog, 'utf8') : '',
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('deletes the ended session\'s two files here and asks the remote to delete its own', () => {
    const outcome = runWatchdogWithCaches('mini');
    // Only the ended session's files: another session's cache is not this run's to remove.
    expect(outcome.localLeft).toEqual(['sync_BBB_alpha']);
    expect(outcome.sshCalls).toContain('-- mini d="${MUTAGEN_DATA_DIRECTORY:-$HOME/.mutagen}/caches"');
    expect(outcome.sshCalls).toContain('"$d/sync_AAA_alpha" "$d/sync_AAA_beta"');
    // The malformed identifier never reached a command.
    expect(outcome.sshCalls).not.toContain('rm -rf');
  });

  it('does not reach for ssh when the session\'s other end is a local folder', () => {
    expect(runWatchdogWithCaches('').sshCalls).toBe('');
  });
});
