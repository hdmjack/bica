import { describe, expect, it } from 'vitest';

import {
  TOUCH_PATH_LIMIT,
  buildTouchScript,
  describeMtimeRepair,
  parseTransferredPaths,
  repairSyncedMtimes,
  wantsMtimeRepair,
} from './syncedMtimes';

/**
 * The bug: an object newer than the source it was *not* built from.
 *
 * A file edited at 23:40 during a long remote build arrives on the remote still stamped 23:40. The
 * build that was already running compiled the previous copy at 23:51. ninja then compares 23:40
 * against 23:51 and skips the file forever, so the next run relinks and exits 0 with none of the edit
 * in the binary. Reported from llvm-blackfin against a `clang` that was missing a whole driver.
 */

describe('parseTransferredPaths', () => {
  it('picks out regular files sent to the remote', () => {
    const out = parseTransferredPaths(
      [
        '<f+++++++++ clang/lib/Driver/ToolChains/CommonArgs.cpp',
        '<f.st...... llvm/lib/IR/Function.cpp',
      ].join('\n'),
    );
    expect(out).toEqual([
      'clang/lib/Driver/ToolChains/CommonArgs.cpp',
      'llvm/lib/IR/Function.cpp',
    ]);
  });

  it('ignores a re-send caused by nothing but our own stamp', () => {
    // Load-bearing. Stamping breaks rsync's quick check, so the file comes back next run as a
    // time-only difference; stamping that too would rebuild every stamped file on every run for
    // ever -- a worse bug than the one being fixed. Measured against mini: the run after a stamp
    // transfers the file once more, and the run after that transfers nothing.
    expect(parseTransferredPaths('<f..t.... a.c')).toEqual([]);
  });

  it('ignores directories, deletions and symlinks', () => {
    // A directory's mtime means nothing to a build tool, and a deletion has nothing left to stamp.
    const out = parseTransferredPaths(
      [
        'cd+++++++++ clang/lib/Driver/',
        '*deleting   build/stale.o',
        '<L+++++++++ bin/clang -> clang-23',
      ].join('\n'),
    );
    expect(out).toEqual([]);
  });

  it('reads openrsync\'s nine-character flags as happily as GNU\'s eleven', () => {
    // macOS ships openrsync, whose itemised field is shorter; nothing may key off the width.
    expect(parseTransferredPaths('<f+++++++ a.c')).toEqual(['a.c']);
    expect(parseTransferredPaths('<f.st.... a.c')).toEqual(['a.c']);
  });

  it('keeps a path containing spaces whole', () => {
    expect(parseTransferredPaths('<f+++++++++ some dir/a file.c')).toEqual([
      'some dir/a file.c',
    ]);
  });
});

describe('buildTouchScript', () => {
  it('feeds paths through a heredoc, not an argument list', () => {
    // A branch switch can deliver more files than ARG_MAX will carry.
    const script = buildTouchScript('~/code/llvm', ['a.c', 'b.c']);
    expect(script).toContain('xargs -0 touch -c');
    expect(script).toContain('BICA_TOUCH_EOF');
  });

  it('prefixes paths so none can be read as an option', () => {
    expect(buildTouchScript('~/code/llvm', ['-rf'])).toContain('./-rf');
  });

  it('quotes the workspace without swallowing the tilde', () => {
    // The same `~`-quoting bug that broke two earlier probes.
    expect(buildTouchScript('~/code/llvm', ['a.c'])).toContain("~/'code/llvm'");
  });

  it('does not abort the run over a path that has since gone', () => {
    expect(buildTouchScript('~/code/llvm', ['a.c'])).toContain('touch -c');
  });
});

describe('repairSyncedMtimes', () => {
  const ok = () => ({ status: 0, stdout: '', stderr: '' });

  it('does nothing when the sync sent nothing', () => {
    let called = false;
    const repair = repairSyncedMtimes({
      sshHost: 'mini',
      remoteWorkspacePath: '~/code/llvm',
      paths: [],
      run: () => {
        called = true;
        return ok();
      },
    });
    expect(repair.touched).toBe(0);
    expect(called).toBe(false);
  });

  it('stamps what the sync sent', () => {
    const repair = repairSyncedMtimes({
      sshHost: 'mini',
      remoteWorkspacePath: '~/code/llvm',
      paths: ['a.c', 'b.c'],
      run: ok,
    });
    expect(repair).toEqual({ touched: 2, skipped: false });
  });

  it('skips a list big enough to be a branch switch', () => {
    // The cure must never cost more than the disease: that build is being redone regardless.
    const many = Array.from({ length: TOUCH_PATH_LIMIT + 1 }, (_, i) => `f${String(i)}.c`);
    let called = false;
    const repair = repairSyncedMtimes({
      sshHost: 'mini',
      remoteWorkspacePath: '~/code/llvm',
      paths: many,
      run: () => {
        called = true;
        return ok();
      },
    });
    expect(repair.skipped).toBe(true);
    expect(called).toBe(false);
  });
});

describe('wantsMtimeRepair', () => {
  it('is off for a repo with nothing that compiles', () => {
    // vitest and eslint read content, not timestamps; this costs a connection.
    expect(wantsMtimeRepair({})).toBe(false);
  });

  it('is on for every signal of a compiled project', () => {
    expect(wantsMtimeRepair({ artifacts: ['build/bin/llc'] })).toBe(true);
    expect(wantsMtimeRepair({ toolchain: ['ninja'] })).toBe(true);
    expect(wantsMtimeRepair({ buildDir: '~/code/llvm/build' })).toBe(true);
    expect(wantsMtimeRepair({ cargoTargetIgnored: true })).toBe(true);
  });
});

describe('describeMtimeRepair', () => {
  it('says nothing when nothing was stamped', () => {
    expect(describeMtimeRepair({ touched: 0, skipped: false })).toBeUndefined();
  });

  it('says what it did, singular and plural', () => {
    expect(describeMtimeRepair({ touched: 1, skipped: false })).toContain('1 synced file');
    expect(describeMtimeRepair({ touched: 4, skipped: false })).toContain('4 synced files');
  });

  it('says what to do by hand when it skipped', () => {
    expect(describeMtimeRepair({ touched: 9000, skipped: true })).toContain('touch');
  });
});
