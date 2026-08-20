import { bold, dim, warn } from '../terminalStyle';
import {
  findConflictingSessions,
  mutagenSyncTerminate,
} from './mutagenSession';
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

