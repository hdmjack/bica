import { resolveBicaPluginConfig } from '../bicaWorkspaceConfig';
import { argvToPosixShCommand } from '../remoteArgvToShellCommand';
import {
  matchingPackageManagerPlugins,
  resolveActivePackageManagerPlugins,
} from '../resolveActivePlugins';
import {
  remoteMkdirWorkspace,
  remoteWorkspaceDirExists,
  runRemoteCommand,
} from './runRemote';
import type { ConfirmFn, PackageManagerPlugin } from '../plugins/types';
import type { PrepareResult } from '../syncProject';

function isFingerprintOutOfSync(
  plugin: PackageManagerPlugin,
  repoRoot: string,
): boolean {
  const local = plugin.readLocalFingerprint(repoRoot);
  const stored = plugin.readStoredHash(repoRoot);
  if (!stored || !local) {
    return false;
  }
  return stored !== local;
}

/** No `.bica/hashes/...` yet but we have a lockfile digest — typical first `bica run` after sync. */
function needsInitialRemoteInstall(
  plugin: PackageManagerPlugin,
  repoRoot: string,
): boolean {
  const local = plugin.readLocalFingerprint(repoRoot);
  const stored = plugin.readStoredHash(repoRoot);
  return stored === null && local !== null;
}

async function ensureRemoteWorkspaceDirectory(
  sshHost: string,
  remoteWorkspacePath: string,
  autoYes: boolean,
  confirmFn: ConfirmFn,
): Promise<number> {
  if (remoteWorkspaceDirExists(sshHost, remoteWorkspacePath)) {
    return 0;
  }
  const create =
    autoYes ||
    (await confirmFn(
      `Remote workspace does not exist on the SSH host yet:\n${remoteWorkspacePath}\n\nCreate it there with mkdir -p?`,
      true,
    ));
  if (!create) {
    process.stderr.write(
      '[bica] Remote workspace path is missing; create it manually or update BICA_REMOTE_PATH / .bica/local.yml.\n',
    );
    return 1;
  }
  const mkdirCode = remoteMkdirWorkspace(sshHost, remoteWorkspacePath);
  if (mkdirCode !== 0) {
    process.stderr.write(
      `[bica] Could not create the remote directory (ssh exited ${mkdirCode}). Check permissions and the path.\n`,
    );
    return mkdirCode;
  }
  return 0;
}

/**
 * Runs the remote argv after optional package-manager preflight (install hash / reinstall prompt).
 */
export async function runRemoteCommandWithPmHooks(options: {
  prep: PrepareResult;
  remoteArgv: string[];
  autoYes: boolean;
  pmOverride: string | undefined;
  confirm: ConfirmFn;
}): Promise<number> {
  const { prep, remoteArgv, autoYes, pmOverride, confirm: confirmFn } = options;
  const { repoRoot, config } = prep;

  const dirReady = await ensureRemoteWorkspaceDirectory(
    config.sshHost,
    config.remoteWorkspacePath,
    autoYes,
    confirmFn,
  );
  if (dirReady !== 0) {
    return dirReady;
  }

  const resolved = resolveBicaPluginConfig(repoRoot);
  const active = resolveActivePackageManagerPlugins(repoRoot, resolved);
  const matched = matchingPackageManagerPlugins(active, remoteArgv, pmOverride);

  if (matched.length > 1) {
    process.stderr.write(
      `[bica] Multiple package manager plugins match; use --pm <id>. Using "${matched[0].id}".\n`,
    );
  }

  const plugin = matched.at(0);
  const cmdStr = argvToPosixShCommand(remoteArgv);

  if (plugin) {
    const isInstall = plugin.isInstallArgv(remoteArgv);
    const initial = !isInstall && needsInitialRemoteInstall(plugin, repoRoot);
    const lockfileDrift =
      !isInstall && isFingerprintOutOfSync(plugin, repoRoot);

    if (initial || lockfileDrift) {
      const promptMessage = initial
        ? `[bica] No remote install recorded yet (${plugin.id}). Run ${plugin.remoteInstallCommand} on the remote first?`
        : `[bica] Lockfile changed since last remote install (${plugin.id}). Reinstall on the remote now?`;
      const reinstall = autoYes || (await confirmFn(promptMessage, true));
      if (reinstall) {
        const installCode = runRemoteCommand(
          config.sshHost,
          config.remoteWorkspacePath,
          plugin.remoteInstallCommand,
          repoRoot,
        );
        if (installCode !== 0) {
          process.stderr.write(
            '\nHint: private registry 401? Run `bica credentials sync`.\n',
          );
          return installCode;
        }
        const fp = plugin.readLocalFingerprint(repoRoot);
        if (fp !== null) {
          plugin.writeStoredHash(repoRoot, fp);
        }
      }
    }
  }

  const code = runRemoteCommand(
    config.sshHost,
    config.remoteWorkspacePath,
    cmdStr,
    repoRoot,
  );

  if (plugin) {
    if (plugin.isInstallArgv(remoteArgv) && code === 0) {
      const fp = plugin.readLocalFingerprint(repoRoot);
      if (fp !== null) {
        plugin.writeStoredHash(repoRoot, fp);
      }
    } else if (plugin.isInstallArgv(remoteArgv) && code !== 0) {
      process.stderr.write(
        '\nHint: private registry 401? Run `bica credentials sync`.\n',
      );
    }
  }

  return code;
}
