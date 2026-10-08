import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Where a checkout's git data actually lives.
 *
 * In an ordinary clone `.git` is a directory and the question is uninteresting. In a `git worktree`
 * it is a one-line file -- `gitdir: /absolute/path/into/the/main/clone` -- and the data is split in
 * two: per-worktree state (HEAD, index, logs) under the main clone's `.git/worktrees/<name>`, and
 * everything shared (objects, refs, config) in the main clone's `.git` itself.
 *
 * Syncing "`.git`" from a worktree therefore copied a one-line file naming a path that does not exist
 * on the remote, and every command that reads history failed with "not a git repository" -- with git
 * sync switched on, doing exactly what it said it did.
 */

export type GitLayout =
  | { kind: 'plain'; gitDir: string }
  | { kind: 'worktree'; gitDir: string; commonDir: string }
  | { kind: 'none' };

export type GitRunner = (
  repoRoot: string,
  args: string[],
) => { ok: boolean; stdout: string };

const realGit: GitRunner = (repoRoot, args) => {
  const r = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
  });
  return {
    ok: r.error == null && (r.status ?? 1) === 0,
    stdout: (r.stdout ?? '').trim(),
  };
};

/**
 * Ask git where its data is, rather than inferring it from the filesystem.
 *
 * `--absolute-git-dir` and `--git-common-dir` are the same two answers git itself uses, and they are
 * equal in an ordinary clone — which is how a worktree is told apart without parsing the `.git` file.
 */
export function resolveGitLayout(
  repoRoot: string,
  run: GitRunner = realGit,
): GitLayout {
  const gitDir = run(repoRoot, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir.ok || gitDir.stdout === '') {
    return { kind: 'none' };
  }
  const common = run(repoRoot, ['rev-parse', '--git-common-dir']);
  const commonDir =
    common.ok && common.stdout !== ''
      ? path.resolve(repoRoot, common.stdout)
      : gitDir.stdout;
  // Compared as canonical paths. git answers `--absolute-git-dir` with symlinks resolved and
  // `--git-common-dir` relative to the working directory, so on macOS -- where /tmp and $HOME both
  // reach their contents through symlinks -- an ordinary clone produced two spellings of one
  // directory and was taken for a worktree.
  return canonical(commonDir) === canonical(gitDir.stdout)
    ? { kind: 'plain', gitDir: gitDir.stdout }
    : { kind: 'worktree', gitDir: gitDir.stdout, commonDir };
}

/** A path with symlinks resolved, or the path itself when it cannot be resolved. */
function canonical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Files in a worktree's own git directory that must not reach the remote.
 *
 * `commondir` and `gitdir` are local absolute or relative paths into the main clone, and the whole
 * point of the copy is that the remote has no main clone. `worktrees` would carry every *other*
 * worktree's state across for nothing.
 */
export const WORKTREE_PRIVATE_ENTRIES: readonly string[] = [
  'commondir',
  'gitdir',
  'worktrees',
];

/** Whether a path holds a `.git` *file*, which is what a worktree has where a clone has a directory. */
export function dotGitIsAFile(repoRoot: string): boolean {
  try {
    return fs.statSync(path.join(repoRoot, '.git')).isFile();
  } catch {
    return false;
  }
}
