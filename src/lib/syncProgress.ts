import { spawnSync } from 'node:child_process';

/**
 * How far the first sync has got, so waiting for it can be about progress rather than about a clock.
 *
 * bica waited sixty seconds for the sync to reach a ready state and then ran the command anyway, with
 * a line saying "continuing anyway". On a repository whose first transfer takes longer than that --
 * a shallow llvm-project, 180,633 files and 2.8GB, is the case this came from -- the command ran in a
 * directory that was still empty. `ls` exited 1, a script exited 127, and both read as the command
 * failing rather than as nothing having been copied. The session was then torn down, so the next run
 * began staging from the start, hit the same minute, and failed the same way: no single-command run
 * could ever succeed on that repository.
 *
 * A minute is not a sensible budget for a first transfer, and no fixed number is, because the right
 * answer scales with the tree and the link. What a timeout should be protecting against is a sync
 * that has *stopped getting anywhere*, which is a question that can be asked directly: Mutagen
 * publishes how many files it has staged, and that number climbs the whole time it is working. So
 * bica now waits as long as that number is moving, and gives up only when nothing has changed for a
 * while -- which is the stall the old timeout was trying to catch, measured rather than guessed.
 */

/** Seconds of no visible progress at all before a sync is called stalled. */
export const SYNC_STALL_SECONDS = 60;

/**
 * Exit code for a run whose files never got to the remote.
 *
 * With 95, 96, 97 and 98: not a verdict on the code. Nothing ran, so there is nothing to conclude
 * from it, and the one thing that must not happen is what used to -- a command's exit code being
 * reported as if it had seen the files.
 */
export const SYNC_NOT_READY_EXIT = 94;

export interface SyncProgress {
  /** Mutagen's own status token, e.g. `staging-beta`, `scanning`, `watching`. */
  status: string | null;
  /** Files staged on the remote so far, during the phase that takes the time. */
  receivedFiles?: number;
  expectedFiles?: number;
  /** Bytes staged so far. The finest-grained signal, and the one that moves on a single huge file. */
  totalReceivedSize?: number;
  /** Files Mutagen has reconciled on each side, which step up once per cycle. */
  alphaFiles?: number;
  betaFiles?: number;
}

/** Shape of the parts of `mutagen sync list --template '{{json .}}'` this reads. */
interface MutagenSessionJson {
  status?: unknown;
  alpha?: { files?: unknown };
  beta?: {
    files?: unknown;
    stagingProgress?: {
      receivedFiles?: unknown;
      expectedFiles?: unknown;
      totalReceivedSize?: unknown;
    };
  };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseSyncProgress(json: string): SyncProgress | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const sessions = Array.isArray(parsed) ? parsed : [parsed];
  const session = sessions[0] as MutagenSessionJson | undefined;
  if (session === undefined || typeof session !== 'object') {
    return null;
  }
  const staging = session.beta?.stagingProgress;
  return {
    status: typeof session.status === 'string' ? session.status : null,
    receivedFiles: asNumber(staging?.receivedFiles),
    expectedFiles: asNumber(staging?.expectedFiles),
    totalReceivedSize: asNumber(staging?.totalReceivedSize),
    alphaFiles: asNumber(session.alpha?.files),
    betaFiles: asNumber(session.beta?.files),
  };
}

/** How a sync's progress is read. Injectable so the waiting can be tested without Mutagen. */
export type ReadProgress = (sessionName: string) => SyncProgress | null;

export function readSyncProgress(sessionName: string): SyncProgress | null {
  const result = spawnSync(
    'mutagen',
    ['sync', 'list', sessionName, '--template', '{{json .}}'],
    { encoding: 'utf8', shell: false },
  );
  if (result.status !== 0) {
    return null;
  }
  return parseSyncProgress(result.stdout ?? '');
}

/**
 * Everything that changes while a sync is working, as one value to compare against the last one.
 *
 * Deliberately includes the per-cycle file counts as well as the staging numbers. Staging is the
 * phase that takes the time, but scanning a very large tree happens before it and publishes nothing
 * except a status, and a sync that is scanning is not stalled.
 */
export function progressFingerprint(progress: SyncProgress | null): string {
  if (progress === null) {
    return 'none';
  }
  return [
    progress.status ?? '',
    progress.receivedFiles ?? '',
    progress.totalReceivedSize ?? '',
    progress.alphaFiles ?? '',
    progress.betaFiles ?? '',
  ].join('/');
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(1)}GB`;
  }
  if (bytes >= 1_000_000) {
    return `${Math.round(bytes / 1_000_000)}MB`;
  }
  return `${Math.round(bytes / 1_000)}kB`;
}

/**
 * A line about where the sync has got to, or undefined when there is nothing worth saying.
 *
 * Said while waiting, because a first sync of a large repository takes minutes and silence for
 * minutes is indistinguishable from a hang -- which is the complaint that produced the sixty-second
 * timeout in the first place.
 */
export function describeSyncProgress(
  progress: SyncProgress | null,
): string | undefined {
  if (progress === null) {
    return undefined;
  }
  const { receivedFiles, expectedFiles, totalReceivedSize } = progress;
  if (receivedFiles !== undefined && expectedFiles !== undefined) {
    const size =
      totalReceivedSize === undefined
        ? ''
        : ` (${formatBytes(totalReceivedSize)})`;
    return `Copying to the remote: ${String(receivedFiles)}/${String(expectedFiles)} files${size}.`;
  }
  if (progress.status === 'scanning') {
    return 'Scanning the tree; a large repository takes a while before anything is sent.';
  }
  return undefined;
}

/**
 * What to tell someone whose sync never got there.
 *
 * Names the stall rather than a timeout, because that is now what it is, and says that nothing ran --
 * the one thing the old "continuing anyway" left the reader to work out from a command's exit code.
 */
export function describeSyncStall(options: {
  lastStatus: string | null;
  progress: SyncProgress | null;
  stallSeconds: number;
}): string {
  const where = describeSyncProgress(options.progress);
  const got = where === undefined ? '' : ` ${where}`;
  return (
    `The sync has not moved for ${String(options.stallSeconds)}s (status: ${
      options.lastStatus ?? 'unknown'
    }).${got}\n` +
    `Nothing ran, so exit ${String(SYNC_NOT_READY_EXIT)} is not a verdict on your code. The files ` +
    'are not on the remote, and a command run against the workspace now would see a partial tree.\n' +
    'Check that the remote is reachable and has room, then run it again. Files that did make it ' +
    'across are still there, so a second attempt sends only what is missing.'
  );
}
