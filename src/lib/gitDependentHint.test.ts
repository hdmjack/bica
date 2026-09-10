import { describe, expect, it } from 'vitest';

import { gitDependentHint } from './gitDependentHint';

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

  it('says nothing when git.sync already mirrored .git', () => {
    expect(
      gitDependentHint({
        argvs: [['pnpm', 'test:run:changed']],
        exitCode: 1,
        syncGit: true,
      }),
    ).toBeUndefined();
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
