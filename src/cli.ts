/**
 * Bica — remote workspace CLI (`bica <command>`).
 *
 * Env: BICA_SSH_HOST (or TTY prompt), BICA_REMOTE_PATH (optional), and other BICA_* vars below.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NO_LANE, resolveBicaPluginConfig } from './bicaWorkspaceConfig';
import { parseArgs } from './cliArgs';
import {
  cmdLanesClean,
  cmdLanesList,
  cmdLanesPrepare,
} from './laneCommands';
import { terminateConflictingSyncSessions } from './lib/ensureSyncReady';
import { acquireLaneForRun, runPinnedLaneRun } from './lib/laneRun';
import { isLaneRemotePath } from './lib/lanes';
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
import { openRemoteInteractiveSsh } from './lib/runRemote';
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
  'lanes',
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

Parallel runs (lanes)
  A lane is a reusable remote workspace with its own directory, sync session, dependency install
  and run lock, so several 'bica run' invocations from one checkout can execute at once without
  crossing. Lanes are reused rather than created per run: a fresh remote workspace has no
  node_modules (the sync ignores it), and paying an install per run would dwarf the time saved.

  --lane <id>                 Run in that lane. Errors if another run holds it.
  --lane auto                 Run in the first free lane of the pool. Start N invocations with
                              --lane auto to fan out; each takes a different lane.
  --lane none                 Force the default workspace even when config defaults to a lane.
  --lanes <N>                 Pool size for this invocation (default 4, or parallel.lanes in
                              bica.yml, or BICA_LANES).
  --ref <rev>                 Run the *committed* content of a branch/tag/commit instead of the
                              working tree, via a throwaway git worktree. This is what makes a
                              multi-branch sweep possible from one checkout: no checkout happens,
                              so local git can be on any branch (or mid-rebase) while every lane
                              runs. Uncommitted work is not included. Needs a lane.
  --return-flow               Force the remote→local artifact pull even with other runs in flight.
                              By default a lane run pulls when it is the only run (the ordinary
                              case) and skips when others are live, since each would otherwise
                              overwrite the last.

  Tired of typing the flags? Put the defaults in bica.yml and 'bica run pnpm lint' is enough:

    run:
      lane: auto        # or a lane id, or none/false for the default workspace
      assumeYes: true   # auto-confirm the prompts a run needs (never 'lanes clean')

  Override per invocation with --lane / --lane none, BICA_LANE, and BICA_ASSUME_YES=0.

  lanes list                  Each lane's remote path, whether a run holds it, and whether its
                              dependencies are installed and current.
  lanes prepare               Sync + install in every lane so a sweep does not pay install cost
                              mid-flight. Sequential: concurrent installs contend on one store.
  lanes clean                 Delete the remote lane workspaces (confirms first; can only ever
                              target paths ending in -lane-<id>, never the base workspace).

  A lane run pins its content with one rsync instead of a live Mutagen session, so switching branches
  locally cannot leak the next branch's files into a run already in flight. Each run names its content
  by git tree OID and the remote re-checks that name after the command, so a run whose workspace was
  taken by another run reports exit 97 instead of someone else's result. The trade is that edits made
  after a lane run starts are not picked up by it, and 'bica start' / 'monitor' still act on the
  default workspace, which a lane run does not use.

  Exit codes worth knowing: 97 = the workspace was replaced mid-command, result discarded, re-run it.
  96 = the remote workspace could not be entered.

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
                              the next 'bica run'. Lane runs use no session at all, so they never
                              disturb a session belonging to the default workspace or another lane.

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
  BICA_LANE                      Default lane for bica run: <id> | auto | none (overrides run.lane)
  BICA_ASSUME_YES                1/0 = auto-confirm run prompts (overrides run.assumeYes)
  BICA_LOGIN_SHELL               Remote shell for non-interactive commands (default zsh)
  BICA_LOGIN_FLAGS               Flags for that shell (default -lc for zsh)
  BICA_DEBUG                     Set to 1 to print the remote script on stderr before ssh (env-dump hint: always on TTY; with debug, also when stderr is not a TTY)
  BICA_SYNC_FLUSH                Set to 1 to run mutagen sync flush before bica run (slower; reduces remote lag vs local)
  BICA_RETURN_FLOW               Set to 0 to disable the post-\`bica run\` rsync that pulls test
                                 snapshots and other whitelisted files back from remote→local
                                 (configure patterns via top-level returnFlow: in bica.yml)

Globals (parsed from the full argv; not forwarded to the remote — put before "run" for clarity)
  -y, --yes              Non-interactive: auto-confirm starting file sync when no session exists yet
                         (or set run.assumeYes / BICA_ASSUME_YES; 'lanes clean' always needs the flag)
  --pm <id>              Disambiguate package-manager hooks when several could match argv[0]
  --lane <id|auto|none>  Run in an isolated, reusable remote workspace (see "Parallel runs")
  --lanes <N>            Lane pool size for --lane auto / the lanes commands
  --ref <rev>            Run a commit's content rather than the working tree (needs --lane)
  --return-flow          Opt a lane run back into the remote→local artifact pull

Examples
  bica init
  bica prepare
  bica --yes run pnpm validate
  bica credentials sync
  bica credentials sync npmrc
  bica plugins list

  # Verify a stacked chain: one lane per branch, all at once, no checkout at all.
  bica lanes prepare --lanes 4
  for b in feat/a feat/b feat/c feat/d; do
    bica --yes run --lane auto --ref "$b" pnpm validate > "verify-$b.log" 2>&1 &
  done; wait
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

async function cmdLanes(
  tail: string[],
  options: { autoYes: boolean; poolOverride: number | undefined },
): Promise<void> {
  const sub = tail[0] ?? 'list';
  if (sub === 'list') {
    cmdLanesList(options.poolOverride);
    return;
  }
  await ensureRemoteSshHostFromEnvOrPrompt();
  if (sub === 'prepare') {
    process.exitCode = await cmdLanesPrepare({
      poolOverride: options.poolOverride,
      // Same benign prompt as a run (create the remote directory), so config may answer it.
      autoYes:
        options.autoYes || resolveBicaPluginConfig(getRepoRoot()).runAssumeYes,
      confirm,
    });
    return;
  }
  if (sub === 'clean') {
    process.exitCode = await cmdLanesClean({
      poolOverride: options.poolOverride,
      // Flag only, never `run.assumeYes`. This confirmation guards a recursive delete of remote
      // directories; a config setting meant to save typing on ordinary runs must not silently
      // authorise that.
      autoYes: options.autoYes,
      confirm,
    });
    return;
  }
  die('usage: bica lanes [list|prepare|clean] [--lanes N]');
}

async function cmdSsh(): Promise<void> {
  await ensureRemoteSshHostFromEnvOrPrompt();
  const repoRoot = getRepoRoot();
  const { sshHost, remoteWorkspacePath } = loadRemoteEnvConfig(repoRoot);
  const code = openRemoteInteractiveSsh(sshHost, remoteWorkspacePath);
  // Set exitCode rather than process.exit() so any buffered stdout/stderr flushes before exit.
  process.exitCode = code;
}

async function runDefaultLane(options: {
  prep: PrepareResult;
  autoYes: boolean;
  pm: string | undefined;
  tail: string[];
  captured: boolean;
  chrome: (text: string) => void;
}): Promise<number> {
  const { prep, autoYes, pm, tail, captured, chrome } = options;
  const { repoRoot, projectFilePath, sessionName, remoteSyncUrl } = prep;

  // Ephemeral session: terminate anything bound to this repo *and this remote workspace* (any name),
  // start fresh from the current project file, run the command, pull return-flow, terminate.
  // Guarantees the running session's ignore config matches what bica.yml says right now. Scoping to
  // the remote workspace leaves concurrent lane sessions — same alpha, different beta — untouched.
  const stale = findAllSessionsForRepo(repoRoot, remoteSyncUrl);
  for (const s of stale) {
    chrome(
      `${warn('[bica]')} ${dim(`Terminating existing sync session ${s.name} for ${repoRoot} before fresh start.`)}\n`,
    );
    mutagenSyncTerminate(s.name);
  }

  // Sessions on some *other* remote workspace used to be swept up by the unscoped sweep above.
  // Scoping is what lets lanes coexist, but it means a session left over from a previous
  // `remotePath` now survives, still pushing this checkout somewhere unexpected. Lane workspaces are
  // legitimate siblings; anything else is worth naming, since a silently surviving session is the
  // kind of thing that later looks like bica running the wrong code.
  const unrelated = findAllSessionsForRepo(repoRoot).filter(
    (s) =>
      s.beta !== remoteSyncUrl &&
      !isLaneRemotePath(
        prep.config.remoteWorkspacePath,
        s.beta.slice(s.beta.indexOf(':') + 1),
      ),
  );
  for (const s of unrelated) {
    chrome(
      `${warn('[bica]')} ${dim(`Session ${s.name} also syncs this checkout, to ${s.beta}. Left running (not this workspace, not a lane) — 'bica stop' or 'mutagen sync terminate ${s.name}' if it is a leftover.`)}\n`,
    );
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
      autoYes,
      pmOverride: pm,
      confirm,
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

async function cmdRun(options: {
  autoYes: boolean;
  pm: string | undefined;
  lane: string | undefined;
  lanes: number | undefined;
  returnFlow: boolean;
  ref: string | undefined;
  tail: string[];
}): Promise<void> {
  const { pm, tail } = options;
  if (tail.length === 0) {
    die('usage: bica run <command> [args...]\nExample: bica run pnpm test:run');
  }

  await ensureRemoteSshHostFromEnvOrPrompt();
  const repoRoot = getRepoRoot();
  const config = resolveBicaPluginConfig(repoRoot);
  const poolSize = options.lanes ?? config.lanePoolSize;

  // Flag beats config beats built-in default. `none` is how config asks for the historical
  // single-workspace run, which `acquireLaneForRun` spells as an absent lane.
  const laneRequest = options.lane ?? config.runLane;
  const laneArg = laneRequest === NO_LANE ? undefined : laneRequest;

  // `--yes` on the command line, or `run.assumeYes` / BICA_ASSUME_YES. This covers only the prompts a
  // run legitimately needs to answer (create the remote directory, start or replace a sync session).
  // `bica lanes clean` deliberately ignores it — see cmdLanes.
  const autoYes = options.autoYes || config.runAssumeYes;

  if (options.ref !== undefined && laneArg === undefined) {
    // The default workspace is driven by a live Mutagen session mirroring the checkout, so there is
    // nowhere for a commit's content to go without fighting that session.
    die(
      '--ref needs a lane: the default workspace is kept in sync with your checkout by a live\n' +
        'session, so it always runs the working tree. Use `--lane auto --ref <rev>`, or set\n' +
        '`run.lane: auto` in bica.yml.',
    );
  }

  const { lane, lock } = acquireLaneForRun({
    repoRoot,
    laneArg,
    poolSize,
  });

  // The lane lock must outlive every other teardown step and survive Ctrl-C, or a killed run leaves
  // its lane permanently unusable. `exit` fires on all paths; the stale-pid takeover in fileLock is
  // the backstop for a hard kill that never reaches it.
  const releaseLock = (): void => {
    lock.release();
  };
  process.on('exit', releaseLock);

  // Captured (piped/redirected) output: suppress decorative `[bica]` chrome and the Mutagen
  // teardown `\r` spinner so the stream is just the remote command's output + one status line.
  const captured = !process.stdout.isTTY;
  const chrome = (text: string): void => {
    if (!captured) {
      process.stderr.write(text);
    }
  };

  const prep = prepareSyncProjectFile({ verbose: false, lane });

  let code: number;
  try {
    if (lane.isDefault) {
      // Mutagen only powers the default workspace; a lane pins its tree with one rsync instead.
      assertMutagenInstalled();
      code = await runDefaultLane({
        prep,
        autoYes,
        pm,
        tail,
        captured,
        chrome,
      });
    } else {
      code = await runPinnedLaneRun({
        prep,
        remoteArgv: tail,
        autoYes,
        pmOverride: pm,
        confirm,
        returnFlowOptIn: options.returnFlow,
        poolSize,
        ref: options.ref,
        chrome,
      });
    }
  } finally {
    releaseLock();
    process.removeListener('exit', releaseLock);
  }

  // Always-print status line so silent-success commands are unambiguous; stderr so `2>/dev/null`
  // still yields a clean command-output-only stream. Set exitCode (not process.exit) so piped
  // stdout/stderr flushes before the event loop drains.
  process.stderr.write(
    `${remoteExitStatusLine(code)}${lane.isDefault ? '' : dim(` [lane ${lane.label}]`)}\n`,
  );
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
      case 'run':
        await cmdRun({
          autoYes,
          pm,
          lane: globals.lane,
          lanes: globals.lanes,
          returnFlow: globals.returnFlow,
          ref: globals.ref,
          tail,
        });
        break;
      case 'lanes':
        await cmdLanes(tail, {
          autoYes,
          poolOverride: globals.lanes,
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

void main();
