import { spawn } from 'node:child_process';

import { claimPathExpr, describeSelfAsOwner, remoteReleaseClaim } from './remoteClaim';
import {
  buildLogsScript,
  describeDetachedRun,
  listDetachedRunRecords,
  readDetachedRunRecord,
  removeDetachedRunRecord,
} from './detachedRun';
import type { DetachedRunRecord } from './detachedRun';
import { reportArtifactPull } from './reportArtifacts';
import { readArtifactSpec } from '../syncProject';
import { remoteReadRecordedExit, runRemoteScriptOverStdin } from './runRemote';
import { REMOTE_UNREACHABLE_EXIT } from './pinnedRun';
import { dim, warn } from '../terminalStyle';


/**
 * `bica logs`, `bica wait` and `bica runs` -- the other half of `--detach`.
 *
 * A detached run prints an id and returns. Everything a caller would have got by waiting -- the
 * output, the exit code, the artifacts -- has to be reachable afterwards by that id, from a process
 * that was not there when it started. All three answers come from the remote rather than from local
 * state: the log is a file there, and the exit code is the one the run appends to its own claim when
 * it finishes, which is the same record an attached run already writes.
 */

/** How long to wait between asking the remote whether a run has finished. */
const WAIT_POLL_MS = 5_000;

export interface DetachedRunState {
  record: DetachedRunRecord;
  state: 'running' | 'finished' | 'gone' | 'unreachable';
  exitCode: number | null;
}

/** How long `wait` keeps trying a host that will not answer before giving the caller its turn. */
const UNREACHABLE_GRACE_MS = 5 * 60_000;

/**
 * Where a detached run has got to.
 *
 * `mine` is what separates "still going" from "gone": the claim holds this run's id until something
 * else takes the workspace, so a claim naming another run means this one's record is history and its
 * exit code is not recoverable. Saying that plainly beats reporting a stranger's exit code.
 *
 * A claim that could not be read says none of that. It used to arrive here as `mine: false` and get
 * reported as a takeover, which is both false and expensive: a 15-minute LLVM build that was still
 * compiling, still holding its claim, was declared gone on one failed poll and had its local record
 * deleted -- the only handle on its output and its artifacts.
 */
export function readDetachedRunState(
  record: DetachedRunRecord,
  read: typeof remoteReadRecordedExit = remoteReadRecordedExit,
): DetachedRunState {
  const recorded = read(
    record.sshHost,
    claimPathExpr(record.remoteWorkspacePath),
    record.runId,
  );
  if (recorded.unreachable) {
    return { record, state: 'unreachable', exitCode: null };
  }
  if (!recorded.mine) {
    return { record, state: 'gone', exitCode: null };
  }
  return recorded.exitCode === null
    ? { record, state: 'running', exitCode: null }
    : { record, state: 'finished', exitCode: recorded.exitCode };
}

export function cmdRuns(): number {
  const records = listDetachedRunRecords();
  if (records.length === 0) {
    process.stderr.write(
      `${dim('[bica]')} ${dim('No detached runs. Start one with `bica run --detach <command>`.')}\n`,
    );
    return 0;
  }
  for (const record of records) {
    const state = readDetachedRunState(record);
    process.stdout.write(
      `${describeDetachedRun(record, state.state, state.exitCode)}\n`,
    );
  }
  return 0;
}

function missing(runId: string): number {
  process.stderr.write(
    `${warn('[bica]')} No detached run called ${runId}. \`bica runs\` lists the ones this machine started.\n`,
  );
  return 1;
}

/**
 * Stream a detached run's output.
 *
 * `--follow` hands the terminal to ssh rather than reading the file in a loop, so a build's output
 * arrives as the build writes it and Ctrl-C stops watching without touching the run. That is the
 * distinction worth protecting: this command is a window, and closing a window does not stop a build.
 */
export async function cmdLogs(
  runId: string,
  options: { follow: boolean },
): Promise<number> {
  const record = readDetachedRunRecord(runId);
  if (record === null) {
    return missing(runId);
  }
  if (!options.follow) {
    const result = runRemoteScriptOverStdin(
      record.sshHost,
      buildLogsScript({ runId, follow: false }),
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.status;
  }
  return new Promise<number>((resolve) => {
    const child = spawn(
      'ssh',
      ['-T', record.sshHost, 'sh', '-s'],
      { stdio: ['pipe', 'inherit', 'inherit'], shell: false },
    );
    child.stdin.end(buildLogsScript({ runId, follow: true }));
    child.on('close', (code) => {
      resolve(code ?? 0);
    });
    child.on('error', () => {
      resolve(1);
    });
  });
}

/**
 * Collect the run's named outputs into the checkout it was started from.
 *
 * Everything needed comes from the record and that checkout's spec, so this works from any shell --
 * `bica wait` is routinely run from a different one than the launch, with none of the environment
 * that run had.
 */
function pullArtifactsForRecord(record: DetachedRunRecord): void {
  let spec;
  try {
    spec = readArtifactSpec(record.repoRoot);
  } catch {
    // A checkout that has moved or lost its spec is not a reason to fail a wait; the exit code is
    // the answer and it is already known.
    return;
  }
  if (spec.artifacts.length === 0) {
    return;
  }
  reportArtifactPull({
    ...spec,
    remoteSyncUrl: `${record.sshHost}:${record.remoteWorkspacePath}`,
    repoRoot: record.repoRoot,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Block until a detached run finishes, then finish the job the launcher could not.
 *
 * Artifacts and return-flow are pulled here and not when the command started, because there was
 * nothing to pull then. That is the point of this command existing rather than `bica logs` plus a
 * read of the exit code: the outputs only exist once the build does, and somebody has to collect
 * them on the near side.
 */
export async function cmdWait(
  runId: string,
  options: {
    pollMs?: number;
    /** How long to keep trying a silent host before handing the shell back. */
    unreachableGraceMs?: number;
    read?: typeof remoteReadRecordedExit;
    now?: () => number;
    /** Overridden in tests, which must not reach a real host to give a lease back. */
    release?: typeof remoteReleaseClaim;
    finish?: (record: DetachedRunRecord) => void;
  } = {},
): Promise<number> {
  const record = readDetachedRunRecord(runId);
  if (record === null) {
    return missing(runId);
  }
  const pollMs = options.pollMs ?? WAIT_POLL_MS;
  const graceMs = options.unreachableGraceMs ?? UNREACHABLE_GRACE_MS;
  const read = options.read ?? remoteReadRecordedExit;
  const now = options.now ?? (() => Date.now());
  let said = false;
  let unreachableSince: number | undefined;
  let saidUnreachable = false;
  for (;;) {
    const state = readDetachedRunState(record, read);
    if (state.state === 'unreachable') {
      // The run is almost certainly fine; it is the question that failed. Keep the record whatever
      // happens here, so `bica wait <id>` works again once the host is back.
      const at = now();
      unreachableSince ??= at;
      if (!saidUnreachable) {
        saidUnreachable = true;
        process.stderr.write(
          `${warn('[bica]')} ${record.sshHost} is not answering; still waiting for ${runId}. ` +
            'Its record is kept, so this is safe to re-run.\n',
        );
      }
      if (at - unreachableSince >= graceMs) {
        process.stderr.write(
          `${warn('[bica]')} Gave up reaching ${record.sshHost} after ` +
            `${String(Math.round(graceMs / 60_000))}m. ${runId} is probably still running there — ` +
            `\`bica wait ${runId}\` again when the host is back.\n`,
        );
        return REMOTE_UNREACHABLE_EXIT;
      }
      await delay(pollMs);
      continue;
    }
    if (unreachableSince !== undefined) {
      unreachableSince = undefined;
      saidUnreachable = false;
      process.stderr.write(
        `${dim('[bica]')} ${dim(`${record.sshHost} is answering again.`)}\n`,
      );
    }
    if (state.state === 'gone') {
      process.stderr.write(
        `${warn('[bica]')} ${runId} is no longer the run holding ${record.remoteWorkspacePath}: ` +
          'something else took the workspace, so its result is not recoverable. ' +
          `Its output is still in \`bica logs ${runId}\`.\n`,
      );
      removeDetachedRunRecord(runId);
      return 1;
    }
    if (state.state === 'finished') {
      const code = state.exitCode ?? 1;
      (options.finish ?? pullArtifactsForRecord)(record);
      // The lease outlived the launcher on purpose; this is where it is given back.
      (options.release ?? remoteReleaseClaim)(
        record.sshHost,
        record.remoteWorkspacePath,
        describeSelfAsOwner(runId),
      );
      removeDetachedRunRecord(runId);
      process.stderr.write(
        `${dim('[bica]')} ${dim(`${runId} finished (exit ${String(code)}).`)}\n`,
      );
      return code;
    }
    if (!said) {
      said = true;
      process.stderr.write(
        `${dim('[bica]')} ${dim(`Waiting for ${runId}; \`bica logs ${runId} --follow\` shows its output.`)}\n`,
      );
    }
    await delay(pollMs);
  }
}
