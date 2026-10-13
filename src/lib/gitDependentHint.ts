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

export interface GitDependentHintInput {
  /** Every command the run executed — one per `--`-separated command, or a single one. */
  argvs: readonly (readonly string[])[];
  /** The run's exit code. A run that succeeded had whatever it needed, so nothing is said. */
  exitCode: number;
  /** Whether `git.sync` copied the repository to the remote. */
  syncGit: boolean;
  /** Whether this checkout is a git worktree, which the copy has to flatten. */
  fromWorktree?: boolean;
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
    // Something is still said when the setting is already on.
    //
    // The hint used to fall silent here, which left the person who had followed its advice with a
    // bare `fatal: not a git repository` and nothing connecting the two. Saying what bica did is
    // worth a line even when it cannot say what went wrong.
    return (
      `\`${culprit.join(' ')}\` reads git history, and \`git.sync\` is on, so bica copied this ` +
      `checkout's repository to the remote before running it${
        input.fromWorktree === true
          ? ' — as one flattened repository, because this checkout is a git worktree and its `.git` is' +
            ' a file naming a path the remote does not have'
          : ''
      }.\n` +
      'If the command still cannot read history, the copy is the thing to look at: `BICA_DEBUG=1` ' +
      'shows the rsync, and `bica run git rev-parse HEAD` says what the remote thinks it is on.'
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
