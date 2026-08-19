import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

import { resolveBicaPluginConfig } from '../bicaWorkspaceConfig';
import { dim, syncRemoteTarget, warn } from '../terminalStyle';
import { acquireLockWithWait, isProcessAlive } from './fileLock';
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
  laneRemoteWorkspacePath,
  lockRootDir,
} from './lanes';
import { shortOid } from './contentIdentity';
import {
  claimIsStale,
  claimPathExpr,
  describeClaim,
  describeSelfAsOwner,
} from './remoteClaim';
import type { ClaimOwner, ClaimResult } from './remoteClaim';
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
import type { ResolvedGitRef } from './gitPin';
import type { LaneIdentity } from './lanes';
import type { ConfirmFn } from '../plugins/types';
import type { PrepareResult } from '../syncProject';

/** How long a queued return-flow pull waits for the lane ahead of it to finish its pull. */
const RETURN_FLOW_LOCK_TIMEOUT_MS = 120_000;


function returnFlowLockPath(repoRoot: string): string {
  return path.join(lockRootDir(repoRoot), '_return-flow.lock');
}

/**
 * Exit code for "refused to start: the workspace is in use, nothing ran".
 *
 * Distinct from 97, which means "ran, then found the workspace had been taken, so the result was
 * discarded". Callers are frequently agents reading exit codes and the two want different reactions:
 * 98 says try another lane or wait, 97 says re-run this one. It also gives the verification harness
 * something stable to assert on -- it previously grepped the refusal text, and silently stopped
 * matching the moment that wording changed.
 */
export const LANE_IN_USE_EXIT = 98;

/** Thrown when every candidate workspace is leased. Carries the exit code so callers need not parse. */
export class LaneInUseError extends Error {
  readonly exitCode = LANE_IN_USE_EXIT;
}

/** How a lane was obtained, and how to give it back. */
export interface AcquiredLane {
  lane: LaneIdentity;
  owner: ClaimOwner;
  release: () => void;
}

/** Injectable so selection can be tested without an SSH host. */
export interface LeaseOps {
  acquire: (remoteWorkspacePath: string, owner: ClaimOwner) => ClaimResult;
  break: (remoteWorkspacePath: string, held: ClaimOwner) => void;
  release: (remoteWorkspacePath: string, owner: ClaimOwner) => void;
}

/**
 * Claim a lane for this run by leasing its remote workspace.
 *
 * Selection used to consult a lock file under `<checkout>/.bica/locks`, which was wrong in two ways
 * at once. It could not see a run from a sibling clone — the case that actually bit, since the
 * contended resource is a directory on a shared host — and because each checkout counted lanes
 * independently, two clones would both pick lane 1 and the second would be *refused* rather than
 * advancing to lane 2. Leasing the workspace fixes both: `auto` walks the pool asking the resource
 * itself, and moves on when a lane is genuinely taken by anyone, from anywhere.
 *
 * A lease left by a process that no longer exists is broken and retried once, so a killed run costs
 * the next one a round-trip rather than the lane.
 */
export function acquireLaneForRun(options: {
  repoRoot: string;
  /** Base remote workspace path, before any lane suffix. */
  baseRemotePath: string;
  laneArg: string | undefined;
  poolSize: number;
  runIdFor: (lane: LaneIdentity) => string;
  lease: LeaseOps;
}): AcquiredLane {
  const { repoRoot, baseRemotePath, laneArg, poolSize, lease } = options;

  const tryLane = (lane: LaneIdentity): AcquiredLane | ClaimResult => {
    const remotePath = laneRemoteWorkspacePath(baseRemotePath, lane);
    const owner = describeSelfAsOwner(options.runIdFor(lane));
    let result = lease.acquire(remotePath, owner);
    if (!result.ok && claimIsStale(result.heldBy, isProcessAlive)) {
      if (result.heldBy !== null) {
        lease.break(remotePath, result.heldBy);
      }
      result = lease.acquire(remotePath, owner);
    }
    if (!result.ok) {
      return result;
    }
    return {
      lane,
      owner,
      release: () => {
        lease.release(remotePath, owner);
      },
    };
  };

  if (laneArg === AUTO_LANE) {
    const refusals: string[] = [];
    for (const id of laneIdsForPool(poolSize)) {
      const got = tryLane(laneIdentity(repoRoot, id));
      if ('lane' in got) {
        return got;
      }
      refusals.push(`  lane ${id}: ${describeClaim(got)}`);
    }
    throw new LaneInUseError(
      `All ${String(poolSize)} lanes are in use:\n${refusals.join('\n')}\n` +
        'Wait for one to finish, or raise the pool size (`parallel.lanes` in bica.yml, `BICA_LANES`, ' +
        'or `--lanes N`). Lanes are shared across every checkout pointing at the same remote host.',
    );
  }

  const lane =
    laneArg === undefined
      ? defaultLaneIdentity(repoRoot)
      : laneIdentity(repoRoot, laneArg);
  const got = tryLane(lane);
  if ('lane' in got) {
    return got;
  }
  const which = lane.isDefault
    ? "this checkout's remote workspace"
    : `Lane "${lane.label}"`;
  throw new LaneInUseError(
    `${which} is in use by ${describeClaim(got)}.\n` +
      'Syncing into it would overwrite that run\'s files, so neither result would be trustworthy. ' +
      'Use `--lane auto` to take the first free lane, or wait for it to finish.',
  );
}

/**
 * Point out generated files the push removed from the remote.
 *
 * A mirror deletes anything the remote has and the source does not. When that something was produced
 * *on* the remote by an install step, the run then executes against files that existed a moment
 * earlier — one session lost an afternoon to 333 `TS2307`s from exactly this, because the icons its
 * postinstall generates are not in `sync.ignore.paths`.
 *
 * Only gitignored deletions are reported. A tracked file disappearing is ordinary branch difference
 * and saying so on every ref switch would be noise; a gitignored one is content no local copy will
 * restore, which is the shape of the problem.
 *
 * Deliberately a warning and not a repair. The obvious repair — invalidate the install fingerprint so
 * the next step regenerates them — would fire on nearly every `--ref` run, because a ref worktree
 * contains no gitignored files at all and so legitimately deletes every one of them. That would mean
 * a full install per run, which is the cost lanes exist to avoid. Naming the files lets the user add
 * them to `sync.ignore.paths` once, which fixes it properly.
 */
function warnAboutDeletedGeneratedFiles(
  repoRoot: string,
  deleted: readonly string[],
): void {
  if (deleted.length === 0) {
    return;
  }
  const check = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: repoRoot,
    input: deleted.join('\n'),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const ignored = (check.stdout ?? '').split('\n').filter((l) => l.trim() !== '');
  if (ignored.length === 0) {
    return;
  }
  const shown = ignored.slice(0, 5).map((p) => `    ${p}`).join('\n');
  const more = ignored.length > 5 ? `\n    …and ${String(ignored.length - 5)} more` : '';
  process.stderr.write(
    `${warn('[bica]')} ${dim(`The sync removed ${String(ignored.length)} gitignored file(s) from the remote workspace:`)}\n${shown}${more}\n` +
      `${dim('    These exist on the remote but not locally, so the mirror deletes them. If an install or')}\n` +
      `${dim('    build step produces them there, add them to sync.ignore.paths so each side keeps its own.')}\n`,
  );
}

/**
 * Run a command in a lane against a pinned copy of the working tree: push once, run, optionally pull.
 * Returns the remote command's exit code, or a non-zero bica-side code when the push failed.
 *
 * Return-flow happens only with `--return-flow`. It mirrors remote artifacts into the local tree with
 * `--delete`, so it describes exactly one content state; with more than one lane running there is no
 * coherent answer, and the pull is serialised even when asked for.
 */
export async function runPinnedLaneRun(options: {
  prep: PrepareResult;
  remoteArgv: string[];
  autoYes: boolean;
  pmOverride: string | undefined;
  confirm: ConfirmFn;
  /** `--return-flow` was passed. Absent, the decision follows whether this run is alone. */
  returnFlowOptIn: boolean;
  /** `--ref`: pin the lane to this git ref's committed content instead of the live working tree. */
  ref: string | undefined;
  /** Lease taken during lane selection; this run already owns the workspace. */
  owner: ClaimOwner;
  chrome: (text: string) => void;
}): Promise<number> {
  const { prep } = options;
  // Explicit opt-in, full stop. This used to guess by counting runs in flight, which was racy by its
  // own admission -- two runs starting together could both conclude they were alone -- and a guess that
  // is usually right is the worst kind here, because return-flow mirrors with `--delete`.
  const resolvedOptions = { ...options, returnFlow: options.returnFlowOptIn };
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
    owner: ClaimOwner;
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

  // The lease was taken during lane selection, before anything was synced, and is released by the
  // caller. By the time we get here the workspace is ours.
  const claimExpr = claimPathExpr(prep.config.remoteWorkspacePath);
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
    `${dim('[bica]')} lane ${lane.label}  workspace ${prep.remoteSyncUrl}  content ${sourceLabel}  run ${options.owner.runId}\n`,
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
  const runId = options.owner.runId;

  warnAboutDeletedGeneratedFiles(prep.repoRoot, push.deleted);

  // The tree (and so `mise.toml`) is on the remote now, which is what `mise trust` needs to see.
  if (dirReady.created) {
    const trusted = remoteTrustMiseWorkspace(
      prep.config.sshHost,
      prep.config.remoteWorkspacePath,
    );
    if (trusted) {
      // Unconditional, not via `chrome`: that helper hides itself when stdout is piped, and this step
      // spent its whole life invisible. Confirming it worked only on a TTY would repeat the fault that
      // let two separate bugs in it go unnoticed. It fires once per lane creation, so it is not noise.
      process.stderr.write(
        `${dim(`[bica:${lane.label}]`)} ${dim('Trusted this new workspace with mise.')}\n`,
      );
    }
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
      `${dim(`[bica:${lane.label}]`)} ${dim('Return-flow is off for lane runs; pass --return-flow to pull artifacts back.')}\n`,
    );
  }

  return code;
}
