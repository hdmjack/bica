/**
 * `.git` is deliberately absent from the remote workspace unless `git.sync` is on: Mutagen ignores it
 * so a continuous watch cannot fight the local index over `index.lock`. The cost is that any command
 * reading the commit graph — `git diff`, `git merge-base`, `vitest --changed`, `turbo --filter=...[ref]`
 * — fails on the remote with git's own "not a repository" error, several lines into whatever the tool
 * printed first.
 *
 * That error names git, not bica, so it reads as a broken checkout rather than a switch nobody flipped.
 * Two sessions diagnosed it as a defect in the sync before anyone found `git.sync`. This module spots
 * the case from the command line alone and says which switch to flip.
 */

/**
 * Flags whose whole point is to resolve files from history. `--since` and `--changed-since` also appear
 * with an inline value, so they are matched as prefixes too.
 */
const GIT_DEPENDENT_FLAGS: readonly string[] = [
  '--changed',
  '--since',
  '--affected',
  '--changed-since',
  '--changedSince',
  '--only-changed',
];

/**
 * Script names rather than flags: `pnpm test:run:changed` says nothing about git to a naive scan, but
 * the word is there, separated the way script names separate words. Anchored on those separators so
 * `unchanged` and `exchanged` do not match.
 */
const GIT_DEPENDENT_WORD = /(^|[:._-])(changed|affected|since)([:._-]|$)/;

/** Turbo's history-relative filter: `--filter=...[origin/master]` resolves a ref. */
const REF_RANGE_FILTER = /^--filter=.*\.\.\./;

function tokenReadsHistory(token: string): boolean {
  if (GIT_DEPENDENT_FLAGS.includes(token)) {
    return true;
  }
  if (
    GIT_DEPENDENT_FLAGS.some((flag) => token.startsWith(`${flag}=`)) ||
    REF_RANGE_FILTER.test(token)
  ) {
    return true;
  }
  return !token.startsWith('-') && GIT_DEPENDENT_WORD.test(token);
}

/** A command reads history if it *is* git, or if any of its arguments resolves a ref. */
export function readsGitHistory(argv: readonly string[]): boolean {
  if (argv.length === 0) {
    return false;
  }
  if (argv[0] === 'git') {
    return true;
  }
  return argv.some(tokenReadsHistory);
}

/**
 * The warning to print *before* a run that is going to meet this, rather than after.
 *
 * The note after the run was not enough, and the way it failed is worth recording. A `:changed`
 * script fails inside its own tooling, so by the time bica gets a word in, the reader is at the
 * bottom of a Node stack trace forty lines long. One more line there is one more line there. The
 * agent that reported this had the note on its screen and diagnosed the stack trace instead, which
 * is the right instinct applied to the wrong evidence.
 *
 * Said in advance, it arrives before any of that noise exists, and it predicts rather than explains.
 * That is safe to say because the prediction is sound: with `git.sync` off there is no repository in
 * the workspace at all, so a command that resolves a ref cannot do it here. This is not the case
 * 0.6.1 had to quieten -- that one fired under ordinary test failures with the setting already *on*,
 * where the note was guessing.
 */
export function gitMissingPreRunNotice(input: {
  argvs: readonly (readonly string[])[];
  syncGit: boolean;
}): string | undefined {
  if (input.syncGit) {
    return undefined;
  }
  const culprit = input.argvs.find(readsGitHistory);
  if (culprit === undefined) {
    return undefined;
  }
  return (
    `\`${culprit.join(' ')}\` resolves git refs, and this remote workspace has no \`.git\` — the ` +
    'sync leaves repository metadata behind. Expect it to fail here with git\'s own "not a git ' +
    'repository", whatever the tool prints around it.\n' +
    'Fix it by turning the copy on, not by changing the command:\n' +
    '  git:\n' +
    '    sync: true     # in bica.yml, or BICA_GIT_SYNC=1 for one run'
  );
}

export interface GitDependentHintInput {
  /** Every command the run executed — one per `--`-separated command, or a single one. */
  argvs: readonly (readonly string[])[];
  /** The run's exit code. A run that succeeded had whatever it needed, so nothing is said. */
  exitCode: number;
  /** Whether `git.sync` copied the repository to the remote. */
  syncGit: boolean;
  /** Whether this checkout is a git worktree, which the copy has to flatten. */
  fromWorktree?: boolean;
  /**
   * Whether the remote workspace actually has a repository, when that has been looked at.
   *
   * Only consulted with `git.sync` on, and only for a failing history-reading command. `undefined`
   * means nobody has looked, which is the same as "no reason to think the copy failed": see
   * `wantsRemoteGitProbe` for why the look is worth an extra connection when it happens at all.
   */
  remoteGitPresent?: boolean;
}

/**
 * Whether it is worth asking the remote if its `.git` is there before saying anything.
 *
 * With `git.sync` on, the hint was firing under *every* failing history-reading run, which on a repo
 * whose whole test script is `test:run:changed` means every failing test run. A note that appears
 * under a genuine test failure is worse than no note: it reads as a diagnosis, sends people to look
 * at the sync, and trains them to skip the channel it arrives on.
 *
 * The honest discriminator is whether the remote has a repository at all, and bica cannot tell from
 * the exit code -- the command's own output is streamed, not captured. So it asks, once, on the one
 * path where the answer changes what is said: a failed run, of a command that reads history, with the
 * setting already on. That is the slow path by definition and already the rare one.
 */
export function wantsRemoteGitProbe(
  input: Omit<GitDependentHintInput, 'remoteGitPresent'>,
): boolean {
  return (
    input.exitCode !== 0 &&
    input.syncGit &&
    input.argvs.some(readsGitHistory)
  );
}

/**
 * The line to print after a failed run, or `undefined` when this failure has nothing to do with git.
 *
 * Silence is the default on purpose: most failed runs are failing tests, and a note about repository
 * metadata under every one of them would be noise that trains the reader to skip the whole channel.
 */
export function gitDependentHint(
  input: GitDependentHintInput,
): string | undefined {
  if (input.exitCode === 0) {
    return undefined;
  }
  const culprit = input.argvs.find(readsGitHistory);
  if (culprit === undefined) {
    return undefined;
  }
  if (input.syncGit) {
    if (input.remoteGitPresent !== false) {
      // The repository is there, so this failure is the command's own and the hint has nothing to
      // add. Silence here is the fix for the note firing under every failing `:changed` run.
      return undefined;
    }
    // The setting is on and the repository still did not arrive, which is the one case worth a line:
    // whoever followed the previous hint would otherwise get a bare `fatal: not a git repository`
    // with nothing connecting the two.
    return (
      `\`${culprit.join(' ')}\` reads git history and \`git.sync\` is on, but the remote workspace ` +
      `has no repository: the copy did not land, so this failure is bica's and not your code${
        input.fromWorktree === true
          ? ' — and this checkout is a git worktree, whose `.git` is a file naming a path the remote' +
            ' does not have, so the flattening is the first thing to suspect'
          : ''
      }.\n` +
      '`BICA_DEBUG=1` shows the rsync that should have carried it, and `bica run git rev-parse HEAD` ' +
      'says what the remote thinks it is on.'
    );
  }
  return (
    `\`${culprit.join(' ')}\` reads git history, and this workspace has no \`.git\`: the sync leaves ` +
    'repository metadata behind, so `git diff`, `git merge-base` and `--changed` fail here rather ' +
    'than resolving. That is likely this failure, not your code.\n' +
    'Turn it on with `git:` / `  sync: true` in `bica.yml` (or `BICA_GIT_SYNC=1` for one run) and ' +
    'bica rsyncs `.git` to the remote before each run.'
  );
}
