import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Naming the content a run verifies.
 *
 * The original design identified a run by *where* it ran — one slot, another slot. A slot is an arbitrary
 * name, so slots have to be handed out exclusively, which is why allocation needed a lock, and why a bug
 * in that lock could silently give two runs one workspace. Naming a run by its *content* removes
 * that whole class: a git tree OID says exactly what was verified, is cheap to compute, can be printed
 * for the caller to check against what they meant to verify, and can be asserted on the remote before
 * the command runs. Correctness then rests on the name, not on the lock.
 *
 * A committed ref already has a tree OID. Uncommitted work gets one too, via a throwaway index — no
 * commit, no stash, and the user's index and HEAD are untouched:
 *
 *     GIT_INDEX_FILE=<tmp> git read-tree HEAD
 *     GIT_INDEX_FILE=<tmp> git add -A      # honours .gitignore
 *     GIT_INDEX_FILE=<tmp> git write-tree
 *
 * Known limit, deliberately not papered over: `git add -A` respects `.gitignore`, so changes to
 * *ignored* files do not alter the OID. This checkout has 473 ignored entries, some of which are real
 * inputs, so the OID names the tracked content and nothing more. It is a strong statement about the
 * source, not a total one about the bytes on disk.
 */

export interface RunContent {
  /** Git tree OID of the content this run verifies. */
  treeOid: string;
  /** How the content was identified, for log lines. */
  source: 'ref' | 'working-tree';
  /** Human label: the ref as requested, or `working tree`. */
  label: string;
}

function git(
  repoRoot: string,
  args: string[],
  env?: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Tree OID of a commit-ish. */
export function treeOidForCommittish(
  repoRoot: string,
  committish: string,
): string | null {
  const out = git(repoRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${committish}^{tree}`,
  ]);
  const oid = out.stdout.trim();
  return out.status === 0 && oid !== '' ? oid : null;
}

/**
 * Tree OID of the current working tree, including uncommitted and untracked-but-not-ignored files.
 *
 * Uses a temporary index file so the user's real index is never touched — this must be safe to run
 * while they are staging a commit in another terminal. Returns null when git cannot answer, in which
 * case callers proceed without a content name rather than inventing one.
 */
export function workingTreeOid(repoRoot: string): string | null {
  // Outside the repository, deliberately. Kept under `.bica` it was inside the tree that `git add -A`
  // walks, so the throwaway index became part of the content it was supposed to be naming — and since
  // the filename carries the pid, the "name" for an unchanged tree differed on every run. Only the
  // convention of gitignoring `.bica` hid it.
  const indexFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bica-content-index-')),
    'index',
  );
  try {
    const env = { GIT_INDEX_FILE: indexFile };

    // Seed from the repository's real index rather than `read-tree HEAD`.
    //
    // Both produce the same tree, but `read-tree` writes an index with no stat information, so the
    // `add -A` that follows cannot tell which files are unchanged and re-hashes every one of them. On
    // an 11k-file monorepo that measured 2.34s against 0.14s for the seeded form — and this runs twice
    // per live-tree run, either side of the transfer, so it was roughly a third of the fixed cost of a
    // workspace run for no benefit at all.
    //
    // Copying leaves the real index untouched; nothing here ever writes through to it.
    let seeded = false;
    const realIndex = git(repoRoot, ['rev-parse', '--git-path', 'index']);
    if (realIndex.status === 0) {
      const from = path.resolve(repoRoot, realIndex.stdout.trim());
      try {
        fs.copyFileSync(from, indexFile);
        seeded = true;
      } catch {
        // No index yet (a fresh clone that has never staged anything), or it is unreadable. The
        // fallback below is correct, only slower.
      }
    }
    if (!seeded && git(repoRoot, ['read-tree', 'HEAD'], env).status !== 0) {
      return null;
    }

    if (git(repoRoot, ['add', '-A'], env).status !== 0) {
      return null;
    }
    const written = git(repoRoot, ['write-tree'], env);
    const oid = written.stdout.trim();
    return written.status === 0 && oid !== '' ? oid : null;
  } finally {
    try {
      fs.rmSync(path.dirname(indexFile), { recursive: true, force: true });
    } catch {
      // A leftover temp index is inert; it is never read again.
    }
  }
}

/** Identify what this run will verify. */
export function resolveRunContent(options: {
  repoRoot: string;
  ref: string | undefined;
}): RunContent | null {
  if (options.ref !== undefined) {
    const treeOid = treeOidForCommittish(options.repoRoot, options.ref);
    return treeOid === null
      ? null
      : { treeOid, source: 'ref', label: options.ref };
  }
  const treeOid = workingTreeOid(options.repoRoot);
  return treeOid === null
    ? null
    : { treeOid, source: 'working-tree', label: 'working tree' };
}

/** Short form for log lines and the remote run marker. */
export function shortOid(oid: string): string {
  return oid.slice(0, 12);
}
