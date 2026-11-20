import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildRealPathProbeScript,
  clearRealPathCache,
  parseRealPathProbe,
  resolveRemoteWorkspacePath,
} from './remoteRealPath';
import type { RemoteScriptRun } from './remoteRealPath';

/** Runs the probe in a real shell, standing in for the remote. */
function probeInShell(workspace: string): string {
  const result = spawnSync('sh', ['-s'], {
    input: buildRealPathProbeScript(workspace),
    encoding: 'utf8',
  });
  return result.stdout;
}

describe('the real-path probe, run in a real shell', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bica-realpath-')));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names the directory a link leads to, however many links lie between', () => {
    // The shape of the report: ~/code/NAME is a link to a directory on another volume.
    const real = path.join(dir, 'volume', 'NAME');
    fs.mkdirSync(real, { recursive: true });
    const hop = path.join(dir, 'hop');
    fs.symlinkSync(real, hop);
    const link = path.join(dir, 'NAME');
    fs.symlinkSync(hop, link);
    expect(parseRealPathProbe(probeInShell(link))).toBe(real);
  });

  it('sees a link through a trailing slash, which would otherwise follow it', () => {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    const link = path.join(dir, 'link');
    fs.symlinkSync(real, link);
    expect(parseRealPathProbe(probeInShell(`${link}/`))).toBe(real);
  });

  it('says nothing for a path that is a real directory, so its name is left alone', () => {
    const real = path.join(dir, 'plain');
    fs.mkdirSync(real);
    expect(parseRealPathProbe(probeInShell(real))).toBe('');
  });

  it('leaves a path with a link higher up alone, since that opens without trouble', () => {
    const real = path.join(dir, 'real-parent');
    fs.mkdirSync(path.join(real, 'work'), { recursive: true });
    const parent = path.join(dir, 'parent-link');
    fs.symlinkSync(real, parent);
    expect(parseRealPathProbe(probeInShell(path.join(parent, 'work')))).toBe('');
  });

  it('says nothing for a path that does not exist yet', () => {
    expect(parseRealPathProbe(probeInShell(path.join(dir, 'not-yet')))).toBe('');
  });

  it('cannot tell where a link leads nowhere', () => {
    const link = path.join(dir, 'dangling');
    fs.symlinkSync(path.join(dir, 'gone'), link);
    expect(parseRealPathProbe(probeInShell(link))).toBeNull();
  });
});

describe('parseRealPathProbe', () => {
  it('rejects an answer that is not an absolute path', () => {
    expect(parseRealPathProbe('real=relative/dir\n')).toBeNull();
    expect(parseRealPathProbe('garbage')).toBeNull();
  });
});

describe('resolveRemoteWorkspacePath', () => {
  beforeEach(() => {
    clearRealPathCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const answering =
    (stdout: string, status = 0): RemoteScriptRun =>
    () => ({ status, stdout, stderr: '' });

  it('uses the real path for a link, and says so', () => {
    const said: string[] = [];
    const chosen = resolveRemoteWorkspacePath(
      'mini',
      '~/code/usg-player-character',
      answering('real=/Volumes/usg-builds/code/usg-player-character\n'),
      (line) => said.push(line),
    );
    expect(chosen).toBe('/Volumes/usg-builds/code/usg-player-character');
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('is a link to /Volumes/usg-builds/code/usg-player-character');
  });

  it('keeps the configured path, silently, when it is not a link', () => {
    const said: string[] = [];
    expect(
      resolveRemoteWorkspacePath('mini', '~/code/x', answering('real=\n'), (l) => said.push(l)),
    ).toBe('~/code/x');
    expect(said).toEqual([]);
  });

  it('keeps the configured path when the remote could not be asked', () => {
    expect(resolveRemoteWorkspacePath('mini', '~/code/x', answering('', 255))).toBe('~/code/x');
  });

  it('asks a host once, however many commands want the answer', () => {
    let asked = 0;
    const run: RemoteScriptRun = () => {
      asked += 1;
      return { status: 0, stdout: 'real=/Volumes/v/x\n', stderr: '' };
    };
    const say = (): void => undefined;
    for (let i = 0; i < 4; i += 1) {
      resolveRemoteWorkspacePath('mini', '~/code/x', run, say);
    }
    expect(asked).toBe(1);
  });

  it('does not ask at all when switched off', () => {
    vi.stubEnv('BICA_RESOLVE_REMOTE_LINKS', '0');
    const run: RemoteScriptRun = () => {
      throw new Error('should not be asked');
    };
    expect(resolveRemoteWorkspacePath('mini', '~/code/x', run)).toBe('~/code/x');
  });
});
