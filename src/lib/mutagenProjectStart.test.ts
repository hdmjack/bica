import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findSessionsFromOtherCheckouts,
  mutagenProjectStart,
  mutagenSyncTerminate,
} from './mutagenSession';

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawnSync }));

interface FakeSession {
  name: string;
  alpha: string;
  beta: string;
  project: string;
}

/**
 * Just enough of Mutagen to reproduce the lock-file behaviour, as observed against mutagen 0.18.1:
 * `project start` refuses with "project already running" whenever `<project file>.lock` is non-empty,
 * whether or not any session is left; `project terminate` ends the sessions labelled with the id in
 * the file and removes it; `sync terminate` ends one session and leaves the file alone.
 */
function fakeMutagen(projectFile: string, alpha: string, beta: string) {
  const lockFile = `${projectFile}.lock`;
  const sessions: FakeSession[] = [];
  let nextId = 0;
  let listingWorks = true;
  const rows = (list: FakeSession[]) =>
    list.map((s) => `${s.name}|id-${s.name}|${s.alpha}|${s.beta}\n`).join('');
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });

  const sshCalls: { args: string[]; input: string }[] = [];

  spawnSync.mockImplementation((cmd: string, args: string[], options?: { input?: string }) => {
    // The cache cleanup after a terminate: recorded, not run.
    if (cmd === 'ssh') {
      sshCalls.push({ args, input: options?.input ?? '' });
      return ok();
    }
    const [group, verb] = args;
    if (group === 'project' && verb === 'start') {
      if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8') !== '') {
        return { status: 1, stdout: '', stderr: 'Error: project already running\n' };
      }
      nextId += 1;
      const project = `proj_${String(nextId)}`;
      fs.writeFileSync(lockFile, project);
      sessions.push({ name: 'repo', alpha, beta, project });
      return ok('Creating session...\n');
    }
    if (group === 'project' && verb === 'terminate') {
      const project = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8') : '';
      for (let i = sessions.length - 1; i >= 0; i -= 1) {
        if (sessions[i].project === project) {
          sessions.splice(i, 1);
        }
      }
      fs.rmSync(lockFile, { force: true });
      return ok();
    }
    if (group === 'sync' && verb === 'terminate') {
      const i = sessions.findIndex((s) => s.name === args[2]);
      if (i >= 0) {
        sessions.splice(i, 1);
      }
      return ok();
    }
    if (group === 'sync' && verb === 'list') {
      if (!listingWorks) {
        return { status: 1, stdout: '', stderr: 'daemon unavailable' };
      }
      const selector = args.indexOf('--label-selector');
      if (selector >= 0) {
        const project = args[selector + 1].replace('io.mutagen.project=', '');
        return ok(rows(sessions.filter((s) => s.project === project)));
      }
      // `sync list <name>` narrows to that session, as Mutagen does.
      const named = args[2] !== undefined && !args[2].startsWith('--') ? args[2] : undefined;
      return ok(rows(sessions.filter((s) => named === undefined || s.name === named)));
    }
    throw new Error(`fake mutagen: unexpected ${args.join(' ')}`);
  });

  return {
    sessions,
    sshCalls,
    breakListing: () => {
      listingWorks = false;
    },
  };
}

describe('mutagenProjectStart with a lock file left behind', () => {
  let dir: string;
  let projectFile: string;
  const beta = 'mini:~/code/repo';

  beforeEach(() => {
    spawnSync.mockReset();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-project-start-'));
    fs.mkdirSync(path.join(dir, '.bica'));
    projectFile = path.join(dir, '.bica', 'project.yml');
    fs.writeFileSync(projectFile, 'sync: {}\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts a session when the previous run left only the lock behind', () => {
    // The reported failure: a run died without its exit hook, so its session and the project's
    // lock file outlived it. The next run's sweep ended the session with `sync terminate`, Mutagen
    // then refused to start because the lock was still there, bica called that "already running",
    // and the run waited sixty seconds on a session that did not exist before stopping with 94.
    const mutagen = fakeMutagen(projectFile, dir, beta);
    expect(mutagenProjectStart(dir, projectFile)).toBe(true);
    // The previous run dies here, and the next one's sweep ends its session.
    mutagenSyncTerminate('repo');
    expect(mutagen.sessions).toEqual([]);
    // Mutagen keeps the ended session's cache on the remote; bica asks the remote to drop it.
    expect(mutagen.sshCalls).toHaveLength(1);
    expect(mutagen.sshCalls[0].args).toContain('mini');
    expect(mutagen.sshCalls[0].input).toContain('"$d/id-repo_alpha" "$d/id-repo_beta"');

    expect(mutagenProjectStart(dir, projectFile)).toBe(true);
    expect(mutagen.sessions.map((s) => s.alpha)).toEqual([dir]);
  });

  it('leaves a project whose sessions are still running alone', () => {
    const mutagen = fakeMutagen(projectFile, dir, beta);
    expect(mutagenProjectStart(dir, projectFile)).toBe(true);
    const running = [...mutagen.sessions];

    expect(mutagenProjectStart(dir, projectFile)).toBe(true);
    expect(mutagen.sessions).toEqual(running);
  });

  it('does not clear the lock when it cannot list the sessions', () => {
    // A failed listing is "cannot tell", and terminating on that would end sessions that are fine.
    const mutagen = fakeMutagen(projectFile, dir, beta);
    expect(mutagenProjectStart(dir, projectFile)).toBe(true);
    const running = [...mutagen.sessions];
    mutagen.breakListing();

    mutagenProjectStart(dir, projectFile);
    expect(mutagen.sessions).toEqual(running);
    expect(fs.readFileSync(`${projectFile}.lock`, 'utf8')).not.toBe('');
  });
});

describe('findSessionsFromOtherCheckouts', () => {
  beforeEach(() => {
    spawnSync.mockReset();
  });

  it("finds another checkout's session into this workspace, and nothing else", () => {
    // Worktrees of one repository that share a remote workspace: a session left behind by one of
    // them keeps replicating its tree over whatever the leaseholder synced.
    spawnSync.mockReturnValue({
      status: 0,
      stdout: [
        'mine|id-1|/code/repo/wt-b|mini:~/code/repo',
        'leftover|id-2|/code/repo/wt-a|mini:~/code/repo',
        'elsewhere|id-3|/code/repo/wt-c|mini:~/code/repo-c',
      ].join('\n'),
      stderr: '',
    });
    expect(
      findSessionsFromOtherCheckouts('/code/repo/wt-b', 'mini:~/code/repo').map((s) => s.name),
    ).toEqual(['leftover']);
  });
});
