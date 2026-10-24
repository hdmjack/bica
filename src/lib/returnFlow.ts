import { spawnSync } from 'node:child_process';
import {
  buildSubmodulePointerScript,
  readSubmodulePointers,
} from './rustWorkspace';
import { remoteWorkspaceWordForSh } from './runRemote';


import { dim, warn } from '../terminalStyle';
import type { PrepareResult } from '../syncProject';
import {
  resolveGitLayout,
  WORKTREE_PRIVATE_ENTRIES,
} from './gitLayout';
import {
  remotePathExprForCd,
  runRemoteScriptOverStdin,
} from './runRemote';
import { SUBPROCESS_MAX_BUFFER } from './subprocessOutput';
import { SYNC_NOT_READY_EXIT } from './syncProgress';
import type { RsyncRunner } from './artifacts';

/**
 * Trees return-flow must never walk, on top of whatever the user ignores. `.git` is mirrored
 * separately by {@link pushGitToRemote} and must not be reached through a `*.log`-style pattern.
 *
 * `.bica` is local-only state — the same reason the pinned push refuses to send it. Return-flow was
 * pulling *into* it, which a dry run caught deleting `.bica/locks/` because the remote has no such
 * directory. The locks self-heal (acquisition mkdirs recursively), so this was not losing anything;
 * what it was doing is letting a post-run pull with `--delete` reach the directory another run may be
 * taking a lock in at that moment. Nothing in the lock design accounts for a third party removing the
 * directory mid-acquire, and it should not have to.
 */
const ALWAYS_EXCLUDED_PATHS: readonly string[] = ['.git', '.bica'];

/**
 * Turn the session's `sync.ignore.paths` into the set of paths return-flow excludes.
 *
 * Ignored trees are owned independently by each side — `node_modules` is installed on the remote,
 * `dist` is built there — so they hold artifacts that match the return-flow whitelist (a dependency
 * shipping `__snapshots__/*.snap`, a build log) but have no business crossing the wire. Without this
 * the mirror drags remote-only files into the local tree and, with `--delete`, removes local-only
 * ones. Mutagen negations (`!foo`) re-include a path in the *forward* sync and say nothing about
 * return-flow ownership, so they are dropped rather than translated.
 */
export function buildReturnFlowExcludes(
  syncIgnorePaths: readonly string[],
): string[] {
  const fromConfig = syncIgnorePaths
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith('!'));
  return Array.from(new Set([...ALWAYS_EXCLUDED_PATHS, ...fromConfig]));
}

// Build the rsync filter-rule arguments that transfer only the whitelisted patterns.
// Excluded trees are ruled out first (first matching rule wins), so rsync never descends into them
// and --delete never reaches inside them; the "+ <slash>" rule lets rsync descend into every
// remaining directory so it can find matches; each whitelist pattern becomes an include; the
// trailing "- *" excludes everything else; and --prune-empty-dirs keeps rsync from materializing
// empty parent dirs on the receiving side.
//
// Note: a "P */" protect rule would look like a tidy way to keep --delete off receiver-side
// directories, but protecting a directory protects everything under it, which switches off the
// obsolete-snapshot pruning entirely. The exclude list is what keeps deletion in bounds.
export function buildReturnFlowRsyncArgs(
  patterns: readonly string[],
  excludePaths: readonly string[] = [],
): string[] {
  return [
    '--prune-empty-dirs',
    ...excludePaths.map((p) => `--filter=- ${p}`),
    '--filter=+ */',
    ...patterns.map((p) => `--filter=+ ${p}`),
    '--filter=- *',
  ];
}

/**
 * Full rsync argv (sans the leading `rsync`) to *mirror* the return-flow patterns from `source`
 * to `dest`, skipping `excludePaths`. `--delete` is scoped to the whitelisted patterns: the trailing
 * `--filter=- *` protects every non-matching file from both transfer and deletion, so only files
 * matching a return-flow pattern that exist on the receiver but not the sender get removed. Used for
 * both the pre-run push (local→remote) and the post-run pull (remote→local) so each side becomes an
 * exact mirror of the other for the whitelisted artifacts. Pure, for testability.
 */
export function buildReturnFlowMirrorArgs(
  patterns: readonly string[],
  source: string,
  dest: string,
  excludePaths: readonly string[] = [],
): string[] {
  return [
    '-az',
    '--delete',
    ...buildReturnFlowRsyncArgs(patterns, excludePaths),
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
    buildReturnFlowExcludes(prep.syncIgnorePaths),
  );

  const result = spawnSync('rsync', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: SUBPROCESS_MAX_BUFFER,
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
    buildReturnFlowExcludes(prep.syncIgnorePaths),
  );

  const result = spawnSync('rsync', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: SUBPROCESS_MAX_BUFFER,
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
 * Files git creates for the length of one operation and removes when it ends.
 *
 * Never worth copying, and harmful to copy. Another git process in the same repository -- an editor
 * polling `git status`, a hook, a second agent -- makes and removes `index.lock` many times a second,
 * and one that vanished while rsync was reading it failed the whole sync with exit 23. A run from a
 * worktree then went ahead with no refs on the remote, and `test:run:changed` reported `unknown
 * revision 'origin/master...HEAD'` as an ordinary exit 1. One that is copied whole is worse: a stale
 * `index.lock` on the remote stops every git command there that writes the index.
 *
 * Excluded on every pass, and deleted from the remote by the passes that mirror, so a lock an earlier
 * version copied does not stay there for good.
 */
export const GIT_TRANSIENT_PATTERNS: readonly string[] = [
  '*.lock',
  'tmp_pack_*',
  'tmp_idx_*',
  'tmp_obj_*',
];

const transientExcludes = GIT_TRANSIENT_PATTERNS.flatMap((p) => ['--exclude', p]);

/**
 * Rsync the local `.git` directory to the remote workspace (local → remote), making the remote git
 * history/HEAD/refs an exact mirror of local. Enables git-dependent commands like `vitest --changed`
 * to resolve the same changed-file set on the remote as they would locally.
 *
 * Uses `--delete` so stale remote-only refs/objects don't linger (unlike return-flow, which never
 * deletes). A failure is returned rather than thrown, and the caller stops the run on it -- see
 * {@link gitSyncStopsRun}.
 */
export function pushGitToRemote(
  prep: PrepareResult,
  run: RsyncRunner = defaultRsyncRunner,
): PullResult {
  if (!rsyncAvailable()) {
    process.stderr.write(
      `${warn('[bica]')} ${dim('rsync not on PATH; skipping .git sync (install rsync to enable git-dependent commands like --changed).')}\n`,
    );
    return { ran: false };
  }

  const layout = resolveGitLayout(prep.repoRoot);
  if (layout.kind === 'none') {
    process.stderr.write(
      `${warn('[bica]')} ${dim(`${prep.repoRoot} is not a git repository, so there is nothing to sync.`)}\n`,
    );
    return { ran: false };
  }

  const remoteDest = `${ensureTrailingSlash(prep.remoteSyncUrl)}.git/`;

  // A previous sync from a worktree may have left a one-line `.git` *file* there, and rsync cannot
  // make a directory where a file is. Only ever a file: a `.git` directory is what this is building.
  clearRemoteDotGitFile(prep);

  if (layout.kind === 'plain') {
    const result = rsyncGit(
      [
        '-az',
        '--delete',
        '--delete-excluded',
        ...transientExcludes,
        ensureTrailingSlash(layout.gitDir),
        remoteDest,
      ],
      run,
    );
    if (result.exitCode === 0) {
      restoreSubmodulePointers(prep);
    }
    return result;
  }

  // A worktree becomes an ordinary repository on the remote.
  //
  // Everything shared goes first -- objects, refs, config -- then this worktree's own state on top of
  // it, so HEAD and the index are this checkout's rather than the main clone's. The result is a plain
  // repository at the same commit, which is all a history-reading command needs and far simpler than
  // reproducing git's worktree layout against paths that do not exist on the remote.
  process.stderr.write(
    `${dim('[bica]')} ${dim('This is a git worktree; syncing the shared repository and this worktree\'s state as one.')}\n`,
  );
  const shared = rsyncGit(
    [
      '-az',
      '--delete',
      '--delete-excluded',
      '--exclude',
      'worktrees/',
      ...transientExcludes,
      ensureTrailingSlash(layout.commonDir),
      remoteDest,
    ],
    run,
  );
  if (shared.exitCode !== 0) {
    return shared;
  }
  return rsyncGit([
    '-az',
    // `--ignore-times`, because the overlay's whole job is to replace files the first pass just
    // wrote. rsync's quick check skips a file whose size and mtime match, and the file that matters
    // most here is `HEAD`: `ref: refs/heads/main` and `ref: refs/heads/side` are the same length, and
    // a worktree created in the same second as its clone has the same timestamp. So the one file that
    // decides which commit the remote is on was silently not copied, and the remote reported the main
    // clone's HEAD with every appearance of success. The overlay is small -- HEAD, index, logs and
    // this worktree's refs -- so forcing it costs nothing worth measuring.
    '--ignore-times',
    ...WORKTREE_PRIVATE_ENTRIES.flatMap((entry) => ['--exclude', entry]),
    ...transientExcludes,
    ensureTrailingSlash(layout.gitDir),
    remoteDest,
  ], run);
}

/** Remove a `.git` that is a plain file on the remote, which only a worktree sync can have left. */
function clearRemoteDotGitFile(prep: PrepareResult): void {
  runRemoteScriptOverStdin(
    prep.config.sshHost,
    `cd ${remotePathExprForCd(prep.config.remoteWorkspacePath)} 2>/dev/null || exit 0\n` +
      '[ -f .git ] && rm -f .git\n' +
      'exit 0\n',
  );
}

/**
 * Put each submodule's `.git` file back on the remote.
 *
 * The sync ignores `.git` at every level, so a submodule's own `.git` -- a one-line file naming a
 * path inside the parent's `.git/modules` -- never travels, while the modules directory it points at
 * does, because that lives inside the parent `.git` this function's caller just copied. The remote
 * ends up with all the data and nothing addressing it, and `git submodule status` calls every
 * submodule uninitialised. rustc's bootstrap reads exactly that.
 */
function restoreSubmodulePointers(prep: PrepareResult): void {
  const pointers = readSubmodulePointers(prep.repoRoot);
  if (pointers.length === 0) {
    return;
  }
  const script = buildSubmodulePointerScript({
    remoteWorkspaceWord: remoteWorkspaceWordForSh(prep.config.remoteWorkspacePath),
    pointers,
  });
  const result = runRemoteScriptOverStdin(prep.config.sshHost, script);
  if (result.status !== 0) {
    process.stderr.write(
      `${warn('[bica]')} ${dim(`Could not restore ${String(pointers.length)} submodule pointer(s) on the remote; \`git submodule\` there will report them uninitialised.`)}\n`,
    );
    return;
  }
  process.stderr.write(
    `${dim('[bica]')} ${dim(`Restored ${String(pointers.length)} submodule pointer(s) on the remote.`)}\n`,
  );
}

function defaultRsyncRunner(args: readonly string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('rsync', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    shell: false,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** rsync's code for "some files vanished before they could be transferred". */
const RSYNC_VANISHED = 24;

/**
 * One `.git` pass, retried once.
 *
 * A repository somebody is using changes under the copy. The transient files are excluded, but a
 * pack written by a fetch or a `gc` can still appear or go part-way through, so one failure earns one
 * more attempt -- which, against a tree that has stopped moving, is a complete copy. A file that
 * vanished (24) is not a failure at all: what vanishes from `.git` is by nature something git was
 * about to remove.
 */
export function rsyncGit(
  args: string[],
  run: RsyncRunner = defaultRsyncRunner,
): PullResult {
  let code = 0;
  let said = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = run(args);
    code = result.status === RSYNC_VANISHED ? 0 : result.status;
    if (code === 0) {
      return { ran: true, exitCode: 0 };
    }
    said = `${result.stderr}${result.stdout}`.trim();
  }
  process.stderr.write(
    `${warn('[bica]')} ${dim(`.git sync rsync exited ${String(code)}${said ? `: ${said}` : ''}`)}\n`,
  );
  return { ran: true, exitCode: code };
}

/**
 * The run's exit code when the `.git` sync failed, or `undefined` to go ahead.
 *
 * It was best-effort, so that a failed copy could not mask the command's exit code. It masked it the
 * other way instead: the commands ran against a repository with no refs, and a history-reading one
 * failed in a way indistinguishable from a real failure. Stopping says the true thing, which is that
 * nothing ran against the tree that was asked for.
 */
export function gitSyncStopsRun(
  result: PullResult,
  sshHost: string,
): number | undefined {
  if (!result.ran || result.exitCode === 0) {
    return undefined;
  }
  process.stderr.write(
    `${warn('[bica]')} The .git sync to ${sshHost} did not complete, so the remote's history is incomplete ` +
      'and a command that reads it would fail as if your code had. Nothing ran, so exit ' +
      `${String(SYNC_NOT_READY_EXIT)} is not a verdict on your code. Re-run; \`git: sync: false\` in ` +
      'bica.yml turns the .git sync off for a repository whose commands never read history.\n',
  );
  return SYNC_NOT_READY_EXIT;
}
