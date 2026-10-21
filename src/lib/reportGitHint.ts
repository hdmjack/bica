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
    writeBicaLines(hint);
  }
}

/**
 * Every line prefixed, not just the first.
 *
 * The hint is several sentences and only its opening line carried `[bica]`, so the line that
 * actually says what to change -- `git:` / `sync: true` -- rendered as bare text at the bottom of
 * whatever the failing command had printed. In a stack trace it is indistinguishable from the
 * program's own output, which is exactly where it was missed.
 */
export function writeBicaLines(text: string): void {
  for (const line of text.split('\n')) {
    process.stderr.write(`${warn('[bica]')} ${line}\n`);
  }
}
