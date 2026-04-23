import { prepareSyncProjectFile } from '../syncProject';
import { bold, dim, syncRemoteTarget, warn } from '../terminalStyle';
import {
  assertMutagenInstalled,
  getSessionListParse,
  isLikelySyncReady,
  mutagenProjectStart,
} from './mutagenSession';
import { confirm, ensureRemoteSshHostFromEnvOrPrompt, sleep } from './prompt';
import type { PrepareResult } from '../syncProject';

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
  const { sessionName, projectFilePath, repoRoot, beta } = prep;

  let info = getSessionListParse(sessionName);

  if (!info.exists) {
    const ok =
      options.autoYes ||
      (await confirm(
        `${dim(`No file sync session "${sessionName}" for this repo yet.`)}\n${bold('Start one-way sync')} ${dim('to')} ${syncRemoteTarget(beta)}?`,
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

  return prep;
}
