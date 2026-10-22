import { artifactsNotProtected, describeArtifactPull, pullArtifacts } from './artifacts';
import type { ArtifactOutcome } from './artifacts';
import { dim, warn } from '../terminalStyle';


/**
 * Bring the named outputs home and say what came, for both run paths.
 *
 * Run whatever the command's exit code was, for the same reason return-flow is: a build that failed
 * at the last link step has still produced everything before it, and a test run that failed has
 * still produced its artifacts. Returns what happened, so the caller can decide whether a copy that
 * failed changes the run's result; see `exitAfterArtifactPull`.
 */
export interface ArtifactPullInput {
  artifacts: readonly string[];
  syncIgnorePaths: readonly string[];
  generatedPaths: readonly string[];
  remoteSyncUrl: string;
  repoRoot: string;
}

export function reportArtifactPull(
  prep: ArtifactPullInput,
): readonly ArtifactOutcome[] {
  if (prep.artifacts.length === 0) {
    return [];
  }
  const unprotected = artifactsNotProtected({
    artifacts: prep.artifacts,
    syncIgnorePaths: prep.syncIgnorePaths,
    generatedPaths: prep.generatedPaths,
  });
  for (const artifact of unprotected) {
    process.stderr.write(
      `${warn('[bica]')} ${artifact} is not under anything the sync leaves alone, so the mirror ` +
        'deletes it during the run and there is nothing to bring home. Add its directory to ' +
        '`sync.ignore.paths`.\n',
    );
  }
  const outcomes = pullArtifacts({
    artifacts: prep.artifacts,
    remoteSyncUrl: prep.remoteSyncUrl,
    repoRoot: prep.repoRoot,
  });
  const said = describeArtifactPull(outcomes);
  for (const line of said?.split('\n') ?? []) {
    // A copy that failed is not progress chrome: it is the one line saying the file somebody is
    // about to run is not the one that was just built.
    const failed = line.startsWith('Could not bring home');
    process.stderr.write(
      failed ? `${warn('[bica]')} ${line}\n` : `${dim('[bica]')} ${dim(line)}\n`,
    );
  }
  return outcomes;
}
