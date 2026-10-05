import * as os from 'node:os';
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

/**
 * Where running tunnels record themselves.
 *
 * Per machine, not per checkout, where the locks above are the other way round. The contended thing is
 * a path in the local filesystem -- two checkouts of the same repo, or two different repos, can name
 * the same `--local` socket, and a registry under one of their `.bica` directories could not see the
 * tunnel started from the other.
 */
export function tunnelStateDir(): string {
  return path.join(os.homedir(), '.bica', 'tunnels');
}
