import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildEmptinessProbeScript,
  buildSeedRsyncArgs,
  remoteWorkspaceIsEmpty,
  seedRemoteWorkspace,
} from './seedWorkspace';
import type { RemoteRunner, RsyncRunner } from './seedWorkspace';

/**
 * The request's first test: "a fixture repo with 100k generated files: first `bica run true` exits 0,
 * and the remote holds every file."
 *
 * The exit-0 half belongs to the sync wait (`waitForSyncReady.test.ts`). This is the other half --
 * that the files get there in one transfer rather than 100,000 -- and the part that needs guarding
 * is the restraint rather than the speed: seeding anything that is not empty, or seeding a tree the
 * remote owns, is how a bulk copy destroys a build directory.
 */

function remote(stdout: string, status = 0): RemoteRunner {
  return () => ({ status, stdout, stderr: '' });
}

describe('buildEmptinessProbeScript', () => {
  it('does not walk the tree to answer a yes/no question', () => {
    // A 180,000-file workspace must not be enumerated to find out that it is not empty.
    const script = buildEmptinessProbeScript('~/code/llvm');
    expect(script).toContain('-maxdepth 1');
    expect(script).toContain('-print -quit');
  });

  it('treats a workspace that does not exist yet as empty', () => {
    expect(buildEmptinessProbeScript('/w')).toContain("if [ ! -d \"$w\" ]");
  });

  it('leaves a leading ~ for the shell to expand', () => {
    // Quoted whole, `~` is a literal directory name, the test for the workspace fails, and every
    // run re-seeds a workspace that is already full. Caught on the second live run, not in these.
    expect(buildEmptinessProbeScript('~/code/llvm')).toContain("w=~/'code/llvm'");
  });
});

describe('buildEmptinessProbeScript, run in a real shell', () => {
  function probe(workspace: string, env: NodeJS.ProcessEnv = process.env): string {
    const result = spawnSync('sh', ['-c', buildEmptinessProbeScript(workspace)], {
      encoding: 'utf8',
      env,
    });
    return result.stdout;
  }

  it('says empty for an empty directory, no for a full one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-probe-'));
    try {
      expect(probe(dir)).toBe('empty=yes\n');
      fs.writeFileSync(path.join(dir, 'f'), '');
      expect(probe(dir)).toBe('empty=no\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('looks inside a workspace path that is a symbolic link, as the remote paths are', () => {
    // `seed-mini.sh` makes ~/code/NAME a link to a directory on another volume. `find` does not
    // follow a link it is handed, so it listed nothing, successfully, and a workspace holding a full
    // tree was called empty and bulk-copied over on every run.
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-probe-real-'));
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-probe-link-'));
    const link = path.join(holder, 'workspace');
    try {
      fs.symlinkSync(real, link);
      expect(probe(link)).toBe('empty=yes\n');
      fs.writeFileSync(path.join(real, 'f'), '');
      expect(probe(link)).toBe('empty=no\n');
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
      fs.rmSync(holder, { recursive: true, force: true });
    }
  });

  it('does not call a workspace empty when the listing itself failed', () => {
    // A failed `find` prints nothing, which is what an empty directory prints too. A full workspace
    // on a machine out of file descriptors was seeded as "empty" on that reading.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-probe-'));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-probe-bin-'));
    try {
      fs.writeFileSync(path.join(dir, 'f'), '');
      fs.writeFileSync(path.join(bin, 'find'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const out = probe(dir, { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` });
      expect(out).toBe('empty=unknown\n');
      expect(/^empty=yes$/m.test(out)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe('remoteWorkspaceIsEmpty', () => {
  it('is false when the listing failed and the probe said so', () => {
    expect(remoteWorkspaceIsEmpty('mini', '/w', remote('empty=unknown\n'))).toBe(false);
  });

  it('is true for a workspace with nothing in it', () => {
    expect(remoteWorkspaceIsEmpty('mini', '/w', remote('empty=yes\n'))).toBe(true);
  });

  it('is false for one that already holds files', () => {
    expect(remoteWorkspaceIsEmpty('mini', '/w', remote('empty=no\n'))).toBe(false);
  });

  it('is false when the probe could not run, rather than guessing', () => {
    // Seeding on a guess is the one way this could write over something.
    expect(remoteWorkspaceIsEmpty('mini', '/w', remote('', 255))).toBe(false);
  });
});

describe('buildSeedRsyncArgs', () => {
  const base = { repoRoot: '/local/llvm', remoteSyncUrl: 'mini:/Users/x/code/llvm' };

  it('excludes every tree the sync is configured to leave alone', () => {
    // Carrying these would push a local `node_modules` over the remote's, or create a `build/` the
    // remote is supposed to own from a local directory that does not exist.
    const args = buildSeedRsyncArgs({
      ...base,
      ignorePaths: ['.git', 'build', 'node_modules'],
    });
    expect(args).toContain('--exclude');
    expect(args).toContain('build');
    expect(args).toContain('node_modules');
    expect(args).toContain('.git');
  });

  it('never deletes, because the destination is supposed to be empty', () => {
    expect(
      buildSeedRsyncArgs({ ...base, ignorePaths: [] }),
    ).not.toContain('--delete');
  });

  it('copies the contents of the repo into the workspace, not the repo directory itself', () => {
    const args = buildSeedRsyncArgs({ ...base, ignorePaths: [] });
    expect(args.at(-2)).toBe('/local/llvm/');
    expect(args.at(-1)).toBe('mini:/Users/x/code/llvm/');
  });
});

describe('seedRemoteWorkspace', () => {
  const base = {
    sshHost: 'mini',
    remoteWorkspacePath: '/w',
    remoteSyncUrl: 'mini:/w',
    repoRoot: '/l',
    ignorePaths: ['build'],
  };

  it('does nothing at all to a workspace that already has files', () => {
    let rsyncCalls = 0;
    const rsync: RsyncRunner = () => {
      rsyncCalls += 1;
      return { status: 0, stderr: '' };
    };
    const result = seedRemoteWorkspace({
      ...base,
      remote: remote('empty=no\n'),
      rsync,
    });
    expect(result.ran).toBe(false);
    expect(rsyncCalls).toBe(0);
  });

  it('seeds an empty workspace', () => {
    const result = seedRemoteWorkspace({
      ...base,
      remote: remote('empty=yes\n'),
      rsync: () => ({ status: 0, stderr: '' }),
    });
    expect(result).toEqual({ ran: true, ok: true });
  });

  it('reports a failed seed without failing the run', () => {
    // A failed seed leaves exactly the state Mutagen was about to reconcile anyway, so the run goes
    // on -- slower, as it did before this existed.
    const result = seedRemoteWorkspace({
      ...base,
      remote: remote('empty=yes\n'),
      rsync: () => ({ status: 12, stderr: 'rsync: connection unexpectedly closed\n' }),
    });
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('connection unexpectedly closed');
  });

  it('does not seed when the probe failed', () => {
    let rsyncCalls = 0;
    seedRemoteWorkspace({
      ...base,
      remote: remote('', 255),
      rsync: () => {
        rsyncCalls += 1;
        return { status: 0, stderr: '' };
      },
    });
    expect(rsyncCalls).toBe(0);
  });
});
