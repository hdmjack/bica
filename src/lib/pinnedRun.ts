import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

import { resolveBicaPluginConfig } from '../bicaWorkspaceConfig';
import { dim, syncRemoteTarget, warn } from '../terminalStyle';
import {
  acquireLockWithWait,
  describeLockHolder,
  isProcessAlive,
} from './fileLock';
import { lockRootDir } from './workspacePaths';
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
import type { PrepareResult } from '../syncProject';

/** How long a queued return-flow pull waits for another run's pull to finish. */
const RETURN_FLOW_LOCK_TIMEOUT_MS = 120_000;


function returnFlowLockPath(repoRoot: string): string {
  return path.join(lockRootDir(repoRoot), '_return-flow.lock');
}

/** The workspace lease this run holds, and how to give it back. */
export interface AcquiredWorkspace {
  owner: ClaimOwner;
  release: () => void;
}

/** Injectable so acquisition can be tested without an SSH host. */
export interface LeaseOps {
  acquire: (remoteWorkspacePath: string, owner: ClaimOwner) => ClaimResult;
  break: (remoteWorkspacePath: string, held: ClaimOwner) => void;
  release: (remoteWorkspacePath: string, owner: ClaimOwner) => void;
}

/**
 * Exit code for "refused to start: the workspace is in use, nothing ran".
 *
 * Distinct from 97, which means "ran, then found the workspace had been taken, so the result was
 * discarded". Callers are frequently agents reading exit codes and the two want opposite reactions:
 * 98 says wait or use another checkout, 97 says re-run this one.
 */
export const WORKSPACE_IN_USE_EXIT = 98;

/** Thrown when the workspace is already leased. Carries the exit code so callers need not parse text. */
export class WorkspaceInUseError extends Error {
  readonly exitCode = WORKSPACE_IN_USE_EXIT;
}

/**
 * Lease the remote workspace for the lifetime of this run.
 *
 * The lease lives on the remote, not in the checkout, because that is where the contended thing is.
 * Several clones on one machine can resolve to the same remote directory, so a lock under
 * `<checkout>/.bica` cannot see the run that would actually collide with you — which is exactly how
 * two clones once ran each other's commands and both reported success.
 *
 * A lease whose owner no longer exists is broken and retried once, so a killed run costs the next one
 * a round-trip rather than the workspace.
 */
export function acquireWorkspace(options: {
  remoteWorkspacePath: string;
  runId: string;
  lease: LeaseOps;
}): AcquiredWorkspace {
  const { remoteWorkspacePath, lease } = options;
  const owner = describeSelfAsOwner(options.runId);
  let result = lease.acquire(remoteWorkspacePath, owner);
  if (!result.ok && claimIsStale(result.heldBy, isProcessAlive)) {
    if (result.heldBy !== null) {
      lease.break(remoteWorkspacePath, result.heldBy);
    }
    result = lease.acquire(remoteWorkspacePath, owner);
  }
  if (!result.ok) {
    throw new WorkspaceInUseError(
      `This remote workspace is in use by ${describeClaim(result)}.\n` +
        'Syncing into it would overwrite that run\'s files, so neither result would be trustworthy. ' +
        'Wait for it to finish, or run from a checkout with a different remotePath.',
    );
  }
  return {
    owner,
    release: () => {
      lease.release(remoteWorkspacePath, owner);
    },
  };
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
 * a full install per run. Naming the files lets the user add them to `sync.ignore.paths` once,
 * which fixes it properly.
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
 * Run a command against a pinned copy of the content: push once, run, optionally pull.
 * Returns the remote command's exit code, or a non-zero bica-side code when the push failed.
 *
 * Return-flow happens only with `--return-flow`. It mirrors remote artifacts into the local tree with
 * `--delete`, so it describes exactly one content state; the pull is serialised even when asked for.
 */
export async function runPinned(options: {
  prep: PrepareResult;
  remoteArgv: string[];
  /** The user's commands, for package-manager plugin matching. See runRemoteCommandWithPmHooks. */
  matchArgvs?: string[][];
  pmOverride: string | undefined;
  /** `--return-flow` was passed. Without it a pinned run does not pull artifacts back. */
  returnFlowOptIn: boolean;
  /** Lease taken before anything was synced; this run already owns the workspace. */
  owner: ClaimOwner;
  chrome: (text: string) => void;
}): Promise<number> {
  const { prep, chrome } = options;
  // Return-flow is explicit opt-in, full stop. It used to be guessed by counting runs in flight, which
  // was racy by its own admission -- two runs starting together could both conclude they were alone --
  // and a guess that is usually right is the worst kind here, because the pull mirrors with `--delete`.
  const returnFlow = options.returnFlowOptIn;

  const dirReady = await ensureRemoteWorkspaceDirectory(
    prep.config.sshHost,
    prep.config.remoteWorkspacePath,
  );
  if (dirReady.code !== 0) {
    return dirReady.code;
  }

  // The lease was taken during workspace selection, before anything was synced, and is released by the
  // caller. By the time we get here the workspace is ours.
  const claimExpr = claimPathExpr(prep.config.remoteWorkspacePath);

  // Printed unconditionally, not through `chrome`. Callers redirect to a log file, which makes stdout
  // a pipe and silences the decorative output — so anything only shown on a TTY is invisible to exactly
  // the audience that needs it. A session downstream of this had resorted to grepping the `pnpm` banner
  // for the workspace path to satisfy itself a run was its own; this states it outright, for any
  // command, so a caller can confirm where a run landed without relying on the command announcing it.
  process.stderr.write(
    `${dim('[bica]')} workspace ${prep.remoteSyncUrl}  run ${options.owner.runId}\n`,
  );
  chrome(
    `${dim('[bica]')} ${dim('Pinning working tree to')} ${syncRemoteTarget(prep.remoteSyncUrl)}\n`,
  );
  const push = pushPinnedWorkingTree({
    repoRoot: prep.repoRoot,
    remoteSyncUrl: prep.remoteSyncUrl,
    syncIgnorePaths: prep.syncIgnorePaths,
    returnFlowPaths: returnFlow ? prep.returnFlowPaths : [],
  });
  if (!push.ok) {
    if (push.torn === true) {
      process.stderr.write(
        `${warn('[bica]')} The working tree changed while syncing: ` +
          `${shortOid(push.treeOidBefore ?? '?')} → ${shortOid(push.treeOidAfter ?? '?')}. ` +
          'Refusing to run, because what landed on the remote is a mix of both and a result from it ' +
          'would look exactly like a real verification.\n' +
          'Let local git settle -- finish the checkout or rebase -- and run it again.\n',
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
      // let two separate bugs in it go unnoticed. It fires once per workspace creation, so it is not noise.
      process.stderr.write(
        `${dim('[bica]')} ${dim('Trusted this new workspace with mise.')}\n`,
      );
    }
  }

  if (resolveBicaPluginConfig(prep.repoRoot).syncGit) {
    chrome(`${dim('[bica]')} ${dim('Syncing .git → remote (git.sync)…')}\n`);
    pushGitToRemote(prep);
  }

  if (returnFlow && prep.returnFlowPaths.length > 0) {
    chrome(
      `${dim('[bica]')} ${dim('Refreshing return-flow artifacts on remote…')}\n`,
    );
    pushReturnFlowToRemote(prep);
  }

  const code = await runRemoteCommandWithPmHooks({
    prep,
    remoteArgv: options.remoteArgv,
    matchArgvs: options.matchArgvs,
    generatedPaths: prep.generatedPaths,
    generatedCommand: prep.generatedCommand,
    pmOverride: options.pmOverride,
    assertRunId: runId,
    claimPathExpr: claimExpr,
  });

  // 255 is ambiguous: ssh uses it for its own transport failures, and a command may legitimately exit
  // 255. The recorded exit code settles which it was, as a fact rather than a guess.
  if (code === 255) {
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
      `${warn('[bica]')} Another run replaced this workspace's contents while the command was ` +
        'executing. The command ran and its output is above, but the result is discarded: it describes ' +
        'a mixture of two content states, not the tree this run claimed to verify. Nothing here is a ' +
        'verdict on your code — re-run it.\n' +
        'The lease exists to prevent this, so it is worth reporting; the point of the check is that a\n' +
        'lease failure costs you a re-run rather than a wrong answer.\n',
    );
  }

  if (returnFlow && prep.returnFlowPaths.length > 0) {
    // Serialised: concurrent pulls with `--delete` into one tree would fight over the same files.
    const rfLock = await acquireLockWithWait(returnFlowLockPath(prep.repoRoot), {
      timeoutMs: RETURN_FLOW_LOCK_TIMEOUT_MS,
    });
    if (rfLock === null) {
      process.stderr.write(
        `${warn('[bica]')} ${dim(`Timed out waiting for ${describeLockHolder(returnFlowLockPath(prep.repoRoot))} to finish its return-flow pull; skipping this one.`)}\n`,
      );
    } else {
      try {
        chrome(
          `${dim('[bica]')} ${dim(`Pulling return-flow files (${prep.returnFlowPaths.join(', ')})…`)}\n`,
        );
        pullReturnFlow(prep);
      } finally {
        rfLock.release();
      }
    }
  } else if (prep.returnFlowPaths.length > 0) {
    chrome(
      `${dim('[bica]')} ${dim('Return-flow is off for pinned runs; pass --return-flow to pull artifacts back.')}\n`,
    );
  }

  return code;
}
