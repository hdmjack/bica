/**
 * Bica — remote workspace CLI (`bica <command>`).
 *
 * Env: BICA_SSH_HOST (or TTY prompt), BICA_REMOTE_PATH (optional), and other BICA_* vars below.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBicaPluginConfig } from './bicaWorkspaceConfig';
import { parseArgs } from './cliArgs';
import { isProcessAlive } from './lib/fileLock';
import { terminateConflictingSyncSessions } from './lib/ensureSyncReady';
import {
  acquireWorkspace,
  runPinned,
  WorkspaceInUseError,
} from './lib/pinnedRun';
import {
  claimPathExpr,
  remoteCancelClaim,
  remoteReadClaim,
  sshLeaseOps,
} from './lib/remoteClaim';
import type { ClaimOwner } from './lib/remoteClaim';
import {
  assignLabels,
  buildParallelScript,
} from './lib/parallelCommands';
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
  openRemoteInteractiveSsh,
  terminateLiveRemoteCommand,
} from './lib/runRemote';
import { runRemoteCommandWithPmHooks } from './lib/runWithPackageManagerPlugins';
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
  ssh                         Interactive ssh, cd to BICA_REMOTE_PATH, then a login shell.
  cancel [--force]            End the run holding this workspace and drop its lease. For the case a
                              run's client was killed (a CI step or an agent tool hitting its command
                              timeout) and the remote command carried on: the lease is correctly
                              honoured, so every later run is refused until the orphan finishes.
                              Refuses when the holder's client is still alive, or when it belongs to
                              another machine; --force overrides both.

Running several commands at once
  Separate them with --. They run concurrently in one remote workspace, against one copy of the
  files, and each one's output is printed under its own heading:

    bica run pnpm lint -- pnpm typecheck -- pnpm test:run

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

Globals (parsed from the full argv; not forwarded to the remote — put before "run" for clarity)
  -y, --yes              Auto-confirm prompts in 'bica start'. 'bica run' never prompts.
  --pm <id>              Disambiguate package-manager hooks when several could match argv[0]
  --return-flow          Pull remote artifacts back for a pinned run

Examples
  bica init
  bica prepare
  bica run pnpm validate
  bica credentials sync
  bica credentials sync npmrc
  bica plugins list

  # Three checks at once, one workspace, one copy of the files
  bica run pnpm lint -- pnpm typecheck -- pnpm test:run

  # One command
  bica run pnpm test:run
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

  const held = remoteReadClaim(sshHost, remoteWorkspacePath);
  if (held === null) {
    process.stderr.write(
      `${dim('[bica]')} ${dim(`No run holds ${sshHost}:${remoteWorkspacePath}; nothing to cancel.`)}\n`,
    );
    return;
  }

  const who = `run ${held.runId} from ${held.host} (pid ${String(held.pid)}${held.remotePid === undefined ? '' : `, remote pid ${String(held.remotePid)}`})`;

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

  const ready = waitForSyncReady(sessionName, { timeoutMs: 60_000 });
  if (!ready.ready) {
    process.stderr.write(
      `${warn('[bica]')} ${dim(`Sync did not reach a ready state within 60s (last status: ${ready.lastStatus ?? 'unknown'}); continuing anyway.`)}\n`,
    );
  } else {
    // Force one flush so any pending alpha→beta changes finish before the remote command runs.
    mutagenSyncFlush(repoRoot, sessionName);
  }

  // When git.sync is enabled, mirror local .git to the remote so git-dependent commands
  // (e.g. `vitest --changed`, `jest --changed`) resolve the same history/HEAD/refs as local.
  // .git is intentionally Mutagen-ignored; this one-shot rsync avoids continuous index.lock churn.
  if (resolveBicaPluginConfig(repoRoot).syncGit) {
    chrome(`${dim('[bica]')} ${dim('Syncing .git → remote (git.sync)…')}\n`);
    const gitPush = pushGitToRemote(prep);
    if (gitPush.ran && gitPush.exitCode === 0) {
      chrome(`${dim('[bica]')} ${dim('.git sync done.')}\n`);
    }
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

  let code: number;
  try {
    code = await runRemoteCommandWithPmHooks({
      prep,
      remoteArgv: tail,
      matchArgvs: options.matchArgvs,
      generatedPaths: options.prep.generatedPaths,
      generatedCommand: options.prep.generatedCommand,
      pmOverride: pm,
      assertRunId: options.owner.runId,
      claimPathExpr: claimPathExpr(prep.config.remoteWorkspacePath),
    });
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
  } finally {
    process.removeListener('SIGINT', onSigint);
    chrome(`${dim('[bica]')} ${dim('Stopping sync session…')}\n`);
    cleanup();
    process.removeListener('exit', cleanup);
    chrome(`${dim('[bica]')} ${dim('Sync session stopped.')}\n`);
  }

  return code;
}

/**
 * Split `a b -- c d -- e` into three argv lists. `--` is the separator because it keeps every command
 * argv-safe: bica has never shell-split a user's command and should not start now, or `pnpm test "a b"`
 * would silently become two arguments.
 */
export function splitOnDoubleDash(tail: string[]): string[][] {
  const out: string[][] = [[]];
  for (const t of tail) {
    if (t === '--') {
      out.push([]);
    } else {
      out[out.length - 1].push(t);
    }
  }
  const commands = out.filter((c) => c.length > 0);

  // `bica run pnpm test -- --coverage` is the conventional "pass the rest through to the tool" form,
  // and here it means something else entirely: two commands, the second being `--coverage`, which the
  // remote shell reports as `command not found` with exit 127. Refuse it rather than let a habit
  // produce a confusing failure, and say what to do instead — which is simply to drop the `--`, since
  // every token after `run` already reaches the remote as argv.
  for (const cmd of commands) {
    if (cmd[0].startsWith('-')) {
      throw new Error(
        `"${cmd[0]}" cannot start a command — bica expects a program to run.\n` +
          'If it is meant as a flag for the previous command, drop the `--` before it; everything ' +
          'after `run` already reaches the remote as argv:\n' +
          '  bica run pnpm test --coverage\n' +
          '`--` separates whole commands that should run at the same time:\n' +
          '  bica run pnpm lint -- pnpm typecheck\n' +
          'If it is meant as a bica option, it is not one; see `bica help`.',
      );
    }
  }
  return commands;
}

async function cmdRun(options: {
  pm: string | undefined;
  returnFlow: boolean;
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

  let acquired;
  try {
    acquired = acquireWorkspace({
      remoteWorkspacePath: baseRemote.remoteWorkspacePath,
      runId: `${String(process.pid)}`,
      lease: sshLeaseOps(baseRemote.sshHost),
      sshHost: baseRemote.sshHost,
    });
  } catch (e: unknown) {
    // A busy workspace is not a bica failure and not a verdict on the code. Its own exit code lets a
    // caller tell "try later" from "something broke".
    if (e instanceof WorkspaceInUseError) {
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

  const remoteArgv = parallel
    ? ['sh', '-c', buildParallelScript(assignLabels(options.commands))]
    : options.commands[0];

  const prep = prepareSyncProjectFile({ verbose: false });
  let code: number;
  try {
    if (parallel) {
      code = await runPinned({
        prep,
        remoteArgv,
        matchArgvs: options.commands,
        pmOverride: pm,
        returnFlowOptIn: options.returnFlow,
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
        captured,
        owner,
        chrome,
      });
    }
  } finally {
    release();
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

  if (rest.length === 0 || rest[0] === 'help' || rest[0] === '--help') {
    printHelp();
    process.exit(rest.length === 0 ? 1 : 0);
  }

  const sub = rest[0];
  const tail = rest.slice(1);

  try {
    if (COMMANDS_NEEDING_BICA_SPEC.has(sub)) {
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
          commands: splitOnDoubleDash(tail),
        });
        break;
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
