import * as path from 'node:path';

import { resolveBicaPluginConfig } from '../bicaWorkspaceConfig';
import { argvToPosixShCommand } from '../remoteArgvToShellCommand';
import {
  matchingPackageManagerPlugins,
  resolveActivePackageManagerPlugins,
} from '../resolveActivePlugins';
import { acquireLockWithWait } from './fileLock';
import { lockRootDir } from './workspacePaths';
import {
  remoteMkdirWorkspace,
  remoteWorkspaceDirExists,
  runRemoteCommand,
} from './runRemote';
import type {
  PackageManagerPlugin,
  PackageManagerStateContext,
} from '../plugins/types';
import type { PrepareResult } from '../syncProject';

/** Where the record of what the remote workspace has installed lives. */
export function packageManagerStateContext(
  repoRoot: string,
): PackageManagerStateContext {
  return {
    repoRoot,
    stateDir: path.join(repoRoot, '.bica'),
  };
}

function isFingerprintOutOfSync(
  plugin: PackageManagerPlugin,
  ctx: PackageManagerStateContext,
): boolean {
  const local = plugin.readLocalFingerprint(ctx.repoRoot);
  const stored = plugin.readStoredHash(ctx);
  if (!stored || !local) {
    return false;
  }
  return stored !== local;
}

/** No `.bica/hashes/...` yet but we have a lockfile digest — typical first `bica run` after sync. */
function needsInitialRemoteInstall(
  plugin: PackageManagerPlugin,
  ctx: PackageManagerStateContext,
): boolean {
  const local = plugin.readLocalFingerprint(ctx.repoRoot);
  const stored = plugin.readStoredHash(ctx);
  return stored === null && local !== null;
}

/** A cold workspace's install can be slow, and every other workspace waiting on it is doing useful work. */
const REMOTE_INSTALL_LOCK_TIMEOUT_MS = 30 * 60_000;

/**
 * Serialise remote installs launched from this checkout.
 *
 * Installs from one checkout can overlap when a run is retried while another is still installing, and
 * they share one content-addressed store on the host.
 *
 * Known limit, stated plainly: this lock is local, so it cannot see an install launched from a sibling
 * clone with a different `remotePath` — which is the remaining real contention on that shared store.
 * pnpm's own store locking is what actually protects it; this only keeps one checkout tidy. The
 * remote workspace itself is guarded properly, by a lease that lives on the remote.
 *
 * On timeout the install proceeds anyway: refusing to run after half an hour of waiting would be
 * worse than a slow install.
 */
async function withRemoteInstallLock(
  repoRoot: string,
  install: () => number,
): Promise<number> {
  const lock = await acquireLockWithWait(
    path.join(lockRootDir(repoRoot), '_remote-install.lock'),
    { timeoutMs: REMOTE_INSTALL_LOCK_TIMEOUT_MS, pollMs: 1_000 },
  );
  if (lock === null) {
    process.stderr.write(
      '[bica] Still waiting on another run\'s remote install after 30m; installing anyway.\n',
    );
    return install();
  }
  try {
    return install();
  } finally {
    lock.release();
  }
}

/** Registry-auth hint only makes sense for package managers that authenticate to a registry. */
function maybeWriteCredentialsHint(plugin: PackageManagerPlugin): void {
  if (plugin.id === 'pnpm') {
    process.stderr.write(
      '\nHint: private registry 401? Run `bica credentials sync`.\n',
    );
  }
}

export interface RemoteWorkspaceReadiness {
  /** 0 when the workspace is usable; otherwise the failure code to return from the run. */
  code: number;
  /** True only when this call created the directory — the moment one-time workspace setup belongs. */
  created: boolean;
}

/**
 * Make sure the remote workspace directory exists, creating it if not.
 *
 * This used to ask first, which is why `--yes` was mandatory boilerplate on every invocation: the
 * prompt fires once per workspace, and an unattended run that meets it simply hangs. The thing it
 * guarded is `mkdir -p` on a path the user configured themselves in `.bica/local.yml`, so the worst
 * case it prevented was a typo creating one empty directory -- visible immediately, since the run then
 * installs from scratch, and removable with one command. Not worth a prompt on every new workspace.
 */
export async function ensureRemoteWorkspaceDirectory(
  sshHost: string,
  remoteWorkspacePath: string,
): Promise<RemoteWorkspaceReadiness> {
  if (remoteWorkspaceDirExists(sshHost, remoteWorkspacePath)) {
    return { code: 0, created: false };
  }
  process.stderr.write(
    `[bica] Creating remote workspace ${remoteWorkspacePath}\n`,
  );
  const mkdirCode = remoteMkdirWorkspace(sshHost, remoteWorkspacePath);
  if (mkdirCode !== 0) {
    process.stderr.write(
      `[bica] Could not create the remote directory (ssh exited ${mkdirCode}). Check permissions and the path.\n`,
    );
    return { code: mkdirCode, created: false };
  }
  return { code: 0, created: true };
}

/**
 * Runs the remote argv after optional package-manager preflight (install hash / reinstall prompt).
 */
export async function runRemoteCommandWithPmHooks(options: {
  prep: PrepareResult;
  /** What actually runs on the remote. For several commands this is an `sh -c` wrapper. */
  remoteArgv: string[];
  /**
   * The user's commands, for deciding which package-manager plugin applies.
   *
   * Separate from `remoteArgv` because a multi-command run wraps everything in `sh -c`, and plugins
   * match on argv[0]. Matching the wrapper matches nothing, so the install preflight silently did not
   * run: `bica run pnpm lint -- pnpm test` into a fresh workspace executed against no node_modules at
   * all. Defaults to `[remoteArgv]`, which is the single-command case.
   */
  matchArgvs?: string[][];
  pmOverride: string | undefined;
  /** Run id of the lease this run holds; the remote confirms it still holds it after the command. */
  assertRunId?: string;
  /** Shell expression for that lease's file on the remote. */
  claimPathExpr?: string;
}): Promise<number> {
  const { prep, remoteArgv, pmOverride } = options;
  const { repoRoot, config } = prep;
  const stateCtx = packageManagerStateContext(repoRoot);

  const dirReady = await ensureRemoteWorkspaceDirectory(
    config.sshHost,
    config.remoteWorkspacePath,
  );
  if (dirReady.code !== 0) {
    return dirReady.code;
  }

  const resolved = resolveBicaPluginConfig(repoRoot);
  const active = resolveActivePackageManagerPlugins(repoRoot, resolved);
  // Any of the user's commands may name a package manager; the first match decides.
  const candidates = options.matchArgvs ?? [remoteArgv];
  const matched = candidates.flatMap((argv) =>
    matchingPackageManagerPlugins(active, argv, pmOverride),
  );

  // A workspace we just created has no node_modules, whatever the local fingerprint claims. The
  // fingerprint records what a *remote* workspace has installed but lives locally, so anything that
  // removes the remote directory -- a manual rm, a wiped host, a recreated workspace -- leaves it
  // asserting an install that no longer exists. The next run would then skip the install and execute
  // against an empty workspace. Clearing it on creation keeps the claim tied to something real.
  if (dirReady.created) {
    for (const plugin of active) {
      plugin.clearStoredHash(stateCtx);
    }
  }

  if (matched.length > 1) {
    process.stderr.write(
      `[bica] Multiple package manager plugins match; use --pm <id>. Using "${matched[0].id}".\n`,
    );
  }

  const plugin = matched.at(0);
  const cmdStr = argvToPosixShCommand(remoteArgv);

  if (plugin) {
    const isInstall = candidates.some((argv) => plugin.isInstallArgv(argv));
    const initial = !isInstall && needsInitialRemoteInstall(plugin, stateCtx);
    const lockfileDrift =
      !isInstall && isFingerprintOutOfSync(plugin, stateCtx);

    if (initial || lockfileDrift) {
      const reason = initial
        ? `[bica] No remote install recorded yet (${plugin.id}); running ${plugin.remoteInstallCommand}.`
        : `[bica] Lockfile changed since last remote install (${plugin.id}); reinstalling.`;
      process.stderr.write(`${reason}\n`);
      const installCode = await withRemoteInstallLock(repoRoot, () =>
        runRemoteCommand(
          config.sshHost,
          config.remoteWorkspacePath,
          plugin.remoteInstallCommand,
          repoRoot,
          { assertRunId: options.assertRunId, claimPathExpr: options.claimPathExpr },
        ),
      );
      if (installCode !== 0) {
        maybeWriteCredentialsHint(plugin);
        return installCode;
      }
      const fp = plugin.readLocalFingerprint(repoRoot);
      if (fp !== null) {
        plugin.writeStoredHash(stateCtx, fp);
      }
    }
  }

  const code = runRemoteCommand(
    config.sshHost,
    config.remoteWorkspacePath,
    cmdStr,
    repoRoot,
    { assertRunId: options.assertRunId, claimPathExpr: options.claimPathExpr },
  );

  if (plugin) {
    const wasInstall = candidates.some((argv) => plugin.isInstallArgv(argv));
    if (wasInstall && code === 0) {
      const fp = plugin.readLocalFingerprint(repoRoot);
      if (fp !== null) {
        plugin.writeStoredHash(stateCtx, fp);
      }
    } else if (wasInstall && code !== 0) {
      maybeWriteCredentialsHint(plugin);
    }
  }

  return code;
}
