import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrepareResult } from '../syncProject';
import {
  buildReturnFlowExcludes,
  buildReturnFlowMirrorArgs,
  buildReturnFlowRsyncArgs,
  GIT_TRANSIENT_PATTERNS,
  gitSyncStopsRun,
  pushGitToRemote,
  rsyncGit,
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

describe('buildReturnFlowMirrorArgs', () => {
  const patterns = ['**/__snapshots__/**', '**/*.snap'];

  it('scopes --delete with the whitelist filters and puts source before dest', () => {
    const args = buildReturnFlowMirrorArgs(
      patterns,
      'mini:~/code/foo/',
      '/local/foo/',
    );
    expect(args).toEqual([
      '-az',
      '--delete',
      '--prune-empty-dirs',
      '--filter=+ */',
      '--filter=+ **/__snapshots__/**',
      '--filter=+ **/*.snap',
      '--filter=- *',
      'mini:~/code/foo/',
      '/local/foo/',
    ]);
  });

  it('passes excluded trees through, keeping --delete out of them entirely', () => {
    const args = buildReturnFlowMirrorArgs(
      patterns,
      'mini:~/code/foo/',
      '/local/foo/',
      ['.git', 'node_modules'],
    );
    // Excluded paths are protected from deletion as well as transfer, so a dependency's own
    // snapshots never cross the wire and local-only ignored trees are left alone.
    expect(args).toContain('--filter=- node_modules');
    expect(args.indexOf('--filter=- node_modules')).toBeLessThan(
      args.indexOf('--filter=+ */'),
    );
  });

  it('places --delete before the trailing exclude so non-matching files stay protected', () => {
    const args = buildReturnFlowMirrorArgs(patterns, 'src/', 'dst/');
    // --delete removes only extraneous *included* files; the final "- *" protects everything else
    // (on the receiver) from deletion.
    expect(args.indexOf('--delete')).toBeLessThan(args.indexOf('--filter=- *'));
  });

  it('is direction-agnostic — same builder used for push (local→remote) and pull (remote→local)', () => {
    const push = buildReturnFlowMirrorArgs(patterns, '/local/', 'mini:~/r/');
    const pull = buildReturnFlowMirrorArgs(patterns, 'mini:~/r/', '/local/');
    expect(push.slice(-2)).toEqual(['/local/', 'mini:~/r/']);
    expect(pull.slice(-2)).toEqual(['mini:~/r/', '/local/']);
    // Only the trailing source/dest differ; the flags are identical.
    expect(push.slice(0, -2)).toEqual(pull.slice(0, -2));
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

