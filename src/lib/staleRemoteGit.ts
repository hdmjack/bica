import { spawnSync } from 'node:child_process';

import { readsGitHistory } from './gitDependentHint';
import {
  remoteWorkspaceWordForSh,
  runRemoteScriptOverStdin,
} from './runRemote';

/**
 * A `.git` left behind on the remote, which answers about a tree that is no longer there.
 *
 * `git.sync` off is meant to mean "the remote has no repository", and the hint in `gitDependentHint`
 * is written for that: the command fails with git's own "not a repository" and bica says which switch
 * to flip. But the sync *ignores* `.git` rather than deleting it, so one run with `git.sync` on leaves
 * a repository in the workspace forever. Every later run copies new files in around it and leaves its
 * refs exactly where that one run left them.
 *
 * That is worse than having none. With no repository the command fails and the failure is read; with
 * a stale one every ref still resolves, so `--changed` quietly diffs against whatever master was days
 * ago and the command reports a confident answer about a selection nobody asked for. The run that
 * prompted this said `Linting 405 changed file(s) against origin/master` for a branch that changes 15,
 * then exhausted node's heap on the other 390 -- which read as a memory problem on the remote machine
 * rather than as a ref four days old. Its sibling `test:run:changed` was still going ten minutes in,
 * and had it finished it would have reported a pass over the wrong set of tests.
 *
 * So this is checked before the command runs, not after it fails, because the damaging case is the one
 * that succeeds.
 */

export { remoteWorkspaceWordForSh };

export interface RemoteGitState {
  /** Whether the remote workspace has a `.git` of its own at all. */
  present: boolean;
  /** What that repository thinks it is on, when `git` was there to answer. */
  branch?: string;
  /** Its newest remote-tracking ref and that ref's commit date -- how far behind it is, in one line. */
  newestRef?: string;
}

/** How a remote script is run. Injectable so the shape of these scripts can be tested without ssh. */
export type RemoteRunner = (
  sshHost: string,
  script: string,
) => { status: number; stdout: string; stderr: string };

/**
 * Key-value lines, because the interesting values contain spaces and a probe should not need a parser.
 *
 * Everything after the existence test is best-effort: a remote without `git` on a non-login `sh` PATH,
 * or a repository too broken to answer, still reports the one fact that drives the warning.
 */
export function buildRemoteGitProbeScript(remoteWorkspacePath: string): string {
  const w = remoteWorkspaceWordForSh(remoteWorkspacePath);
  return [
    `w=${w}`,
    `if [ ! -e "$w/.git" ]; then printf 'present=no\\n'; exit 0; fi`,
    `printf 'present=yes\\n'`,
    `command -v git >/dev/null 2>&1 || exit 0`,
    `printf 'branch=%s\\n' "$(git -C "$w" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"`,
    `printf 'newestRef=%s\\n' "$(git -C "$w" for-each-ref --sort=-committerdate --count=1 --format='%(refname:short) (%(committerdate:short))' refs/remotes 2>/dev/null || true)"`,
    '',
  ].join('\n');
}

export function parseRemoteGitProbe(stdout: string): RemoteGitState {
  const fields = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) {
      fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  }
  if (fields.get('present') !== 'yes') {
    return { present: false };
  }
  const branch = fields.get('branch');
  const newestRef = fields.get('newestRef');
  return {
    present: true,
    ...(branch !== undefined && branch !== '' ? { branch } : {}),
    ...(newestRef !== undefined && newestRef !== '' ? { newestRef } : {}),
  };
}

export function readRemoteGitState(
  sshHost: string,
  remoteWorkspacePath: string,
  run: RemoteRunner = runRemoteScriptOverStdin,
): RemoteGitState {
  const result = run(sshHost, buildRemoteGitProbeScript(remoteWorkspacePath));
  if (result.status !== 0) {
    // A probe that could not run says nothing either way, and a guess here would warn about a
    // repository that may not exist. Silence is the honest reading.
    return { present: false };
  }
  return parseRemoteGitProbe(result.stdout);
}

/** The branch this checkout is on, or undefined when git cannot say. */
export function localBranch(repoRoot: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  const name = (result.stdout ?? '').trim();
  return result.status === 0 && name !== '' ? name : undefined;
}

export interface StaleRemoteGitInput {
  /** Every command this run will execute -- one per `--`-separated command, or a single one. */
  argvs: readonly (readonly string[])[];
  /** Whether `git.sync` will copy this checkout's repository over before the command runs. */
  syncGit: boolean;
  remote: RemoteGitState;
  /** This checkout's branch, when git could say. */
  localBranch?: string;
}

/**
 * The lines to print before the command runs, or `undefined` when there is nothing to warn about.
 *
 * Narrow on purpose. A command that does not read history does not care what the remote's refs say,
 * and `git.sync` on means they are about to be overwritten with this checkout's own. The warning is
 * for the one case where a command will silently believe them.
 */
export function staleRemoteGitWarning(
  input: StaleRemoteGitInput,
): string | undefined {
  if (input.syncGit || !input.remote.present) {
    return undefined;
  }
  const culprit = input.argvs.find(readsGitHistory);
  if (culprit === undefined) {
    return undefined;
  }
  const { branch, newestRef } = input.remote;
  const evidence: string[] = [];
  if (branch !== undefined && branch !== input.localBranch) {
    evidence.push(
      `it is on \`${branch}\`${
        input.localBranch === undefined
          ? ''
          : `, where this checkout is on \`${input.localBranch}\``
      }`,
    );
  }
  if (newestRef !== undefined) {
    evidence.push(`its newest remote-tracking ref is ${newestRef}`);
  }
  const says =
    evidence.length === 0 ? '' : ` -- ${evidence.join(', and ')}.`;
  return (
    `\`${culprit.join(' ')}\` reads git history, \`git.sync\` is off, and the remote workspace has a ` +
    `\`.git\` of its own left over from an earlier run that did sync it. The sync never touches it, ` +
    `so git there answers about that old copy rather than about the files just sent${says}\n` +
    'A stale repository is worse than none: without one the command fails outright, with one it ' +
    'resolves `--changed` against the wrong base and reports a confident answer for a selection ' +
    'nobody asked for.\n' +
    'Turn on `git:` / `  sync: true` in `bica.yml` (or `BICA_GIT_SYNC=1` for one run), or delete the ' +
    'remote `.git` to get the loud failure back.'
  );
}

/**
 * The whole check, gated so that it costs nothing on the runs it has nothing to say about.
 *
 * The probe is an ssh round-trip, and most runs neither read history nor leave `git.sync` off, so the
 * cheap tests come first and the remote is asked only when its answer could change the output.
 */
export function warnAboutStaleRemoteGit(options: {
  argvs: readonly (readonly string[])[];
  syncGit: boolean;
  sshHost: string;
  remoteWorkspacePath: string;
  repoRoot: string;
  run?: RemoteRunner;
}): string | undefined {
  if (options.syncGit || !options.argvs.some(readsGitHistory)) {
    return undefined;
  }
  return staleRemoteGitWarning({
    argvs: options.argvs,
    syncGit: options.syncGit,
    remote: readRemoteGitState(
      options.sshHost,
      options.remoteWorkspacePath,
      options.run,
    ),
    localBranch: localBranch(options.repoRoot),
  });
}
