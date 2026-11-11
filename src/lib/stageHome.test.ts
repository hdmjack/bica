import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildWriteBackPullArgs } from './writeBack';
import {
  buildStageScript,
  REMOTE_STAGE_ROOT,
  STAGE_DONE,
  STAGE_LINKED_DIR,
  stageDirName,
  stageSyncUrl,
  takeStage,
} from './stageHome';
import type { StagePlan } from './stageHome';

/**
 * The script is run for real, under `sh` with a throwaway HOME and workspace: what is under test is
 * what a remote's shell and rsync do with it, which a string comparison would not show.
 */
let home: string;
let workspace: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-stage-home-'));
  workspace = path.join(home, 'work space');
  fs.mkdirSync(workspace);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const file = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function runScript(
  script: string,
  env: NodeJS.ProcessEnv = {},
): { status: number; stdout: string } {
  const r = spawnSync('sh', ['-s'], {
    input: script,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...env },
  });
  return { status: r.status ?? 1, stdout: r.stdout };
}

function stageAt(runId: string): string {
  return path.join(home, REMOTE_STAGE_ROOT, stageDirName(runId));
}

function script(plan: Partial<StagePlan>, runId = '4242'): string {
  const built = buildStageScript({
    // The spelling bica.yml uses, so the `~` expansion is part of what is tested.
    remoteWorkspacePath: '~/work space',
    runId,
    plan: { files: [], returnFlow: null, artifacts: [], ...plan },
  });
  if (built === null) {
    throw new Error('expected a script');
  }
  return built;
}

describe('the snapshot', () => {
  it('holds the named files, and is unmoved by what the workspace does next', () => {
    // The point of it: the next run's sync rewrites the workspace while this run is still copying home.
    write('previews/a.png', 'run one, a');
    write('previews/b.png', 'run one, b');
    write('src/untouched.ts', 'not named');

    const r = runScript(script({ files: ['previews/a.png', 'previews/b.png'] }));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(STAGE_DONE);

    write('previews/a.png', 'run two, a');
    fs.rmSync(path.join(workspace, 'previews/b.png'));

    const staged = stageAt('4242');
    expect(fs.readFileSync(path.join(staged, 'previews/a.png'), 'utf8')).toBe('run one, a');
    expect(fs.readFileSync(path.join(staged, 'previews/b.png'), 'utf8')).toBe('run one, b');
    expect(fs.existsSync(path.join(staged, 'src/untouched.ts'))).toBe(false);
  });

  it('is what the write-back pull reads, in the same layout', () => {
    write('previews/a.png', 'run one');
    runScript(script({ files: ['previews/a.png'] }));
    write('previews/a.png', 'run two');

    const local = path.join(home, 'local');
    fs.mkdirSync(local);
    const args = buildWriteBackPullArgs({
      remoteSyncUrl: stageAt('4242'),
      repoRoot: local,
    });
    const pulled = spawnSync('rsync', args, {
      input: 'previews/a.png\0',
      encoding: 'utf8',
    });
    expect(pulled.status).toBe(0);
    expect(fs.readFileSync(path.join(local, 'previews/a.png'), 'utf8')).toBe('run one');
  });

  it('takes only what the return-flow whitelist matches', () => {
    write('src/__snapshots__/a.snap', 'snap');
    write('src/a.ts', 'source');
    write('node_modules/dep/__snapshots__/x.snap', 'a dependency');

    const r = runScript(
      script({
        returnFlow: {
          patterns: ['**/__snapshots__/**'],
          excludes: ['node_modules'],
        },
      }),
    );
    expect(r.status).toBe(0);
    const staged = stageAt('4242');
    expect(fs.existsSync(path.join(staged, 'src/__snapshots__/a.snap'))).toBe(true);
    expect(fs.existsSync(path.join(staged, 'src/a.ts'))).toBe(false);
    expect(fs.existsSync(path.join(staged, 'node_modules'))).toBe(false);
  });

  it('takes a file artifact and a directory artifact at their own paths, and tolerates a missing one', () => {
    write('build/bin/llc', 'the binary');
    write('out/report/index.html', 'report');

    const r = runScript(
      script({ artifacts: ['build/bin/llc', 'out/report/', 'never/built'] }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(STAGE_DONE);
    const staged = stageAt('4242');
    expect(fs.readFileSync(path.join(staged, 'build/bin/llc'), 'utf8')).toBe('the binary');
    expect(fs.readFileSync(path.join(staged, 'out/report/index.html'), 'utf8')).toBe('report');
    expect(fs.existsSync(path.join(staged, 'never'))).toBe(false);
  });

  it('copies what an artifact link points at, because the link would point nowhere else', () => {
    write('build/bin/clang-23', 'the real one');
    fs.symlinkSync('clang-23', path.join(workspace, 'build/bin/clang'));

    runScript(script({ artifacts: ['build/bin/clang'] }));

    const copied = path.join(stageAt('4242'), 'build/bin/clang');
    expect(fs.lstatSync(copied).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(copied, 'utf8')).toBe('the real one');
  });

  it('declines to snapshot an artifact that links to a directory, and copies nothing', () => {
    // The 15 GB run: `-L` follows the link, so the snapshot would hold everything it points at.
    const big = path.join(home, 'big');
    fs.mkdirSync(big);
    fs.writeFileSync(path.join(big, 'huge.bin'), 'x'.repeat(1_000_000));
    write('previews/queue/a.png', 'a');
    fs.symlinkSync(big, path.join(workspace, 'previews/worlds'));

    const r = runScript(script({ artifacts: ['previews/'] }));
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain(STAGE_DONE);
    expect(r.stdout).toContain(STAGE_LINKED_DIR);
    expect(r.stdout).toContain('previews/worlds');
    expect(fs.existsSync(path.join(stageAt('4242'), 'previews'))).toBe(false);
  });

  it('declines an artifact that is itself a link to a directory', () => {
    const big = path.join(home, 'big');
    fs.mkdirSync(big);
    fs.writeFileSync(path.join(big, 'huge.bin'), 'x');
    fs.symlinkSync(big, path.join(workspace, 'previews'));

    const r = runScript(script({ artifacts: ['previews/'] }));
    expect(r.stdout).toContain(STAGE_LINKED_DIR);
    expect(r.stdout).not.toContain(STAGE_DONE);
  });

  it('still takes a directory artifact whose links point at files', () => {
    write('out/real.txt', 'real');
    fs.symlinkSync('real.txt', path.join(workspace, 'out/alias.txt'));
    const r = runScript(script({ artifacts: ['out/'] }));
    expect(r.stdout).toContain(STAGE_DONE);
    expect(fs.readFileSync(path.join(stageAt('4242'), 'out/alias.txt'), 'utf8')).toBe('real');
  });

  it('replaces an earlier snapshot of the same run rather than adding to it', () => {
    write('a.txt', 'a');
    write('b.txt', 'b');
    runScript(script({ files: ['a.txt'] }));
    runScript(script({ files: ['b.txt'] }));
    const staged = stageAt('4242');
    expect(fs.existsSync(path.join(staged, 'a.txt'))).toBe(false);
    expect(fs.existsSync(path.join(staged, 'b.txt'))).toBe(true);
  });

  it('removes a snapshot a dead run left behind, and leaves a recent one alone', () => {
    const root = path.join(home, REMOTE_STAGE_ROOT);
    const old = path.join(root, '1111');
    const recent = path.join(root, '2222');
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(recent, { recursive: true });
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    fs.utimesSync(old, threeDaysAgo, threeDaysAgo);

    write('a.txt', 'a');
    runScript(script({ files: ['a.txt'] }));

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it('fails, and says nothing of being done, when the workspace is not there', () => {
    const r = runScript(
      buildStageScript({
        remoteWorkspacePath: '~/no such place',
        runId: '4242',
        plan: { files: ['a.txt'], returnFlow: null, artifacts: [] },
      }) ?? '',
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain(STAGE_DONE);
  });

  it('fails, and says nothing of being done, when the remote has no rsync', () => {
    write('a.txt', 'a');
    // A PATH with everything the script needs before it reaches rsync, and not rsync: otherwise it
    // would fail at `mkdir` and this would pass without testing the check it is named for.
    const bare = path.join(home, 'bare');
    fs.mkdirSync(bare);
    for (const tool of ['mkdir', 'rm', 'find']) {
      const found = spawnSync('/usr/bin/which', [tool], { encoding: 'utf8' }).stdout.trim();
      fs.symlinkSync(found, path.join(bare, tool));
    }
    const r = spawnSync('/bin/sh', ['-s'], {
      input: script({ files: ['a.txt'] }),
      encoding: 'utf8',
      env: { HOME: home, PATH: bare },
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain(STAGE_DONE);
    // It got as far as making the directory, so it was the missing rsync that stopped it.
    expect(fs.existsSync(stageAt('4242'))).toBe(true);
  });

  it('carries a file name with a space, a quote and a glob character literally', () => {
    write("odd dir/it's [1] *.txt", 'odd');
    const r = runScript(script({ files: ["odd dir/it's [1] *.txt"] }));
    expect(r.status).toBe(0);
    expect(
      fs.readFileSync(path.join(stageAt('4242'), "odd dir/it's [1] *.txt"), 'utf8'),
    ).toBe('odd');
  });
});

describe('buildStageScript', () => {
  it('declines a path it cannot carry rather than dropping it', () => {
    expect(
      buildStageScript({
        remoteWorkspacePath: '~/w',
        runId: '1',
        plan: { files: ['a\nb'], returnFlow: null, artifacts: [] },
      }),
    ).toBeNull();
  });
});

describe('takeStage', () => {
  const plan: StagePlan = { files: ['a.txt'], returnFlow: null, artifacts: [] };

  it('names the snapshot where the pulls can read it', () => {
    const calls: string[] = [];
    const stage = takeStage({
      sshHost: 'mini',
      remoteWorkspacePath: '~/w',
      runId: '4242',
      plan,
      run: (_host, s) => {
        calls.push(s);
        return { status: 0, stdout: `${STAGE_DONE}\n`, stderr: '' };
      },
    });
    expect(stage?.url).toBe(stageSyncUrl('mini', '4242'));
    expect(stage?.url).toBe(`mini:${REMOTE_STAGE_ROOT}/4242`);
    stage?.remove();
    expect(calls.at(-1)).toContain('rm -rf');
    expect(calls.at(-1)).toContain('4242');
  });

  it('says there is none, and clears what it started, when the remote could not take it', () => {
    const calls: string[] = [];
    const stage = takeStage({
      sshHost: 'mini',
      remoteWorkspacePath: '~/w',
      runId: '4242',
      plan,
      run: (_host, s) => {
        calls.push(s);
        return { status: 1, stdout: '', stderr: 'rsync: not found' };
      },
    });
    expect(stage).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('rm -rf');
  });

  it('treats an exit 0 without the done line as no snapshot', () => {
    // A script cut short must not be taken for a complete copy: the lease would go on its word.
    const stage = takeStage({
      sshHost: 'mini',
      remoteWorkspacePath: '~/w',
      runId: '4242',
      plan,
      run: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    expect(stage).toBeNull();
  });

  it('does not touch the remote when there is nothing to bring home', () => {
    let called = false;
    const stage = takeStage({
      sshHost: 'mini',
      remoteWorkspacePath: '~/w',
      runId: '4242',
      plan: { files: [], returnFlow: null, artifacts: [] },
      run: () => {
        called = true;
        return { status: 0, stdout: STAGE_DONE, stderr: '' };
      },
    });
    expect(stage).toBeNull();
    expect(called).toBe(false);
  });
});
