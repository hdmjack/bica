import { artifactsNotProtected, describeArtifactPull, pullArtifacts } from './artifacts';
import { dim, warn } from '../terminalStyle';


/**
 * Bring the named outputs home and say what came, for both run paths.
 *
 * Run whatever the command's exit code was, for the same reason return-flow is: a build that failed
 * at the last link step has still produced everything before it, and a test run that failed has
 * still produced its artifacts. Nothing here can change the run's result -- an artifact that could
 * not be fetched is reported and nothing else -- because the command's exit code is the answer and
 * a copy afterwards must not overwrite it.
 */
export interface ArtifactPullInput {
  artifacts: readonly string[];
  syncIgnorePaths: readonly string[];
  generatedPaths: readonly string[];
  remoteSyncUrl: string;
  repoRoot: string;
}

export function reportArtifactPull(prep: ArtifactPullInput): void {
  if (prep.artifacts.length === 0) {
    return;
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
  const said = describeArtifactPull(
    pullArtifacts({
      artifacts: prep.artifacts,
      remoteSyncUrl: prep.remoteSyncUrl,
      repoRoot: prep.repoRoot,
    }),
  );
  if (said === undefined) {
    return;
  }
  for (const line of said.split('\n')) {
    process.stderr.write(`${dim('[bica]')} ${dim(line)}\n`);
  }
}
