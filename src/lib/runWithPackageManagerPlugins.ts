import { resolveBicaPluginConfig } from '../bicaWorkspaceConfig';
import { CONNECTION_LOST_EXIT } from './connectionLoss';
import { launchDetachedRun } from './detachedRun';
import { buildEnvForwarding, describeEnvForwarding } from './envPassthrough';
import { readLocalBicaSettings } from '../localBicaSettings';
import { claimPathExpr } from './remoteClaim';
import { argvToPosixShCommand } from '../remoteArgvToShellCommand';
import { remoteMissingGeneratedPaths } from './generatedPaths';
import {
  matchingPackageManagerPlugins,
  resolveActivePackageManagerPlugins,
} from '../resolveActivePlugins';
import { assignLabels } from './parallelCommands';
import {
  describeRemoteState,
  findRemoteLeftovers,
  readRemoteLoad,
} from './remoteLeftovers';
import { dim, warn } from '../terminalStyle';
import {
  clearRemoteInstallRecord,
  readRemoteInstallRecord,
  writeRemoteInstallRecord,
} from './remoteInstallState';
import {
  REMOTE_CD_FAILED_EXIT,
  REMOTE_CONTENT_MISMATCH_EXIT,
  loginShellFromEnv,
  remoteMkdirWorkspace,
  shellSingleQuoteRemotePathForSh,
  remoteWorkspaceDirExists,
  runRemoteCommand,
} from './runRemote';
import type { PackageManagerPlugin } from '../plugins/types';
import type { PrepareResult } from '../syncProject';

/**
 * What the lockfile here says against what the remote says it installed.
 *
 * Both readings are taken once and compared together, because they used to be taken separately and
 * the second of them is now an ssh round trip.
 */
function compareFingerprints(options: {
  local: string | null;
  remote: string | null;
}): { initial: boolean; drift: boolean } {
  const { local, remote } = options;
  return {
    initial: remote === null && local !== null,
    drift: remote !== null && local !== null && remote !== local,
  };
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
 * Name what a run left behind, and say when the remote is labouring.
 *
 * Only for a leased run, because the lease is what records the process groups to ask about. Entirely
 * best-effort: it costs one round trip and must never turn a successful run into a failed one, so any
 * difficulty simply means nothing is said.
 */
function reportRemoteStateAfterRun(options: {
  sshHost: string;
  remoteWorkspacePath: string;
  leased: boolean;
}): void {
  if (!options.leased) {
    return;
  }
  try {
    const message = describeRemoteState({
      sshHost: options.sshHost,
      leftovers: findRemoteLeftovers(options.sshHost, options.remoteWorkspacePath),
      load: readRemoteLoad(options.sshHost),
    });
    if (message !== undefined) {
      process.stderr.write(`${dim('[bica]')} ${dim(message)}\n`);
    }
  } catch {
    // Nothing said is the right outcome for a report that cannot be made.
  }
}

/**
 * Run several commands at once in one workspace, one connection each.
 *
 * One workspace rather than one per command is the measured choice: commands reading the same files
 * do not need separate copies of them. One *connection* per command is what makes their output
 * separable while it is still arriving.
 *
 * None of them records its exit code into the lease. That record is written by rewriting the claim
 * line, so concurrent writers would race and leave a line with several exit codes or none; the one
 * result for the run is recorded here instead. Each still publishes its own process group, and the
 * lease now treats a run as alive while any of those groups is.
 */
async function runConcurrently(options: {
  commands: string[][];
  sshHost: string;
  remoteWorkspacePath: string;
  repoRoot: string;
  assertRunId?: string;
  claimPathExpr?: string;
}): Promise<number> {
  const labelled = assignLabels(options.commands);
  process.stderr.write(
    `${dim('[bica]')} ${dim(`Running ${String(labelled.length)} commands at once: ${labelled.map((c) => c.label).join(', ')}`)}\n`,
  );

  const started = Date.now();
  const results = await Promise.all(
    labelled.map(async (command) => {
      const code = await runRemoteCommand(
        options.sshHost,
        options.remoteWorkspacePath,
        argvToPosixShCommand(command.argv),
        options.repoRoot,
        {
          assertRunId: options.assertRunId,
          claimPathExpr: options.claimPathExpr,
          label: command.label,
          recordExitCode: false,
        },
      );
      const seconds = Math.round((Date.now() - started) / 1000);
      process.stderr.write(
        `${dim('[bica]')} ${dim(`${command.label} finished (exit ${String(code)}) after ${String(seconds)}s`)}\n`,
      );
      return { label: command.label, code };
    }),
  );

  // The same line this has always printed, because callers read it rather than parsing output.
  process.stdout.write(
    `\n[bica] exit codes: ${results.map((r) => `${r.label}=${String(r.code)}`).join(' ')}\n`,
  );
  return aggregateExitCode(results.map((r) => r.code));
}

/**
 * One exit code for a run of several commands.
 *
 * Ordered by what the caller has to do about it: a discarded result (97) outranks a workspace that
 * could not be entered (96), which outranks a connection that dropped (95), which outranks an
 * ordinary failure -- because the first three say nothing about the code under test and the last
 * does. Any other failure collapses to 1, as it always has: which command failed is in the summary
 * line.
 *
 * A drop ranks below the other two because they are definite statements about the workspace and it
 * is not: 97 and 96 each name something to fix or re-run deliberately, where 95 means only that
 * nobody knows how that command ended.
 */
export function aggregateExitCode(codes: readonly number[]): number {
  if (codes.includes(REMOTE_CONTENT_MISMATCH_EXIT)) {
    return REMOTE_CONTENT_MISMATCH_EXIT;
  }
  if (codes.includes(REMOTE_CD_FAILED_EXIT)) {
    return REMOTE_CD_FAILED_EXIT;
  }
  if (codes.includes(CONNECTION_LOST_EXIT)) {
    return CONNECTION_LOST_EXIT;
  }
  return codes.some((c) => c !== 0) ? 1 : 0;
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
  /** Paths the remote must have before the command runs. See `generatedPaths.ts`. */
  generatedPaths?: string[];
  /** Command that regenerates them. Falls back to the package manager's install when unset. */
  generatedCommand?: string;
  pmOverride: string | undefined;
  /** Run id of the lease this run holds; the remote confirms it still holds it after the command. */
  assertRunId?: string;
  /** Shell expression for that lease's file on the remote. */
  claimPathExpr?: string;
  /** Start the command detached under this run id instead of waiting for it. See detachedRun.ts. */
  detachRunId?: string;
  /**
   * The user's commands, when there is more than one and they are to run at the same time.
   *
   * Each gets its own ssh connection into the one workspace, and the output is labelled and streamed
   * as it arrives. This used to be a shell script generated for the remote, which could not stream:
   * it captured each command to a file and replayed them once the slowest had finished, so a run said
   * nothing at all until it was over -- a three-command run sat silent for two hours and was
   * reasonably reported as never having started. Coordinating here instead means the output, the exit
   * codes and the teardown are Node's problem, where they are ordinary, rather than another twenty
   * lines of POSIX shell for every feature.
   */
  concurrentCommands?: string[][];
}): Promise<number> {
  const { prep, remoteArgv, pmOverride } = options;
  const { repoRoot, config } = prep;

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

  // A workspace we just created has no node_modules, whatever any record claims. The record lives
  // beside the workspace rather than inside it -- a record inside would be deleted by the sync -- so
  // anything that removes the directory itself leaves the record asserting an install that no longer
  // exists. Clearing it on creation keeps the claim tied to something real.
  if (dirReady.created) {
    for (const plugin of active) {
      clearRemoteInstallRecord(
        config.sshHost,
        config.remoteWorkspacePath,
        plugin.id,
      );
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
    const localFingerprint = plugin.readLocalFingerprint(repoRoot);
    const compared = isInstall
      ? { initial: false, drift: false }
      : compareFingerprints({
          local: localFingerprint,
          remote: readRemoteInstallRecord(
            config.sshHost,
            config.remoteWorkspacePath,
            plugin.id,
          ),
        });
    const initial = compared.initial;
    const lockfileDrift = compared.drift;
    // Ask whether the output is actually there, rather than inferring it from the lockfile. A
    // `git worktree` has every gitignored generated file missing and an unchanged lockfile, so the
    // fingerprint says "installed" while the workspace cannot compile. Only probed when the repo
    // declares something, so this costs one round trip for repos that opt in and nothing otherwise.
    const missingGenerated =
      isInstall || initial || lockfileDrift
        ? []
        : remoteMissingGeneratedPaths(
            config.sshHost,
            config.remoteWorkspacePath,
            options.generatedPaths ?? [],
          );

    if (initial || lockfileDrift || missingGenerated.length > 0) {
      // A missing-output repair runs the repo's own command when it declares one. Falling back to
      // the install is a guess and usually a wrong one: `pnpm install` skips `postinstall` entirely
      // when the lockfile is already satisfied, so the install fires, reports success, and
      // regenerates nothing -- which is exactly what happened the first time this was tried.
      const repairCommand =
        !initial && !lockfileDrift && options.generatedCommand !== undefined
          ? options.generatedCommand
          : plugin.remoteInstallCommand;
      const reason = initial
        ? `[bica] No remote install recorded yet (${plugin.id}); running ${plugin.remoteInstallCommand}.`
        : lockfileDrift
          ? `[bica] The remote workspace last installed from a different lockfile (${plugin.id}); reinstalling.`
          : `[bica] Generated output missing on the remote (${missingGenerated.join(', ')}); ` +
            `running ${repairCommand} to produce it.`;
      process.stderr.write(`${reason}\n`);
      // No local lock around this. The remote workspace is leased for the whole run -- taken in
      // `cmdRun` before anything syncs, released in its `finally` -- so a second run against this
      // workspace exits 98 without reaching an install, and a run against a *different* workspace was
      // never something a lock keyed on this checkout could see anyway. The lock that used to be here
      // could therefore only ever wait on something that cannot happen, at the cost of a 30-minute
      // stall if its file were ever left behind. Contention on the shared pnpm store between
      // different workspaces is pnpm's own store locking to handle, not bica's.
      const installCode = await runRemoteCommand(
        config.sshHost,
        config.remoteWorkspacePath,
        repairCommand,
        repoRoot,
        { assertRunId: options.assertRunId, claimPathExpr: options.claimPathExpr },
      );
      if (installCode !== 0) {
        maybeWriteCredentialsHint(plugin);
        return installCode;
      }
      if (localFingerprint !== null) {
        writeRemoteInstallRecord(
          config.sshHost,
          config.remoteWorkspacePath,
          plugin.id,
          localFingerprint,
        );
      }
    }
  }

  // Said once per run, before anything executes, because a variable that silently did not travel
  // produces a build with different settings and no evidence of why.
  const forwarding = buildEnvForwarding(options.prep.env);
  // `$BICA_BUILD_DIR` goes across whether or not anything is declared in `env:`: it is bica's own
  // answer to "where does this checkout build", not one of the user's variables.
  const buildDir = readLocalBicaSettings(repoRoot).buildDir;
  const envScript =
    buildDir === undefined
      ? forwarding.script
      : `${forwarding.script}export BICA_BUILD_DIR=${shellSingleQuoteRemotePathForSh(buildDir)}\n`;
  const envSaid = describeEnvForwarding(forwarding);
  if (envSaid !== undefined) {
    process.stderr.write(`${dim('[bica]')} ${dim(envSaid)}\n`);
  }
  if (buildDir !== undefined) {
    process.stderr.write(
      `${dim('[bica]')} ${dim(`\`$BICA_BUILD_DIR\` is ${buildDir} for this checkout.`)}\n`,
    );
  }

  if (options.detachRunId !== undefined) {
    // Everything above has already happened attached: the workspace is there, the install preflight
    // has run, generated paths have been repaired. Only the command itself is let go of, which is the
    // part that takes the hour.
    const outcome = launchDetachedRun({
      sshHost: config.sshHost,
      remoteWorkspacePath: config.remoteWorkspacePath,
      repoRoot,
      command: cmdStr,
      envScript,
      argv: options.remoteArgv,
      runId: options.detachRunId,
      claimPathExpr: options.claimPathExpr ?? claimPathExpr(config.remoteWorkspacePath),
      loginShell: loginShellFromEnv(),
    });
    if (outcome.exitedEarly) {
      // Started, ran, and was over inside the second bica waits to see whether it would start at
      // all. That is not a failure: `true` does it, and so does `ninja` on a tree with nothing to
      // do. It used to be reported as exit 1 with no run id on stdout, which broke the
      // `id=$(bica run --detach …) && bica wait "$id"` form in the way that looks most like a
      // broken build -- a failing exit code over a log that says the command succeeded.
      //
      // Reported as started, because that is what the launcher's exit code means for every other
      // detached run. The command's own code comes from `bica wait`, which is what ends a detached
      // run, and which returns immediately for one already over.
      process.stderr.write(
        `${dim('[bica]')} ${dim(
          outcome.exitCode === undefined
            ? 'It finished within a second of starting; `bica wait` has its exit code.'
            : `It finished within a second of starting, with exit ${String(outcome.exitCode)}.`,
        )}\n`,
      );
      return 0;
    }
    if (!outcome.started) {
      process.stderr.write(
        `${warn('[bica]')} Could not start a detached run on ${config.sshHost}.\n`,
      );
      return 1;
    }
    return 0;
  }

  const concurrent = options.concurrentCommands ?? [];
  const code =
    concurrent.length > 1
      ? await runConcurrently({
          commands: concurrent,
          sshHost: config.sshHost,
          remoteWorkspacePath: config.remoteWorkspacePath,
          repoRoot,
          assertRunId: options.assertRunId,
          claimPathExpr: options.claimPathExpr,
        })
      : await runRemoteCommand(
          config.sshHost,
          config.remoteWorkspacePath,
          cmdStr,
          repoRoot,
          {
            assertRunId: options.assertRunId,
            claimPathExpr: options.claimPathExpr,
            envScript,
          },
        );

  // Said once, after the command, and only when there is something to say.
  //
  // A command may leave a server running deliberately; bica does not interfere with that. But nobody
  // else is looking, and a server whose idle-exit is broken costs days rather than minutes when
  // nothing reports it.
  reportRemoteStateAfterRun({
    sshHost: config.sshHost,
    remoteWorkspacePath: config.remoteWorkspacePath,
    leased: options.claimPathExpr !== undefined,
  });

  if (plugin) {
    const wasInstall = candidates.some((argv) => plugin.isInstallArgv(argv));
    if (wasInstall && code === 0) {
      const fp = plugin.readLocalFingerprint(repoRoot);
      if (fp !== null) {
        writeRemoteInstallRecord(
          config.sshHost,
          config.remoteWorkspacePath,
          plugin.id,
          fp,
        );
      }
    } else if (wasInstall && code !== 0) {
      maybeWriteCredentialsHint(plugin);
    }
  }

  return code;
}
