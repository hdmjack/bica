import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildSubmodulePointerScript,
  readSubmodulePointers,
} from './rustWorkspace';
import { remoteWorkspaceWordForSh } from './runRemote';


import { dim, warn } from '../terminalStyle';
import type { PrepareResult } from '../syncProject';
import {
  resolveGitLayout,
  WORKTREE_PRIVATE_ENTRIES,
} from './gitLayout';
import {
  remotePathExprForCd,
  runRemoteScriptOverStdin,
  shellSingleQuoteRemotePathForSh,
} from './runRemote';
import { idleLimitHint } from './sshShare';
import { SUBPROCESS_MAX_BUFFER } from './subprocessOutput';
import { SYNC_NOT_READY_EXIT } from './syncProgress';
import type { RsyncRunner } from './artifacts';

/**
 * Trees return-flow must never walk, on top of whatever the user ignores. `.git` is mirrored
 * separately by {@link pushGitToRemote} and must not be reached through a `*.log`-style pattern.
 *
 * `.bica` is local-only state — the same reason the pinned push refuses to send it. Return-flow was
 * pulling *into* it, which a dry run caught deleting `.bica/locks/` because the remote has no such
 * directory. The locks self-heal (acquisition mkdirs recursively), so this was not losing anything;
 * what it was doing is letting a post-run pull with `--delete` reach the directory another run may be
 * taking a lock in at that moment. Nothing in the lock design accounts for a third party removing the
 * directory mid-acquire, and it should not have to.
 */
const ALWAYS_EXCLUDED_PATHS: readonly string[] = ['.git', '.bica'];

/**
 * Turn the session's `sync.ignore.paths` into the set of paths return-flow excludes.
 *
 * Ignored trees are owned independently by each side — `node_modules` is installed on the remote,
 * `dist` is built there — so they hold artifacts that match the return-flow whitelist (a dependency
 * shipping `__snapshots__/*.snap`, a build log) but have no business crossing the wire. Without this
 * the mirror drags remote-only files into the local tree and, with `--delete`, removes local-only
 * ones. Mutagen negations (`!foo`) re-include a path in the *forward* sync and say nothing about
 * return-flow ownership, so they are dropped rather than translated.
 */
export function buildReturnFlowExcludes(
  syncIgnorePaths: readonly string[],
): string[] {
  const fromConfig = syncIgnorePaths
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith('!'));
  return Array.from(new Set([...ALWAYS_EXCLUDED_PATHS, ...fromConfig]));
}

// Build the rsync filter-rule arguments that select only the whitelisted patterns.
// Excluded trees are ruled out first (first matching rule wins), so rsync never descends into them;
// the "+ <slash>" rule lets rsync descend into every remaining directory so it can find matches;
// each whitelist pattern becomes an include; the trailing "- *" excludes everything else; and
// --prune-empty-dirs keeps rsync from materializing empty parent dirs on the receiving side.
//
// These rules must never be paired with --delete. --prune-empty-dirs drops from the sender's list
// every directory that holds no return-flow file -- nearly every directory in a source tree -- so a
// receiver deleting with them tries to remove all of those. Files inside are protected by "- *" and
// survive, which is why rsync printed "not empty, cannot delete" for tracked source directories; an
// empty directory has nothing to protect it and was removed. Receiver-side protect rules ("P */",
// "-r */") cannot fix it on the rsync macOS ships: any of them switched off deletion altogether.
// Obsolete files are removed by name instead; see removeObsoleteReturnFlowFiles.
export function buildReturnFlowRsyncArgs(
  patterns: readonly string[],
  excludePaths: readonly string[] = [],
): string[] {
  return [
    '--prune-empty-dirs',
    ...excludePaths.map((p) => `--filter=- ${p}`),
    '--filter=+ */',
    ...patterns.map((p) => `--filter=+ ${p}`),
    '--filter=- *',
  ];
}

/**
 * Full rsync argv (sans the leading `rsync`) to *copy* the return-flow patterns from `source` to
 * `dest`, skipping `excludePaths`. Used for both the pre-run push (local→remote) and the post-run
 * pull (remote→local).
 *
 * Copy only, never `--delete`: see the note on {@link buildReturnFlowRsyncArgs} for what rsync did to
 * directories when it was. Making the receiver an exact mirror is finished by
 * {@link removeObsoleteReturnFlowFiles}, which removes files by name. Pure, for testability.
 */
export function buildReturnFlowCopyArgs(
  patterns: readonly string[],
  source: string,
  dest: string,
  excludePaths: readonly string[] = [],
): string[] {
  return [
    '-az',
    ...buildReturnFlowRsyncArgs(patterns, excludePaths),
    source,
    dest,
  ];
}

function ensureTrailingSlash(p: string): string {
  return p.endsWith('/') ? p : `${p}/`;
}

/**
 * Detect rsync. Returns true when callable; false otherwise (caller should warn, not fail).
 */
function rsyncAvailable(): boolean {
  const result = spawnSync('rsync', ['--version'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: false,
  });
  return result.error == null && result.status === 0;
}

/** Keeps a file name literal in an rsync filter rule, where `*`, `?` and `[` are patterns. */
export function escapeRsyncPattern(p: string): string {
  return p.replaceAll(/[\\*?[]/g, (c) => `\\${c}`);
}

/** The file names in `lsof -Fn` output: lines `n<name>`, of which only the absolute paths are files. */
export function parseLsofNames(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('n/'))
    .map((line) => line.slice(1));
}

interface FdStat {
  isFile: boolean;
  dev: number;
  ino: number;
}

/** Where a file descriptor of this process points, or null when that cannot be told. */
function pathOfOwnFd(fd: number): string | null {
  try {
    // Linux names it outright; macOS has no such link, and `lsof` is how it is asked.
    return fs.readlinkSync(`/proc/self/fd/${String(fd)}`);
  } catch {
    // Fall through.
  }
  const out = spawnSync('lsof', ['-nP', '-a', '-p', String(process.pid), '-d', String(fd), '-Fn'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  });
  return parseLsofNames(out.stdout ?? '')[0] ?? null;
}

/**
 * The files, as paths inside the checkout, that this process's stdout and stderr are open on.
 *
 * Return-flow owns whatever matches its patterns, `*.log` among them, and the pull after a run replaces
 * the local copy with the remote's. `bica run CMD > run.log 2>&1` from inside the checkout made the
 * log one of those: rsync renames its copy over the file, the shell goes on writing into the old one
 * that no longer has a name, and the run's output vanishes while the exit code stays 0. A file the run
 * itself is writing is nobody's to replace, so the pull is told to leave it.
 *
 * Nothing is looked up unless an output is a regular file, which is the only time this matters.
 */
export function outputFilesInside(
  repoRoot: string,
  deps: {
    statFd?: (fd: number) => FdStat;
    pathOfFd?: (fd: number) => string | null;
  } = {},
): string[] {
  const statFd =
    deps.statFd ??
    ((fd: number): FdStat => {
      const s = fs.fstatSync(fd);
      return { isFile: s.isFile(), dev: s.dev, ino: s.ino };
    });
  const pathOfFd = deps.pathOfFd ?? pathOfOwnFd;
  let root: string;
  try {
    root = fs.realpathSync(repoRoot);
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const fd of [1, 2]) {
    try {
      const stat = statFd(fd);
      if (!stat.isFile) {
        continue;
      }
      const named = pathOfFd(fd);
      if (named === null) {
        continue;
      }
      const real = fs.realpathSync(named);
      const onDisk = fs.statSync(real);
      // The name must still be this very file; a path read after a rename or delete would protect a
      // stranger.
      if (onDisk.ino !== stat.ino || onDisk.dev !== stat.dev) {
        continue;
      }
      const rel = path.relative(root, real);
      if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        found.add(rel.split(path.sep).join('/'));
      }
    } catch {
      // An output that cannot be examined cannot be protected; the pull then runs as it always did.
    }
  }
  return [...found];
}

/**
 * The local files return-flow owns, as of one moment: path inside the checkout to `size:mtime`.
 * Compared with a later one to find what somebody touched in between.
 */
export type ReturnFlowSnapshot = ReadonlyMap<string, string>;

const LISTING_LINE = /^([-dl])\S{9}\s+(\d+)\s+(\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d) (.+)$/;

/** rsync prints an awkward byte in a listed name as `\#NNN`, octal; this turns those back into bytes. */
function decodeListedName(name: string): string {
  const bytes = Buffer.from(name, 'utf8');
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x5c && bytes[i + 1] === 0x23) {
      const octal = bytes.subarray(i + 2, i + 5).toString('latin1');
      if (/^[0-7]{3}$/.test(octal)) {
        out.push(Number.parseInt(octal, 8));
        i += 4;
        continue;
      }
    }
    out.push(bytes[i]);
  }
  return Buffer.from(out).toString('utf8');
}

/** The files in `rsync --list-only` output; directories are not files and say nothing about contents. */
export function parseRsyncListing(stdout: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const m = LISTING_LINE.exec(line);
    if (m === null || m[1] === 'd') {
      continue;
    }
    files.set(decodeListedName(m[4]), `${m[2]}:${m[3]}`);
  }
  return files;
}

/** Paths present in only one of the two snapshots, or present in both with different contents. */
export function pathsChangedBetween(
  before: ReturnFlowSnapshot,
  after: ReturnFlowSnapshot,
): string[] {
  const changed = new Set<string>();
  for (const [file, state] of before) {
    if (after.get(file) !== state) {
      changed.add(file);
    }
  }
  for (const file of after.keys()) {
    if (!before.has(file)) {
      changed.add(file);
    }
  }
  return [...changed].sort();
}

/**
 * Split an rsync location into host and path, by rsync's own rule: a colon before the first slash
 * names a host. `mini:code/repo` is remote; `/Users/me/repo` and a test's temporary directory are not.
 */
export function splitRsyncUrl(url: string): { host: string | null; path: string } {
  const m = /^([^/:]+):(.*)$/.exec(url);
  return m === null ? { host: null, path: url } : { host: m[1], path: m[2] };
}

/**
 * The return-flow files under one root, local or remote, listed by rsync itself so that the patterns
 * and the excluded trees mean there exactly what they mean to the copy.
 */
function listReturnFlowFilesAt(
  prep: PrepareResult,
  rootUrl: string,
): { files: ReturnFlowSnapshot } | { error: string } {
  const listed = spawnSync(
    'rsync',
    [
      '-a',
      '--list-only',
      ...buildReturnFlowRsyncArgs(
        prep.returnFlowPaths,
        buildReturnFlowExcludes(prep.syncIgnorePaths),
      ),
      ensureTrailingSlash(rootUrl),
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: SUBPROCESS_MAX_BUFFER,
      shell: false,
    },
  );
  if (listed.error !== undefined || listed.status !== 0) {
    const err = (listed.stderr ?? '').trim() || listed.error?.message || '';
    return { error: `rsync exited ${String(listed.status ?? 1)}${err ? `: ${err}` : ''}` };
  }
  return { files: parseRsyncListing(listed.stdout ?? '') };
}

/**
 * What the local return-flow files look like now. Null when it cannot be told, which the pull reads
 * as "no baseline" and handles as it always did.
 */
export function snapshotReturnFlowFiles(
  prep: PrepareResult,
): ReturnFlowSnapshot | null {
  if (prep.returnFlowPaths.length === 0 || process.env.BICA_RETURN_FLOW?.trim() === '0') {
    return null;
  }
  if (!rsyncAvailable()) {
    return null;
  }
  const listed = listReturnFlowFilesAt(prep, prep.repoRoot);
  return 'files' in listed ? listed.files : null;
}

/**
 * Files the receiving side has and the sending side does not, minus `keep`: the ones a mirror removes.
 *
 * Files only. A directory is never on this list, because which directories a listing shows depends on
 * where return-flow files happen to be, not on what the tree holds. Anything that is not a plain path
 * inside the root is dropped as well; a listing never produces one, and this is the line that would
 * otherwise turn one into a removal outside the checkout.
 */
export function obsoleteReturnFlowFiles(
  source: ReturnFlowSnapshot,
  dest: ReturnFlowSnapshot,
  keep: readonly string[] = [],
): string[] {
  const kept = new Set(keep);
  return [...dest.keys()]
    .filter((f) => !source.has(f) && !kept.has(f) && isPlainRelativePath(f))
    .sort();
}

function isPlainRelativePath(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || rel.includes('\0')) {
    return false;
  }
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * The directories above `files`, deepest first, for an `rmdir` that removes those the removal left
 * empty. `rmdir` refuses a directory with anything in it, so one that held more than return-flow
 * files, or that was already empty and holds nothing that was removed, is never on this list or
 * survives it. The root itself is never listed.
 */
export function parentsDeepestFirst(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const segments = f.split('/');
    for (let i = segments.length - 1; i > 0; i--) {
      dirs.add(segments.slice(0, i).join('/'));
    }
  }
  const depth = (d: string): number => d.split('/').length;
  return [...dirs].sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
}

/**
 * A POSIX `sh` script that removes `files` under `remotePath`, then the directories that left empty.
 * Fed to the remote over stdin, so a name is carried by quoting alone. Exits 3 when the workspace
 * cannot be entered and 1 when a file could not be removed.
 */
export function buildRemoteRemovalScript(
  remotePath: string,
  files: readonly string[],
): string {
  const root = remotePath.trim() === '' ? '~' : remotePath;
  const lines = [
    `cd ${remotePathExprForCd(root)} || exit 3`,
    'status=0',
    ...files.map((f) => `rm -f -- ${shellSingleQuoteRemotePathForSh(f)} || status=1`),
    ...parentsDeepestFirst(files).map(
      (d) => `rmdir -- ${shellSingleQuoteRemotePathForSh(d)} 2>/dev/null`,
    ),
    'exit $status',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Remove obsolete return-flow files from the root `rootUrl` names, local or remote, and then the
 * directories that removing them left empty. Nothing else is removed: in particular a directory that
 * was empty beforehand, or that holds anything return-flow does not own, stays.
 */
export function removeObsoleteReturnFlowFiles(
  rootUrl: string,
  files: readonly string[],
): { error?: string } {
  if (files.length === 0) {
    return {};
  }
  const { host, path: rootPath } = splitRsyncUrl(rootUrl);
  if (host !== null) {
    const result = runRemoteScriptOverStdin(host, buildRemoteRemovalScript(rootPath, files));
    return result.status === 0
      ? {}
      : { error: `the removal exited ${String(result.status)}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}` };
  }
  const failed: string[] = [];
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(rootPath, f));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        failed.push(f);
      }
    }
  }
  for (const d of parentsDeepestFirst(files)) {
    try {
      fs.rmdirSync(path.join(rootPath, d));
    } catch {
      // Not empty, or already gone: either way it is not this removal's to take.
    }
  }
  return failed.length === 0 ? {} : { error: `could not remove ${failed.join(', ')}` };
}

function namedList(files: readonly string[]): string {
  const shown = files.slice(0, 8).join(', ');
  return files.length > 8 ? `${shown} and ${String(files.length - 8)} more` : shown;
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

export interface PullResult {
  /** Whether rsync ran. False = skipped (no patterns, rsync missing, or disabled). */
  ran: boolean;
  /** rsync exit code, when ran. */
  exitCode?: number;
}

/**
 * Finish a mirror whose copy has run: remove from `destUrl` what `destBefore` listed there and
 * `sourceUrl` no longer has, and say what went. `role` names the transfer in every line, so a reader
 * can tell which side was being changed.
 */
function pruneAfterCopy(options: {
  prep: PrepareResult;
  role: string;
  sourceUrl: string;
  destUrl: string;
  /** The receiving side's return-flow files, listed before the copy. */
  destBefore: ReturnFlowSnapshot | null;
  /** The sending side's, when they are already known; listed here otherwise. */
  source?: ReturnFlowSnapshot;
  keep?: readonly string[];
  /** Where the removed files were, for the message: "here" or "on the remote". */
  where: string;
  /** The side that no longer has them, for the message. */
  sender: string;
}): void {
  const { role } = options;
  if (options.destBefore === null) {
    process.stderr.write(
      `${warn('[bica]')} ${dim(`${role}: could not list the receiving side, so obsolete files there were left in place.`)}\n`,
    );
    return;
  }
  let source = options.source;
  if (source === undefined) {
    const listed = listReturnFlowFilesAt(options.prep, options.sourceUrl);
    if ('error' in listed) {
      process.stderr.write(
        `${warn('[bica]')} ${dim(`${role}: could not list the sending side (${listed.error}), so obsolete files were left in place.`)}\n`,
      );
      return;
    }
    source = listed.files;
  }
  const obsolete = obsoleteReturnFlowFiles(source, options.destBefore, options.keep);
  if (obsolete.length === 0) {
    return;
  }
  const removal = removeObsoleteReturnFlowFiles(options.destUrl, obsolete);
  if (removal.error !== undefined) {
    process.stderr.write(
      `${warn('[bica]')} ${dim(`${role}: removing ${plural(obsolete.length, 'obsolete file', 'obsolete files')} ${options.where} failed (${removal.error}).`)}\n`,
    );
    return;
  }
  process.stderr.write(
    `${dim('[bica]')} ${dim(`${role}: removed ${plural(obsolete.length, 'file', 'files')} ${options.where} that ${options.sender} no longer has: ${namedList(obsolete)}.`)}\n`,
  );
}

/**
 * Mirror the configured return-flow patterns from the remote workspace into the local repo
 * (remote → local). Local artifacts matching a return-flow pattern that no longer exist on the remote
 * are removed, so stale/obsolete snapshots (e.g. pruned by `vitest -u`, or left over from another
 * branch) don't linger locally. Non-matching files, and directories, are never touched. Pair with
 * {@link pushReturnFlowToRemote}, which resets the remote to the current branch before the run so this
 * pull mirrors current-branch state, not stale cross-branch state.
 *
 * A local file changed while the run was going (see `before`) and a file this process is writing its
 * output to are neither replaced nor removed.
 *
 * Best-effort — failures emit a warning and return non-zero but do not throw, so they don't mask
 * the remote command's exit code. A copy that failed removes nothing.
 */
export function pullReturnFlow(
  prep: PrepareResult,
  before: ReturnFlowSnapshot | null = null,
  /** Where to read from instead of the workspace: a snapshot taken under the lease (stageHome.ts). */
  sourceUrl: string = prep.remoteSyncUrl,
): PullResult {
  if (prep.returnFlowPaths.length === 0) {
    return { ran: false };
  }
  if (process.env.BICA_RETURN_FLOW?.trim() === '0') {
    return { ran: false };
  }
  if (!rsyncAvailable()) {
    process.stderr.write(
      `${warn('[bica]')} ${dim('rsync not on PATH; skipping return-flow pull (install rsync to enable snapshot return).')}\n`,
    );
    return { ran: false };
  }

  // Listed before the copy, so a file created here after this moment is not on it and cannot be
  // removed. The same listing says what changed here while the run was going: the remote's copies
  // were made when the run began, so they say nothing about what somebody did here since. Mirroring
  // them anyway brought back logs deleted during a long build and removed a log created during it,
  // which existed nowhere else. A local file that moved while the run was going is not the run's to undo.
  const localNow = snapshotReturnFlowFiles(prep);

  // The run's own output grows while it runs and is protected below; it is not something to report.
  const outputs = outputFilesInside(prep.repoRoot);
  const touched = (before !== null && localNow !== null ? pathsChangedBetween(before, localNow) : [])
    .filter((f) => !outputs.includes(f));
  if (touched.length > 0) {
    process.stderr.write(
      `${warn('[bica]')} ${dim(`Left ${String(touched.length)} local return-flow file${touched.length === 1 ? '' : 's'} alone because ${touched.length === 1 ? 'it was' : 'they were'} changed, created or deleted here while the run was going: ${namedList(touched)}.`)}\n`,
    );
  }
  const keep = [...outputs, ...touched];

  const remoteSource = ensureTrailingSlash(sourceUrl);
  const localDest = ensureTrailingSlash(prep.repoRoot);
  const args = buildReturnFlowCopyArgs(
    prep.returnFlowPaths,
    remoteSource,
    localDest,
    [
      ...buildReturnFlowExcludes(prep.syncIgnorePaths),
      // Anchored with a leading slash, so only that file at that place.
      ...keep.map((rel) => `/${escapeRsyncPattern(rel)}`),
    ],
  );

  const role = 'return-flow pull (remote → here)';
  const result = spawnSync('rsync', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    shell: false,
  });
  const code = result.status ?? 1;
  if (code !== 0) {
    const err = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    process.stderr.write(
      `${warn('[bica]')} ${dim(`${role}: rsync exited ${String(code)}${err ? `: ${err}` : ''}. Nothing was removed here.`)}\n`,
    );
    return { ran: true, exitCode: code };
  }
  pruneAfterCopy({
    prep,
    role,
    sourceUrl,
    destUrl: prep.repoRoot,
    destBefore: localNow,
    keep,
    where: 'here',
    sender: 'the remote',
  });
  return { ran: true, exitCode: code };
}

/**
 * Mirror the local return-flow artifacts (snapshots, logs) onto the remote *before* the run
 * (local → remote). Remote files matching a pattern that this checkout does not have are removed.
 *
 * Return-flow patterns are Mutagen-ignored, so the forward sync never refreshes them on the remote
 * when you switch branches — the remote keeps the *previous* branch's snapshots, which then flow
 * back locally via {@link pullReturnFlow}. This one-shot rsync resets the remote's artifacts to the
 * current branch's committed state so the remote command starts clean and can't leak stale,
 * cross-branch snapshots. `.git`-style direct rsync (not Mutagen) is safe precisely because these
 * paths are Mutagen-ignored, so the live session won't fight it.
 *
 * `localFiles` is the listing the caller took for the pull's baseline, reused so the local tree is not
 * walked twice. It is taken before the copy: a file created here after it is copied but not removed,
 * and one deleted here after it stays on the remote until the next run, which is the safe side of both.
 *
 * Best-effort — failures emit a warning and return non-zero but do not throw.
 */
export function pushReturnFlowToRemote(
  prep: PrepareResult,
  localFiles: ReturnFlowSnapshot | null = null,
): PullResult {
  if (prep.returnFlowPaths.length === 0) {
    return { ran: false };
  }
  if (process.env.BICA_RETURN_FLOW?.trim() === '0') {
    return { ran: false };
  }
  if (!rsyncAvailable()) {
    process.stderr.write(
      `${warn('[bica]')} ${dim('rsync not on PATH; skipping return-flow remote refresh (install rsync to avoid stale cross-branch snapshots).')}\n`,
    );
    return { ran: false };
  }

  const role = 'return-flow refresh (here → remote)';
  const source = localFiles ?? snapshotReturnFlowFiles(prep);
  const remoteListing = listReturnFlowFilesAt(prep, prep.remoteSyncUrl);
  const remoteBefore = 'files' in remoteListing ? remoteListing.files : null;

  const localSource = ensureTrailingSlash(prep.repoRoot);
  const remoteDest = ensureTrailingSlash(prep.remoteSyncUrl);
  const args = buildReturnFlowCopyArgs(
    prep.returnFlowPaths,
    localSource,
    remoteDest,
    buildReturnFlowExcludes(prep.syncIgnorePaths),
  );

  const result = spawnSync('rsync', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    shell: false,
  });
  const code = result.status ?? 1;
  if (code !== 0) {
    const err = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    process.stderr.write(
      `${warn('[bica]')} ${dim(`${role}: rsync exited ${String(code)}${err ? `: ${err}` : ''}. Nothing was removed on the remote.`)}\n`,
    );
    return { ran: true, exitCode: code };
  }
  if (source === null) {
    process.stderr.write(
      `${warn('[bica]')} ${dim(`${role}: could not list this checkout's return-flow files, so obsolete ones on the remote were left in place.`)}\n`,
    );
    return { ran: true, exitCode: code };
  }
  pruneAfterCopy({
    prep,
    role,
    sourceUrl: prep.repoRoot,
    destUrl: prep.remoteSyncUrl,
    destBefore: remoteBefore,
    source,
    where: 'on the remote',
    sender: 'this checkout',
  });
  return { ran: true, exitCode: code };
}

/**
 * Files git creates for the length of one operation and removes when it ends.
 *
 * Never worth copying, and harmful to copy. Another git process in the same repository -- an editor
 * polling `git status`, a hook, a second agent -- makes and removes `index.lock` many times a second,
 * and one that vanished while rsync was reading it failed the whole sync with exit 23. A run from a
 * worktree then went ahead with no refs on the remote, and `test:run:changed` reported `unknown
 * revision 'origin/master...HEAD'` as an ordinary exit 1. One that is copied whole is worse: a stale
 * `index.lock` on the remote stops every git command there that writes the index.
 *
 * Excluded on every pass, and deleted from the remote by the passes that mirror, so a lock an earlier
 * version copied does not stay there for good.
 */
export const GIT_TRANSIENT_PATTERNS: readonly string[] = [
  '*.lock',
  'tmp_pack_*',
  'tmp_idx_*',
  'tmp_obj_*',
];

const transientExcludes = GIT_TRANSIENT_PATTERNS.flatMap((p) => ['--exclude', p]);

/**
 * Rsync the local `.git` directory to the remote workspace (local → remote), making the remote git
 * history/HEAD/refs an exact mirror of local. Enables git-dependent commands like `vitest --changed`
 * to resolve the same changed-file set on the remote as they would locally.
 *
 * Uses `--delete` so stale remote-only refs/objects don't linger (unlike return-flow, which never
 * deletes). A failure is returned rather than thrown, and the caller stops the run on it -- see
 * {@link gitSyncStopsRun}.
 */
export function pushGitToRemote(
  prep: PrepareResult,
  run: RsyncRunner = defaultRsyncRunner,
): PullResult {
  if (!rsyncAvailable()) {
    process.stderr.write(
      `${warn('[bica]')} ${dim('rsync not on PATH; skipping .git sync (install rsync to enable git-dependent commands like --changed).')}\n`,
    );
    return { ran: false };
  }

  const layout = resolveGitLayout(prep.repoRoot);
  if (layout.kind === 'none') {
    process.stderr.write(
      `${warn('[bica]')} ${dim(`${prep.repoRoot} is not a git repository, so there is nothing to sync.`)}\n`,
    );
    return { ran: false };
  }

  const remoteDest = `${ensureTrailingSlash(prep.remoteSyncUrl)}.git/`;

  // A previous sync from a worktree may have left a one-line `.git` *file* there, and rsync cannot
  // make a directory where a file is. Only ever a file: a `.git` directory is what this is building.
  clearRemoteDotGitFile(prep);

  if (layout.kind === 'plain') {
    const result = rsyncGit(
      [
        '-az',
        '--delete',
        '--delete-excluded',
        ...transientExcludes,
        ensureTrailingSlash(layout.gitDir),
        remoteDest,
      ],
      run,
    );
    if (result.exitCode === 0) {
      restoreSubmodulePointers(prep);
    }
    return result;
  }

  // A worktree becomes an ordinary repository on the remote.
  //
  // Everything shared goes first -- objects, refs, config -- then this worktree's own state on top of
  // it, so HEAD and the index are this checkout's rather than the main clone's. The result is a plain
  // repository at the same commit, which is all a history-reading command needs and far simpler than
  // reproducing git's worktree layout against paths that do not exist on the remote.
  process.stderr.write(
    `${dim('[bica]')} ${dim('This is a git worktree; syncing the shared repository and this worktree\'s state as one.')}\n`,
  );
  const shared = rsyncGit(
    [
      '-az',
      '--delete',
      '--delete-excluded',
      '--exclude',
      'worktrees/',
      ...transientExcludes,
      ensureTrailingSlash(layout.commonDir),
      remoteDest,
    ],
    run,
  );
  if (shared.exitCode !== 0) {
    return shared;
  }
  return rsyncGit([
    '-az',
    // `--ignore-times`, because the overlay's whole job is to replace files the first pass just
    // wrote. rsync's quick check skips a file whose size and mtime match, and the file that matters
    // most here is `HEAD`: `ref: refs/heads/main` and `ref: refs/heads/side` are the same length, and
    // a worktree created in the same second as its clone has the same timestamp. So the one file that
    // decides which commit the remote is on was silently not copied, and the remote reported the main
    // clone's HEAD with every appearance of success. The overlay is small -- HEAD, index, logs and
    // this worktree's refs -- so forcing it costs nothing worth measuring.
    '--ignore-times',
    ...WORKTREE_PRIVATE_ENTRIES.flatMap((entry) => ['--exclude', entry]),
    ...transientExcludes,
    ensureTrailingSlash(layout.gitDir),
    remoteDest,
  ], run);
}

/** Remove a `.git` that is a plain file on the remote, which only a worktree sync can have left. */
function clearRemoteDotGitFile(prep: PrepareResult): void {
  runRemoteScriptOverStdin(
    prep.config.sshHost,
    `cd ${remotePathExprForCd(prep.config.remoteWorkspacePath)} 2>/dev/null || exit 0\n` +
      '[ -f .git ] && rm -f .git\n' +
      'exit 0\n',
  );
}

/**
 * Put each submodule's `.git` file back on the remote.
 *
 * The sync ignores `.git` at every level, so a submodule's own `.git` -- a one-line file naming a
 * path inside the parent's `.git/modules` -- never travels, while the modules directory it points at
 * does, because that lives inside the parent `.git` this function's caller just copied. The remote
 * ends up with all the data and nothing addressing it, and `git submodule status` calls every
 * submodule uninitialised. rustc's bootstrap reads exactly that.
 */
function restoreSubmodulePointers(prep: PrepareResult): void {
  const pointers = readSubmodulePointers(prep.repoRoot);
  if (pointers.length === 0) {
    return;
  }
  const script = buildSubmodulePointerScript({
    remoteWorkspaceWord: remoteWorkspaceWordForSh(prep.config.remoteWorkspacePath),
    pointers,
  });
  const result = runRemoteScriptOverStdin(prep.config.sshHost, script);
  if (result.status !== 0) {
    process.stderr.write(
      `${warn('[bica]')} ${dim(`Could not restore ${String(pointers.length)} submodule pointer(s) on the remote; \`git submodule\` there will report them uninitialised.`)}\n`,
    );
    return;
  }
  process.stderr.write(
    `${dim('[bica]')} ${dim(`Restored ${String(pointers.length)} submodule pointer(s) on the remote.`)}\n`,
  );
}

function defaultRsyncRunner(args: readonly string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('rsync', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    shell: false,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** rsync's code for "some files vanished before they could be transferred". */
const RSYNC_VANISHED = 24;

/**
 * One `.git` pass, retried once.
 *
 * A repository somebody is using changes under the copy. The transient files are excluded, but a
 * pack written by a fetch or a `gc` can still appear or go part-way through, so one failure earns one
 * more attempt -- which, against a tree that has stopped moving, is a complete copy. A file that
 * vanished (24) is not a failure at all: what vanishes from `.git` is by nature something git was
 * about to remove.
 */
export function rsyncGit(
  args: string[],
  run: RsyncRunner = defaultRsyncRunner,
): PullResult {
  let code = 0;
  let said = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = run(args);
    code = result.status === RSYNC_VANISHED ? 0 : result.status;
    if (code === 0) {
      return { ran: true, exitCode: 0 };
    }
    said = `${result.stderr}${result.stdout}`.trim();
  }
  const hint = idleLimitHint(code);
  process.stderr.write(
    `${warn('[bica]')} ${dim(`.git sync rsync exited ${String(code)}${said ? `: ${said}` : ''}${hint ? `\n${hint}` : ''}`)}\n`,
  );
  return { ran: true, exitCode: code };
}

/**
 * The run's exit code when the `.git` sync failed, or `undefined` to go ahead.
 *
 * It was best-effort, so that a failed copy could not mask the command's exit code. It masked it the
 * other way instead: the commands ran against a repository with no refs, and a history-reading one
 * failed in a way indistinguishable from a real failure. Stopping says the true thing, which is that
 * nothing ran against the tree that was asked for.
 */
export function gitSyncStopsRun(
  result: PullResult,
  sshHost: string,
): number | undefined {
  if (!result.ran || result.exitCode === 0) {
    return undefined;
  }
  process.stderr.write(
    `${warn('[bica]')} The .git sync to ${sshHost} did not complete, so the remote's history is incomplete ` +
      'and a command that reads it would fail as if your code had. Nothing ran, so exit ' +
      `${String(SYNC_NOT_READY_EXIT)} is not a verdict on your code. Re-run; \`git: sync: false\` in ` +
      'bica.yml turns the .git sync off for a repository whose commands never read history.\n',
  );
  return SYNC_NOT_READY_EXIT;
}
