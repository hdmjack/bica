import {
  gitDependentHint,
  wantsRemoteGitProbe,
} from './gitDependentHint';
import type { GitDependentHintInput } from './gitDependentHint';
import { readRemoteGitState } from './staleRemoteGit';
import { warn } from '../terminalStyle';

/**
 * Print the git-history note for a finished run, having first established whether there is anything
 * to say.
 *
 * Kept apart from `gitDependentHint` because the decision and the lookup belong in different places:
 * the hint is a pure function of the command line and one fact, and the fact costs a connection. This
 * is the only thing that spends it, and only on the path where the answer differs -- see
 * `wantsRemoteGitProbe`.
 */
export function reportGitDependentHint(
  input: Omit<GitDependentHintInput, 'remoteGitPresent'>,
  remote: { sshHost: string; remoteWorkspacePath: string },
): void {
  let remoteGitPresent: boolean | undefined;
  if (wantsRemoteGitProbe(input)) {
    try {
      remoteGitPresent = readRemoteGitState(
        remote.sshHost,
        remote.remoteWorkspacePath,
      ).present;
    } catch {
      // A probe that cannot run is not a reason to claim the copy failed. Left undefined, which the
      // hint reads as "no reason to think anything went wrong" and stays quiet.
    }
  }
  const hint = gitDependentHint({ ...input, remoteGitPresent });
  if (hint !== undefined) {
    process.stderr.write(`${warn('[bica]')} ${hint}\n`);
  }
}
