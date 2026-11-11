import {
  remotePathExprForCd,
  runRemoteScriptOverStdin,
  shellSingleQuoteRemotePathForSh,
} from './runRemote';
import { buildReturnFlowRsyncArgs } from './returnFlow';
import { dim } from '../terminalStyle';

/**
 * A private copy, taken on the remote while the run still holds the workspace lease, of whatever the
 * run is about to bring home.
 *
 * Why it exists. Copying home is the last thing a run does and, for a job that wrote thousands of
 * files, not a short one: one run kept the lease through 4163 preview files and the run chained after
 * it was refused twice with 98. Giving the lease back first would end that, and would also let the
 * next run's sync overwrite those files on the remote while they were still being read. What lands in
 * the local tree would then be some of this run's output and some of the next run's, under a message
 * saying it was this run's. The lease exists to prevent exactly that.
 *
 * So the copy home reads from somewhere nobody else writes. The snapshot is one rsync on the remote,
 * from the workspace to a directory beside it, which is a copy on a local disk and a fraction of what
 * crossing the network costs. Once it is taken the lease goes, and the pulls read the snapshot instead
 * of the workspace. It holds the same relative paths, so every pull works unchanged apart from where
 * it reads.
 *
 * Best effort in one direction only: if the snapshot cannot be taken -- no rsync on the remote, a full
 * disk -- the caller keeps the lease through the copy, as it always did.
 */

/** Where snapshots live on the remote, relative to its home directory: rsync and `sh` both read it so. */
export const REMOTE_STAGE_ROOT = '.bica/stage';

/** A snapshot older than this is a run that died before it could remove its own. */
const STALE_AFTER_DAYS = 1;

/** Said by the script once the snapshot is complete, so a partial one is never mistaken for it. */
export const STAGE_DONE = 'BICA_STAGE_DONE';

/**
 * Said, with the artifact's name after it, when the script declined to take a snapshot because an
 * artifact holds a link to a directory.
 *
 * An artifact is pulled with `-L`, so a link is read as what it points at; a snapshot has to do the
 * same or the pull would find links that point nowhere. For a link to a file that costs the file. For
 * a link to a directory it costs the whole directory, whatever the run changed: one run staged about
 * 15 GB on the remote's disk, for minutes, to bring home 4 KB. Pulling from the workspace reads only
 * what differs, so a run with such a link keeps the lease through the copy, as it did before 0.10.3.
 */
export const STAGE_LINKED_DIR = 'BICA_STAGE_LINKED_DIR';

export interface StagePlan {
  /** Workspace-relative files, such as what `--write-back` found the command wrote. */
  files: readonly string[];
  /** The return-flow whitelist, with the trees that stay out of it; null when there is none. */
  returnFlow: {
    patterns: readonly string[];
    excludes: readonly string[];
  } | null;
  /** The `artifacts:` entries, as written in the config. */
  artifacts: readonly string[];
}

/** What the snapshot for a run is called. Run ids are pids, but nothing here relies on that. */
export function stageDirName(runId: string): string {
  return runId.replaceAll(/[^A-Za-z0-9._-]/g, '_');
}

/** The rsync source that names a run's snapshot, in the shape `remoteSyncUrl` has for the workspace. */
export function stageSyncUrl(sshHost: string, runId: string): string {
  return `${sshHost}:${REMOTE_STAGE_ROOT}/${stageDirName(runId)}`;
}

/** Whether there is anything to take a snapshot of. */
export function planIsEmpty(plan: StagePlan): boolean {
  return (
    plan.files.length === 0 &&
    plan.returnFlow === null &&
    plan.artifacts.length === 0
  );
}

const FILES_DELIMITER = 'BICA_STAGE_FILES_END';

/**
 * The `sh` script that takes the snapshot.
 *
 * Returns null when it cannot be written faithfully: a path that contains a newline cannot travel in a
 * line-separated list, and rather than drop it quietly the caller keeps the lease and copies as before.
 */
export function buildStageScript(options: {
  remoteWorkspacePath: string;
  runId: string;
  plan: StagePlan;
}): string | null {
  const { plan } = options;
  if (
    plan.files.some((f) => /[\n\r]/.test(f) || f === FILES_DELIMITER) ||
    plan.artifacts.some((a) => /[\n\r]/.test(a))
  ) {
    return null;
  }
  const quote = shellSingleQuoteRemotePathForSh;
  const root = '"$HOME/' + REMOTE_STAGE_ROOT + '"';
  const stage = `${root}/${quote(stageDirName(options.runId))}`;
  const lines = [
    // A snapshot left by a run that died is the one thing here that is not cleaned up by its owner.
    `find ${root} -mindepth 1 -maxdepth 1 -mtime +${String(STALE_AFTER_DAYS)} -exec rm -rf {} + 2>/dev/null || true`,
    `rm -rf ${stage}`,
    `mkdir -p ${stage} || exit 1`,
    `cd ${remotePathExprForCd(options.remoteWorkspacePath)} || exit 1`,
    'command -v rsync >/dev/null 2>&1 || exit 1',
  ];
  for (const artifact of plan.artifacts) {
    // Before anything is copied, so a refusal leaves nothing behind. `-H` reads an artifact that is
    // itself a link as what it points at, which the second test then catches.
    const target = quote(`./${artifact.replace(/^\.?\//, '').replace(/\/+$/, '')}`);
    lines.push(
      `if [ -L ${target} ] && [ -d ${target} ]; then echo ${STAGE_LINKED_DIR} ${target}; exit 1; fi`,
      `LINKED=$(find -H ${target} -type l -exec test -d {} \\; -print -quit 2>/dev/null)`,
      `if [ -n "$LINKED" ]; then echo ${STAGE_LINKED_DIR} "$LINKED"; exit 1; fi`,
    );
  }
  if (plan.files.length > 0) {
    lines.push(
      `rsync -a --files-from=- ./ ${stage}/ <<'${FILES_DELIMITER}' || exit 1`,
      ...plan.files,
      FILES_DELIMITER,
    );
  }
  if (plan.returnFlow !== null) {
    const filters = buildReturnFlowRsyncArgs(
      plan.returnFlow.patterns,
      plan.returnFlow.excludes,
    ).map(quote);
    lines.push(`rsync -a ${filters.join(' ')} ./ ${stage}/ || exit 1`);
  }
  for (const artifact of plan.artifacts) {
    const clean = artifact.replace(/^\.?\//, '');
    // `-R` keeps the path, so the snapshot has the layout the pull expects. A missing artifact is not a
    // failed snapshot: the pull reports it as missing, which is what it should say.
    lines.push(`rsync -aLR ${quote(`./${clean}`)} ${stage}/ 2>/dev/null || true`);
  }
  lines.push(`echo ${STAGE_DONE}`);
  return `${lines.join('\n')}\n`;
}

export interface Stage {
  /** Where the pulls read from instead of the workspace. */
  url: string;
  remove: () => void;
}

/**
 * Take the snapshot, or say there is none.
 *
 * A null means the caller must keep the lease until its copy is done: nothing about the workspace has
 * changed, and nothing is left behind on the remote.
 */
export function takeStage(options: {
  sshHost: string;
  remoteWorkspacePath: string;
  runId: string;
  plan: StagePlan;
  run?: typeof runRemoteScriptOverStdin;
}): Stage | null {
  if (planIsEmpty(options.plan)) {
    return null;
  }
  const script = buildStageScript(options);
  if (script === null) {
    return null;
  }
  const run = options.run ?? runRemoteScriptOverStdin;
  const remove = (): void => {
    run(
      options.sshHost,
      `rm -rf "$HOME/${REMOTE_STAGE_ROOT}"/${shellSingleQuoteRemotePathForSh(stageDirName(options.runId))}\nexit 0\n`,
    );
  };
  const result = run(options.sshHost, script);
  if (result.status !== 0 || !result.stdout.includes(STAGE_DONE)) {
    const linked = new RegExp(`${STAGE_LINKED_DIR} (.+)`).exec(result.stdout);
    if (linked !== null) {
      process.stderr.write(
        `${dim('[bica]')} ${dim(`Keeping the workspace until the files are home: ${linked[1]} links to a directory, and a snapshot would copy all of it.`)}\n`,
      );
    }
    // Whatever was half-copied is no use to anyone.
    remove();
    return null;
  }
  return { url: stageSyncUrl(options.sshHost, options.runId), remove };
}
