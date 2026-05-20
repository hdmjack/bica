import { prepareSyncProjectFile } from '../syncProject';
import { bold, dim, syncRemoteTarget, warn } from '../terminalStyle';
import {
  assertMutagenInstalled,
  findConflictingSessions,
  getSessionListParse,
  isLikelySyncReady,
  mutagenProjectStart,
  mutagenSyncFlush,
  mutagenSyncTerminate,
} from './mutagenSession';
import { confirm, ensureRemoteSshHostFromEnvOrPrompt, sleep } from './prompt';
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
 * Ensures we can run commands on the remote: workspace file sync is running (or user starts it),
 * and config is written. Remote runs over SSH; the remote copy may lag this machine briefly.
 */
export async function ensureSyncReady(options: {
  autoYes: boolean;
}): Promise<PrepareResult> {
  assertMutagenInstalled();
  await ensureRemoteSshHostFromEnvOrPrompt();
  const prep = prepareSyncProjectFile({ verbose: false });
  const { sessionName, projectFilePath, repoRoot, remoteSyncUrl } = prep;

  await terminateConflictingSyncSessions(prep, { autoYes: options.autoYes });

  let info = getSessionListParse(sessionName);

  if (!info.exists) {
    const ok =
      options.autoYes ||
      (await confirm(
        `${dim(`No file sync session "${sessionName}" for this repo yet.`)}\n${bold('Start one-way sync')} ${dim('to')} ${syncRemoteTarget(remoteSyncUrl)}?`,
        true,
      ));
    if (!ok) {
      process.exit(1);
    }
    if (!mutagenProjectStart(repoRoot, projectFilePath)) {
      process.exit(1);
    }
    // Session may not show up in sync list immediately after project start.
    await sleep(1500);
  }

  info = getSessionListParse(sessionName);
  if (!isLikelySyncReady(info.status)) {
    process.stderr.write(
      `${warn('[bica]')} ${dim('Sync:')} ${info.status ?? 'unknown'} ${dim('(remote disk may lag this machine).')}\n`,
    );
  }

  // Optional: block until Mutagen pushes pending local changes to remote (see README / BICA_SYNC_FLUSH).
  if (process.env.BICA_SYNC_FLUSH?.trim() === '1' && info.exists) {
    if (!mutagenSyncFlush(repoRoot, sessionName)) {
      process.stderr.write(
        `${warn('[bica]')} ${dim('BICA_SYNC_FLUSH=1 but flush failed; continuing anyway.')}\n`,
      );
    }
  }

  return prep;
}
