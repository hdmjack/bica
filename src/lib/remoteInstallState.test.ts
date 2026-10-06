import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  clearRemoteInstallRecord,
  installRecordPathExpr,
  readRemoteInstallRecord,
  writeRemoteInstallRecord,
} from './remoteInstallState';
import type { RemoteRunner } from './remoteInstallState';

/** A remote whose only filesystem is a map, driven by the scripts the module actually sends. */
function fakeRemote(initial: Record<string, string> = {}): {
  run: RemoteRunner;
  files: Map<string, string>;
  scripts: string[];
} {
  const files = new Map(Object.entries(initial));
  const scripts: string[] = [];
  const run: RemoteRunner = (_host, script) => {
    scripts.push(script);
    const write = /printf '%s\\n' '(.+)' > (\S+)/.exec(script);
    if (write) {
      files.set(write[2], `${write[1]}\n`);
      return { status: 0, stdout: '', stderr: '' };
    }
    const read = /^cat (\S+) /.exec(script);
    if (read) {
      return { status: 0, stdout: files.get(read[1]) ?? '', stderr: '' };
    }
    const remove = /^rm -f (\S+)/.exec(script);
    if (remove) {
      files.delete(remove[1]);
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected script: ${script}`);
  };
  return { run, files, scripts };
}

describe('where an install record lives', () => {
  it('is keyed by the remote workspace, not by whoever is asking', () => {
    // The whole point: two checkouts pointing at one workspace read and write one record.
    expect(installRecordPathExpr('~/code/repo-3', 'pnpm')).toBe(
      installRecordPathExpr('~/code/repo-3', 'pnpm'),
    );
    expect(installRecordPathExpr('~/code/repo-3', 'pnpm')).not.toBe(
      installRecordPathExpr('~/code/repo-4', 'pnpm'),
    );
  });

  it('separates package managers sharing a workspace', () => {
    expect(installRecordPathExpr('~/code/repo', 'pnpm')).not.toBe(
      installRecordPathExpr('~/code/repo', 'cargo'),
    );
  });

  it('sits outside any synced tree, where a sync cannot delete it', () => {
    const p = installRecordPathExpr('~/code/repo', 'pnpm');
    expect(p.startsWith('~/.bica/installs/')).toBe(true);
    expect(p).not.toContain('code/repo/');
  });

  it('reduces a path to one safe filename segment', () => {
    const p = installRecordPathExpr('~/code/some repo/with:chars', 'pnpm');
    expect(p.slice('~/.bica/installs/'.length)).not.toContain('/');
  });
});

describe('reading and writing the record', () => {
  it('round-trips a digest through the remote', () => {
    const remote = fakeRemote();
    writeRemoteInstallRecord('h', '~/code/repo', 'pnpm', 'abc123', remote.run);
    expect(readRemoteInstallRecord('h', '~/code/repo', 'pnpm', remote.run)).toBe(
      'abc123',
    );
  });

  it('reads nothing for a workspace that has never installed', () => {
    const remote = fakeRemote();
    expect(
      readRemoteInstallRecord('h', '~/code/repo', 'pnpm', remote.run),
    ).toBeNull();
  });

  it('reads what another checkout wrote for the same workspace', () => {
    const remote = fakeRemote();
    writeRemoteInstallRecord('h', '~/code/repo', 'pnpm', 'from-a', remote.run);
    // A different checkout, the same remote path: it must see A's install, not its own history.
    expect(readRemoteInstallRecord('h', '~/code/repo', 'pnpm', remote.run)).toBe(
      'from-a',
    );
  });

  it('treats an unreadable record as no record, so the run installs', () => {
    const failing: RemoteRunner = () => ({
      status: 255,
      stdout: 'anything',
      stderr: 'ssh: connect failed',
    });
    expect(
      readRemoteInstallRecord('h', '~/code/repo', 'pnpm', failing),
    ).toBeNull();
  });

  it('clears a record, so the next run installs', () => {
    const remote = fakeRemote();
    writeRemoteInstallRecord('h', '~/code/repo', 'pnpm', 'abc', remote.run);
    clearRemoteInstallRecord('h', '~/code/repo', 'pnpm', remote.run);
    expect(
      readRemoteInstallRecord('h', '~/code/repo', 'pnpm', remote.run),
    ).toBeNull();
  });

  it('creates the directory before writing into it', () => {
    const remote = fakeRemote();
    writeRemoteInstallRecord('h', '~/code/repo', 'pnpm', 'abc', remote.run);
    expect(remote.scripts[0]).toContain('mkdir -p ~/.bica/installs');
  });

  it('does not let a digest escape its quoting', () => {
    // Run the script the module would send through a real shell, with HOME pointed at a temp
    // directory, and check what lands on disk. Asserting on the text of the script only restates the
    // escaping rule; running it is what shows the hostile digest stayed data.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-install-rec-'));
    const canary = path.join(home, 'canary');
    fs.writeFileSync(canary, 'untouched');
    const hostile = `abc'; rm -f ${canary}; echo '`;
    const remote = fakeRemote();
    writeRemoteInstallRecord('h', '~/code/repo', 'pnpm', hostile, remote.run);
    try {
      const result = spawnSync('sh', ['-s'], {
        input: remote.scripts[0],
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(fs.readFileSync(canary, 'utf8')).toBe('untouched');
      const written = fs.readFileSync(
        path.join(home, '.bica', 'installs', 'code_repo.pnpm'),
        'utf8',
      );
      expect(written.trim()).toBe(hostile);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
