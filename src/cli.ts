/**
 * Bica — remote workspace CLI (`bica <command>`).
 *
 * Env: BICA_SSH_HOST (or TTY prompt), BICA_REMOTE_PATH (optional), and other BICA_* vars below.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBicaPluginConfig } from './bicaWorkspaceConfig';
import { ensureSyncReady } from './lib/ensureSyncReady';
import {
  mutagenProjectStart,
  mutagenProjectTerminate,
  mutagenSyncList,
  mutagenSyncMonitor,
} from './lib/mutagenSession';
import { confirm, ensureRemoteSshHostFromEnvOrPrompt } from './lib/prompt';
import { openRemoteInteractiveSsh } from './lib/runRemote';
import { runRemoteCommandWithPmHooks } from './lib/runWithPackageManagerPlugins';
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
]);

function parseArgs(argv: string[]): {
  autoYes: boolean;
  pm: string | undefined;
  rest: string[];
} {
  const rest: string[] = [];
  let autoYes = false;
  let pm: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') {
      autoYes = true;
    } else if (a === '--pm') {
      if (i + 1 >= argv.length) {
        throw new Error(
          'usage: --pm requires a package-manager plugin id (e.g. pnpm)',
        );
      }
      const next = argv[i + 1];
      if (next.startsWith('-')) {
        throw new Error(
          'usage: --pm requires a package-manager plugin id (e.g. pnpm)',
        );
      }
      i += 1;
      pm = next;
    } else {
      rest.push(a);
    }
  }
  return { autoYes, pm, rest };
}

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

Workspace
  init                        Interactive setup: create bica.yml + .bica/local.yml (SSH/path).

File sync
  prepare                     Read bica.yml + BICA_* / .bica/local.yml → write the sync project file
                              bica uses for start/stop (derived from your sync: block).
  start / stop / list / monitor
                              Start, stop, list, or watch workspace file sync.

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
  BICA_SYNC_FLUSH                Set to 1 to run mutagen sync flush before bica run (slower; reduces remote lag vs local)

Globals (parsed from the full argv; not forwarded to the remote — put before "run" for clarity)
  -y, --yes              Non-interactive: auto-confirm starting file sync when no session exists yet
  --pm <id>              Disambiguate package-manager hooks when several could match argv[0]

Examples
  bica init
  bica prepare
  bica --yes run pnpm validate
  bica credentials sync
  bica credentials sync npmrc
  bica plugins list
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

async function cmdStart(): Promise<void> {
  await ensureRemoteSshHostFromEnvOrPrompt();
  const prep = prepareSyncProjectFile({ verbose: false });
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
  process.exit(code);
}

async function cmdRun(
  autoYes: boolean,
  pm: string | undefined,
  tail: string[],
): Promise<void> {
  if (tail.length === 0) {
    die('usage: bica run <command> [args...]\nExample: bica run pnpm test:run');
  }

  const prep = await ensureSyncReady({ autoYes });
  const code = await runRemoteCommandWithPmHooks({
    prep,
    remoteArgv: tail,
    autoYes,
    pmOverride: pm,
    confirm,
  });
  process.exit(code);
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  let autoYes = false;
  let pm: string | undefined;
  let rest: string[];
  try {
    const parsed = parseArgs(raw);
    autoYes = parsed.autoYes;
    pm = parsed.pm;
    rest = parsed.rest;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    die(msg);
  }

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
        await cmdStart();
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
        await cmdRun(autoYes, pm, tail);
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
