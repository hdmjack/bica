import { describe, expect, it } from 'vitest';

import { gitDependentHint, wantsRemoteGitProbe } from './gitDependentHint';

const failed = { exitCode: 1, syncGit: false };

describe('gitDependentHint', () => {
  it('says nothing when the run succeeded', () => {
    expect(
      gitDependentHint({
        argvs: [['pnpm', 'test:run:changed']],
        exitCode: 0,
        syncGit: false,
      }),
    ).toBeUndefined();
  });

  it('stays quiet when git.sync is on and the repository is there', () => {
    // The noise this fixes: on a repo whose test script is `test:run:changed`, the note was landing
    // under every failing test run, where it reads as a diagnosis of a failure it has nothing to do
    // with.
    expect(
      gitDependentHint({
        argvs: [['pnpm', 'test:run:changed']],
        exitCode: 1,
        syncGit: true,
        remoteGitPresent: true,
      }),
    ).toBeUndefined();
  });

  it('speaks when git.sync is on and the copy did not land', () => {
    // The case the silence must not swallow: whoever followed the previous hint would otherwise get
    // a bare `fatal: not a git repository` and nothing connecting the two.
    const hint = gitDependentHint({
      argvs: [['pnpm', 'test:run:changed']],
      exitCode: 1,
      syncGit: true,
      remoteGitPresent: false,
    });
    expect(hint).toContain('git.sync');
    expect(hint).toContain('pnpm test:run:changed');
    expect(hint).not.toContain('Turn it on');
  });

  it('says nothing with git.sync on when nobody looked', () => {
    // An unavailable probe must not be read as a failed copy.
    expect(
      gitDependentHint({
        argvs: [['pnpm', 'test:run:changed']],
        exitCode: 1,
        syncGit: true,
      }),
    ).toBeUndefined();
  });

  it('names the worktree case, where the copy has to be flattened', () => {
    const hint = gitDependentHint({
      argvs: [['git', 'diff', 'main...HEAD']],
      exitCode: 128,
      syncGit: true,
      remoteGitPresent: false,
      fromWorktree: true,
    });
    expect(hint).toContain('worktree');
  });

  it('stays quiet for an ordinary failing test run', () => {
    expect(
      gitDependentHint({ argvs: [['pnpm', 'test:run']], ...failed }),
    ).toBeUndefined();
  });

  it('fires on a script name whose last segment is `changed`', () => {
    const hint = gitDependentHint({
      argvs: [['pnpm', 'test:run:changed']],
      ...failed,
    });
    expect(hint).toContain('pnpm test:run:changed');
    expect(hint).toContain('sync: true');
  });

  it('fires on `--changed` and on `--since=` with an inline value', () => {
    expect(
      gitDependentHint({
        argvs: [['pnpm', 'vitest', '--changed', 'origin/master']],
        ...failed,
      }),
    ).toBeDefined();
    expect(
      gitDependentHint({
        argvs: [['pnpm', 'jest', '--changedSince=origin/develop']],
        ...failed,
      }),
    ).toBeDefined();
  });

  it("fires on turbo's history-relative filter", () => {
    expect(
      gitDependentHint({
        argvs: [['pnpm', 'turbo', 'run', 'build', '--filter=...[origin/master]']],
        ...failed,
      }),
    ).toBeDefined();
  });

  it('fires when the command is git itself', () => {
    expect(
      gitDependentHint({ argvs: [['git', 'status']], ...failed }),
    ).toBeDefined();
  });

  it('does not fire on a plain --filter that names a package', () => {
    expect(
      gitDependentHint({
        argvs: [['pnpm', '--filter', '@acme/ui', 'build']],
        ...failed,
      }),
    ).toBeUndefined();
  });

  it('does not mistake `unchanged` for `changed`', () => {
    expect(
      gitDependentHint({ argvs: [['pnpm', 'lint:unchanged']], ...failed }),
    ).toBeUndefined();
  });

  it('names the offending command out of several run at once', () => {
    const hint = gitDependentHint({
      argvs: [
        ['pnpm', 'lint'],
        ['pnpm', 'test:run:changed'],
      ],
      ...failed,
    });
    expect(hint).toContain('pnpm test:run:changed');
    expect(hint).not.toContain('pnpm lint');
  });
});

describe('wantsRemoteGitProbe', () => {
  // The probe costs a connection, so it has to be confined to the one path where its answer changes
  // what is printed.
  it('asks only for a failing history-reading command with the setting already on', () => {
    expect(
      wantsRemoteGitProbe({
        argvs: [['pnpm', 'test:run:changed']],
        exitCode: 1,
        syncGit: true,
      }),
    ).toBe(true);
  });

  it('does not ask when the run passed', () => {
    expect(
      wantsRemoteGitProbe({
        argvs: [['pnpm', 'test:run:changed']],
        exitCode: 0,
        syncGit: true,
      }),
    ).toBe(false);
  });

  it('does not ask when the command never touches history', () => {
    expect(
      wantsRemoteGitProbe({
        argvs: [['pnpm', 'test:run']],
        exitCode: 1,
        syncGit: true,
      }),
    ).toBe(false);
  });

  it('does not ask when the setting is off, which already explains it', () => {
    expect(
      wantsRemoteGitProbe({
        argvs: [['pnpm', 'test:run:changed']],
        exitCode: 1,
        syncGit: false,
      }),
    ).toBe(false);
  });
});
