import * as fs from 'node:fs';
import * as path from 'node:path';

import { bold, dim, warn } from '../terminalStyle';
import { isProcessAlive } from './fileLock';
import {
  findConflictingSessions,
  findSessionsFromOtherCheckouts,
  listAllSyncSessions,
  mutagenSyncTerminate,
} from './mutagenSession';
import type { SyncSessionSummary } from './mutagenSession';
import { confirm } from './prompt';
import type { PrepareResult } from '../syncProject';

/**
 * Detect and terminate Mutagen sessions that bind the same alpha+beta as `prep` but under a
 * different name (typically a leftover from an older `bica.yml`). Same-path duplicates fight the
 * new session's ignore rules and silently overwrite return-flow files.
 */
export async function terminateConflictingSyncSessions(
  prep: PrepareResult,
  options: { autoYes: boolean },
): Promise<void> {
  const conflicts = findConflictingSessions({
    expectedSessionName: prep.sessionName,
    alphaPath: prep.repoRoot,
    remoteSyncUrl: prep.remoteSyncUrl,
  });
  if (conflicts.length === 0) {
    return;
  }
  for (const c of conflicts) {
    const ok =
      options.autoYes ||
      (await confirm(
        `${warn('[bica]')} ${dim('Found duplicate Mutagen session')} ${bold(c.name)} ${dim(`on same paths as`)} ${bold(prep.sessionName)}${dim('. Old session ignores can clobber return-flow files. Terminate it?')}`,
        true,
      ));
    if (ok) {
      mutagenSyncTerminate(c.name);
    } else {
      process.stderr.write(
        `${warn('[bica]')} ${dim(`Keeping ${c.name} — return-flow / ignore changes may not apply.`)}\n`,
      );
    }
  }
}

/**
 * Where a `bica run` records that it started this checkout's sync, as its pid.
 *
 * The only way to tell another checkout's sync that a finished run left behind from one somebody
 * started on purpose with `bica start`. Mutagen cannot say: its project files take no labels, and both
 * kinds of session are made from the same project file. Ending a leftover is housekeeping; ending a
 * deliberate one takes away a sync somebody is working against, without asking.
 */
export const LIVE_RUN_MARKER_RELATIVE = path.join('.bica', 'live-run');

export function writeLiveRunMarker(repoRoot: string): void {
  try {
    fs.writeFileSync(path.join(repoRoot, LIVE_RUN_MARKER_RELATIVE), `${String(process.pid)}\n`);
  } catch {
    // Without it, a session this run leaves behind reads as deliberate: refused, never ended. The safe way round.
  }
}

export function removeLiveRunMarker(repoRoot: string): void {
  try {
    fs.rmSync(path.join(repoRoot, LIVE_RUN_MARKER_RELATIVE), { force: true });
  } catch {
    // Same: a marker that stays only ever makes its sessions look more deliberate than they are.
  }
}

/**
 * Whether another checkout's session was left behind by a `bica run` that is over.
 *
 * Only a marker naming a pid that is gone says so. No marker means `bica start`, or a bica older than
 * the marker; a live pid means the run that made it is still going. Both are somebody else's sync.
 */
export function sessionIsLeftoverOfRun(
  session: SyncSessionSummary,
  alive: (pid: number) => boolean = isProcessAlive,
): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(session.alpha, LIVE_RUN_MARKER_RELATIVE), 'utf8');
  } catch {
    return false;
  }
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 && !alive(pid);
}

/**
 * End every sync on this machine whose `bica run` is over, whichever checkout and workspace it is for.
 *
 * The watchdog each run starts does this the moment the run dies; this is the net under it, for a
 * watchdog that never started or was killed with its run. Before it, a leftover was only noticed by a
 * later run from the same checkout or into the same workspace, so one into a workspace nobody used
 * again went on writing there for as long as it pleased.
 *
 * Only sessions with a marker naming a dead pid: a `bica start` sync and a run still going are left.
 */
export function endLeftoverRunSyncs(
  options: {
    list?: () => SyncSessionSummary[];
    alive?: (pid: number) => boolean;
    terminate?: (name: string) => void;
  } = {},
): string[] {
  const list = options.list ?? listAllSyncSessions;
  const terminate = options.terminate ?? ((name: string) => void mutagenSyncTerminate(name));
  const ended: string[] = [];
  for (const s of list()) {
    if (!sessionIsLeftoverOfRun(s, options.alive)) {
      continue;
    }
    process.stderr.write(
      `${warn('[bica]')} ${dim(`Ending sync session ${s.name} from ${s.alpha} to ${s.beta}: the run that started it has ended.`)}\n`,
    );
    terminate(s.name);
    removeLiveRunMarker(s.alpha);
    ended.push(s.name);
  }
  return ended;
}

/** Exit code for a workspace somebody else is syncing into; the lease's own "in use". */
const SYNCED_FROM_ELSEWHERE_EXIT = 98;

/**
 * Deal with other checkouts' syncs into this workspace before a run or a `bica start` uses it.
 *
 * Checkouts may share a remote workspace, and the lease keeps their runs apart. A Mutagen session is
 * outside the lease: it goes on making the workspace an exact copy of *its* checkout, under whatever
 * runs there next. One a finished run left behind is ended, and said so. One somebody started on
 * purpose is not ours to end, so the run is refused instead, with the two ways out.
 *
 * Returns an exit code to stop with, or `undefined` to go ahead.
 */
export function settleOtherCheckoutsSyncs(options: {
  repoRoot: string;
  remoteSyncUrl: string;
  alive?: (pid: number) => boolean;
  find?: typeof findSessionsFromOtherCheckouts;
  terminate?: (name: string) => void;
}): number | undefined {
  const find = options.find ?? findSessionsFromOtherCheckouts;
  const terminate = options.terminate ?? ((name: string) => void mutagenSyncTerminate(name));
  const deliberate: SyncSessionSummary[] = [];
  for (const s of find(options.repoRoot, options.remoteSyncUrl)) {
    if (sessionIsLeftoverOfRun(s, options.alive)) {
      // Said on stderr rather than as chrome: it changes another checkout's state.
      process.stderr.write(
        `${warn('[bica]')} ${dim(`Ending sync session ${s.name} from ${s.alpha}: the run that started it has ended, and it would go on writing that checkout's files into this workspace.`)}\n`,
      );
      terminate(s.name);
    } else {
      deliberate.push(s);
    }
  }
  if (deliberate.length === 0) {
    return undefined;
  }
  const here = path.basename(options.repoRoot);
  for (const s of deliberate) {
    process.stderr.write(
      `${warn('[bica]')} ${s.alpha} is syncing into ${options.remoteSyncUrl} (session ${s.name}), started with \`bica start\` rather than by a run.\n` +
        `${warn('[bica]')} Syncing from here as well would overwrite its files with this checkout's, so bica has left it alone and run nothing. Either:\n` +
        `${warn('[bica]')}   stop it there:  cd ${s.alpha} && bica stop\n` +
        `${warn('[bica]')}   or give this checkout a workspace of its own: \`remotePath: ~/code/${here}\` in .bica/local.yml, or BICA_REMOTE_PATH\n`,
    );
  }
  process.stderr.write(
    `${warn('[bica]')} Nothing ran, so exit ${String(SYNCED_FROM_ELSEWHERE_EXIT)} is not a verdict on your code.\n`,
  );
  return SYNCED_FROM_ELSEWHERE_EXIT;
}

