import { spawnSync } from 'node:child_process';

import {
  remoteWorkspaceWordForSh,
  runRemoteScriptOverStdin,
} from './runRemote';

/**
 * One bulk rsync to fill an empty remote workspace, before Mutagen is asked to.
 *
 * Mutagen is a good incremental mirror and a slow first transfer: it stages a 180,000-file tree one
 * file at a time, each with its own round trip, and the first `bica run` on an llvm-project checkout
 * spends most of an hour on that before anything can start. rsync does the same job in one pass over
 * one connection, which is what it was built for.
 *
 * Only when the workspace is *empty*, and that restraint is the whole safety argument. Seeding a
 * directory that already holds files would mean reasoning about which side is newer, deleting what
 * does not match, and getting it right against a build tree the remote owns -- all of which is
 * Mutagen's job and none of which rsync should be improvising here. An empty workspace has no such
 * question: nothing can be lost because there is nothing there.
 *
 * The excludes matter as much as the copy. `sync.ignore.paths` names the trees each side owns, and a
 * seed that carried them would push a local `node_modules` over a remote one, or -- far worse --
 * create a `build/` the remote was supposed to own, from a local directory that does not exist.
 */

/** How the seed is run. Injectable so the shape of the command can be tested without a remote. */
export type RsyncRunner = (args: readonly string[]) => {
  status: number;
  stderr: string;
};

/** How the emptiness check is run. */
export type RemoteRunner = (
  sshHost: string,
  script: string,
) => { status: number; stdout: string; stderr: string };

/**
 * Whether the remote workspace has nothing in it.
 *
 * Asks for one entry rather than a count: a 180,000-file tree should not be walked to answer a
 * yes/no question, and `find -maxdepth 1` stops as soon as it has something to print. A path that
 * does not exist yet is empty by any reading, and so is one that cannot be listed -- in which case
 * the seed is skipped and Mutagen handles it, which is exactly the old behaviour.
 */
export function buildEmptinessProbeScript(remoteWorkspacePath: string): string {
  const w = remoteWorkspaceWordForSh(remoteWorkspacePath);
  return [
    `w=${w}`,
    `if [ ! -d "$w" ]; then printf 'empty=yes\\n'; exit 0; fi`,
    // `-print -quit` leaves as soon as one entry is found, so this costs nothing on a full tree.
    `found=$(find "$w" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)`,
    `if [ -z "$found" ]; then printf 'empty=yes\\n'; else printf 'empty=no\\n'; fi`,
    '',
  ].join('\n');
}

export function remoteWorkspaceIsEmpty(
  sshHost: string,
  remoteWorkspacePath: string,
  run: RemoteRunner = runRemoteScriptOverStdin,
): boolean {
  const result = run(sshHost, buildEmptinessProbeScript(remoteWorkspacePath));
  if (result.status !== 0) {
    // A probe that could not run is not evidence of an empty workspace, and seeding on a guess is
    // the one way this could overwrite something.
    return false;
  }
  return /^empty=yes$/m.test(result.stdout);
}

/**
 * The seed command.
 *
 * `--delete` is deliberately absent: the destination is empty, so there is nothing to delete, and
 * including it would make this dangerous the moment the emptiness check were ever wrong.
 */
export function buildSeedRsyncArgs(options: {
  repoRoot: string;
  remoteSyncUrl: string;
  ignorePaths: readonly string[];
}): string[] {
  const excludes = options.ignorePaths.flatMap((p) => [
    '--exclude',
    p.replace(/^\.?\//, ''),
  ]);
  // No `--info=stats2`: openrsync, which is what macOS ships as `rsync`, does not take it and
  // answers with its usage text, so the seed failed with a truncated "source ... directory" and the
  // run quietly fell back to the slow path.
  return [
    '-az',
    ...excludes,
    `${options.repoRoot.replace(/\/+$/, '')}/`,
    `${options.remoteSyncUrl}/`,
  ];
}

export interface SeedResult {
  /** False when the workspace already had files, or rsync was not available. */
  ran: boolean;
  ok: boolean;
  error?: string;
}

function defaultRsync(args: readonly string[]): {
  status: number;
  stderr: string;
} {
  const result = spawnSync('rsync', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  return { status: result.status ?? 1, stderr: result.stderr ?? '' };
}

export function seedRemoteWorkspace(options: {
  sshHost: string;
  remoteWorkspacePath: string;
  remoteSyncUrl: string;
  repoRoot: string;
  ignorePaths: readonly string[];
  rsync?: RsyncRunner;
  remote?: RemoteRunner;
}): SeedResult {
  if (
    !remoteWorkspaceIsEmpty(
      options.sshHost,
      options.remoteWorkspacePath,
      options.remote,
    )
  ) {
    return { ran: false, ok: true };
  }
  const rsync = options.rsync ?? defaultRsync;
  const result = rsync(
    buildSeedRsyncArgs({
      repoRoot: options.repoRoot,
      remoteSyncUrl: options.remoteSyncUrl,
      ignorePaths: options.ignorePaths,
    }),
  );
  if (result.status !== 0) {
    // Never fatal. A failed seed leaves an empty or partly filled workspace, which is precisely the
    // state Mutagen is about to reconcile anyway -- so the run goes on, slower, as it did before.
    return {
      ran: true,
      ok: false,
      error: result.stderr.trim().split('\n').at(-1) ?? `rsync exited ${String(result.status)}`,
    };
  }
  return { ran: true, ok: true };
}
