import { spawnSync } from 'node:child_process';

import { workingTreeOid } from './contentIdentity';
import { dim, warn } from '../terminalStyle';

/**
 * Pinned (one-shot) working-tree sync, used by lane runs instead of a live Mutagen session.
 *
 * A lane run must execute the tree as it stood when the run started. A live session cannot promise
 * that: it is *designed* to keep pushing later edits, so checking out the next branch locally —
 * exactly what a per-branch sweep does — would push that branch's files into a lane that is still
 * running the previous one. One `rsync` at the start pins the content by construction, and dropping
 * the session also removes the ephemeral-session collision (`bica run` terminating its predecessor)
 * that blocked concurrency in the first place.
 *
 * The trade is deliberate: no live sync inside a lane. Edits made after a lane run starts are not
 * picked up by that run. Interactive development keeps using the default (non-lane) run, which is
 * unchanged.
 */

/** Local-only bica state (locks, install fingerprints, generated project files). Never pushed. */
const LOCAL_ONLY_PATHS: readonly string[] = ['.bica'];

/**
 * `.git` is excluded here even when `git.sync` is on: it is mirrored by its own rsync so that the
 * one-shot tree push and the git push keep independent `--delete` scopes.
 */
const NEVER_PUSHED_PATHS: readonly string[] = ['.git'];

/**
 * Translate the user's `sync.ignore.paths` into rsync filter rules and build the argv for the
 * pinned push.
 *
 * Mutagen ignore syntax is gitignore-like, including `!path` negations that re-include something an
 * earlier rule excluded. rsync resolves filters first-match-wins, so negations become `+` rules
 * emitted *before* the `-` rules they override.
 *
 * `--delete` makes the lane an exact mirror of the pinned tree, so a file removed on this branch is
 * removed in the lane too. It is safe next to the excludes because rsync never deletes inside an
 * excluded tree — the lane's `node_modules` survives, which is the whole point of reusing lanes.
 * `--delete-excluded` would destroy that and is deliberately not used.
 *
 * Pure, for testability.
 */
export function buildPinnedPushArgs(options: {
  source: string;
  dest: string;
  /** The user's `sync.ignore.paths`, verbatim (negations included). */
  syncIgnorePaths: readonly string[];
  /**
   * Return-flow patterns to leave alone because the run owns them on the remote. Empty when
   * return-flow is off for this run, in which case the tree's own snapshots push normally.
   */
  returnFlowPaths: readonly string[];
}): string[] {
  const includes: string[] = [];
  const excludes: string[] = [...NEVER_PUSHED_PATHS, ...LOCAL_ONLY_PATHS];

  for (const raw of options.syncIgnorePaths) {
    const p = raw.trim();
    if (p.length === 0) {
      continue;
    }
    if (p.startsWith('!')) {
      const reincluded = p.slice(1).trim();
      if (reincluded.length > 0) {
        includes.push(reincluded);
      }
      continue;
    }
    excludes.push(p);
  }
  excludes.push(...options.returnFlowPaths.map((p) => p.trim()).filter(Boolean));

  return [
    '-az',
    '--delete',
    ...includes.map((p) => `--filter=+ ${p}`),
    ...Array.from(new Set(excludes)).map((p) => `--filter=- ${p}`),
    options.source,
    options.dest,
  ];
}

function ensureTrailingSlash(p: string): string {
  return p.endsWith('/') ? p : `${p}/`;
}

export interface PinnedPushResult {
  ok: boolean;
  /** rsync exit code, when rsync ran. */
  exitCode?: number;
  /** Set when the content changed mid-transfer, so what landed is not what was named. */
  torn?: boolean;
  /** Content name observed before the transfer, when git could supply one. */
  treeOidBefore?: string;
  /** Content name observed after. Differs from `treeOidBefore` exactly when `torn` is set. */
  treeOidAfter?: string;
}

/**
 * Push the pinned content to the lane's remote workspace, and confirm that what landed is what was
 * named.
 *
 * The content is identified by a git tree OID either side of the transfer. Equal OIDs mean the source
 * did not move while rsync walked it, so the run can honestly claim to have verified that tree.
 * Different OIDs mean it did move, and the run fails — a result derived from a half-synced mix of two
 * states looks exactly like a real verification and is not one.
 *
 * There is deliberately no retry. Retrying was a courtesy that muddied the report: the caller wants to
 * know that their tree is moving under them, not to have bica quietly try again until it stops. One
 * attempt, and the failure names both OIDs.
 *
 * A `--ref` run passes `sourceDir` pointing at a throwaway worktree. That cannot move, so its OID is
 * known up front and no comparison is needed.
 */
export function pushPinnedWorkingTree(options: {
  repoRoot: string;
  /** Directory to push. Defaults to `repoRoot` (the live tree). */
  sourceDir?: string;
  remoteSyncUrl: string;
  syncIgnorePaths: readonly string[];
  returnFlowPaths: readonly string[];
  /** Known content name, when the source is immutable (a `--ref` worktree). Skips the comparison. */
  knownTreeOid?: string;
}): PinnedPushResult {
  const sourceDir = options.sourceDir ?? options.repoRoot;
  const isLiveTree = sourceDir === options.repoRoot;
  const args = buildPinnedPushArgs({
    source: ensureTrailingSlash(sourceDir),
    dest: ensureTrailingSlash(options.remoteSyncUrl),
    syncIgnorePaths: options.syncIgnorePaths,
    returnFlowPaths: options.returnFlowPaths,
  });

  const before =
    options.knownTreeOid ??
    (isLiveTree ? workingTreeOid(options.repoRoot) : null);

  const result = spawnSync('rsync', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  const code = result.status ?? 1;
  if (code !== 0) {
    const err = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    process.stderr.write(
      `${warn('[bica]')} ${dim(`pinned sync rsync exited ${String(code)}${err ? `: ${err}` : ''}`)}\n`,
    );
    return { ok: false, exitCode: code, treeOidBefore: before ?? undefined };
  }

  // An immutable source needs no re-check, and a checkout git cannot describe gets no content name —
  // in neither case is there a comparison to fail.
  if (options.knownTreeOid !== undefined || !isLiveTree || before === null) {
    return { ok: true, exitCode: 0, treeOidBefore: before ?? undefined };
  }

  const after = workingTreeOid(options.repoRoot);
  if (after === null || before === after) {
    return { ok: true, exitCode: 0, treeOidBefore: before, treeOidAfter: after ?? undefined };
  }
  return {
    ok: false,
    torn: true,
    exitCode: 0,
    treeOidBefore: before,
    treeOidAfter: after,
  };
}
