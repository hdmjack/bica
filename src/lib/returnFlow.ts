import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

import { dim, warn } from '../terminalStyle';
import type { PrepareResult } from '../syncProject';

// Build the rsync filter-rule arguments that pull only the whitelisted patterns from remote→local.
// The "+ <slash>" rule lets rsync descend into every directory so it can find matches; each
// whitelist pattern becomes an include; the trailing "- *" excludes everything else; and
// --prune-empty-dirs keeps rsync from materializing empty parent dirs on the local side.
export function buildReturnFlowRsyncArgs(patterns: readonly string[]): string[] {
  return [
    '--prune-empty-dirs',
    '--filter=+ */',
    ...patterns.map((p) => `--filter=+ ${p}`),
    '--filter=- *',
  ];
}

/**
 * Full rsync argv (sans the leading `rsync`) to *mirror* the return-flow patterns from `source`
 * to `dest`. `--delete` is scoped to the whitelisted patterns: the trailing `--filter=- *`
 * protects every non-matching file from both transfer and deletion, so only files matching a
 * return-flow pattern that exist on the receiver but not the sender get removed. Used for both the
 * pre-run push (local→remote) and the post-run pull (remote→local) so each side becomes an exact
 * mirror of the other for the whitelisted artifacts. Pure, for testability.
 */
export function buildReturnFlowMirrorArgs(
  patterns: readonly string[],
  source: string,
  dest: string,
): string[] {
  return [
    '-az',
    '--delete',
    ...buildReturnFlowRsyncArgs(patterns),
    source,
    dest,
  ];
}

function ensureTrailingSlash(p: string): string {
  return p.endsWith('/') ? p : `${p}/`;
}

/**
 * Detect rsync. Returns true when callable; false otherwise (caller should warn, not fail).
 */
function rsyncAvailable(): boolean {
  const result = spawnSync('rsync', ['--version'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: false,
  });
  return result.error == null && result.status === 0;
}

export interface PullResult {
  /** Whether rsync ran. False = skipped (no patterns, rsync missing, or disabled). */
  ran: boolean;
  /** rsync exit code, when ran. */
  exitCode?: number;
}

/**
 * Mirror the configured return-flow patterns from the remote workspace into the local repo
 * (remote → local, with `--delete` scoped to the patterns). Local artifacts matching a return-flow
 * pattern that no longer exist on the remote are removed, so stale/obsolete snapshots (e.g. pruned
 * by `vitest -u`, or left over from another branch) don't linger locally. Non-matching files are
 * never touched. Pair with {@link pushReturnFlowToRemote}, which resets the remote to the current
 * branch before the run so this pull mirrors current-branch state, not stale cross-branch state.
 *
 * Best-effort — failures emit a warning and return non-zero but do not throw, so they don't mask
 * the remote command's exit code.
 */
export function pullReturnFlow(prep: PrepareResult): PullResult {
  if (prep.returnFlowPaths.length === 0) {
    return { ran: false };
  }
  if (process.env.BICA_RETURN_FLOW?.trim() === '0') {
    return { ran: false };
  }
  if (!rsyncAvailable()) {
    process.stderr.write(
      `${warn('[bica]')} ${dim('rsync not on PATH; skipping return-flow pull (install rsync to enable snapshot return).')}\n`,
    );
    return { ran: false };
  }

  const remoteSource = ensureTrailingSlash(prep.remoteSyncUrl);
  const localDest = ensureTrailingSlash(prep.repoRoot);
  const args = buildReturnFlowMirrorArgs(
    prep.returnFlowPaths,
    remoteSource,
    localDest,
  );

  const result = spawnSync('rsync', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  const code = result.status ?? 1;
  if (code !== 0) {
    const err = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    process.stderr.write(
      `${warn('[bica]')} ${dim(`return-flow rsync exited ${String(code)}${err ? `: ${err}` : ''}`)}\n`,
    );
  }
  return { ran: true, exitCode: code };
}

/**
 * Mirror the local return-flow artifacts (snapshots, logs) onto the remote *before* the run
 * (local → remote, with `--delete` scoped to the patterns).
 *
 * Return-flow patterns are Mutagen-ignored, so the forward sync never refreshes them on the remote
 * when you switch branches — the remote keeps the *previous* branch's snapshots, which then flow
 * back locally via {@link pullReturnFlow}. This one-shot rsync resets the remote's artifacts to the
 * current branch's committed state so the remote command starts clean and can't leak stale,
 * cross-branch snapshots. `.git`-style direct rsync (not Mutagen) is safe precisely because these
 * paths are Mutagen-ignored, so the live session won't fight it.
 *
 * Best-effort — failures emit a warning and return non-zero but do not throw.
 */
export function pushReturnFlowToRemote(prep: PrepareResult): PullResult {
  if (prep.returnFlowPaths.length === 0) {
    return { ran: false };
  }
  if (process.env.BICA_RETURN_FLOW?.trim() === '0') {
    return { ran: false };
  }
  if (!rsyncAvailable()) {
    process.stderr.write(
      `${warn('[bica]')} ${dim('rsync not on PATH; skipping return-flow remote refresh (install rsync to avoid stale cross-branch snapshots).')}\n`,
    );
    return { ran: false };
  }

  const localSource = ensureTrailingSlash(prep.repoRoot);
  const remoteDest = ensureTrailingSlash(prep.remoteSyncUrl);
  const args = buildReturnFlowMirrorArgs(
    prep.returnFlowPaths,
    localSource,
    remoteDest,
  );

  const result = spawnSync('rsync', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  const code = result.status ?? 1;
  if (code !== 0) {
    const err = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    process.stderr.write(
      `${warn('[bica]')} ${dim(`return-flow remote refresh rsync exited ${String(code)}${err ? `: ${err}` : ''}`)}\n`,
    );
  }
  return { ran: true, exitCode: code };
}

/**
 * Rsync the local `.git` directory to the remote workspace (local → remote), making the remote git
 * history/HEAD/refs an exact mirror of local. Enables git-dependent commands like `vitest --changed`
 * to resolve the same changed-file set on the remote as they would locally.
 *
 * Uses `--delete` so stale remote-only refs/objects don't linger (unlike return-flow, which never
 * deletes). Best-effort — failures emit a warning and return non-zero but do not throw, so they
 * don't mask the remote command's exit code.
 */
export function pushGitToRemote(prep: PrepareResult): PullResult {
  if (!rsyncAvailable()) {
    process.stderr.write(
      `${warn('[bica]')} ${dim('rsync not on PATH; skipping .git sync (install rsync to enable git-dependent commands like --changed).')}\n`,
    );
    return { ran: false };
  }

  const localSource = ensureTrailingSlash(path.join(prep.repoRoot, '.git'));
  const remoteDest = `${ensureTrailingSlash(prep.remoteSyncUrl)}.git/`;
  const args = ['-az', '--delete', localSource, remoteDest];

  const result = spawnSync('rsync', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  const code = result.status ?? 1;
  if (code !== 0) {
    const err = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    process.stderr.write(
      `${warn('[bica]')} ${dim(`.git sync rsync exited ${String(code)}${err ? `: ${err}` : ''}`)}\n`,
    );
  }
  return { ran: true, exitCode: code };
}
