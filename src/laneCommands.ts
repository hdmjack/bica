import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveBicaPluginConfig } from './bicaWorkspaceConfig';
import { describeLockHolder, tryAcquireLock } from './lib/fileLock';
import {
  isLaneRemotePath,
  laneIdentity,
  laneIdsForPool,
  lanesRootDir,
  laneRemoteWorkspacePath,
} from './lib/lanes';
import { pushPinnedWorkingTree } from './lib/pinnedSync';
import {
  remoteRemoveLaneDirectory,
  remoteTrustMiseWorkspace,
  runRemoteCommand,
} from './lib/runRemote';
import {
  ensureRemoteWorkspaceDirectory,
  packageManagerStateContext,
} from './lib/runWithPackageManagerPlugins';
import { resolveActivePackageManagerPlugins } from './resolveActivePlugins';
import { bold, dim, ok, warn } from './terminalStyle';
import {
  getRepoRoot,
  loadRemoteEnvConfig,
  prepareSyncProjectFile,
} from './syncProject';
import type { ConfirmFn } from './plugins/types';

/** Freshness of a lane's remote `node_modules`, judged by the recorded install fingerprint. */
type LaneWarmth = 'cold' | 'stale' | 'warm' | 'n/a';

function laneWarmth(repoRoot: string, laneId: string): LaneWarmth {
  const lane = laneIdentity(repoRoot, laneId);
  const resolved = resolveBicaPluginConfig(repoRoot);
  const plugins = resolveActivePackageManagerPlugins(repoRoot, resolved);
  const ctx = packageManagerStateContext(repoRoot, lane);
  let sawFingerprintable = false;
  for (const plugin of plugins) {
    const local = plugin.readLocalFingerprint(repoRoot);
    if (local === null) {
      continue;
    }
    sawFingerprintable = true;
    const stored = plugin.readStoredHash(ctx);
    if (stored === null) {
      return 'cold';
    }
    if (stored !== local) {
      return 'stale';
    }
  }
  return sawFingerprintable ? 'warm' : 'n/a';
}

function describeWarmth(w: LaneWarmth): string {
  switch (w) {
    case 'warm':
      return ok('warm');
    case 'stale':
      return warn('stale lockfile');
    case 'cold':
      return dim('cold (needs install)');
    case 'n/a':
      return dim('no package manager');
  }
}

/** Lane ids in the pool, plus any lane that still has local state from a larger past pool. */
function knownLaneIds(repoRoot: string, poolSize: number): string[] {
  const ids = new Set(laneIdsForPool(poolSize));
  try {
    for (const entry of fs.readdirSync(lanesRootDir(repoRoot), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) {
        ids.add(entry.name);
      }
    }
  } catch {
    // No lane state yet — the pool ids are the whole story.
  }
  return Array.from(ids).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

export function cmdLanesList(poolOverride: number | undefined): void {
  const repoRoot = getRepoRoot();
  const resolved = resolveBicaPluginConfig(repoRoot);
  const poolSize = poolOverride ?? resolved.lanePoolSize;
  const base = loadRemoteEnvConfig(repoRoot);

  console.log(`pool size: ${String(poolSize)}`);
  console.log(`base workspace: ${base.sshHost}:${base.remoteWorkspacePath}\n`);

  for (const id of knownLaneIds(repoRoot, poolSize)) {
    const lane = laneIdentity(repoRoot, id);
    const remotePath = laneRemoteWorkspacePath(base.remoteWorkspacePath, lane);
    const inPool = laneIdsForPool(poolSize).includes(id);
    // Probing by taking the lock and immediately releasing it is the only honest read: a lock file
    // whose holder has died is free, and only acquisition knows that.
    const probe = tryAcquireLock(lane.lockFilePath);
    const busy = probe === null;
    const holder = busy ? describeLockHolder(lane.lockFilePath) : null;
    probe?.release();

    const state = busy ? warn('busy') : dim('free');
    console.log(
      `  ${bold(id.padEnd(8))} ${state}  ${describeWarmth(laneWarmth(repoRoot, id))}${inPool ? '' : dim('  (outside pool)')}`,
    );
    console.log(`           ${dim(`${base.sshHost}:${remotePath}`)}`);
    if (holder !== null) {
      console.log(`           ${dim(`held by ${holder}`)}`);
    }
  }
}

/**
 * Warm the pool: sync the current tree into every lane and install its dependencies.
 *
 * Sequential on purpose. The pushes could overlap, but the installs are the expensive part and
 * several `pnpm install` runs at once contend on the host's single content-addressed store; a warm
 * store makes each subsequent lane cheap anyway. This is a one-time cost per lane, not per run —
 * which is what makes lanes worth having.
 */
export async function cmdLanesPrepare(options: {
  poolOverride: number | undefined;
  autoYes: boolean;
  confirm: ConfirmFn;
}): Promise<number> {
  const repoRoot = getRepoRoot();
  const resolved = resolveBicaPluginConfig(repoRoot);
  const poolSize = options.poolOverride ?? resolved.lanePoolSize;
  const plugins = resolveActivePackageManagerPlugins(repoRoot, resolved);

  let failures = 0;
  for (const id of laneIdsForPool(poolSize)) {
    const lane = laneIdentity(repoRoot, id);
    const lock = tryAcquireLock(lane.lockFilePath);
    if (lock === null) {
      process.stderr.write(
        `${warn('[bica]')} ${dim(`Lane ${id} is busy (${describeLockHolder(lane.lockFilePath)}); skipping.`)}\n`,
      );
      continue;
    }
    try {
      const prep = prepareSyncProjectFile({ verbose: false, lane });
      process.stderr.write(
        `${dim(`[bica:${id}]`)} preparing ${prep.remoteSyncUrl}\n`,
      );
      const dirReady = await ensureRemoteWorkspaceDirectory(
        prep.config.sshHost,
        prep.config.remoteWorkspacePath,
        options.autoYes,
        options.confirm,
      );
      if (dirReady.code !== 0) {
        failures += 1;
        continue;
      }
      const push = pushPinnedWorkingTree({
        repoRoot,
            remoteSyncUrl: prep.remoteSyncUrl,
        syncIgnorePaths: prep.syncIgnorePaths,
        returnFlowPaths: [],
      });
      if (!push.ok) {
        failures += 1;
        continue;
      }
      if (dirReady.created) {
        remoteTrustMiseWorkspace(prep.config.sshHost, prep.config.remoteWorkspacePath);
      }
      const ctx = packageManagerStateContext(repoRoot, lane);
      for (const plugin of plugins) {
        const local = plugin.readLocalFingerprint(repoRoot);
        if (local === null || plugin.readStoredHash(ctx) === local) {
          continue;
        }
        process.stderr.write(
          `${dim(`[bica:${id}]`)} ${plugin.remoteInstallCommand}\n`,
        );
        const code = runRemoteCommand(
          prep.config.sshHost,
          prep.config.remoteWorkspacePath,
          plugin.remoteInstallCommand,
          repoRoot,
        );
        if (code !== 0) {
          process.stderr.write(
            `${warn('[bica]')} ${dim(`Lane ${id}: ${plugin.remoteInstallCommand} exited ${String(code)}.`)}\n`,
          );
          failures += 1;
          break;
        }
        plugin.writeStoredHash(ctx, local);
      }
    } finally {
      lock.release();
    }
  }

  if (failures > 0) {
    process.stderr.write(
      `${warn('[bica]')} ${String(failures)} lane(s) failed to prepare.\n`,
    );
    return 1;
  }
  process.stderr.write(`${ok('[bica]')} Lane pool ready.\n`);
  return 0;
}

/** Remove lane workspaces from the remote host and forget their local state. */
export async function cmdLanesClean(options: {
  poolOverride: number | undefined;
  autoYes: boolean;
  confirm: ConfirmFn;
}): Promise<number> {
  const repoRoot = getRepoRoot();
  const resolved = resolveBicaPluginConfig(repoRoot);
  const poolSize = options.poolOverride ?? resolved.lanePoolSize;
  const base = loadRemoteEnvConfig(repoRoot);

  const targets: { id: string; remotePath: string }[] = [];
  for (const id of knownLaneIds(repoRoot, poolSize)) {
    const lane = laneIdentity(repoRoot, id);
    const remotePath = laneRemoteWorkspacePath(base.remoteWorkspacePath, lane);
    // Belt and braces: only a path that is provably base + `-lane-<id>` may be removed.
    if (!isLaneRemotePath(base.remoteWorkspacePath, remotePath)) {
      continue;
    }
    targets.push({ id, remotePath });
  }

  if (targets.length === 0) {
    process.stderr.write(`${dim('[bica]')} ${dim('No lane workspaces to remove.')}\n`);
    return 0;
  }

  const listing = targets
    .map((t) => `  ${base.sshHost}:${t.remotePath}`)
    .join('\n');
  const proceed =
    options.autoYes ||
    (await options.confirm(
      `${warn('[bica]')} Recursively delete these remote lane workspaces (including their node_modules)?\n${listing}\n`,
      false,
    ));
  if (!proceed) {
    // Say so explicitly. `run.assumeYes` does not reach this confirmation, so a user who has it on
    // would otherwise see a silent no-op and reasonably conclude the command was broken.
    process.stderr.write(
      `${dim('[bica]')} ${dim('Nothing removed. `bica lanes clean` needs an explicit -y/--yes; run.assumeYes does not authorise deleting remote directories.')}\n`,
    );
    return 0;
  }

  let failures = 0;
  for (const t of targets) {
    const lane = laneIdentity(repoRoot, t.id);
    const lock = tryAcquireLock(lane.lockFilePath);
    if (lock === null) {
      process.stderr.write(
        `${warn('[bica]')} ${dim(`Lane ${t.id} is busy; not removing it.`)}\n`,
      );
      failures += 1;
      continue;
    }
    try {
      const result = remoteRemoveLaneDirectory(base.sshHost, t.remotePath);
      if (!result.ok) {
        process.stderr.write(
          `${warn('[bica]')} ${dim(`Lane ${t.id}: ${result.reason ?? 'removal failed'}`)}\n`,
        );
        failures += 1;
        continue;
      }
      fs.rmSync(path.join(lanesRootDir(repoRoot), t.id), {
        recursive: true,
        force: true,
      });
      process.stderr.write(`${dim(`[bica:${t.id}]`)} ${dim('removed')}\n`);
    } finally {
      lock.release();
    }
  }
  return failures > 0 ? 1 : 0;
}
