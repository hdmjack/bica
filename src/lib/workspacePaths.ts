import * as path from 'node:path';

/**
 * Local bica state directories.
 *
 * These are the coordination locks only -- the return-flow pull and pinned-worktree creation, whose
 * contended resources genuinely are local to this checkout. The lease on the *remote* workspace lives
 * on the remote, because that is where the thing being contended is; a lock here could not see a run
 * launched from a sibling clone.
 */
export function lockRootDir(repoRoot: string): string {
  return path.join(repoRoot, '.bica', 'locks');
}
