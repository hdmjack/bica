import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  betaSshHost,
  buildRemoteCacheRemovalScript,
  cacheFileNames,
  mutagenCacheDir,
  removeLocalSessionCaches,
  removeSessionCaches,
} from './mutagenCaches';
import type { SyncSessionSummary } from './mutagenSession';

function session(identifier: string, beta: string): SyncSessionSummary {
  return { name: 'run', identifier, alpha: '/repo', beta };
}

describe('where the caches are', () => {
  it('follows MUTAGEN_DATA_DIRECTORY, and falls back to ~/.mutagen', () => {
    expect(mutagenCacheDir({ MUTAGEN_DATA_DIRECTORY: '/data/m' }, '/home/me')).toBe('/data/m/caches');
    expect(mutagenCacheDir({ MUTAGEN_DATA_DIRECTORY: '' }, '/home/me')).toBe('/home/me/.mutagen/caches');
    expect(mutagenCacheDir({}, '/home/me')).toBe('/home/me/.mutagen/caches');
  });

  it('names the two files Mutagen writes, and refuses an identifier it does not recognise', () => {
    // Identifiers already begin with `sync_`; seen on Mutagen 0.18.1 with `mutagen sync list`.
    expect(cacheFileNames('sync_L5lM4pXWB8H7kStW18IcvC0lMEiRIWGfbtBxB9qzAKm')).toEqual([
      'sync_L5lM4pXWB8H7kStW18IcvC0lMEiRIWGfbtBxB9qzAKm_alpha',
      'sync_L5lM4pXWB8H7kStW18IcvC0lMEiRIWGfbtBxB9qzAKm_beta',
    ]);
    expect(cacheFileNames('../x')).toEqual([]);
    expect(cacheFileNames('a b')).toEqual([]);
    expect(cacheFileNames('')).toEqual([]);
  });
});

describe('removeLocalSessionCaches', () => {
  it('removes only the named sessions\' files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica caches '));
    try {
      for (const name of ['sync_A_alpha', 'sync_A_beta', 'sync_B_alpha', 'sync_AB_alpha']) {
        fs.writeFileSync(path.join(dir, name), '');
      }
      expect(removeLocalSessionCaches(['sync_A', 'sync_gone'], dir)).toBe(2);
      expect(fs.readdirSync(dir).sort()).toEqual(['sync_AB_alpha', 'sync_B_alpha']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('betaSshHost', () => {
  it('reads the host out of the host:path form, and is null for a local beta', () => {
    expect(betaSshHost('mini:~/code/web-app')).toBe('mini');
    expect(betaSshHost(':/tmp/b')).toBeNull();
    expect(betaSshHost('')).toBeNull();
  });
});

describe('buildRemoteCacheRemovalScript', () => {
  it('removes both files of each session from the remote\'s own data directory', () => {
    expect(buildRemoteCacheRemovalScript(['sync_A', 'sync_B'])).toBe(
      'd="${MUTAGEN_DATA_DIRECTORY:-$HOME/.mutagen}/caches"\n' +
        'rm -f "$d/sync_A_alpha" "$d/sync_A_beta" "$d/sync_B_alpha" "$d/sync_B_beta"\n',
    );
  });

  it('is empty when no identifier is safe, so nothing is sent', () => {
    expect(buildRemoteCacheRemovalScript(['x; reboot'])).toBe('');
  });
});

describe('removeSessionCaches', () => {
  it('cleans here once and on each remote host once', () => {
    const local: string[][] = [];
    const remote: [string, string[]][] = [];
    removeSessionCaches(
      [session('sync_1', 'mini:/a'), session('sync_2', 'mini:/b'), session('sync_3', 'box:/c'), session('sync_4', ':/d')],
      {
        removeLocal: (ids) => (local.push(ids), 0),
        removeRemote: (host, ids) => (remote.push([host, ids]), true),
      },
    );
    expect(local).toEqual([['sync_1', 'sync_2', 'sync_3', 'sync_4']]);
    expect(remote).toEqual([
      ['mini', ['sync_1', 'sync_2']],
      ['box', ['sync_3']],
    ]);
  });

  it('says so, once per host, when the remote could not be cleaned, and carries on', () => {
    const said: string[] = [];
    removeSessionCaches([session('sync_1', 'mini:/a')], {
      removeLocal: () => 0,
      removeRemote: () => false,
      warn: (m) => void said.push(m),
    });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('mini');
    expect(said[0]).toContain('sync_1');
  });

  it('does nothing for no sessions', () => {
    removeSessionCaches([], {
      removeLocal: () => {
        throw new Error('should not be called');
      },
    });
  });
});
