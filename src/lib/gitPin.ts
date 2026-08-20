import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { treeOidForCommittish } from './contentIdentity';
import { acquireLockWithWait, isProcessAlive } from './fileLock';
import { lockRootDir } from './workspacePaths';
import {
  sanitizeRemotePosixAbsolutePath,
  shellSingleQuoteRemotePathForSh,
  tryResolveRemoteWorkspaceAbsolutePath,
} from './runRemote';
import { dim, warn } from '../terminalStyle';

/**
 * Pinning a run to a git ref instead of the live working tree.
 *
 * The live tree cannot serve a multi-branch sweep: one checkout holds one branch, so verifying
 * thirteen means thirteen `git checkout`s, and a checkout that lands mid-sync would
 * leave the workspace holding a mix of two branches. Reading the content straight out of the
 * object database removes the race rather than detecting it — the local tree is never touched, never
 * consulted, and can be on any branch (or mid-rebase) while every pinned runs.
 *
 * The mechanism is a throwaway detached `git worktree`. It costs no clone (worktrees share the object
 * store), it materialises exactly the ref's committed content, and rsyncing from it gives `--delete`
 * the same meaning it has for a live tree, which `git archive` piped to `tar` would not.
 *
 * The consequence to be aware of: a ref pin sees committed content only. Uncommitted local work is
 * not part of it. That is the right semantics for verifying a branch chain and the wrong semantics
 * for "run what I have open", which is what the default (live-tree) path is for.
 */

/** Worktree creation touches shared `.git` bookkeeping, so runs take turns. */
const GIT_WORKTREE_LOCK_TIMEOUT_MS = 60_000;

function gitLockPath(repoRoot: string): string {
  return path.join(lockRootDir(repoRoot), '_git-worktree.lock');
}

function git(
  repoRoot: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export interface ResolvedGitRef {
  /** The ref as the user wrote it. */
  requested: string;
  /** Commit the ref points at. */
  sha: string;
  /**
   * Tree OID of that commit — the content name for the run. Known up front and immutable, which is
   * why a ref-pinned run needs no before/after comparison.
   */
  treeOid: string;
  /**
   * Fully-qualified branch ref (`refs/heads/…`) when the request names a local branch, else null.
   * Used to give the remote `.git` the same symbolic HEAD, so `--changed`-style commands
   * resolve the branch rather than a detached commit.
   */
  branchRef: string | null;
}

export function resolveGitRef(repoRoot: string, ref: string): ResolvedGitRef {
  const rev = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = rev.stdout.trim();
  if (rev.status !== 0 || sha === '') {
    throw new Error(
      `Cannot resolve --ref ${JSON.stringify(ref)} to a commit in this repository.`,
    );
  }
  const branch = git(repoRoot, [
    'rev-parse',
    '--symbolic-full-name',
    '--verify',
    '--quiet',
    ref,
  ]);
  const fullName = branch.stdout.trim();
  const treeOid = treeOidForCommittish(repoRoot, sha);
  if (treeOid === null) {
    throw new Error(`Cannot resolve a tree for --ref ${JSON.stringify(ref)}.`);
  }
  return {
    requested: ref,
    sha,
    treeOid,
    branchRef: fullName.startsWith('refs/heads/') ? fullName : null,
  };
}

/**
 * Pinned-worktree directory, outside the repository and keyed by pid.
 *
 * Outside because a live `git worktree` inside `repoRoot` sits inside the tree that `git add -A`
 * walks, so the content name would end up describing bica's own scratch checkout. That is the same
 * trap already fixed for the throwaway index in `contentIdentity.ts`, where only the convention of
 * gitignoring `.bica` was hiding it — a correctness property should not rest on a user's `.gitignore`.
 *
 * Pid-keyed so two runs from the same checkout can never rsync over each other's worktree, whatever
 * else goes wrong. The observed symptom when they did was `rsync exited 23` plus `is not a working
 * tree` on teardown.
 */
function pinRoot(): string {
  return path.join(os.tmpdir(), 'bica-pins');
}

function pinDir(): string {
  return path.join(pinRoot(), `pin-${String(process.pid)}`);
}

/** Remove pin directories left by processes that are no longer running. */
function removeOrphanedPinDirs(): void {
  const root = pinRoot();
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const pid = Number(/-(\d+)$/.exec(name)?.[1]);
    // Unsuffixed directories predate the pid scheme; a live pid is still working in its own.
    if (Number.isInteger(pid) && isProcessAlive(pid)) {
      continue;
    }
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

/**
 * Materialise `resolved` in a throwaway worktree, hand its path to `body`, then remove it.
 *
 * `git worktree prune` runs first so a worktree orphaned by an earlier hard kill does not block the
 * path. Creation and removal are serialised because both write shared `.git/worktrees` bookkeeping,
 * and several runs starting at once would otherwise collide there.
 */
export async function withPinnedWorktree<T>(
  options: { repoRoot: string; resolved: ResolvedGitRef },
  body: (worktreePath: string) => Promise<T>,
): Promise<T> {
  const { repoRoot, resolved } = options;
  const dir = pinDir();

  const lock = await acquireLockWithWait(gitLockPath(repoRoot), {
    timeoutMs: GIT_WORKTREE_LOCK_TIMEOUT_MS,
  });
  if (lock === null) {
    throw new Error(
      'Timed out waiting to create a pinned worktree (another run held the git lock for over 60s).',
    );
  }
  try {
    git(repoRoot, ['worktree', 'prune']);
    removeOrphanedPinDirs();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const add = git(repoRoot, [
      'worktree',
      'add',
      '--detach',
      '--force',
      dir,
      resolved.sha,
    ]);
    if (add.status !== 0) {
      throw new Error(
        `git worktree add for --ref ${resolved.requested} failed: ${add.stderr.trim() || `exit ${String(add.status)}`}`,
      );
    }
  } finally {
    lock.release();
  }

  try {
    return await body(dir);
  } finally {
    const cleanupLock = await acquireLockWithWait(gitLockPath(repoRoot), {
      timeoutMs: GIT_WORKTREE_LOCK_TIMEOUT_MS,
    });
    try {
      const removed = git(repoRoot, ['worktree', 'remove', '--force', dir]);
      if (removed.status !== 0) {
        // Leaving the directory behind is recoverable (`git worktree prune` on the next run picks it
        // up), so warn rather than mask the run's own result.
        process.stderr.write(
          `${warn('[bica]')} ${dim(`Could not remove pinned worktree ${dir}: ${removed.stderr.trim()}`)}\n`,
        );
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      cleanupLock?.release();
    }
  }
}

/**
 * Point the remote `.git` at the pinned ref.
 *
 * `git.sync` rsyncs the *local* `.git`, whose HEAD is whatever the caller has checked out — not the
 * ref this workspace is running. Without this, a `--ref` run with `git.sync` on would have
 * `vitest --changed` compute its changed-file set against the wrong branch and quietly verify the
 * wrong thing. Best-effort: a failure warns instead of failing the run, and only affects
 * git-dependent commands.
 */
export function setRemoteHeadForPin(options: {
  sshHost: string;
  remoteWorkspacePath: string;
  resolved: ResolvedGitRef;
}): boolean {
  const { resolved } = options;
  // ssh hands its command to the remote login shell, so the path is resolved to an absolute one and
  // single-quoted rather than relying on `~` expansion or hoping it contains no spaces.
  const absolute = tryResolveRemoteWorkspaceAbsolutePath(
    options.sshHost,
    options.remoteWorkspacePath,
  );
  if (absolute === null) {
    process.stderr.write(
      `${warn('[bica]')} ${dim(`Could not resolve ${options.remoteWorkspacePath} on the remote; leaving the workspace's HEAD alone.`)}\n`,
    );
    return false;
  }
  const args =
    resolved.branchRef !== null
      ? ['symbolic-ref', 'HEAD', resolved.branchRef]
      : ['update-ref', '--no-deref', 'HEAD', resolved.sha];
  const result = spawnSync(
    'ssh',
    [
      '-T',
      options.sshHost,
      'git',
      '-C',
      shellSingleQuoteRemotePathForSh(
        sanitizeRemotePosixAbsolutePath(absolute),
      ),
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false },
  );
  if (result.status === 0) {
    return true;
  }
  process.stderr.write(
    `${warn('[bica]')} ${dim(`Could not point the remote HEAD at ${resolved.requested}; git-dependent commands (--changed) may resolve the wrong branch: ${(result.stderr ?? '').trim()}`)}\n`,
  );
  return false;
}
