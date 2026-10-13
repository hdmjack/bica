import { describe, expect, it } from 'vitest';

import {
  buildRemoteGitProbeScript,
  parseRemoteGitProbe,
  readRemoteGitState,
  remoteWorkspaceWordForSh,
  staleRemoteGitWarning,
  warnAboutStaleRemoteGit,
} from './staleRemoteGit';
import type { RemoteRunner } from './staleRemoteGit';

/**
 * The report's own suggested test, with the comparison moved to where bica can make it.
 *
 * It asked for a run whose remote `origin/master` is older than the local one, asserting that the run
 * either syncs the refs or names the stale one before the command starts. Standing up two real
 * repositories across ssh is the integration half; what is tested here is the decision -- that a
 * leftover remote repository is noticed, described, and warned about *before* the command runs, and
 * that the warning stays silent on the runs it has nothing to say about.
 */

/** Exactly what the probe printed on `mini` for the workspace in the report. */
const STALE_PROBE =
  'present=yes\n' +
  'branch=refactor/retire-settings-access-map\n' +
  'newestRef=origin/master (2026-10-09)\n';

function runnerReturning(stdout: string, status = 0): RemoteRunner {
  return () => ({ status, stdout, stderr: '' });
}

const CHANGED = [['pnpm', 'lint:changed']];

describe('the workspace path as a shell word', () => {
  it('leaves a leading ~ for the shell, because that is how bica.yml spells it', () => {
    // Quoted whole, `~` is a literal directory name: the test for `.git` fails, and the warning goes
    // silent on exactly the workspaces it exists for. This was true of the first version of it.
    expect(remoteWorkspaceWordForSh('~/code/float-javascript-2')).toBe(
      `~/'code/float-javascript-2'`,
    );
  });

  it('leaves ~user bare the same way', () => {
    expect(remoteWorkspaceWordForSh('~someone/code/repo')).toBe(
      `~someone/'code/repo'`,
    );
  });

  it('quotes an absolute path whole', () => {
    expect(remoteWorkspaceWordForSh('/Users/x/code/my repo')).toBe(
      `'/Users/x/code/my repo'`,
    );
  });

  it('keeps a path with a space in it one word either way', () => {
    expect(remoteWorkspaceWordForSh('~/my code/repo')).toBe(`~/'my code/repo'`);
  });
});

describe('the probe script', () => {
  it('uses the workspace as one word', () => {
    expect(buildRemoteGitProbeScript('/Users/x/code/my repo')).toContain(
      `w='/Users/x/code/my repo'`,
    );
  });

  it('answers the existence question before it needs git at all', () => {
    // A remote without `git` on a non-login `sh` PATH must still be able to report the one fact the
    // warning turns on, so the exit for "no .git" comes first and the rest is best-effort.
    const script = buildRemoteGitProbeScript('/w');
    const existence = script.indexOf('present=no');
    const needsGit = script.indexOf('command -v git');
    expect(existence).toBeGreaterThan(-1);
    expect(existence).toBeLessThan(needsGit);
  });
});

describe('parseRemoteGitProbe', () => {
  it('reads the fields the probe prints', () => {
    expect(parseRemoteGitProbe(STALE_PROBE)).toEqual({
      present: true,
      branch: 'refactor/retire-settings-access-map',
      newestRef: 'origin/master (2026-10-09)',
    });
  });

  it('keeps the spaces in a value, which the date is on the other side of', () => {
    const state = parseRemoteGitProbe('present=yes\nnewestRef=origin/main (2026-01-02)\n');
    expect(state.newestRef).toBe('origin/main (2026-01-02)');
  });

  it('reports a workspace with no repository as having none', () => {
    expect(parseRemoteGitProbe('present=no\n')).toEqual({ present: false });
  });

  it('settles for existence alone when git could not answer', () => {
    expect(parseRemoteGitProbe('present=yes\n')).toEqual({ present: true });
  });

  it('treats empty answers as no answer rather than as empty strings', () => {
    // `$(git ... || true)` prints nothing when the repository is too broken to read.
    expect(parseRemoteGitProbe('present=yes\nbranch=\nnewestRef=\n')).toEqual({
      present: true,
    });
  });
});

describe('readRemoteGitState', () => {
  it('says nothing either way when the probe itself could not run', () => {
    // A guess here would warn about a repository that may not exist.
    expect(readRemoteGitState('mini', '/w', runnerReturning('', 255))).toEqual({
      present: false,
    });
  });
});

describe('staleRemoteGitWarning', () => {
  const stale = parseRemoteGitProbe(STALE_PROBE);

  it('names the command, the branch and how far behind the refs are', () => {
    const said = staleRemoteGitWarning({
      argvs: CHANGED,
      syncGit: false,
      remote: stale,
      localBranch: 'fix/acl-prime-skip-access-rights-view',
    });
    expect(said).toContain('pnpm lint:changed');
    expect(said).toContain('refactor/retire-settings-access-map');
    expect(said).toContain('fix/acl-prime-skip-access-rights-view');
    expect(said).toContain('origin/master (2026-10-09)');
    expect(said).toContain('BICA_GIT_SYNC=1');
  });

  it('says the wrong answer is the danger, not the failure', () => {
    // The run that prompted this did not look like a bica problem: it looked like a branch with 405
    // changed files and a remote short of memory.
    const said = staleRemoteGitWarning({
      argvs: CHANGED,
      syncGit: false,
      remote: stale,
      localBranch: 'feature/x',
    });
    expect(said).toContain('worse than none');
  });

  it('does not claim a branch mismatch when the branches agree', () => {
    const said = staleRemoteGitWarning({
      argvs: CHANGED,
      syncGit: false,
      remote: stale,
      localBranch: 'refactor/retire-settings-access-map',
    });
    // Still worth warning -- the refs are stale whatever branch HEAD is on -- but not worth claiming
    // a difference that is not there.
    expect(said).toContain('origin/master (2026-10-09)');
    expect(said).not.toContain('where this checkout is on');
  });

  it('still warns when git could say nothing beyond the repository existing', () => {
    const said = staleRemoteGitWarning({
      argvs: CHANGED,
      syncGit: false,
      remote: { present: true },
    });
    expect(said).toContain('left over from an earlier run');
  });

  it('stays quiet when git.sync is about to overwrite those refs', () => {
    expect(
      staleRemoteGitWarning({ argvs: CHANGED, syncGit: true, remote: stale }),
    ).toBeUndefined();
  });

  it('stays quiet when the remote has no repository, which fails loudly on its own', () => {
    expect(
      staleRemoteGitWarning({
        argvs: CHANGED,
        syncGit: false,
        remote: { present: false },
      }),
    ).toBeUndefined();
  });

  it('stays quiet for a command that does not read history', () => {
    expect(
      staleRemoteGitWarning({
        argvs: [['pnpm', 'test:run']],
        syncGit: false,
        remote: stale,
      }),
    ).toBeUndefined();
  });

  it('warns on the one command that reads history out of several', () => {
    const said = staleRemoteGitWarning({
      argvs: [['pnpm', 'build'], ['pnpm', 'test:run:changed']],
      syncGit: false,
      remote: stale,
    });
    expect(said).toContain('pnpm test:run:changed');
  });
});

describe('warnAboutStaleRemoteGit', () => {
  it('does not ask the remote anything when the command cannot care', () => {
    // The probe is an ssh round-trip on the hot path of every run.
    let asked = 0;
    const run: RemoteRunner = () => {
      asked += 1;
      return { status: 0, stdout: STALE_PROBE, stderr: '' };
    };
    warnAboutStaleRemoteGit({
      argvs: [['pnpm', 'test:run']],
      syncGit: false,
      sshHost: 'mini',
      remoteWorkspacePath: '/w',
      repoRoot: process.cwd(),
      run,
    });
    warnAboutStaleRemoteGit({
      argvs: CHANGED,
      syncGit: true,
      sshHost: 'mini',
      remoteWorkspacePath: '/w',
      repoRoot: process.cwd(),
      run,
    });
    expect(asked).toBe(0);
  });

  it('asks, and warns, for a history-reading command with git.sync off', () => {
    const said = warnAboutStaleRemoteGit({
      argvs: CHANGED,
      syncGit: false,
      sshHost: 'mini',
      remoteWorkspacePath: '/w',
      repoRoot: process.cwd(),
      run: runnerReturning(STALE_PROBE),
    });
    expect(said).toContain('pnpm lint:changed');
  });
});
