import { spawnSync } from 'node:child_process';
import { pinnedToolchain } from './rustWorkspace';
import { resolveBicaPluginConfig } from '../bicaWorkspaceConfig';
import { resolveActivePackageManagerPlugins } from '../resolveActivePlugins';
import chalk from 'chalk';

import { doctorContextForThisRepo, reportOnThisMachine } from './doctor';
import type { CheckResult } from './doctor';
import { bicaIsGitignored } from './gitignore';
import { remoteLoginPreambleForRun, runRemoteScriptOverStdin } from './runRemote';
import { dim } from '../terminalStyle';
import {
  getRepoRoot,
  loadRemoteEnvConfig,
  prepareSyncProjectFile,
} from '../syncProject';
import { ownVersion } from './ownVersion';

/**
 * Run every check against this machine and print the report.
 *
 * One place, because two commands want it: `bica doctor`, and the end of `bica init` — where a verdict
 * is worth more than a prompt, since the alternative is discovering a missing prerequisite during a
 * first real command.
 */
export function checkThisMachine(): CheckResult[] {
  return reportOnThisMachine({
    ...doctorContextForThisRepo({
      gitRoot: gitRootOrUndefined,
      bicaRoot: getRepoRoot,
      remoteConfig: loadRemoteEnvConfig,
      preamble: remoteLoginPreambleForRun,
    }),
    version: ownVersion(),
    runLocal: (command, args) => {
      const r = spawnSync(command, args, { encoding: 'utf8', shell: false });
      return {
        ok: r.error == null && (r.status ?? 1) === 0,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
      };
    },
    runRemote: runRemoteScriptOverStdin,
    isGitignored: bicaIsGitignored,
    syncIgnorePaths: ignorePathsOrEmpty(),
    defaultedIgnores: defaultedIgnoresOrEmpty(),
    toolchain: declaredToolchainOrEmpty(),
    packageManagerPluginIds: activePackageManagerIdsOrEmpty(),
    pinnedToolchain: pinnedToolchainOrNull(),
    write: (text) => process.stdout.write(text),
    decorate: {
      ok: (t) => chalk.green(t),
      bad: (t) => chalk.red(t),
      warn: (t) => chalk.yellow(t),
      dim: (t) => dim(t),
    },
  });
}

/**
 * What this repository keeps off the remote, or nothing when there is no config to read.
 *
 * Total, like everything else the doctor gathers: a repository without a bica.yml is a case it has to
 * describe rather than fail on.
 */
function defaultedIgnoresOrEmpty(): readonly string[] {
  try {
    return prepareSyncProjectFile({ verbose: false }).companionRecordsIgnored;
  } catch {
    return [];
  }
}

function ignorePathsOrEmpty(): readonly string[] {
  try {
    return prepareSyncProjectFile({ verbose: false }).syncIgnorePaths;
  } catch {
    return [];
  }
}

/** The toolchain `rust-toolchain.toml` pins, when this is a Rust repository that pins one. */
function pinnedToolchainOrNull(): string | null {
  const repoRoot = gitRootOrUndefined();
  return repoRoot === undefined ? null : pinnedToolchain(repoRoot);
}

/** Which package-manager plugins apply here, for the install-preflight note. */
function activePackageManagerIdsOrEmpty(): readonly string[] {
  try {
    const repoRoot = gitRootOrUndefined();
    if (repoRoot === undefined) {
      return [];
    }
    return resolveActivePackageManagerPlugins(
      repoRoot,
      resolveBicaPluginConfig(repoRoot),
    ).map((p) => p.id);
  } catch {
    return [];
  }
}

/** The repository's declared `toolchain:`, or nothing when there is no readable spec. */
function declaredToolchainOrEmpty(): readonly string[] {
  try {
    return prepareSyncProjectFile({ verbose: false }).toolchain;
  } catch {
    return [];
  }
}

/** The enclosing git repository, or nothing — used where bica's own config may not exist yet. */
function gitRootOrUndefined(): string | undefined {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    shell: false,
  });
  const out = (r.stdout ?? '').trim();
  return r.error == null && (r.status ?? 1) === 0 && out !== '' ? out : undefined;
}
