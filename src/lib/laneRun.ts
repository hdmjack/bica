import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveBicaPluginConfig } from '../bicaWorkspaceConfig';
import { dim, syncRemoteTarget, warn } from '../terminalStyle';
import {
  acquireLockWithWait,
  describeLockHolder,
  isProcessAlive,
  readLockHolder,
  tryAcquireLock,
} from './fileLock';
import {
  resolveGitRef,
  setRemoteHeadForPin,
  withPinnedWorktree,
} from './gitPin';
import {
  AUTO_LANE,
  defaultLaneIdentity,
  laneIdentity,
  laneIdsForPool,
  lockRootDir,
} from './lanes';
import { shortOid } from './contentIdentity';
import {
  claimIsStale,
  claimPathExpr,
  describeClaim,
  describeSelfAsOwner,
  remoteAcquireClaim,
  remoteBreakClaim,
  remoteReleaseClaim,
} from './remoteClaim';
import {
  REMOTE_CONTENT_MISMATCH_EXIT,
  remoteReadRecordedExit,
} from './runRemote';
import { pushPinnedWorkingTree } from './pinnedSync';
import { remoteTrustMiseWorkspace } from './runRemote';
import { pullReturnFlow, pushGitToRemote, pushReturnFlowToRemote } from './returnFlow';
import {
  ensureRemoteWorkspaceDirectory,
  runRemoteCommandWithPmHooks,
} from './runWithPackageManagerPlugins';
import type { HeldLock } from './fileLock';
import type { ResolvedGitRef } from './gitPin';
import type { LaneIdentity } from './lanes';
import type { ConfirmFn } from '../plugins/types';
import type { PrepareResult } from '../syncProject';

/** How long a queued return-flow pull waits for the lane ahead of it to finish its pull. */
const RETURN_FLOW_LOCK_TIMEOUT_MS = 120_000;

export interface AcquiredLane {
  lane: LaneIdentity;
  lock: HeldLock;
}

/**
 * How many `bica run` invocations for this checkout are live right now, this one included.
 *
 * Read-only on purpose: it inspects lock files and checks whether the recorded pid is alive, rather
 * than acquiring, so it neither steals a stale lock nor disturbs a running lane.
 */
export function countRunsInFlight(repoRoot: string, poolSize: number): number {
  const candidates = [
    defaultLaneIdentity(repoRoot).lockFilePath,
    ...laneIdsForPool(poolSize).map(
      (id) => laneIdentity(repoRoot, id).lockFilePath,
    ),
  ];
  // Lanes outside the current pool still hold real runs (the pool may have shrunk since they started).
  try {
    for (const entry of fs.readdirSync(lockRootDir(repoRoot), {
      withFileTypes: true,
    })) {
      if (entry.isFile() && entry.name.endsWith('.lock')) {
        candidates.push(path.join(lockRootDir(repoRoot), entry.name));
      }
    }
  } catch {
    // No lock directory yet — the candidate list above is already complete.
  }

  let live = 0;
  for (const filePath of new Set(candidates)) {
    // Coordination locks (`_return-flow`, `_git-worktree`, `_remote-install`) are held for a phase,
    // not a run, so counting them would overstate how many runs are in flight.
    if (path.basename(filePath).startsWith('_') && !filePath.endsWith('_default.lock')) {
      continue;
    }
    const holder = readLockHolder(filePath);
    if (holder !== null && isProcessAlive(holder.pid)) {
      live += 1;
    }
  }
  return live;
}

/**
 * Whether a lane run should pull return-flow artifacts back into the local tree.
 *
 * `--return-flow` forces it on. Otherwise it follows whether this run is *alone*: return-flow mirrors
 * with `--delete`, so it describes exactly one branch's artifacts. One run at a time is the ordinary
 * case and pulling is correct there — switching it off unconditionally for lanes would silently
 * regress snapshot return the moment lanes became the default. Several runs at once is the case that
 * cannot be made coherent, because each would overwrite the last.
 *
 * Decided once, before the push, so the push exclusions, the remote refresh and the pull all agree.
 */
export function shouldPullReturnFlow(options: {
  explicitOptIn: boolean;
  runsInFlight: number;
}): boolean {
  return options.explicitOptIn || options.runsInFlight <= 1;
}

function returnFlowLockPath(repoRoot: string): string {
  return path.join(lockRootDir(repoRoot), '_return-flow.lock');
}

/**
 * Claim a lane for this run and hold its lock for the run's lifetime.
 *
 * The lock is what makes concurrency safe rather than merely possible: without it two runs can still
 * choose the same lane, sync different trees into one remote directory, and each report a result
 * derived from the other's files. Holding it converts that into an error before anything syncs.
 *
 * - `laneArg` unset — the default workspace. Contention is an error naming the holder, because the
 *   caller asked for *this* workspace specifically.
 * - `laneArg === 'auto'` — the first lane in the pool whose lock is free. Contention is expected and
 *   simply advances to the next candidate; running out means the pool is smaller than the fan-out.
 * - an explicit lane id — that lane, or an error naming the holder.
 */
export function acquireLaneForRun(options: {
  repoRoot: string;
  laneArg: string | undefined;
  poolSize: number;
}): AcquiredLane {
  const { repoRoot, laneArg, poolSize } = options;

  if (laneArg === undefined) {
    const lane = defaultLaneIdentity(repoRoot);
    const lock = tryAcquireLock(lane.lockFilePath);
    if (lock === null) {
      throw new Error(
        `Another bica run already owns this checkout's remote workspace: ${describeLockHolder(lane.lockFilePath)}\n` +
          'Concurrent runs need their own workspace — start them with `bica run --lane auto ...`.',
      );
    }
    return { lane, lock };
  }

  if (laneArg === AUTO_LANE) {
    for (const id of laneIdsForPool(poolSize)) {
      const lane = laneIdentity(repoRoot, id);
      const lock = tryAcquireLock(lane.lockFilePath);
      if (lock !== null) {
        return { lane, lock };
      }
    }
    throw new Error(
      `All ${String(poolSize)} lanes are busy. Wait for a run to finish, or raise the pool size ` +
        '(`parallel.lanes` in bica.yml, `BICA_LANES`, or `--lanes N`).',
    );
  }

  const lane = laneIdentity(repoRoot, laneArg);
  const lock = tryAcquireLock(lane.lockFilePath);
  if (lock === null) {
    throw new Error(
      `Lane "${laneArg}" is already in use: ${describeLockHolder(lane.lockFilePath)}\n` +
        'Pick another lane, or use `--lane auto` to take the first free one.',
    );
  }
  return { lane, lock };
}

/**
 * Run a command in a lane against a pinned copy of the working tree: push once, run, optionally pull.
 * Returns the remote command's exit code, or a non-zero bica-side code when the push failed.
 *
 * Return-flow follows {@link shouldPullReturnFlow}: on when this run is alone (the ordinary case),
 * off when other runs are in flight, forced on by `--return-flow`. When it runs, the pull is
 * serialised so two lanes cannot rsync into the same tree at once.
 */
export async function runPinnedLaneRun(options: {
  prep: PrepareResult;
  remoteArgv: string[];
  autoYes: boolean;
  pmOverride: string | undefined;
  confirm: ConfirmFn;
  /** `--return-flow` was passed. Absent, the decision follows whether this run is alone. */
  returnFlowOptIn: boolean;
  /** Lane pool size, for counting how many runs are in flight. */
  poolSize: number;
  /** `--ref`: pin the lane to this git ref's committed content instead of the live working tree. */
  ref: string | undefined;
  chrome: (text: string) => void;
}): Promise<number> {
  const { prep } = options;
  const runsInFlight = countRunsInFlight(prep.repoRoot, options.poolSize);
  const returnFlow = shouldPullReturnFlow({
    explicitOptIn: options.returnFlowOptIn,
    runsInFlight,
  });
  const resolvedOptions = { ...options, returnFlow, runsInFlight };
  if (options.ref === undefined) {
    return runPinnedLaneRunFrom(resolvedOptions, undefined, undefined);
  }
  const resolved = resolveGitRef(prep.repoRoot, options.ref);
  return withPinnedWorktree(
    { repoRoot: prep.repoRoot, laneLabel: prep.lane.label, resolved },
    (worktreePath) => runPinnedLaneRunFrom(resolvedOptions, worktreePath, resolved),
  );
}

async function runPinnedLaneRunFrom(
  options: {
    prep: PrepareResult;
    remoteArgv: string[];
    autoYes: boolean;
    pmOverride: string | undefined;
    confirm: ConfirmFn;
    returnFlow: boolean;
    runsInFlight: number;
    chrome: (text: string) => void;
  },
  sourceDir: string | undefined,
  resolvedRef: ResolvedGitRef | undefined,
): Promise<number> {
  const { prep, chrome } = options;
  const lane = prep.lane;

  const dirReady = await ensureRemoteWorkspaceDirectory(
    prep.config.sshHost,
    prep.config.remoteWorkspacePath,
    options.autoYes,
    options.confirm,
  );
  if (dirReady.code !== 0) {
    return dirReady.code;
  }

  // The lease is taken here, *before* the rsync, because the rsync is what destroys another run's
  // work. Claiming after it would let this run overwrite a live run's files and only then discover the
  // conflict -- which is exactly what happened: the victim exited 97 and the thief exited 0.
  const owner = describeSelfAsOwner(
    resolvedRef === undefined
      ? `${lane.label}-${String(process.pid)}`
      : `${shortOid(resolvedRef.treeOid)}-${String(process.pid)}`,
  );
  let claim = remoteAcquireClaim(
    prep.config.sshHost,
    prep.config.remoteWorkspacePath,
    owner,
  );
  if (!claim.ok && claimIsStale(claim.heldBy, isProcessAlive)) {
    // The holder is gone. Break exactly the claim we inspected and try once more.
    if (claim.heldBy !== null) {
      remoteBreakClaim(prep.config.sshHost, prep.config.remoteWorkspacePath, claim.heldBy);
    }
    claim = remoteAcquireClaim(
      prep.config.sshHost,
      prep.config.remoteWorkspacePath,
      owner,
    );
  }
  if (!claim.ok) {
    process.stderr.write(
      `${warn('[bica]')} ${prep.remoteSyncUrl} is in use by ${describeClaim(claim)}. ` +
        'Refusing to run: syncing into it would overwrite that run\'s files, and neither result would ' +
        'then be trustworthy. Use a different lane, or wait for it to finish.\n',
    );
    return REMOTE_CONTENT_MISMATCH_EXIT;
  }
  const claimExpr = claimPathExpr(prep.config.remoteWorkspacePath);
  // Released on every path below. A hard kill still strands it, but that is recoverable without a
  // clock: the claim names this machine and this pid, so the next run finds the owner gone and breaks it.
  const releaseClaim = (): void => {
    remoteReleaseClaim(prep.config.sshHost, prep.config.remoteWorkspacePath, owner);
  };
  try {
    return await runLeasedCommand();
  } finally {
    releaseClaim();
  }

  async function runLeasedCommand(): Promise<number> {
  const sourceLabel =
    resolvedRef === undefined
      ? 'working tree'
      : `${resolvedRef.requested} (${resolvedRef.sha.slice(0, 12)})`;

  // Printed unconditionally, not through `chrome`. Callers redirect to a log file, which makes stdout
  // a pipe and silences the decorative output — so anything only shown on a TTY is invisible to exactly
  // the audience that needs it. A session downstream of this had resorted to grepping the `pnpm` banner
  // for the workspace path to satisfy itself a run was its own; this states it outright, for any
  // command, and pairs it with the content name so the run can be checked against what was intended.
  process.stderr.write(
    `${dim('[bica]')} lane ${lane.label}  workspace ${prep.remoteSyncUrl}  content ${sourceLabel}  run ${owner.runId}\n`,
  );
  chrome(
    `${dim(`[bica:${lane.label}]`)} ${dim(`Pinning ${sourceLabel} to`)} ${syncRemoteTarget(prep.remoteSyncUrl)}\n`,
  );
  const push = pushPinnedWorkingTree({
    repoRoot: prep.repoRoot,
    sourceDir,
    remoteSyncUrl: prep.remoteSyncUrl,
    syncIgnorePaths: prep.syncIgnorePaths,
    returnFlowPaths: options.returnFlow ? prep.returnFlowPaths : [],
    knownTreeOid: resolvedRef?.treeOid,
  });
  if (!push.ok) {
    if (push.torn === true) {
      process.stderr.write(
        `${warn('[bica]')} The working tree changed while syncing lane ${lane.label}: ` +
          `${shortOid(push.treeOidBefore ?? '?')} → ${shortOid(push.treeOidAfter ?? '?')}. ` +
          'Refusing to run, because what landed on the remote is a mix of both and a result from it ' +
          'would look exactly like a real verification.\n' +
          'Let local git settle and re-run, or pin to a commit with `--ref <branch>`, which reads the ' +
          'content out of the object database and ignores the working tree entirely.\n',
      );
    }
    return 1;
  }
  const runId = owner.runId;

  // The tree (and so `mise.toml`) is on the remote now, which is what `mise trust` needs to see.
  if (dirReady.created) {
    remoteTrustMiseWorkspace(prep.config.sshHost, prep.config.remoteWorkspacePath);
  }

  if (resolveBicaPluginConfig(prep.repoRoot).syncGit) {
    chrome(`${dim(`[bica:${lane.label}]`)} ${dim('Syncing .git → remote (git.sync)…')}\n`);
    pushGitToRemote(prep);
    if (resolvedRef !== undefined) {
      // The pushed .git carries the *local* checkout's HEAD; repoint it at what this lane runs.
      setRemoteHeadForPin({
        sshHost: prep.config.sshHost,
        remoteWorkspacePath: prep.config.remoteWorkspacePath,
        resolved: resolvedRef,
      });
    }
  }

  if (options.returnFlow && prep.returnFlowPaths.length > 0) {
    chrome(
      `${dim(`[bica:${lane.label}]`)} ${dim('Refreshing return-flow artifacts on remote…')}\n`,
    );
    pushReturnFlowToRemote(prep);
  }

  const code = await runRemoteCommandWithPmHooks({
    prep,
    remoteArgv: options.remoteArgv,
    autoYes: options.autoYes,
    pmOverride: options.pmOverride,
    confirm: options.confirm,
    assertRunId: runId,
    claimPathExpr: claimExpr,
  });

  // 255 is ambiguous: ssh uses it for its own transport failures, and a command may legitimately exit
  // 255. The recorded exit code settles which it was, as a fact rather than a guess.
  if (code === 255 && runId !== undefined) {
    const recorded = remoteReadRecordedExit(prep.config.sshHost, claimExpr, runId);
    if (recorded.mine && recorded.exitCode === 255) {
      process.stderr.write(
        `${warn('[bica]')} ${dim('The remote command really did exit 255 — confirmed from the exit code it recorded — so this is a command failure, not a dropped connection.')}\n`,
      );
    } else {
      process.stderr.write(
        `${warn('[bica]')} ${dim("The remote command never recorded an exit code, so ssh's 255 was a dropped connection rather than a command failure. Re-run; see BICA_SSH_OPTS for keepalive tuning.")}\n`,
      );
    }
  }

  if (code === REMOTE_CONTENT_MISMATCH_EXIT) {
    // Be precise about what happened: the command *did* run, and may well have printed output above.
    // What is being thrown away is its result, because another run replaced the workspace contents
    // part-way through, so that output describes some mixture of two content states.
    process.stderr.write(
      `${warn('[bica]')} Another run replaced lane ${lane.label}'s contents while this command was ` +
        'executing. The command ran and its output is above, but the result is discarded: it describes ' +
        'a mixture of two content states, not the tree this run claimed to verify. Nothing here is a ' +
        'verdict on your code — re-run it.\n' +
        "The lane lock exists to prevent this, so it is worth reporting; the point of the check is that " +
        'a lock failure costs you a re-run rather than a wrong answer.\n',
    );
  }

  if (options.returnFlow && prep.returnFlowPaths.length > 0) {
    // Serialised: concurrent pulls with `--delete` into one tree would fight over the same files.
    const rfLock = await acquireLockWithWait(returnFlowLockPath(prep.repoRoot), {
      timeoutMs: RETURN_FLOW_LOCK_TIMEOUT_MS,
    });
    if (rfLock === null) {
      process.stderr.write(
        `${warn('[bica]')} ${dim('Timed out waiting for another lane to finish its return-flow pull; skipping this one.')}\n`,
      );
    } else {
      try {
        chrome(
          `${dim(`[bica:${lane.label}]`)} ${dim(`Pulling return-flow files (${prep.returnFlowPaths.join(', ')})…`)}\n`,
        );
        pullReturnFlow(prep);
      } finally {
        rfLock.release();
      }
    }
  } else if (prep.returnFlowPaths.length > 0) {
    chrome(
      `${dim(`[bica:${lane.label}]`)} ${dim(`Return-flow skipped: ${String(options.runsInFlight)} runs in flight would each overwrite the last (pass --return-flow to force).`)}\n`,
    );
  }

  return code;
  }
}
