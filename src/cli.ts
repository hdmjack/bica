/**
 * Bica — remote workspace CLI (`bica <command>`).
 *
 * Env: BICA_SSH_HOST (or TTY prompt), BICA_REMOTE_PATH (optional), and other BICA_* vars below.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBicaPluginConfig } from './bicaWorkspaceConfig';
import { parseArgs } from './cliArgs';
import { isProcessAlive } from './lib/fileLock';
import { hasProblem } from './lib/doctor';
import { ownVersion } from './lib/ownVersion';
import { checkThisMachine } from './lib/doctorRun';
import { reportGitDependentHint } from './lib/reportGitHint';
import { wantsMtimeRepair } from './lib/syncedMtimes';
import { splitParallelCommands } from './lib/commandSeparator';
import { readLocalBicaSettings } from './localBicaSettings';
import { cmdLogs, cmdRuns, cmdWait } from './lib/detachedCommands';
import { reportArtifactPull } from './lib/reportArtifacts';
import { seedRemoteWorkspace } from './lib/seedWorkspace';
import {
  SYNC_NOT_READY_EXIT,
  SYNC_STALL_SECONDS,
  describeSyncStall,
} from './lib/syncProgress';
import { warnAboutStaleRemoteGit } from './lib/staleRemoteGit';
import {
  classifyTunnelInvocation,
  DEFAULT_READY_TIMEOUT_SECONDS,
  formatTunnelList,
  parseTunnelArgs,
  runTunnel,
  tunnelNeedsWorkspace,
  TUNNEL_USAGE,
} from './lib/tunnel';
import type { TunnelArgs } from './lib/tunnel';
import {
  claimLocalSocket,
  cleanUpAfterDeadTunnel,
  describeTunnel,
  listTunnelRecords,
  readTunnelRecord,
  removeTunnelRecord,
  tunnelLogPathFor,
  writeTunnelRecord,
} from './lib/tunnelState';
import type { TunnelRecord } from './lib/tunnelState';
import { terminateConflictingSyncSessions } from './lib/ensureSyncReady';
import {
  acquireWorkspace,
  runPinned,
  RemoteUnreachableError,
  WorkspaceInUseError,
} from './lib/pinnedRun';
import {
  claimPathExpr,
  describeClaim,
  remoteCancelClaim,
  remoteReadClaim,
  sshLeaseOps,
} from './lib/remoteClaim';
import type { ClaimOwner } from './lib/remoteClaim';
import {
  assertMutagenInstalled,
  findAllSessionsForRepo,
  mutagenProjectStart,
  mutagenProjectTerminate,
  mutagenSyncFlush,
  mutagenSyncList,
  mutagenSyncMonitor,
  mutagenSyncTerminate,
  waitForSyncReady,
} from './lib/mutagenSession';
import { confirm, ensureRemoteSshHostFromEnvOrPrompt } from './lib/prompt';
import {
  pullReturnFlow,
  pushGitToRemote,
  pushReturnFlowToRemote,
} from './lib/returnFlow';
import {
  collectWriteBack,
  placeWriteBackMarker,
  reportWriteBack,
  writeBackDisabled,
  writeBackMarkerPath,
} from './lib/writeBack';
import {
  openRemoteInteractiveSsh,
  runRemoteScriptOverStdin,
  terminateLiveRemoteCommand,
} from './lib/runRemote';
import { runRemoteCommandWithPmHooks } from './lib/runWithPackageManagerPlugins';
import type { DetachOutcomeSink } from './lib/runWithPackageManagerPlugins';
import { dim, remoteExitStatusLine, syncRemoteTarget, warn } from './terminalStyle';
import {
  BUILTIN_CREDENTIALS_PLUGINS,
  BUILTIN_PACKAGE_MANAGER_PLUGINS,
  BUILTIN_REMOTE_SHELL_PLUGINS,
} from './plugins/builtIns';
import {
  pickCredentialsPluginsForSync,
  resolveActiveCredentialsPlugins,
  resolveActivePackageManagerPlugins,
  resolveActiveRemoteShellPlugins,
} from './resolveActivePlugins';
import { cmdInit, ensureBicaWorkspaceOrInteractiveSetup } from './setupWizard';
import {
  getRepoRoot,
  loadRemoteEnvConfig,
  MUTAGEN_PROJECT_RELATIVE,
  prepareSyncProjectFile,
  readPrimarySessionNameFromSpec,
} from './syncProject';
import type { ParsedGlobals } from './cliArgs';
import type { PrepareResult } from './syncProject';
import { dotGitIsAFile } from './lib/gitLayout';

/** Commands that require bica.yml (or legacy bica-workspace.yml) at the Git root. */
const COMMANDS_NEEDING_BICA_SPEC = new Set([
  'prepare',
  'start',
  'stop',
  'monitor',
  'credentials',
  'plugins',
  'ssh',
  'run',
  'tunnel',
  'cancel',
]);

function printHelp(): void {
  console.log(`
Usage: bica <command> [options]

Remote execution
  run <command> [args...]     Required for remote argv: there is no shorthand (use
                              'bica run pnpm test', not 'bica pnpm test'). The token "run" is local;
                              every token after it becomes argv on the remote (POSIX-quoted, no
                              shell injection). Do not pass local-only options after "run" unless you
                              intend the remote to see them. Example: bica run pnpm test:run
  run --detach <command>      Start it on the remote and return once it is running, printing a run
                              id. For work that outlasts the caller: an agent's tool call times out
                              after ten minutes and a 50-minute build cannot be started from one at
                              all otherwise. The command survives the connection closing, and the
                              workspace stays leased until you wait for it, so a second run gets 98.
  runs                        The detached runs started from this machine, and where each has got to.
  logs <run-id> [--follow]    A detached run's output. Closing this window does not stop the run.
  wait <run-id>               Block until it finishes; exits with the command's own exit code, brings
                              its artifacts home and gives the workspace back.
  ssh                         Interactive ssh, cd to BICA_REMOTE_PATH, then a login shell.
  cancel [--force]            End the run holding this workspace and drop its lease. For the case a
                              run's client was killed (a CI step or an agent tool hitting its command
                              timeout) and the remote command carried on: the lease is correctly
                              honoured, so every later run is refused until the orphan finishes.
                              Refuses when the holder's client is still alive, or when it belongs to
                              another machine; --force overrides both.

Running several commands at once
  Separate them with --also. They run concurrently in one remote workspace, against one copy of the
  files, and each one's output is printed under its own heading:

    bica run pnpm lint --also pnpm typecheck --also pnpm test:run

  -- is not a separator: it belongs to the program, as it does everywhere else, so
  'bica run cargo run -p x -- 1 1024' passes 1 and 1024 to the binary.

    ===== pnpm-lint =====      <output>
    ===== pnpm-typecheck ===== <output>
    ===== pnpm-test-run =====  <output>
    [bica] exit codes: pnpm-lint=0 pnpm-typecheck=1 pnpm-test-run=0

  The run exits non-zero if any command failed, so a caller can branch on one code. Commands that
  read the same files do not need separate copies of them: measured on a real monorepo this is
  faster than a workspace each, uses a third of the disk, and builds dist once instead of three
  identical times.

  --return-flow               Pull remote artifacts back after a multi-command run. Off by default
                              there because the pull mirrors with --delete and describes exactly one
                              content state.

Commands that write files
  The remote gets a copy of your tree, so a command that edits files edits the copy. bica names those
  files after every run, because a formatter that reports success and changes nothing locally is
  indistinguishable from one that worked:

    [bica] This command wrote 12 files on the remote. They stay there — your local tree is unchanged:

  --write-back                Copy them home as well. Only the files the run actually changed, only
                              ones git does not ignore, and never one you edited locally while the
                              run was out — those are named and left alone, so a run you leave going
                              in the background cannot overwrite what you are typing. Implies a
                              pinned run: a live session reverts remote-side writes by design.

  The remote workspace is leased for the duration of a run, so a second run — including one from a
  sibling clone that resolves to the same remote path — refuses rather than syncing over the first.

  Exit codes worth knowing, since none of them are verdicts on your code:
    98  refused to start; the workspace is in use. Nothing ran. Wait, or use a checkout with a
        different remotePath — another clone pointing at the same one is exactly what is refused.
    97  ran, but the workspace was taken part-way through, so the result was discarded. Re-run.
    96  the remote workspace could not be entered.

  A run killed by SIGTERM or SIGHUP ends its remote command and releases the workspace on the way
  out, so a caller's command timeout no longer leaves an orphan. A SIGKILLed client cannot do that —
  no handler runs — so \`bica cancel\` is the answer for that one.

Workspace
  init                        Interactive setup: create bica.yml + .bica/local.yml (SSH/path).
  doctor                      Check everything bica needs — local tools, config, the remote and its
                              toolchain — and say what to do about whatever is missing. Exits non-zero
                              if something would stop a run. Run this first when anything is odd.

File sync
  prepare                     Read bica.yml + BICA_* / .bica/local.yml → write the sync project file
                              bica uses for start/stop (derived from your sync: block).
  start / stop / list / monitor
                              Start, stop, list, or watch workspace file sync.
                              Note: 'bica run' uses an ephemeral session per invocation
                              (terminates any existing session for this repo *and this remote
                              workspace* before starting, and tears it down on exit). 'start' is
                              for users who want a long-lived session — but it will be killed at
                              the next 'bica run'. A multi-command run uses no session at all, so it
                              never disturbs one.

Long-lived remote processes
  tunnel --local=<path.sock> --remote=<path.sock> [--ready-timeout=<s>] [--ready-when=<regex>]
         [--restart=never|on-exit|on-demand] [--detach] -- <command> [args...]
                              Start <command> on the remote (same workspace and login preamble as
                              'bica run'), wait for it to create <remote path>, then forward that
                              socket to <local path> over ssh. Readiness is a real connect, not the
                              socket file appearing, so a slow-starting server is waited for rather
                              than forwarded to early. A dropped connection reconnects with backoff.
                              Local clients connect to a path and need to know nothing about the
                              remote. Holds no workspace lease, so
                              'bica run' keeps working while a tunnel is up -- and takes no sync of
                              its own, so the process reads whatever the last run synced. Ends when
                              either side does, and unlinks the local socket on the way out so a
                              client sees "no server" rather than a path that cannot answer.
                              Needs OpenSSH 6.7+ on both ends (stream-local forwarding).
                              --restart says what to do when the remote command exits by itself:
                              'never' (default) closes the tunnel with it; 'on-exit' starts it again
                              at once; 'on-demand' leaves the socket bound and starts it when the
                              next client connects -- the mode for a server with an idle timeout,
                              since the socket never disappears and so no client is ever told there
                              is nothing there.
                              --detach runs it in the background, surviving this shell, and prints
                              where its output goes.
                              --ready-when is a pattern the server prints when it can answer. Use it
                              for anything that binds its socket before it is ready -- a model load,
                              a warm-up -- because no probe can tell that apart from a working
                              server: the kernel queues connections either way. Without it, bica
                              says so when a request goes unanswered for 20s.
  tunnel --list               Tunnels that have recorded themselves, live ones first. Also removes
                              the socket a killed tunnel left behind, so clients see no server
                              rather than a refused connection.
  tunnel --stop <local.sock>  Stop the tunnel serving that path and clear its record.
  tunnel --restart <local.sock>
                              Start a recorded tunnel again with the same host, paths, command and
                              restart mode -- for one that was killed rather than stopped.

Plugins
  credentials sync [id...]    Run enabled credentials plugins. With ids, only those plugins (must
                              be active for this workspace). No args = all active.
  plugins list                Built-in plugins, active/inactive, and autoDiscover summary.

Maintainers (bica package development only)
  build                       Typecheck only (pnpm exec tsc --noEmit). Same as pnpm build here.
  dev [args...]               Typecheck, pnpm link --global, PATH hint, then tsx watch on the CLI.
                              Optional args go to the watched CLI (default: silent reload; use
                              \`pnpm dev -- help\` to print this help on each save). Same as pnpm dev.
                              Blocks until Ctrl+C.

Config precedence (no merging)
  Defaults come from bica.yml (or legacy bica-workspace.yml) under bica: (pluginMode,
  packageManagerPlugins, credentialsPlugins, remoteShellPlugins). If an env var below is set, it replaces the
  corresponding YAML value.

  BICA_PLUGIN_MODE               auto | explicit
  BICA_PACKAGE_MANAGER_PLUGINS   Comma-separated ids (replaces YAML list)
  BICA_CREDENTIALS_PLUGINS       Comma-separated ids (replaces YAML list)
  BICA_REMOTE_SHELL_PLUGINS      Comma-separated ids (replaces YAML list; used for bica run SSH preamble)

Environment
  BICA_SSH_HOST                  SSH target (optional: .bica/local.yml, ~/.ssh/config, or prompt)
  BICA_REMOTE_PATH               Remote workspace path (default ~/code/<repo folder name>)
  BICA_LOGIN_SHELL               Remote shell for non-interactive commands (default zsh)
  BICA_LOGIN_FLAGS               Flags for that shell (default -lc for zsh)
  BICA_DEBUG                     Set to 1 to print the remote script on stderr before ssh (env-dump hint: always on TTY; with debug, also when stderr is not a TTY)
  BICA_RETURN_FLOW               Set to 0 to disable the post-\`bica run\` rsync that pulls test
                                 snapshots and other whitelisted files back from remote→local
                                 (configure patterns via top-level returnFlow: in bica.yml)
  BICA_WRITE_BACK                Set to 0 to skip noticing which files a run wrote on the remote
                                 (and, with --write-back, copying them home)

Globals (parsed from the full argv; not forwarded to the remote — put before "run" for clarity)
  -y, --yes              Auto-confirm prompts in 'bica start'. 'bica run' never prompts.
  --pm <id>              Disambiguate package-manager hooks when several could match argv[0]
  --return-flow          Pull remote artifacts back for a pinned run
  --write-back           Copy home the files the command wrote (implies a pinned run)

Examples
  bica init
  bica doctor
  bica prepare
  bica run pnpm validate
  bica credentials sync
  bica credentials sync npmrc
  bica plugins list

  # Three checks at once, one workspace, one copy of the files
  bica run pnpm lint --also pnpm typecheck --also pnpm test:run

  # One command
  bica run pnpm test:run

  # A parser that stays up on the remote, reachable at a local socket path
  bica tunnel --local=/tmp/parser.sock --remote=/tmp/parser.sock -- ./serve-parser

  # One that survives this shell, and restarts itself when a client needs it
  bica tunnel --local=/tmp/parser.sock --remote=/tmp/parser.sock \
    --restart=on-demand --detach -- ./serve-parser
  bica tunnel --list
  bica tunnel --stop /tmp/parser.sock
`);
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Maintainer: typecheck only (no link, no watch). */
function cmdBuild(): void {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = path.join(dir, '..');
  const script = path.join(pkgRoot, 'scripts', 'build.cjs');
  const result = spawnSync(process.execPath, [script], {
    cwd: pkgRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

/** Maintainer: typecheck, global link, PATH hint, tsx watch (re-run CLI on save). */
function cmdDev(forwarded: string[]): void {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = path.join(dir, '..');
  const script = path.join(pkgRoot, 'scripts', 'dev.cjs');
  const result = spawnSync(process.execPath, [script, ...forwarded], {
    cwd: pkgRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      INIT_CWD: process.cwd(),
    },
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

async function cmdPrepare(): Promise<void> {
  await ensureRemoteSshHostFromEnvOrPrompt();
  prepareSyncProjectFile({ verbose: true });
}

async function cmdStart(autoYes: boolean): Promise<void> {
  await ensureRemoteSshHostFromEnvOrPrompt();
  const prep = prepareSyncProjectFile({ verbose: false });
  await terminateConflictingSyncSessions(prep, { autoYes });
  if (!mutagenProjectStart(prep.repoRoot, prep.projectFilePath)) {
    process.exit(1);
  }
}

function cmdStop(): void {
  const repoRoot = getRepoRoot();
  const projectFilePath = path.join(repoRoot, MUTAGEN_PROJECT_RELATIVE);
  if (!fs.existsSync(projectFilePath)) {
    console.error(
      'No sync project file found. Run `bica prepare` or `bica start` first.',
    );
    process.exit(1);
  }
  if (!mutagenProjectTerminate(repoRoot, projectFilePath)) {
    process.exit(1);
  }
}

function cmdList(): void {
  mutagenSyncList();
}

function cmdMonitor(): void {
  const sessionName = readPrimarySessionNameFromSpec();
  mutagenSyncMonitor(sessionName);
}

async function cmdCredentialsSync(pluginArgs: string[]): Promise<void> {
  await ensureRemoteSshHostFromEnvOrPrompt();
  const repoRoot = getRepoRoot();
  const { sshHost } = loadRemoteEnvConfig(repoRoot);
  const resolved = resolveBicaPluginConfig(repoRoot);
  const active = resolveActiveCredentialsPlugins(repoRoot, resolved);
  let plugins;
  try {
    plugins = pickCredentialsPluginsForSync(active, pluginArgs);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    die(msg);
  }
  if (plugins.length === 0) {
    process.stderr.write(
      '[bica] No credentials plugins apply (see `bica plugins list`).\n',
    );
    return;
  }
  const ctx = { sshHost, confirm };
  for (const p of plugins) {
    await p.sync(ctx);
  }
}

function cmdPluginsList(): void {
  const repoRoot = getRepoRoot();
  const resolved = resolveBicaPluginConfig(repoRoot);
  const pmActive = resolveActivePackageManagerPlugins(repoRoot, resolved);
  const credActive = resolveActiveCredentialsPlugins(repoRoot, resolved);
  const rsActive = resolveActiveRemoteShellPlugins(repoRoot, resolved);
  const pmIds = new Set(pmActive.map((p) => p.id));
  const credIds = new Set(credActive.map((p) => p.id));
  const rsIds = new Set(rsActive.map((p) => p.id));
  const discoverCtx = { repoRoot };

  console.log(`pluginMode: ${resolved.pluginMode}`);
  if (resolved.packageManagerPluginIds !== undefined) {
    console.log(
      `packageManagerPlugins (effective list): ${resolved.packageManagerPluginIds.join(', ') || '(empty)'}`,
    );
  } else {
    console.log(
      'packageManagerPlugins (effective list): (default — all built-ins if autoDiscover)',
    );
  }
  if (resolved.credentialsPluginIds !== undefined) {
    console.log(
      `credentialsPlugins (effective list): ${resolved.credentialsPluginIds.join(', ') || '(empty)'}`,
    );
  } else {
    console.log(
      'credentialsPlugins (effective list): (default — all built-ins if autoDiscover)',
    );
  }
  if (resolved.remoteShellPluginIds !== undefined) {
    console.log(
      `remoteShellPlugins (effective list): ${resolved.remoteShellPluginIds.join(', ') || '(empty)'}`,
    );
  } else {
    console.log(
      'remoteShellPlugins (effective list): (default — all built-ins if autoDiscover)',
    );
  }

  console.log('\nPackage manager plugins:');
  for (const p of BUILTIN_PACKAGE_MANAGER_PLUGINS) {
    const status = pmIds.has(p.id) ? 'active' : 'inactive';
    const { summary } = p.explainAutoDiscover(discoverCtx);
    console.log(`  ${p.id}  ${status}`);
    console.log(`         ${summary}`);
  }

  console.log('\nCredentials plugins:');
  for (const p of BUILTIN_CREDENTIALS_PLUGINS) {
    const status = credIds.has(p.id) ? 'active' : 'inactive';
    const { summary } = p.explainAutoDiscover(discoverCtx);
    console.log(`  ${p.id}  ${status}`);
    console.log(`         ${summary}`);
  }

  console.log('\nRemote shell plugins (bica run):');
  for (const p of BUILTIN_REMOTE_SHELL_PLUGINS) {
    const status = rsIds.has(p.id) ? 'active' : 'inactive';
    const { summary } = p.explainAutoDiscover(discoverCtx);
    console.log(`  ${p.id}  ${status}`);
    console.log(`         ${summary}`);
  }
}

async function cmdSsh(): Promise<void> {
  await ensureRemoteSshHostFromEnvOrPrompt();
  const repoRoot = getRepoRoot();
  const { sshHost, remoteWorkspacePath } = loadRemoteEnvConfig(repoRoot);
  const code = openRemoteInteractiveSsh(sshHost, remoteWorkspacePath);
  // Set exitCode rather than process.exit() so any buffered stdout/stderr flushes before exit.
  process.exitCode = code;
}

/**
 * `bica doctor`: check everything bica needs and say what to do about what is missing.
 *
 * Exists because every prerequisite is invisible until it fails, and fails in the middle of something
 * else — a missing Mutagen as a sync that never starts, a remote without pnpm as a command not found
 * three minutes in. Each is a minute to fix and an afternoon to identify.
 */
function cmdDoctor(): void {
  process.exitCode = hasProblem(checkThisMachine()) ? 1 : 0;
}

/** Wait for a condition, briefly, without pinning the loop. */
async function pollFor(
  check: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

/**
 * `bica tunnel --list`: what is running, and what merely left a record behind.
 *
 * Listing also tidies, which a read-only command would not normally do. The thing being tidied is a
 * socket file with no listener behind it -- left by a tunnel that was killed rather than stopped --
 * and it actively misleads: a client connecting there is refused, where an absent path would have
 * said plainly that no tunnel is running. Nothing else is scheduled to notice, so the next command
 * that looks is the right moment.
 */
function cmdTunnelList(): void {
  const entries = listTunnelRecords();
  console.log(formatTunnelList(entries));
  for (const { record, alive } of entries) {
    if (alive) {
      continue;
    }
    // The socket goes; the record stays. The record is what `--restart` rebuilds the tunnel from --
    // host, paths, command, restart mode -- so clearing it would make the very next line of advice
    // impossible to follow, which is exactly what it did the first time this was written.
    const removed = cleanUpAfterDeadTunnel(record);
    if (removed.length > 0) {
      process.stderr.write(
        `${dim('[bica]')} ${dim(`Cleared up after the dead tunnel for ${record.localSocket}: ${removed.join(', ')}.`)}\n` +
          `${dim('[bica]')} ${dim(`Clients now find no server rather than a refused connection. Start it again with \`bica tunnel --restart ${record.localSocket}\`.`)}\n`,
      );
    }
  }
}

/**
 * `bica tunnel --restart <local-socket>`: start a recorded tunnel again, as it was.
 *
 * The record already holds everything the original invocation did -- host, both socket paths, the
 * remote argv, the restart mode -- so reviving one need not mean finding the `uv run --with …` line
 * that started it. That matters most for the case this exists for: a tunnel killed outright, found
 * dead hours later by whoever needed it.
 */
async function cmdTunnelRestart(localSocket: string): Promise<void> {
  const target = path.resolve(localSocket);
  const record = readTunnelRecord(target);
  if (record === null) {
    die(
      `No tunnel is recorded for ${target}, so there is nothing to restart.\n` +
        'Start one with `bica tunnel --local=… --remote=… -- <command>`.',
    );
  }
  if (isProcessAlive(record.pid)) {
    die(
      `That tunnel is already running:\n  ${describeTunnel(record, true)}\n` +
        `Stop it first with \`bica tunnel --stop ${target}\` if you mean to replace it.`,
    );
  }
  cleanUpAfterDeadTunnel(record);
  removeTunnelRecord(target);
  process.stderr.write(
    `${dim('[bica]')} ${dim(`Starting the recorded tunnel for ${target} again.`)}\n`,
  );
  await detachTunnel({
    localSocket: record.localSocket,
    remoteSocket: record.remoteSocket,
    remoteArgv: record.remoteArgv,
    restart: record.restart,
    readyTimeoutSeconds: DEFAULT_READY_TIMEOUT_SECONDS,
    detach: true,
  });
}

/**
 * `bica tunnel --stop <local-socket>`: end one tunnel by the path it serves.
 *
 * The path is the name because it is the only part a user has in hand -- it is what they typed to
 * start it and what their client connects to, where the pid is something they would have to go
 * looking for. That it is also the thing two tunnels can collide over is the same fact from the
 * other side.
 */
async function cmdTunnelStop(localSocket: string): Promise<void> {
  const target = path.resolve(localSocket);
  const record = readTunnelRecord(target);
  if (record === null) {
    process.stderr.write(
      `${dim('[bica]')} ${dim(`No tunnel is recorded for ${target}.`)}\n`,
    );
    return;
  }
  if (!isProcessAlive(record.pid)) {
    removeTunnelRecord(target);
    process.stderr.write(
      `${dim('[bica]')} ${dim(`The tunnel for ${target} (pid ${String(record.pid)}) is already gone; cleared its record.`)}\n`,
    );
    return;
  }
  process.kill(record.pid, 'SIGTERM');
  const ended = await pollFor(() => !isProcessAlive(record.pid), 15_000);
  if (!ended) {
    process.stderr.write(
      `${warn('[bica]')} pid ${String(record.pid)} did not stop within 15s. ` +
        `Send it SIGKILL yourself if it is wedged: kill -9 ${String(record.pid)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  // The tunnel clears these itself on the way out. Doing it again covers the one case where it
  // could not -- a SIGKILL, which runs no handler -- and costs nothing when it already did.
  removeTunnelRecord(target);
  process.stderr.write(
    `${dim('[bica]')} ${dim(`Stopped the tunnel for ${target} (pid ${String(record.pid)}).`)}\n`,
  );
}

/**
 * `--detach`: start the same tunnel again as a background process that outlives this shell.
 *
 * Re-executing this process rather than forking is what keeps the two paths honest -- the detached
 * tunnel runs the identical code with the identical arguments, minus the flag that asked for it. The
 * child writes its own record, so the parent can wait for that record to appear and report a tunnel
 * that is genuinely up rather than one that was merely spawned.
 */
async function detachTunnel(args: TunnelArgs): Promise<void> {
  const logPath = tunnelLogPathFor(args.localSocket);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, 'a');
  // Built from the arguments, not from this process's own command line.
  //
  // Copying argv worked only while the command being detached was literally the one that had been
  // typed. `--restart` revives a tunnel from its record, so its argv is `tunnel --restart <path>` --
  // and a child given that starts no tunnel at all, it tries to revive one again.
  //
  // `execArgv` leads, or the child is a plain node that cannot read the TypeScript it is pointed at:
  // this process runs under a loader (tsx in development), and re-executing without the flags that
  // installed it reproduces the arguments but not the runtime.
  const argv = [
    ...process.execArgv,
    process.argv[1],
    'tunnel',
    `--local=${args.localSocket}`,
    `--remote=${args.remoteSocket}`,
    `--ready-timeout=${String(args.readyTimeoutSeconds)}`,
    `--restart=${args.restart}`,
    '--',
    ...args.remoteArgv,
  ];
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
  fs.closeSync(log);

  // Waits for the tunnel to be *serving*, not merely to exist.
  //
  // This used to return as soon as the child had written its record, which it does when it binds the
  // local socket -- before the remote command has started. So `--detach` returned in under a second
  // with the socket present and nothing behind it, and the next client to connect failed. The
  // readiness stamp is written when something first answers, which is what `--ready-timeout` has
  // always promised and what the foreground form prints as "Tunnel up".
  //
  // The budget is the caller's own, plus a margin for the start bica does before the command runs:
  // clearing the remote socket, and the first connection to the host.
  const deadlineMs = args.readyTimeoutSeconds * 1000 + 15_000;
  // Stops early when the child is gone, rather than waiting out a budget nothing is using any more.
  // A server that cannot start fails inside its own `--ready-timeout`, and the parent sitting out the
  // remainder turns a five-second failure into a twenty-second one.
  let childGone = false;
  const ready = await pollFor(() => {
    if (readTunnelRecord(args.localSocket)?.readyAt !== undefined) {
      return true;
    }
    if (child.pid !== undefined && !isProcessAlive(child.pid)) {
      childGone = true;
      return true;
    }
    return false;
  }, deadlineMs);
  const record = readTunnelRecord(args.localSocket);
  if (!ready || childGone) {
    const stillStarting = !childGone && record !== null && isProcessAlive(record.pid);
    process.stderr.write(
      stillStarting
        ? `${warn('[bica]')} The detached tunnel has not served anything after ` +
            `${String(Math.round(deadlineMs / 1000))}s and is still starting (pid ${String(record.pid)}).\n` +
            `${warn('[bica]')} Its output is in ${logPath}. Raise --ready-timeout if the server is ` +
            `simply slow, or stop it with \`bica tunnel --stop ${args.localSocket}\`.\n`
        : `${warn('[bica]')} The detached tunnel did not start. Its output is in ${logPath}\n`,
    );
    process.exitCode = 1;
    return;
  }
  writeTunnelRecord({ ...(record as TunnelRecord), logPath });
  process.stderr.write(
    `${dim('[bica]')} ${dim(`Detached and serving ${args.localSocket} (pid ${String(record?.pid ?? child.pid ?? 0)}).`)}\n` +
      `${dim('[bica]')} ${dim(`Output: ${logPath} — stop it with \`bica tunnel --stop ${args.localSocket}\`.`)}\n`,
  );
}

/**
 * Serve a long-lived remote process over a forwarded Unix socket.
 *
 * The client on this side is not told anything: it connects to a path, as it always did, and the work
 * happens on the remote. That is the whole point of forwarding the socket rather than a port -- no
 * caller has to learn a host.
 */
async function cmdTunnel(
  tail: string[],
  options: { detachedByGlobals: boolean },
): Promise<void> {
  const invocation = classifyTunnelInvocation(tail);
  if (invocation.kind === 'list') {
    cmdTunnelList();
    return;
  }
  if (invocation.kind === 'restart') {
    if (invocation.target === undefined || invocation.target === '') {
      die(`--restart needs the local socket path of the tunnel to restart.\n${TUNNEL_USAGE}`);
    }
    await cmdTunnelRestart(invocation.target);
    return;
  }
  if (invocation.kind === 'stop') {
    if (invocation.target === undefined || invocation.target === '') {
      die(`--stop needs the local socket path of the tunnel to stop.\n${TUNNEL_USAGE}`);
    }
    await cmdTunnelStop(invocation.target);
    return;
  }

  const args = parseTunnelArgs(tail, {
    detachedByGlobals: options.detachedByGlobals,
  });

  // One tunnel per local socket. Two of them bind the same path in turn, so the second silently
  // takes the first's clients while the first keeps a remote server alive for nobody -- which is
  // exactly the state that left two processes to be found with `pkill`.
  const claim = claimLocalSocket(args.localSocket);
  if (claim.kind === 'taken') {
    die(
      `A tunnel is already serving ${args.localSocket}:\n` +
        `  ${describeTunnel(claim.by, true)}\n` +
        `Stop it with \`bica tunnel --stop ${args.localSocket}\`, or pick a different --local path.`,
    );
  }
  if (claim.kind === 'stale') {
    process.stderr.write(
      `${dim('[bica]')} ${dim(`Taking over from a tunnel that left a record but no process (pid ${String(claim.previous.pid)}).`)}\n`,
    );
    removeTunnelRecord(args.localSocket);
  }

  if (args.detach) {
    await detachTunnel(args);
    return;
  }

  await ensureRemoteSshHostFromEnvOrPrompt();
  const repoRoot = getRepoRoot();
  const { sshHost, remoteWorkspacePath } = loadRemoteEnvConfig(repoRoot);
  // No sync of its own: the tree the remote process reads is whatever the last `bica run` put there,
  // and syncing here would need the lease this command deliberately does not take.
  process.exitCode = await runTunnel({
    repoRoot,
    sshHost,
    remoteWorkspacePath,
    args,
  });
}

/**
 * End the run holding this workspace and drop its lease.
 *
 * Exists because the exit-98 refusal used to have no in-CLI answer. It named the holder precisely and
 * then offered `ssh <host> kill -TERM -<pgid>` -- which asks the reader to reason about process groups,
 * and which a sandboxed caller frequently cannot run at all, so the only remaining option was to wait
 * out a suite whose output nobody was reading any more.
 *
 * Guarded rather than prompted. A cancel is only ever typed on purpose, but the two cases where it
 * would destroy work someone is watching -- a live client, and a run from another machine -- are both
 * knowable from the claim, so they refuse and say what to do instead. `--force` is for when the caller
 * means it.
 */
async function cmdCancel(options: { force: boolean }): Promise<void> {
  await ensureRemoteSshHostFromEnvOrPrompt();
  const repoRoot = getRepoRoot();
  const { sshHost, remoteWorkspacePath } = loadRemoteEnvConfig(repoRoot);

  const report = remoteReadClaim(sshHost, remoteWorkspacePath);
  if (report === null) {
    process.stderr.write(
      `${dim('[bica]')} ${dim(`No run holds ${sshHost}:${remoteWorkspacePath}; nothing to cancel.`)}\n`,
    );
    return;
  }

  const held = report.heldBy;
  // Rendered by the same helper the refusal uses, so the run the user was told to cancel is described
  // to them the same way twice.
  const who = describeClaim({ ok: false, ...report });

  if (held.host !== os.hostname() && !options.force) {
    process.stderr.write(
      `${warn('[bica]')} The workspace is held by ${who} — another machine.\n` +
        'Cancelling would kill a run whose output is going to someone else\'s terminal, and this host\n' +
        'cannot tell whether it is healthy. Cancel it there, or pass --force if you are certain.\n',
    );
    process.exitCode = 1;
    return;
  }

  const clientAlive = held.host === os.hostname() && isProcessAlive(held.pid);
  if (clientAlive && !options.force) {
    process.stderr.write(
      `${warn('[bica]')} ${who} is still running on this machine, and its client is alive.\n` +
        `Interrupt it where it is running (Ctrl-C stops the client and the remote together), or pass\n` +
        '--force to end it from here.\n',
    );
    process.exitCode = 1;
    return;
  }

  if (clientAlive) {
    // Signal the client and let it unwind itself, rather than reaching past it to the remote. Its
    // SIGTERM handler ends the remote command, releases the lease, and stops the mutagen session --
    // three things this command cannot do from outside. Clearing the claim out from under a live
    // client instead would leave it running a command whose result is discarded at the end-of-run
    // check: correct, but a slower and more confusing way to arrive here.
    process.kill(held.pid, 'SIGTERM');
    process.stderr.write(
      `${dim('[bica]')} Signalled its client (pid ${String(held.pid)}); it is ending the remote command and releasing the workspace. (${who})\n`,
    );
    return;
  }

  const outcome = remoteCancelClaim(sshHost, remoteWorkspacePath, held.runId);
  if (outcome.notMine) {
    // The claim changed under us, which means a run arrived legitimately between the read and the
    // cancel. Leaving it alone is the whole point of scoping the cancel to a run id.
    process.stderr.write(
      `${warn('[bica]')} ${dim('The workspace was claimed by a different run while cancelling; left it alone.')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const what = outcome.signalled
    ? 'Signalled the remote process group and cleared the lease.'
    : outcome.neverRan
      ? 'That run never reached the remote, so there was nothing to stop; cleared the lease it left behind.'
      : 'The remote command had already finished; cleared the lease it left behind.';
  process.stderr.write(`${dim('[bica]')} ${what} (${who})\n`);
}

async function runWithLiveSession(options: {
  prep: PrepareResult;
  pm: string | undefined;
  tail: string[];
  matchArgvs?: string[][];
  /** The user's commands when several are to run at once; see `concurrentCommands`. */
  concurrentCommands?: string[][];
  captured: boolean;
  /**
   * The lease this run already holds. Passed through to the remote script so it can publish its own
   * pid into the claim and confirm the lease at the end, exactly as the pinned path does.
   *
   * This path went without both for its whole life, which is why the lease's liveness oracle could be
   * wrong here and nothing noticed: the single-command run is the common one.
   */
  owner: ClaimOwner;
  chrome: (text: string) => void;
}): Promise<number> {
  const { prep, pm, tail, captured, chrome } = options;
  const { repoRoot, projectFilePath, sessionName, remoteSyncUrl } = prep;

  // Ephemeral session: terminate anything bound to this repo *and this remote workspace* (any name),
  // start fresh from the current project file, run the command, pull return-flow, terminate.
  // Guarantees the running session's ignore config matches what bica.yml says right now. Scoping to
  // the remote workspace leaves a session for a different workspace untouched.
  const stale = findAllSessionsForRepo(repoRoot, remoteSyncUrl);
  for (const s of stale) {
    chrome(
      `${warn('[bica]')} ${dim(`Terminating existing sync session ${s.name} for ${repoRoot} before fresh start.`)}\n`,
    );
    mutagenSyncTerminate(s.name);
  }

  chrome(
    `${dim('Starting one-way sync to')} ${syncRemoteTarget(remoteSyncUrl)}\n`,
  );
  // Seeded before Mutagen is started, not after: once the session exists it begins staging, and the
  // point of the seed is that Mutagen's first scan finds the files already there.
  const seed = seedRemoteWorkspace({
    sshHost: prep.config.sshHost,
    remoteWorkspacePath: prep.config.remoteWorkspacePath,
    remoteSyncUrl,
    repoRoot,
    ignorePaths: prep.syncIgnorePaths,
  });
  if (seed.ran) {
    process.stderr.write(
      seed.ok
        ? `${dim('[bica]')} ${dim('Seeded the empty remote workspace in one transfer; the sync takes over from here.')}\n`
        : `${warn('[bica]')} ${dim(`Could not seed the remote workspace (${seed.error ?? 'rsync failed'}); the sync will copy it instead, which is slower.`)}\n`,
    );
  }
  if (!mutagenProjectStart(repoRoot, projectFilePath)) {
    process.exit(1);
  }

  // Cleanup hook: terminate the project on any exit path (normal, error, SIGINT, SIGTERM).
  let cleanupDone = false;
  const cleanup = (): void => {
    if (cleanupDone) {
      return;
    }
    cleanupDone = true;
    mutagenProjectTerminate(repoRoot, projectFilePath, captured);
  };
  process.on('exit', cleanup);

  let sigintCount = 0;
  const onSigint = (): void => {
    sigintCount += 1;
    if (sigintCount >= 2) {
      // Second Ctrl-C: emergency exit. Cleanup hook still runs via 'exit' event.
      process.removeListener('SIGINT', onSigint);
      process.kill(process.pid, 'SIGINT');
    }
  };
  process.on('SIGINT', onSigint);

  const ready = waitForSyncReady(sessionName, {
    // Not via `chrome`: that hides itself when stdout is captured, and a first sync of a large
    // repository can run for an hour. Silence for an hour in a log is the thing the old sixty-second
    // give-up was reaching for. It is stderr and one line every ten seconds, so nothing that reads
    // bica's stdout is affected.
    onProgress: (line) => {
      process.stderr.write(`${dim('[bica]')} ${dim(line)}\n`);
    },
  });
  if (!ready.ready) {
    // Refused rather than run. This used to say "continuing anyway" and hand the command a directory
    // that was still empty, so the command's own exit code -- 1 from `ls`, 127 from a script that was
    // not there yet -- was reported as the result of a run that never saw a single file.
    for (const line of describeSyncStall({
      lastStatus: ready.lastStatus,
      progress: ready.progress,
      // The budget that was actually applied, which is larger for a phase with nothing to publish.
      stallSeconds: ready.stalledSeconds ?? SYNC_STALL_SECONDS,
    }).split('\n')) {
      process.stderr.write(`${warn('[bica]')} ${line}\n`);
    }
    return SYNC_NOT_READY_EXIT;
  }
  // Force one flush so any pending alpha→beta changes finish before the remote command runs.
  mutagenSyncFlush(repoRoot, sessionName);

  // When git.sync is enabled, mirror local .git to the remote so git-dependent commands
  // (e.g. `vitest --changed`, `jest --changed`) resolve the same history/HEAD/refs as local.
  // .git is intentionally Mutagen-ignored; this one-shot rsync avoids continuous index.lock churn.
  const { syncGit } = resolveBicaPluginConfig(repoRoot);
  if (syncGit) {
    chrome(`${dim('[bica]')} ${dim('Syncing .git → remote (git.sync)…')}\n`);
    const gitPush = pushGitToRemote(prep);
    if (gitPush.ran && gitPush.exitCode === 0) {
      chrome(`${dim('[bica]')} ${dim('.git sync done.')}\n`);
    }
  }

  // Before the command, not after it: a command that believes a stale repository succeeds, and a
  // warning under a successful run is the only place it can be read.
  const staleGit = warnAboutStaleRemoteGit({
    argvs: options.matchArgvs ?? [tail],
    syncGit,
    sshHost: prep.config.sshHost,
    remoteWorkspacePath: prep.config.remoteWorkspacePath,
    repoRoot,
  });
  if (staleGit !== undefined) {
    process.stderr.write(`${warn('[bica]')} ${staleGit}\n`);
  }

  // Return-flow artifacts (snapshots, logs) are Mutagen-ignored, so the forward sync never
  // refreshes them on the remote across a branch switch — the remote keeps the previous branch's
  // snapshots, which then flow back locally. Mirror the current branch's artifacts onto the remote
  // (local → remote, --delete) before the run so it starts clean and can't leak stale cross-branch
  // snapshots back via return-flow.
  if (prep.returnFlowPaths.length > 0) {
    chrome(
      `${dim('[bica]')} ${dim('Refreshing return-flow artifacts on remote…')}\n`,
    );
    const rfPush = pushReturnFlowToRemote(prep);
    if (rfPush.ran && rfPush.exitCode === 0) {
      chrome(`${dim('[bica]')} ${dim('Return-flow remote refresh done.')}\n`);
    }
  }

  // Detection only on this path, never a pull. A live session is `one-way-replica`: it exists to make
  // the remote an exact copy of local, so it reverts remote-side writes as it notices them. That both
  // rules out copying them home — the content may already be gone — and leaves the report worth
  // printing, because a reverted write still moves the file's mtime, so the probe still sees that the
  // command wrote. `--write-back` pins the tree instead, which is the only way to hold those writes
  // still long enough to bring them back.
  // What this used to say was wrong, and wrong in the direction that sends people to the slower path
  // for no reason: it claimed the live session copies local timestamps, so a freshly edited file
  // could arrive older than an object built from the previous copy. Measured against mini, a file
  // stamped 1 January 2025 locally arrives stamped with the time of the transfer. Mutagen propagates
  // content, not mtimes, so a file it delivers is newer than everything already built -- which is
  // the safe direction, and the direction the pinned path has to be *repaired* into.
  //
  // The hazard a compiled project does have on this path is a different one, and it is the reason
  // the pinned sync exists: the session is designed to go on pushing while the command runs, so an
  // edit made mid-build lands behind a build that has already read the old copy of some other file.
  // The result is one artifact assembled from two versions of the tree, which no timestamp reveals.
  if (
    wantsMtimeRepair({
      ...prep,
      buildDir: readLocalBicaSettings(repoRoot).buildDir,
    })
  ) {
    process.stderr.write(
      `${dim('[bica]')} ${dim(
        'The live session keeps pushing while this runs, so an edit made mid-build can land behind ' +
          'a build that has already read the files around it — one artifact from two versions of ' +
          'the tree. `--detach` and `--write-back` pin the tree for the run instead.',
      )}\n`,
    );
  }

  const markerPath = writeBackMarkerPath(options.owner.runId);
  const watchingWrites =
    !writeBackDisabled() &&
    placeWriteBackMarker(
      prep.config.sshHost,
      markerPath,
      runRemoteScriptOverStdin,
    );

  let code: number;
  try {
    code = await runRemoteCommandWithPmHooks({
      prep,
      remoteArgv: tail,
      matchArgvs: options.matchArgvs,
      concurrentCommands: options.concurrentCommands,
      generatedPaths: options.prep.generatedPaths,
      generatedCommand: options.prep.generatedCommand,
      pmOverride: pm,
      assertRunId: options.owner.runId,
      claimPathExpr: claimPathExpr(prep.config.remoteWorkspacePath),
    });
    reportGitDependentHint(
      {
        argvs: options.matchArgvs ?? [tail],
        exitCode: code,
        syncGit,
        fromWorktree: dotGitIsAFile(repoRoot),
      },
      {
        sshHost: prep.config.sshHost,
        remoteWorkspacePath: prep.config.remoteWorkspacePath,
      },
    );
    if (watchingWrites) {
      reportWriteBack(
        collectWriteBack({
          sshHost: prep.config.sshHost,
          remoteWorkspacePath: prep.config.remoteWorkspacePath,
          remoteSyncUrl: prep.remoteSyncUrl,
          repoRoot: prep.repoRoot,
          markerPath,
          ignorePaths: [...prep.syncIgnorePaths, ...prep.returnFlowPaths],
          pushedTreeOid: undefined,
          pull: false,
          run: runRemoteScriptOverStdin,
        }),
        false,
      );
    }
    // Pull whitelisted artifacts (test snapshots, etc.) regardless of remote exit code —
    // failed tests still produce snapshot diffs the user needs locally.
    if (prep.returnFlowPaths.length > 0) {
      chrome(
        `${dim('[bica]')} ${dim(`Pulling return-flow files (${prep.returnFlowPaths.join(', ')})…`)}\n`,
      );
    }
    const pull = pullReturnFlow(prep);
    if (pull.ran && pull.exitCode === 0) {
      chrome(`${dim('[bica]')} ${dim('Return-flow pull done.')}\n`);
    }
    reportArtifactPull(prep);
  } finally {
    process.removeListener('SIGINT', onSigint);
    chrome(`${dim('[bica]')} ${dim('Stopping sync session…')}\n`);
    cleanup();
    process.removeListener('exit', cleanup);
    chrome(`${dim('[bica]')} ${dim('Sync session stopped.')}\n`);
  }

  return code;
}


async function cmdRun(options: {
  pm: string | undefined;
  returnFlow: boolean;
  /** `--write-back`: copy home what the command wrote. Forces a pinned run; see runPinned. */
  writeBack: boolean;
  /** `--detach`: start it and return the run id. Forces a pinned run; see detachedRun.ts. */
  detach: boolean;
  /** Several commands to run concurrently in one workspace, or one command. */
  commands: string[][];
}): Promise<void> {
  const { pm } = options;
  if (options.commands.length === 0) {
    die('usage: bica run <command> [args...]\nExample: bica run pnpm test:run');
  }

  await ensureRemoteSshHostFromEnvOrPrompt();
  const repoRoot = getRepoRoot();
  const baseRemote = loadRemoteEnvConfig(repoRoot);
  // Several commands pin the content: they run for minutes and must all see the same tree, which a
  // live session -- designed to keep pushing later edits -- cannot promise.
  const parallel = options.commands.length > 1;
  // A single command normally uses the live session, but `--write-back` cannot: `one-way-replica`
  // makes the remote an exact copy of local, so it reverts the remote-side writes that would be
  // copied home, and the pinned push is also what supplies the content name the local-edit guard
  // compares against. Pinning is the mechanism, not a preference, so the flag selects it.
  // `--detach` pins for a different reason: the tree must stop moving. A live session goes on
  // mirroring local edits into a workspace that is being compiled for the next hour, and nobody is
  // watching to notice.
  const pinned = parallel || options.writeBack || options.detach;

  if (options.detach && parallel) {
    die(
      'bica run --detach takes one command. Several commands at once need somebody watching their\n' +
        'output, which is the thing --detach gives up.',
    );
  }

  let acquired;
  try {
    acquired = acquireWorkspace({
      remoteWorkspacePath: baseRemote.remoteWorkspacePath,
      runId: `${String(process.pid)}`,
      lease: sshLeaseOps(baseRemote.sshHost),
      sshHost: baseRemote.sshHost,
      command: options.commands.map((c) => c.join(' ')).join(' -- '),
    });
  } catch (e: unknown) {
    // A busy workspace is not a bica failure and not a verdict on the code. Its own exit code lets a
    // caller tell "try later" from "something broke".
    if (e instanceof WorkspaceInUseError || e instanceof RemoteUnreachableError) {
      process.stderr.write(`${e.message}\n`);
      process.exitCode = e.exitCode;
      return;
    }
    throw e;
  }
  const { owner, release } = acquired;
  process.on('exit', release);

  // A caller with a command timeout — a CI step, an agent's shell tool — kills the client with
  // SIGTERM part-way through a run. With no handler the client dies at once and the remote command
  // carries on, holding the lease with nobody reading its output; every later run is then correctly
  // refused for as long as the orphan takes to finish. One incident spent six minutes that way.
  //
  // SIGINT is deliberately not handled here. Ctrl-C goes to the foreground process *group*, which
  // includes the ssh, so the remote already dies with it — that case was never the broken one, and
  // the live-session path has its own SIGINT handling to unwind mutagen.
  let tearingDown = false;
  const onFatalSignal = (signal: NodeJS.Signals, exitCode: number) => {
    if (tearingDown) {
      return;
    }
    tearingDown = true;
    process.stderr.write(
      `\n${warn('[bica]')} ${signal} received — ending the remote command and releasing the workspace.\n`,
    );
    // Remote first: this signals the process group and removes the claim in one round-trip, so the
    // workspace is never advertised as free while the command is still winding down. Killing the local
    // ssh afterwards is what stops us waiting on a connection we no longer want.
    remoteCancelClaim(baseRemote.sshHost, baseRemote.remoteWorkspacePath, owner.runId);
    terminateLiveRemoteCommand();
    process.removeListener('exit', release);
    process.exit(exitCode);
  };
  const onSigterm = (): void => {
    onFatalSignal('SIGTERM', 143);
  };
  const onSighup = (): void => {
    onFatalSignal('SIGHUP', 129);
  };
  process.on('SIGTERM', onSigterm);
  process.on('SIGHUP', onSighup);

  const captured = !process.stdout.isTTY;
  const chrome = (text: string): void => {
    if (!captured) {
      process.stderr.write(text);
    }
  };

  // Several commands are coordinated here, not by a script written for the remote: `remoteArgv` is
  // the first of them and is ignored when `concurrentCommands` has more than one.
  const remoteArgv = options.commands[0];
  const concurrentCommands = parallel ? options.commands : undefined;

  const prep = prepareSyncProjectFile({ verbose: false });
  let code: number;
  /** A detached run keeps the workspace while it builds; `bica wait` is what gives it back. */
  let keepLease = false;
  try {
    if (options.detach) {
      const detachOutcome: DetachOutcomeSink = {};
      code = await runPinned({
        prep,
        remoteArgv,
        matchArgvs: options.commands,
        concurrentCommands: undefined,
        pmOverride: pm,
        returnFlowOptIn: false,
        detachRunId: owner.runId,
        detachOutcome,
        owner,
        chrome,
      });
      if (code === 0 && detachOutcome.exitedEarly === true) {
        // Already over before the launcher let go of it. There is nothing to watch and nothing to
        // come back for, so this collects it here rather than describing it as a run in progress
        // and leaving the workspace leased until somebody thinks to wait for it.
        //
        // The launch output used to disagree with itself about such a run: "finished with exit 1",
        // then "Started detached … to watch", then "remote command exited 0" -- the last of which
        // is the line a reader takes as the result, and it was reporting the launcher.
        keepLease = true;
        process.removeListener('exit', release);
        process.removeListener('SIGTERM', onSigterm);
        process.removeListener('SIGHUP', onSighup);
        process.stdout.write(`${owner.runId}\n`);
        process.stderr.write(
          `${dim('[bica]')} ${dim('It was already finished when the launcher let go, so bica collected it rather than leaving it to `bica wait`.')}\n`,
        );
        // The same path `bica wait` takes: the artifacts, the lease, and the record marked finished
        // so a later `bica wait <id>` answers with this code instead of asking a workspace that has
        // moved on.
        code = await cmdWait(owner.runId, {});
      } else if (code === 0) {
        // The lease is deliberately left held: the build is still going, and a second `bica run`
        // must meet 98 rather than rsync over a compile. `bica wait` gives it back.
        keepLease = true;
        process.removeListener('exit', release);
        process.removeListener('SIGTERM', onSigterm);
        process.removeListener('SIGHUP', onSighup);
        process.stdout.write(`${owner.runId}\n`);
        process.stderr.write(
          `${dim('[bica]')} ${dim(`Started detached. \`bica logs ${owner.runId} --follow\` to watch, \`bica wait ${owner.runId}\` for its exit code and artifacts.`)}\n`,
        );
      }
    } else if (pinned) {
      code = await runPinned({
        prep,
        remoteArgv,
        matchArgvs: options.commands,
        concurrentCommands,
        pmOverride: pm,
        returnFlowOptIn: options.returnFlow,
        writeBackOptIn: options.writeBack,
        owner,
        chrome,
      });
    } else {
      assertMutagenInstalled();
      code = await runWithLiveSession({
        prep,
        pm,
        tail: remoteArgv,
        matchArgvs: options.commands,
        concurrentCommands,
        captured,
        owner,
        chrome,
      });
    }
  } finally {
    if (!keepLease) {
      release();
    }
    process.removeListener('exit', release);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGHUP', onSighup);
  }

  process.stderr.write(`${remoteExitStatusLine(code)}\n`);
  process.exitCode = code;
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  let globals: ParsedGlobals;
  try {
    globals = parseArgs(raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    die(msg);
  }
  const { autoYes, pm, rest } = globals;

  // Maintainer: tsx watch (see scripts/dev.cjs) re-runs the CLI on save; default argv is this
  // no-op so we do not print the full help page on every file change.
  if (rest.length === 1 && rest[0] === 'watch-idle') {
    process.exit(0);
  }

  if (rest[0] === '--version' || rest[0] === '-v' || rest[0] === 'version') {
    console.log(ownVersion());
    process.exit(0);
  }

  if (rest.length === 0 || rest[0] === 'help' || rest[0] === '--help') {
    printHelp();
    process.exit(rest.length === 0 ? 1 : 0);
  }

  const sub = rest[0];
  const tail = rest.slice(1);

  try {
    // `tunnel` is in the set because starting one needs a host and a remote path. Ending or listing
    // one needs neither -- those read `~/.bica/tunnels` and nothing else -- and refusing them outside
    // a configured repository made `--stop` unusable from exactly the directory somebody debugging a
    // stuck tunnel happens to be standing in.
    const needsSpec =
      sub === 'tunnel'
        ? tunnelNeedsWorkspace(tail)
        : COMMANDS_NEEDING_BICA_SPEC.has(sub);
    if (needsSpec) {
      await ensureBicaWorkspaceOrInteractiveSetup(sub);
    }

    switch (sub) {
      case 'init':
        await cmdInit();
        break;
      case 'prepare':
        await cmdPrepare();
        break;
      case 'start':
        await cmdStart(autoYes);
        break;
      case 'stop':
        cmdStop();
        break;
      case 'list':
        cmdList();
        break;
      case 'monitor':
        cmdMonitor();
        break;
      case 'credentials':
        if (tail[0] !== 'sync') {
          die('usage: bica credentials sync [plugin-id...]');
        }
        await cmdCredentialsSync(tail.slice(1));
        break;
      case 'plugins':
        if (tail[0] !== 'list') {
          die('usage: bica plugins list');
        }
        cmdPluginsList();
        break;
      case 'ssh':
        await cmdSsh();
        break;
      case 'doctor':
        cmdDoctor();
        break;
      case 'tunnel':
        await cmdTunnel(tail, { detachedByGlobals: globals.detach });
        break;
      case 'cancel': {
        const force = tail.includes('--force');
        const unknown = tail.filter((t) => t !== '--force');
        if (unknown.length > 0) {
          die('usage: bica cancel [--force]');
        }
        await cmdCancel({ force });
        break;
      }
      case 'run':
        await cmdRun({
          pm,
          returnFlow: globals.returnFlow,
          writeBack: globals.writeBack,
          detach: globals.detach,
          commands: splitParallelCommands(tail),
        });
        break;
      case 'runs':
        if (tail.length > 0) {
          die('usage: bica runs');
        }
        process.exitCode = cmdRuns();
        break;
      case 'logs': {
        const follow = tail.includes('--follow') || tail.includes('-f');
        const id = tail.find((t) => !t.startsWith('-'));
        if (id === undefined) {
          die('usage: bica logs <run-id> [--follow]');
        }
        process.exitCode = await cmdLogs(id, { follow });
        break;
      }
      case 'wait': {
        const id = tail.find((t) => !t.startsWith('-'));
        if (id === undefined) {
          die('usage: bica wait <run-id>');
        }
        process.exitCode = await cmdWait(id);
        break;
      }
      case 'build':
        if (tail.length > 0) {
          die('usage: bica build');
        }
        cmdBuild();
        break;
      case 'dev':
        cmdDev(tail);
        break;
      default:
        die(
          `Unknown command "${sub}". Run \`bica help\` for usage.\n` +
            'Tip: run remote commands with `bica run <command> [args...]`.',
        );
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    die(msg);
  }
}

// Guarded so the module can be imported for testing; the bin entry runs this file directly.
if (process.argv[1] !== undefined && process.argv[1].endsWith('cli.ts')) {
  void main();
}
