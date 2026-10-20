import { remoteWorkspaceWordForSh, runRemoteScriptOverStdin } from './runRemote';

/**
 * Make a freshly synced file newer than anything already built from an older copy of it.
 *
 * The pinned sync is `rsync -a`, which preserves each file's local mtime. That is right for a tree
 * nobody is building, and wrong the moment the remote owns a build directory, because an object can
 * then be *newer than the source it was not built from*: a file edited at 23:40 while a long build
 * was running arrives on the remote still stamped 23:40, and the object that build compiled at 23:51
 * from the previous copy is newer than it. ninja, make and cargo's mtime fingerprinting all compare
 * exactly those two numbers, so they skip the file -- not once, but every run from then on.
 *
 * This belongs to the pinned path and only the pinned path. The live session propagates content
 * rather than timestamps, so a file it delivers already carries the remote's own clock and is newer
 * than everything built before it -- the state this repair has to manufacture. Measured against
 * mini: a local file stamped 1 January 2025 arrives stamped with the time of the transfer, and so
 * does a newly created one.
 *
 * Reported from llvm-blackfin, where it produced a `clang` with none of the edit in it from a run
 * that exited 0, and then went on reporting success. That is the failure the pinned sync's torn-tree
 * check exists to prevent, arriving by a route that check cannot see: the run really did use the new
 * files, and the build tool still produced an artifact from the old ones.
 *
 * The repair is to stamp the files this sync delivered with the remote's own clock, so they are newer
 * than every object in the tree. Only those files: touching anything else would force a rebuild of
 * work that is still good, which on LLVM is forty minutes.
 *
 * The cost is one extra transfer of each touched file on the next sync, since rsync's quick check
 * compares size and mtime and will now see a difference. That is a handful of files against a build,
 * and it is the right direction to be wrong in -- rebuilding something that did not need it is a
 * delay, while skipping something that did is a wrong answer reported as a right one.
 */

/**
 * Above this many files, the stamping is skipped.
 *
 * A sync this large is a first push or a branch switch, where the build is going to be substantially
 * redone anyway and the list would be a multi-megabyte script. The guard matters because the cure
 * must never be more expensive than the disease it prevents.
 */
export const TOUCH_PATH_LIMIT = 2000;

/**
 * Files this push sent whose *content* changed, from the itemised output the pinned sync already
 * captures.
 *
 * `<f` is rsync's "a regular file is being sent to the remote". Directories, symlinks and deletions
 * are excluded because a directory's mtime means nothing to a build tool and a deletion has nothing
 * left to stamp.
 *
 * The content test is what keeps this from eating itself. Stamping sets the remote's mtime to the
 * remote's clock, which no longer equals the local one, so rsync's quick check re-sends the file on
 * the very next run -- and if that re-send were stamped too, every stamped file would be rebuilt on
 * every run for ever, which is a worse bug than the one being fixed. rsync labels that re-send
 * `..t`, a difference of time alone, against `+++` for a new file and `.s` for one whose size moved.
 * Stamping only the latter two makes the repair settle: measured against `mini`, the run after a
 * stamp transfers the file once more and the run after that transfers nothing at all.
 *
 * The flag positions are `c` (content), `s` (size), `t` (time) at indices 2, 3 and 4. macOS ships
 * openrsync, whose field is 9 characters against GNU's 11, so nothing may depend on the width --
 * only on those three positions, which both agree on.
 *
 * Known limit: an edit that leaves the file's size unchanged is also reported as `..t`, so one made
 * to a file that was stamped on the immediately preceding run is skipped. It is narrow -- the file
 * is in sync again afterwards, and any later edit transfers normally -- and `touch` on the file is
 * the remedy if a build ever skips something it should not have.
 */
export function parseTransferredPaths(rsyncStdout: string): string[] {
  const out: string[] = [];
  for (const line of rsyncStdout.split('\n')) {
    const m = /^([<>]f\S*)\s+(.+?)\s*$/.exec(line);
    if (m === null) {
      continue;
    }
    const flags = m[1];
    const contentChanged =
      flags[2] === 'c' || flags[2] === '+' || flags[3] === 's' || flags[3] === '+';
    if (contentChanged) {
      out.push(m[2]);
    }
  }
  return out;
}

/**
 * Stamp the given paths with the remote's clock.
 *
 * Paths arrive through a heredoc rather than an argument list because a branch switch can deliver
 * more files than `ARG_MAX` will carry, and are prefixed `./` so that nothing beginning with `-` is
 * read by `touch` as an option. `-c` so a path that has since gone does not fail the run: this is a
 * repair, and a repair that aborts a build is worse than the staleness it was fixing.
 */
export function buildTouchScript(
  remoteWorkspacePath: string,
  paths: readonly string[],
): string {
  const body = paths.map((p) => `./${p}`).join('\n');
  return [
    `cd ${remoteWorkspaceWordForSh(remoteWorkspacePath)} || exit 1`,
    "tr '\\n' '\\0' <<'BICA_TOUCH_EOF' | xargs -0 touch -c",
    body,
    'BICA_TOUCH_EOF',
    '',
  ].join('\n');
}

export interface MtimeRepair {
  touched: number;
  /** True when the list was too long to be worth stamping; see {@link TOUCH_PATH_LIMIT}. */
  skipped: boolean;
}

/**
 * Whether this repository has a build tool that reads mtimes.
 *
 * Gated rather than unconditional because it costs a connection and buys nothing for a Node repo:
 * vitest and eslint read content, not timestamps. Every signal here marks a project that compiles --
 * named outputs to bring home, a declared toolchain, a shared build directory, a Rust `target/`.
 */
export function wantsMtimeRepair(prep: {
  artifacts?: readonly unknown[];
  toolchain?: readonly unknown[];
  buildDir?: string;
  cargoTargetIgnored?: boolean;
}): boolean {
  return (
    (prep.artifacts?.length ?? 0) > 0 ||
    (prep.toolchain?.length ?? 0) > 0 ||
    prep.buildDir !== undefined ||
    prep.cargoTargetIgnored === true
  );
}

export function repairSyncedMtimes(options: {
  sshHost: string;
  remoteWorkspacePath: string;
  paths: readonly string[];
  run?: typeof runRemoteScriptOverStdin;
}): MtimeRepair {
  if (options.paths.length === 0) {
    return { touched: 0, skipped: false };
  }
  if (options.paths.length > TOUCH_PATH_LIMIT) {
    return { touched: options.paths.length, skipped: true };
  }
  const run = options.run ?? runRemoteScriptOverStdin;
  const result = run(
    options.sshHost,
    buildTouchScript(options.remoteWorkspacePath, options.paths),
  );
  return { touched: result.status === 0 ? options.paths.length : 0, skipped: false };
}

export function describeMtimeRepair(repair: MtimeRepair): string | undefined {
  if (repair.skipped) {
    return (
      `${String(repair.touched)} files changed, which is more than a stamping pass is worth: the ` +
      'build is going to redo most of this tree anyway. If a build tool skips a file it should have ' +
      'rebuilt, `touch` it and run again.'
    );
  }
  if (repair.touched === 0) {
    return undefined;
  }
  return repair.touched === 1
    ? "Stamped 1 synced file with the remote's clock, so the build cannot skip it."
    : `Stamped ${String(repair.touched)} synced files with the remote's clock, so the build cannot skip them.`;
}
