import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findAllSessionsForRepo } from './mutagenSession';

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawnSync }));

const REPO = '/Users/me/code/repo';

function sessionsOnHost(rows: [string, string, string][]): void {
  spawnSync.mockReturnValue({
    status: 0,
    stdout: rows.map(([name, alpha, beta]) => `${name}|id-${name}|${alpha}|${beta}`).join('\n'),
    stderr: '',
  });
}

describe('findAllSessionsForRepo', () => {
  beforeEach(() => {
    spawnSync.mockReset();
  });

  it('scoped to a remote workspace, leaves concurrent lanes alone', () => {
    // This is the isolation that makes parallel runs possible at all: every lane shares the alpha
    // (one checkout), so matching on alpha alone would have each `bica run` terminate its siblings'
    // sessions.
    sessionsOnHost([
      ['repo', REPO, 'host:~/code/repo'],
      ['repo-lane-1', REPO, 'host:~/code/repo-lane-1'],
      ['repo-lane-2', REPO, 'host:~/code/repo-lane-2'],
    ]);
    const found = findAllSessionsForRepo(REPO, 'host:~/code/repo-lane-1');
    expect(found.map((s) => s.name)).toEqual(['repo-lane-1']);
  });

  it('still catches a differently-named session on the same remote workspace', () => {
    // A leftover from an older bica.yml session name fights the new session's ignore rules, so it
    // must be terminated even though the name does not match.
    sessionsOnHost([
      ['old-name', REPO, 'host:~/code/repo-lane-1'],
      ['repo-lane-2', REPO, 'host:~/code/repo-lane-2'],
    ]);
    expect(
      findAllSessionsForRepo(REPO, 'host:~/code/repo-lane-1').map((s) => s.name),
    ).toEqual(['old-name']);
  });

  it('ignores sessions belonging to another checkout', () => {
    sessionsOnHost([['other', '/Users/me/code/other', 'host:~/code/repo-lane-1']]);
    expect(findAllSessionsForRepo(REPO, 'host:~/code/repo-lane-1')).toEqual([]);
  });

  it('without a remote workspace, keeps the old repo-wide sweep', () => {
    sessionsOnHost([
      ['repo', REPO, 'host:~/code/repo'],
      ['repo-lane-1', REPO, 'host:~/code/repo-lane-1'],
    ]);
    expect(findAllSessionsForRepo(REPO)).toHaveLength(2);
  });

  it('treats an unusable mutagen listing as "no detection possible", not "no sessions"', () => {
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'boom' });
    expect(findAllSessionsForRepo(REPO, 'host:~/code/repo')).toEqual([]);
  });
});
