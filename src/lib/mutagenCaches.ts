import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SyncSessionSummary } from './mutagenSession';

/**
 * Removing the cache files Mutagen leaves behind when a session ends.
 *
 * Mutagen 0.18.1 keeps `<identifier>_alpha` on the alpha's machine and `<identifier>_beta` on the
 * beta's, both in `<data directory>/caches`, and does not delete either on `terminate`. bica starts a
 * session per run, so every run left a pair: 1,700 files and 3.5 GB on a laptop in a few weeks, and
 * the same again on the remote.
 *
 * Only ever the two exact names of a session bica has just ended. The remote's directory is shared
 * by every machine that syncs into it, so nothing here sweeps by age or by "not in my list".
 */

/** What Mutagen's identifiers look like. Anything else is never put in a path or a command. */
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]+$/;

/** `${MUTAGEN_DATA_DIRECTORY:-$HOME/.mutagen}`, spelled for `sh`, which is where it is evaluated remotely. */
const SH_CACHE_DIR = '"${MUTAGEN_DATA_DIRECTORY:-$HOME/.mutagen}/caches"';

export function mutagenCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const dataDir = env.MUTAGEN_DATA_DIRECTORY;
  return path.join(
    dataDir !== undefined && dataDir !== '' ? dataDir : path.join(home, '.mutagen'),
    'caches',
  );
}

export function cacheFileNames(identifier: string): string[] {
  return SAFE_IDENTIFIER.test(identifier)
    ? [`${identifier}_alpha`, `${identifier}_beta`]
    : [];
}

/** Delete the session's cache files on this machine. Returns how many were removed. */
export function removeLocalSessionCaches(
  identifiers: string[],
  dir: string = mutagenCacheDir(),
): number {
  let removed = 0;
  for (const id of identifiers) {
    for (const name of cacheFileNames(id)) {
      try {
        fs.unlinkSync(path.join(dir, name));
        removed += 1;
      } catch {
        // Not there, which is the usual case for the end this machine is not.
      }
    }
  }
  return removed;
}

/**
 * The ssh host a session's beta endpoint is on, from the `host:path` form `SYNC_LIST_TEMPLATE`
 * prints, or null when beta is a local folder (an empty host).
 */
export function betaSshHost(beta: string): string | null {
  const colon = beta.indexOf(':');
  const host = colon === -1 ? '' : beta.slice(0, colon).trim();
  return host === '' ? null : host;
}

/** Run on the remote under `sh`: one removal of both of each session's files. */
export function buildRemoteCacheRemovalScript(identifiers: string[]): string {
  const names = identifiers.flatMap(cacheFileNames);
  if (names.length === 0) {
    return '';
  }
  return [
    `d=${SH_CACHE_DIR}`,
    `rm -f ${names.map((n) => `"$d/${n}"`).join(' ')}`,
    '',
  ].join('\n');
}

export type RunRemoteScript = (
  sshHost: string,
  script: string,
) => { status: number | null; stderr: string };

/**
 * Bounded, because this runs while a run is ending: a remote that has gone quiet must not hold up the
 * exit hook, and nothing here may prompt.
 */
function runOverSsh(sshHost: string, script: string): { status: number | null; stderr: string } {
  const result = spawnSync(
    'ssh',
    ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', sshHost, 'sh', '-s'],
    {
      input: script,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'pipe'],
      shell: false,
      timeout: 15_000,
    },
  );
  return { status: result.status, stderr: result.stderr ?? '' };
}

export function removeRemoteSessionCaches(
  sshHost: string,
  identifiers: string[],
  run: RunRemoteScript = runOverSsh,
): boolean {
  const script = buildRemoteCacheRemovalScript(identifiers);
  if (script === '') {
    return true;
  }
  return run(sshHost, script).status === 0;
}

/**
 * Remove the cache files of sessions that have just been terminated, on both ends.
 *
 * Call it after `terminate`, not before: a session still winding down can write its cache again. A
 * failure is said once and left, because the files only cost disk and the run's own result matters more.
 */
export function removeSessionCaches(
  sessions: SyncSessionSummary[],
  deps: {
    removeLocal?: (identifiers: string[]) => number;
    removeRemote?: (sshHost: string, identifiers: string[]) => boolean;
    warn?: (message: string) => void;
  } = {},
): void {
  if (sessions.length === 0) {
    return;
  }
  const removeLocal = deps.removeLocal ?? ((ids) => removeLocalSessionCaches(ids));
  const removeRemote = deps.removeRemote ?? ((host, ids) => removeRemoteSessionCaches(host, ids));
  const warn = deps.warn ?? ((message) => void process.stderr.write(message));

  removeLocal(sessions.map((s) => s.identifier));

  const byHost = new Map<string, string[]>();
  for (const s of sessions) {
    const host = betaSshHost(s.beta);
    if (host !== null) {
      byHost.set(host, [...(byHost.get(host) ?? []), s.identifier]);
    }
  }
  for (const [host, identifiers] of byHost) {
    if (!removeRemote(host, identifiers)) {
      warn(
        `[bica] Could not remove the sync cache on ${host}; ${identifiers.join(', ')} stays in its ~/.mutagen/caches until deleted.\n`,
      );
    }
  }
}
