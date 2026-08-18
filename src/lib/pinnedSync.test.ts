import { describe, expect, it } from 'vitest';

import { buildPinnedPushArgs } from './pinnedSync';

function args(overrides: {
  syncIgnorePaths?: string[];
  returnFlowPaths?: string[];
}): string[] {
  return buildPinnedPushArgs({
    source: '/repo/',
    dest: 'host:~/code/repo-lane-1/',
    syncIgnorePaths: overrides.syncIgnorePaths ?? [],
    returnFlowPaths: overrides.returnFlowPaths ?? [],
  });
}

describe('buildPinnedPushArgs', () => {
  it('mirrors with --delete so a file removed on this branch is removed in the lane', () => {
    expect(args({})).toContain('--delete');
  });

  it('never passes --delete-excluded, which would wipe the lane node_modules', () => {
    // Reusing a warm lane is the whole reason lanes exist; deleting inside excluded trees would
    // force a reinstall on every run.
    expect(args({ syncIgnorePaths: ['node_modules'] })).not.toContain(
      '--delete-excluded',
    );
  });

  it('excludes .git, which is mirrored by its own rsync with its own --delete scope', () => {
    expect(args({})).toContain('--filter=- .git');
  });

  it('excludes .bica, which is local-only state (locks, fingerprints, pinned worktrees)', () => {
    expect(args({})).toContain('--filter=- .bica');
  });

  it('turns each configured ignore path into an exclude', () => {
    const out = args({ syncIgnorePaths: ['node_modules', 'dist'] });
    expect(out).toContain('--filter=- node_modules');
    expect(out).toContain('--filter=- dist');
  });

  it('turns a Mutagen negation into an include ordered before the excludes', () => {
    // rsync is first-match-wins, so a re-include is only meaningful ahead of the rule it overrides.
    const out = args({ syncIgnorePaths: ['dist', '!dist/keep'] });
    expect(out.indexOf('--filter=+ dist/keep')).toBeLessThan(
      out.indexOf('--filter=- dist'),
    );
  });

  it('ignores whitespace-only and bare-negation entries', () => {
    const out = args({ syncIgnorePaths: ['  ', '!', ' dist '] });
    expect(out).toContain('--filter=- dist');
    expect(out).not.toContain('--filter=- ');
    expect(out).not.toContain('--filter=+ ');
  });

  it('pushes snapshots when the caller passes no return-flow patterns', () => {
    // With return-flow off the caller passes [], because the branch's committed snapshots are then
    // ordinary files: skipping them would run the tests against whatever the lane's previous
    // occupant left behind.
    const out = args({ returnFlowPaths: [] });
    expect(out.some((a) => a.includes('.snap'))).toBe(false);
  });

  it('excludes return-flow patterns when the run owns them on the remote', () => {
    const out = buildPinnedPushArgs({
      source: '/repo/',
      dest: 'host:d/',
      syncIgnorePaths: [],
      returnFlowPaths: ['**/*.snap', '*.log'],
    });
    expect(out).toContain('--filter=- **/*.snap');
    expect(out).toContain('--filter=- *.log');
  });

  it('deduplicates excludes so a path listed twice yields one rule', () => {
    const out = buildPinnedPushArgs({
      source: '/repo/',
      dest: 'host:d/',
      syncIgnorePaths: ['.git', 'dist'],
      returnFlowPaths: ['dist'],
    });
    expect(out.filter((a) => a === '--filter=- .git')).toHaveLength(1);
    expect(out.filter((a) => a === '--filter=- dist')).toHaveLength(1);
  });

  it('ends with source then dest', () => {
    const out = args({});
    expect(out.slice(-2)).toEqual(['/repo/', 'host:~/code/repo-lane-1/']);
  });
});
