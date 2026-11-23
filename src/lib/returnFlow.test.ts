import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrepareResult } from '../syncProject';
import {
  buildReturnFlowExcludes,
  buildRemoteRemovalScript,
  buildReturnFlowCopyArgs,
  buildReturnFlowRsyncArgs,
  obsoleteReturnFlowFiles,
  parentsDeepestFirst,
  pushReturnFlowToRemote,
  splitRsyncUrl,
  GIT_TRANSIENT_PATTERNS,
  gitSyncStopsRun,
  pushGitToRemote,
  rsyncGit,
  escapeRsyncPattern,
  outputFilesInside,
  parseLsofNames,
  parseRsyncListing,
  pathsChangedBetween,
  pullReturnFlow,
  snapshotReturnFlowFiles,
} from './returnFlow';
import { SYNC_NOT_READY_EXIT } from './syncProgress';

describe('buildReturnFlowRsyncArgs', () => {
  it('emits include filters for every pattern, plus a final exclude', () => {
    const args = buildReturnFlowRsyncArgs([
      '**/__snapshots__/**',
      '**/*.snap',
    ]);
    expect(args).toEqual([
      '--prune-empty-dirs',
      '--filter=+ */',
      '--filter=+ **/__snapshots__/**',
      '--filter=+ **/*.snap',
      '--filter=- *',
    ]);
  });

  it('still emits the include-dir + exclude-everything filters when patterns is empty', () => {
    const args = buildReturnFlowRsyncArgs([]);
    expect(args).toEqual([
      '--prune-empty-dirs',
      '--filter=+ */',
      '--filter=- *',
    ]);
  });

  it('rules out excluded trees before anything else so rsync never descends into them', () => {
    const args = buildReturnFlowRsyncArgs(
      ['**/*.snap'],
      ['.git', 'node_modules', 'dist'],
    );
    expect(args).toEqual([
      '--prune-empty-dirs',
      '--filter=- .git',
      '--filter=- node_modules',
      '--filter=- dist',
      '--filter=+ */',
      '--filter=+ **/*.snap',
      '--filter=- *',
    ]);
    // First matching rule wins: the excludes must precede the descend-everywhere include.
    expect(args.indexOf('--filter=- node_modules')).toBeLessThan(
      args.indexOf('--filter=+ */'),
    );
  });
});

describe('buildReturnFlowExcludes', () => {
  it('always excludes .git, which is mirrored separately', () => {
    expect(buildReturnFlowExcludes([])).toContain('.git');
  });

  it('always excludes .bica, so a pull cannot reach the lock directory', () => {
    expect(buildReturnFlowExcludes([])).toContain('.bica');
  });

  it('excludes the trees each side owns independently', () => {
    expect(
      buildReturnFlowExcludes(['node_modules', 'dist', '.playwright-mcp']),
    ).toEqual(['.git', '.bica', 'node_modules', 'dist', '.playwright-mcp']);
  });

  it('does not repeat .git when the config also ignores it', () => {
    expect(buildReturnFlowExcludes(['.git', 'node_modules'])).toEqual([
      '.git',
      '.bica',
      'node_modules',
    ]);
  });

  it('drops blanks and Mutagen negations, which say nothing about return-flow ownership', () => {
    expect(
      buildReturnFlowExcludes(['  node_modules  ', '', '!dist/keep']),
    ).toEqual(['.git', '.bica', 'node_modules']);
  });
});

describe('buildReturnFlowCopyArgs', () => {
  const patterns = ['**/__snapshots__/**', '**/*.snap'];

  it('copies the whitelist with no --delete, and puts source before dest', () => {
    const args = buildReturnFlowCopyArgs(
      patterns,
      'mini:~/code/foo/',
      '/local/foo/',
    );
    expect(args).toEqual([
      '-az',
      '--prune-empty-dirs',
      '--filter=+ */',
      '--filter=+ **/__snapshots__/**',
      '--filter=+ **/*.snap',
      '--filter=- *',
      'mini:~/code/foo/',
      '/local/foo/',
    ]);
    // With --prune-empty-dirs the sender leaves out every directory holding no return-flow file, and a
    // receiver deleting against that list tries to remove all of them. Never pair the two.
    expect(args.some((a) => a.startsWith('--delete'))).toBe(false);
  });

  it('passes excluded trees through ahead of the descend-everywhere include', () => {
    const args = buildReturnFlowCopyArgs(
      patterns,
      'mini:~/code/foo/',
      '/local/foo/',
      ['.git', 'node_modules'],
    );
    expect(args).toContain('--filter=- node_modules');
    expect(args.indexOf('--filter=- node_modules')).toBeLessThan(
      args.indexOf('--filter=+ */'),
    );
  });

  it('is direction-agnostic — same builder used for push (local→remote) and pull (remote→local)', () => {
    const push = buildReturnFlowCopyArgs(patterns, '/local/', 'mini:~/r/');
    const pull = buildReturnFlowCopyArgs(patterns, 'mini:~/r/', '/local/');
    expect(push.slice(-2)).toEqual(['/local/', 'mini:~/r/']);
    expect(pull.slice(-2)).toEqual(['mini:~/r/', '/local/']);
    expect(push.slice(0, -2)).toEqual(pull.slice(0, -2));
  });
});

describe('splitRsyncUrl', () => {
  it('reads a colon before the first slash as a host, as rsync does', () => {
    expect(splitRsyncUrl('mini:code/repo')).toEqual({ host: 'mini', path: 'code/repo' });
    expect(splitRsyncUrl('mini:~/code/repo')).toEqual({ host: 'mini', path: '~/code/repo' });
    expect(splitRsyncUrl('mini:')).toEqual({ host: 'mini', path: '' });
  });

  it('reads a path, including one with a colon after a slash, as local', () => {
    expect(splitRsyncUrl('/Users/me/repo')).toEqual({ host: null, path: '/Users/me/repo' });
    expect(splitRsyncUrl('/tmp/a:b')).toEqual({ host: null, path: '/tmp/a:b' });
  });
});

describe('obsoleteReturnFlowFiles', () => {
  const listing = (...files: string[]): Map<string, string> =>
    new Map(files.map((f) => [f, '1:2026/11/23 00:00:00']));

  it('is the files the receiver has and the sender does not, minus those kept', () => {
    expect(
      obsoleteReturnFlowFiles(
        listing('a/__snapshots__/a.snap'),
        listing('a/__snapshots__/a.snap', 'b/__snapshots__/b.snap', 'run.log', 'kept.log'),
        ['kept.log'],
      ),
    ).toEqual(['b/__snapshots__/b.snap', 'run.log']);
  });

  it('never yields a path that could leave the root', () => {
    expect(
      obsoleteReturnFlowFiles(listing(), listing('../x.log', '/etc/x.log', 'a/../b.log', './c.log', 'ok.log')),
    ).toEqual(['ok.log']);
  });
});

describe('parentsDeepestFirst', () => {
  it('lists each directory above the files once, deepest first, never the root', () => {
    expect(parentsDeepestFirst(['a/b/__snapshots__/x.snap', 'a/b/__snapshots__/y.snap', 'a/c.log', 'top.log'])).toEqual([
      'a/b/__snapshots__',
      'a/b',
      'a',
    ]);
  });
});

describe('buildRemoteRemovalScript', () => {
  it('removes the named files and only the directories that left empty, when run by sh', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bica removal 'quoted' "));
    try {
      fs.mkdirSync(path.join(dir, 'ui/__snapshots__'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'ui/scripts'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'ui/empty'), { recursive: true });
      fs.writeFileSync(path.join(dir, "ui/__snapshots__/it's.snap"), 'x');
      fs.writeFileSync(path.join(dir, 'ui/scripts/x.js'), 'x');
      const script = buildRemoteRemovalScript(dir, ["ui/__snapshots__/it's.snap", 'gone/already.log']);
      expect(spawnSync('sh', ['-s'], { input: script }).status).toBe(0);
      expect(fs.existsSync(path.join(dir, 'ui/__snapshots__'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'ui/scripts/x.js'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'ui/empty'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops before removing anything when the root cannot be entered', () => {
    const script = buildRemoteRemovalScript('/nonexistent/bica/root', ['a.log']);
    expect(spawnSync('sh', ['-s'], { input: script, stdio: ['pipe', 'ignore', 'ignore'] }).status).toBe(3);
  });
});

describe('a return-flow mirror leaves directories alone', () => {
  // The reported symptom: after a `bica run`, openrsync printed "not empty, cannot delete" for a dozen
  // tracked source directories in the checkout. The pull's --delete, against a sender list that
  // --prune-empty-dirs had stripped of every directory without a snapshot or log, was trying to remove
  // them. Files inside were protected and survived; an empty directory was removed.
  const rsync = spawnSync('rsync', ['--version']);

  function tree(root: string, files: Record<string, string>, emptyDirs: string[] = []): void {
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    }
    for (const d of emptyDirs) {
      fs.mkdirSync(path.join(root, d), { recursive: true });
    }
  }

  it.runIf(rsync.status === 0)('pull: removes the obsolete snapshot and nothing else, and rsync says nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica pull dirs '));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const remote = path.join(dir, 'remote');
      const local = path.join(dir, 'local');
      const source = {
        '.husky/_/h': 'h',
        'ui/scripts/x.js': 's',
        'ui/__snapshots__/kept.snap': 'k',
      };
      tree(remote, source);
      tree(local, { ...source, 'ui/old/__snapshots__/obsolete.snap': 'o', 'gone/keep.ts': 'g' }, ['ui/empty', 'newwork/nested']);
      const prep = {
        repoRoot: local,
        remoteSyncUrl: remote,
        returnFlowPaths: ['**/__snapshots__/**'],
        syncIgnorePaths: [],
      } as unknown as PrepareResult;

      expect(pullReturnFlow(prep).exitCode).toBe(0);

      expect(fs.existsSync(path.join(local, 'ui/old/__snapshots__/obsolete.snap'))).toBe(false);
      // Emptied by the removal, so it goes; its parent held only that and goes too.
      expect(fs.existsSync(path.join(local, 'ui/old'))).toBe(false);
      for (const kept of ['.husky/_/h', 'ui/scripts/x.js', 'ui/__snapshots__/kept.snap', 'gone/keep.ts', 'ui/empty', 'newwork/nested']) {
        expect(fs.existsSync(path.join(local, kept)), kept).toBe(true);
      }
      const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(printed).not.toContain('cannot delete');
      expect(printed).toContain('return-flow pull (remote → here): removed 1 file here');
      expect(printed).toContain('ui/old/__snapshots__/obsolete.snap');
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(rsync.status === 0)('pull: removes the last obsolete snapshot when the remote has none at all', () => {
    // openrsync skips deletion when the sender's list is empty, so --delete never removed this one.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica pull none '));
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const remote = path.join(dir, 'remote');
      const local = path.join(dir, 'local');
      tree(remote, { 'src/a.ts': 'a' });
      tree(local, { 'src/a.ts': 'a', 'src/__snapshots__/a.snap': 'old' });
      const prep = {
        repoRoot: local,
        remoteSyncUrl: remote,
        returnFlowPaths: ['**/__snapshots__/**'],
        syncIgnorePaths: [],
      } as unknown as PrepareResult;
      expect(pullReturnFlow(prep).exitCode).toBe(0);
      expect(fs.existsSync(path.join(local, 'src/__snapshots__'))).toBe(false);
      expect(fs.existsSync(path.join(local, 'src/a.ts'))).toBe(true);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(rsync.status === 0)('push: resets the remote\'s snapshots and leaves its directories alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica push dirs '));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const remote = path.join(dir, 'remote');
      const local = path.join(dir, 'local');
      tree(local, { 'ui/scripts/x.js': 's', 'ui/__snapshots__/new.snap': 'n' }, ['ui/empty']);
      tree(remote, { 'ui/scripts/x.js': 's', 'other/__snapshots__/stale.snap': 'st' }, ['ui/empty', 'remote-only/empty']);
      const prep = {
        repoRoot: local,
        remoteSyncUrl: remote,
        returnFlowPaths: ['**/__snapshots__/**'],
        syncIgnorePaths: [],
      } as unknown as PrepareResult;

      expect(pushReturnFlowToRemote(prep, snapshotReturnFlowFiles(prep)).exitCode).toBe(0);

      expect(fs.readFileSync(path.join(remote, 'ui/__snapshots__/new.snap'), 'utf8')).toBe('n');
      expect(fs.existsSync(path.join(remote, 'other'))).toBe(false);
      for (const kept of ['ui/scripts/x.js', 'ui/empty', 'remote-only/empty']) {
        expect(fs.existsSync(path.join(remote, kept)), kept).toBe(true);
      }
      const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(printed).not.toContain('cannot delete');
      expect(printed).toContain('return-flow refresh (here → remote): removed 1 file on the remote');
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rsyncGit', () => {
  const answers = (...statuses: number[]) => {
    const calls: number[] = [];
    let i = 0;
    const run = () => {
      const status = statuses[Math.min(i, statuses.length - 1)];
      i += 1;
      calls.push(status);
      return { status, stdout: '', stderr: status === 0 ? '' : 'rsync error: some files could not be transferred (code 23)' };
    };
    return { run, calls };
  };

  it('tries once more after a failure, and reports the second answer', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const flaky = answers(23, 0);
    expect(rsyncGit(['-az'], flaky.run)).toEqual({ ran: true, exitCode: 0 });
    expect(flaky.calls).toEqual([23, 0]);

    const broken = answers(23, 23);
    expect(rsyncGit(['-az'], broken.run)).toEqual({ ran: true, exitCode: 23 });
    vi.restoreAllMocks();
  });

  it('counts a vanished file as a complete copy, since what vanishes from .git is transient', () => {
    const vanished = answers(24);
    expect(rsyncGit(['-az'], vanished.run)).toEqual({ ran: true, exitCode: 0 });
    expect(vanished.calls).toEqual([24]);
  });
});

describe('gitSyncStopsRun', () => {
  it('stops the run with 94 when the .git sync did not complete, before anything runs', () => {
    let said = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      said += String(chunk);
      return true;
    });
    expect(gitSyncStopsRun({ ran: true, exitCode: 23 }, 'mini')).toBe(SYNC_NOT_READY_EXIT);
    expect(said).toContain('The .git sync to mini did not complete');
    expect(said).toContain('not a verdict on your code');
    vi.restoreAllMocks();
  });

  it('lets a completed or skipped sync go ahead', () => {
    expect(gitSyncStopsRun({ ran: true, exitCode: 0 }, 'mini')).toBeUndefined();
    expect(gitSyncStopsRun({ ran: false }, 'mini')).toBeUndefined();
  });
});

/**
 * The real copy, into a local directory standing in for the remote: a bare path is a local
 * destination to rsync. `ssh` is stubbed for the one remote tidy-up the sync makes first.
 */
describe('pushGitToRemote, against a repository in use', () => {
  let root = '';
  let originalPath = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-gitsync-'));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\ncat >/dev/null\nexit 0\n', { mode: 0o755 });
    originalPath = process.env.PATH ?? '';
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  });
  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("leaves git's lock files behind, and clears one an earlier sync left on the remote", () => {
    const repo = path.join(root, 'repo');
    const remote = path.join(root, 'remote');
    fs.mkdirSync(repo);
    const git = (...args: string[]) =>
      spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'f'), 'x');
    git('add', 'f');
    git('commit', '-qm', 'one');
    // Held by "another git process" for the length of the copy.
    fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '');
    // Copied whole by an earlier version, and now stopping git on the remote from writing its index.
    fs.mkdirSync(path.join(remote, '.git'), { recursive: true });
    fs.writeFileSync(path.join(remote, '.git', 'index.lock'), '');

    const prep = {
      repoRoot: repo,
      remoteSyncUrl: remote,
      config: { sshHost: 'stub', remoteWorkspacePath: remote },
    } as unknown as PrepareResult;
    expect(pushGitToRemote(prep)).toEqual({ ran: true, exitCode: 0 });
    expect(fs.existsSync(path.join(remote, '.git', 'HEAD'))).toBe(true);
    expect(fs.existsSync(path.join(remote, '.git', 'index.lock'))).toBe(false);
    expect(GIT_TRANSIENT_PATTERNS).toContain('*.lock');
  });
});


describe('a log the run is writing is not the remote\'s to replace', () => {
  // The reported failure: `bica run CMD > f.log 2>&1` exited 0 with the command's output and bica's own
  // lines missing. `*.log` is a default return-flow pattern, so the pull after the run replaced the
  // local f.log with the remote's copy -- rsync writes a temporary file and renames it over the
  // original -- and the shell went on writing into the old file, which no longer had a name.
  const rsync = spawnSync('rsync', ['--version']);

  it.runIf(rsync.status === 0)('replaces a matching local log with the remote\'s, and spares one that is excluded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica redirect '));
    try {
      const remote = path.join(dir, 'remote');
      const local = path.join(dir, 'local');
      fs.mkdirSync(remote);
      fs.mkdirSync(local);
      fs.writeFileSync(path.join(remote, 'run.log'), 'the remote\'s older copy\n');
      fs.writeFileSync(path.join(remote, 'other.log'), 'the remote\'s older copy\n');
      fs.writeFileSync(path.join(local, 'run.log'), 'everything the run printed\n');
      fs.writeFileSync(path.join(local, 'other.log'), 'everything the run printed\n');
      const pull = (excludes: string[]): void => {
        const args = buildReturnFlowCopyArgs(['*.log'], `${remote}/`, `${local}/`, excludes);
        expect(spawnSync('rsync', args).status).toBe(0);
      };
      pull([]);
      expect(fs.readFileSync(path.join(local, 'run.log'), 'utf8')).toBe("the remote's older copy\n");

      fs.writeFileSync(path.join(local, 'run.log'), 'everything the run printed\n');
      pull(['/run.log']);
      expect(fs.readFileSync(path.join(local, 'run.log'), 'utf8')).toBe('everything the run printed\n');
      // The rule names one file; the pull still does its job on the rest.
      expect(fs.readFileSync(path.join(local, 'other.log'), 'utf8')).toBe("the remote's older copy\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('escapeRsyncPattern', () => {
  it('keeps a file name literal in a filter rule', () => {
    expect(escapeRsyncPattern('/logs/a*b[1]?.log')).toBe('/logs/a\\*b\\[1]\\?.log');
    expect(escapeRsyncPattern('/plain name.log')).toBe('/plain name.log');
  });
});

describe('parseLsofNames', () => {
  it('reads the file names out of `lsof -Fn` output, ignoring the rest', () => {
    expect(parseLsofNames('p123\nf1\nn/tmp/repo/run.log\nf2\nn/tmp/repo/run.log\nn->0x1234\n')).toEqual([
      '/tmp/repo/run.log',
      '/tmp/repo/run.log',
    ]);
  });
});

describe('outputFilesInside', () => {
  it('names the files stdout and stderr are open on inside the checkout, once each, and nothing else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica outputs '));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'bica elsewhere '));
    try {
      const repo = fs.realpathSync(dir);
      fs.mkdirSync(path.join(repo, 'logs'));
      const inside = path.join(repo, 'logs', 'run.log');
      const outside = path.join(elsewhere, 'outside.log');
      fs.writeFileSync(inside, '');
      fs.writeFileSync(outside, '');
      const stat = (p: string): { isFile: boolean; dev: number; ino: number } => {
        const s = fs.statSync(p);
        return { isFile: s.isFile(), dev: s.dev, ino: s.ino };
      };
      const fds: Record<number, string> = { 1: inside, 2: inside };
      expect(
        outputFilesInside(repo, {
          statFd: (fd) => stat(fds[fd]),
          pathOfFd: (fd) => fds[fd],
        }),
      ).toEqual(['logs/run.log']);

      fds[1] = outside;
      fds[2] = outside;
      expect(
        outputFilesInside(repo, { statFd: (fd) => stat(fds[fd]), pathOfFd: (fd) => fds[fd] }),
      ).toEqual([]);

      // A pipe or a terminal is not a file, and is not looked up at all.
      expect(
        outputFilesInside(repo, {
          statFd: () => ({ isFile: false, dev: 0, ino: 0 }),
          pathOfFd: () => {
            throw new Error('must not be asked');
          },
        }),
      ).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('parseRsyncListing', () => {
  it('reads files with their size and time, keeps spaces in names, and skips directories', () => {
    const listing = [
      'drwx------          160 2026/10/31 13:45:27 .',
      '-rw-r--r--            2 2026/10/31 13:45:27 a b.log',
      'drwxr-xr-x           96 2026/10/31 13:45:27 sub',
      '-rw-r--r--          940 2026/10/31 13:45:28 sub/c.log',
      '',
    ].join('\n');
    expect([...parseRsyncListing(listing)]).toEqual([
      ['a b.log', '2:2026/10/31 13:45:27'],
      ['sub/c.log', '940:2026/10/31 13:45:28'],
    ]);
  });

  it('turns the octal escapes rsync prints for awkward bytes back into the name', () => {
    const listing = '-rw-r--r--            2 2026/10/31 13:45:27 tab\\#011here.log\n';
    expect([...parseRsyncListing(listing).keys()]).toEqual(['tab\there.log']);
  });
});

describe('pathsChangedBetween', () => {
  it('names files that were created, deleted or rewritten, and not the ones that were left alone', () => {
    const before = new Map([
      ['kept.log', '1:t1'],
      ['deleted.log', '1:t1'],
      ['rewritten.log', '1:t1'],
    ]);
    const after = new Map([
      ['kept.log', '1:t1'],
      ['rewritten.log', '9:t2'],
      ['created.log', '1:t3'],
    ]);
    expect(pathsChangedBetween(before, after)).toEqual(['created.log', 'deleted.log', 'rewritten.log']);
  });
});

/**
 * As reported against 0.8.18: during a long `bica run`, logs were deleted and another was created in
 * the checkout. The pull at the end mirrored the remote's copy from when the run began, which brought
 * the deleted ones back and removed the new one, a log that existed nowhere else.
 */
describe('pullReturnFlow and what changed locally while the run was going', () => {
  const rsync = spawnSync('rsync', ['--version']);

  it.runIf(rsync.status === 0)('leaves alone a local log that was deleted, created or rewritten during the run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica pull during run '));
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const remote = path.join(dir, 'remote');
      const local = path.join(dir, 'local');
      fs.mkdirSync(remote);
      fs.mkdirSync(local);
      // What the push at the start of the run put on the remote, and what the run then wrote there.
      for (const name of ['deleted.log', 'rewritten.log', 'untouched.log']) {
        fs.writeFileSync(path.join(local, name), 'as it was when the run began\n');
        fs.writeFileSync(path.join(remote, name), 'as it was when the run began\n');
      }
      fs.writeFileSync(path.join(remote, 'untouched.log'), 'the run wrote this on the remote\n');
      fs.writeFileSync(path.join(remote, 'only-the-run-made-this.log'), 'from the remote\n');
      const prep = {
        repoRoot: local,
        remoteSyncUrl: remote,
        returnFlowPaths: ['*.log'],
        syncIgnorePaths: [],
      } as unknown as PrepareResult;

      const before = snapshotReturnFlowFiles(prep);
      expect(before).not.toBeNull();

      fs.rmSync(path.join(local, 'deleted.log'));
      fs.writeFileSync(path.join(local, 'rewritten.log'), 'edited here during the run, longer than before\n');
      fs.writeFileSync(path.join(local, 'created.log'), 'created here during the run\n');

      expect(pullReturnFlow(prep, before).exitCode).toBe(0);

      expect(fs.existsSync(path.join(local, 'deleted.log'))).toBe(false);
      expect(fs.readFileSync(path.join(local, 'rewritten.log'), 'utf8')).toBe(
        'edited here during the run, longer than before\n',
      );
      expect(fs.readFileSync(path.join(local, 'created.log'), 'utf8')).toBe('created here during the run\n');
      // The pull still does its job for what only the run touched.
      expect(fs.readFileSync(path.join(local, 'untouched.log'), 'utf8')).toBe('the run wrote this on the remote\n');
      expect(fs.readFileSync(path.join(local, 'only-the-run-made-this.log'), 'utf8')).toBe('from the remote\n');
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(rsync.status === 0)('still mirrors everything when there is no snapshot to compare with', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica pull no snapshot '));
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const remote = path.join(dir, 'remote');
      const local = path.join(dir, 'local');
      fs.mkdirSync(remote);
      fs.mkdirSync(local);
      fs.writeFileSync(path.join(remote, 'a.log'), 'remote\n');
      fs.writeFileSync(path.join(local, 'b.log'), 'local only\n');
      const prep = {
        repoRoot: local,
        remoteSyncUrl: remote,
        returnFlowPaths: ['*.log'],
        syncIgnorePaths: [],
      } as unknown as PrepareResult;
      pullReturnFlow(prep);
      expect(fs.existsSync(path.join(local, 'a.log'))).toBe(true);
      expect(fs.existsSync(path.join(local, 'b.log'))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
