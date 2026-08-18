import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import chalk from 'chalk';

import { resolveBicaPluginConfig } from '../bicaWorkspaceConfig';
import { resolveActiveRemoteShellPlugins } from '../resolveActivePlugins';
import { dim } from '../terminalStyle';
import type { RemoteShellPlugin } from '../plugins/types';

function loginShellFromEnv(): string {
  const shell = process.env.BICA_LOGIN_SHELL?.trim();
  return shell !== undefined && shell.length > 0 ? shell : 'zsh';
}

function loginFlagsFromEnv(): string[] {
  const bica = process.env.BICA_LOGIN_FLAGS?.trim();
  const hasBica = bica !== undefined && bica.length > 0;
  const custom = hasBica ? bica : undefined;
  if (custom !== undefined) {
    return custom.split(/\s+/).filter(Boolean);
  }
  // Drop -i (interactive): it enables precmd hooks (e.g. mise's _mise_hook) that fire between
  // commands and reset PATH, undoing our pathBoost and even Mise's own tool paths.
  // Login (-l) is sufficient to source .zprofile / .zlogin where tool managers activate.
  return ['-lc'];
}

/**
 * SSH options that keep long remote commands (e.g. `cargo build`) alive across quiet stretches.
 * ServerAliveInterval probes every 30s; CountMax 20 tolerates ~10 min of silence before giving up,
 * avoiding "Broken pipe" / "Connection reset" drops on slow downloads or compiles.
 * Extra opts can be appended via BICA_SSH_OPTS (space-separated, each token passed verbatim).
 */
function sshKeepaliveOpts(): string[] {
  const base = [
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=20',
    '-o',
    'TCPKeepAlive=yes',
  ];
  const extra = process.env.BICA_SSH_OPTS?.trim();
  if (extra !== undefined && extra.length > 0) {
    base.push(...extra.split(/\s+/).filter(Boolean));
  }
  return base;
}

/**
 * Escape a path segment for use inside double quotes on the remote shell (zsh/bash).
 */
function escapeForDoubleQuotedRemotePath(s: string): string {
  return s
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', '\\$')
    .replaceAll('`', '\\`');
}

/**
 * Expression for `cd` on the remote. Tilde must not be wrapped in single quotes — it would not expand.
 */
export function remotePathExprForCd(remoteWorkspacePath: string): string {
  const p = remoteWorkspacePath.trim();
  if (p === '~') {
    return '"$HOME"';
  }
  if (p.startsWith('~/')) {
    const tail = p.slice(2);
    return `"$HOME/${escapeForDoubleQuotedRemotePath(tail)}"`;
  }
  // Double quotes only: single quotes inside the remote -c script can break sshd wrapping.
  return `"${escapeForDoubleQuotedRemotePath(p)}"`;
}

const remoteHomeDirCache = new Map<string, string>();

interface RemoteHomeProbeLog {
  sshHost: string;
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Last remote HOME resolution probe (`sh -c 'cd && pwd'`, any outcome) for mkdir failure diagnostics. */
let lastRemoteHomeProbe: RemoteHomeProbeLog | null = null;

/** Wrap `s` in single quotes for a POSIX `sh -c '…'` script (paths only; escapes embedded `'`). */
export function shellSingleQuoteRemotePathForSh(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Strip CR/LF from ssh stdout / config so mkdir never sees a hidden newline in the path. */
export function sanitizeRemotePosixAbsolutePath(p: string): string {
  return p.replaceAll(/\r|\n/g, '').trim();
}

function sshTArgv(sshHost: string, ...remote: string[]): string[] {
  return ['ssh', '-T', sshHost, ...remote];
}

/**
 * argv lists for a resolved absolute path: run `/bin` then `/usr/bin` with no shell (paths may
 * contain spaces; argv avoids quoting bugs).
 */
function probeResolvedAbsoluteArgvs(
  sshHost: string,
  clean: string,
  kind: 'exists' | 'mkdir',
): string[][] {
  const tool = kind === 'exists' ? 'test' : 'mkdir';
  const flag = kind === 'exists' ? '-d' : '-p';
  return [
    sshTArgv(sshHost, `/bin/${tool}`, flag, clean),
    sshTArgv(sshHost, `/usr/bin/${tool}`, flag, clean),
  ];
}

function spawnSshArgvSync(
  argv: string[],
  stdio: 'quiet' | 'inheritStdout',
): { status: number; stderr: string } {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    stdio:
      stdio === 'quiet'
        ? ['ignore', 'pipe', 'pipe']
        : ['ignore', 'inherit', 'pipe'],
    shell: false,
  });
  return { status: result.status ?? 1, stderr: result.stderr };
}

function formatArgvForDiag(argv: readonly string[]): string {
  return argv.map((a) => JSON.stringify(a)).join(' ');
}

function writeRemoteMkdirFailureDiagnostics(options: {
  sshHost: string;
  configuredPath: string;
  resolveAbsolute: string | null;
  exitCode: number;
  mkdirArgv: readonly string[];
  mkdirStderr: string;
  probe: RemoteHomeProbeLog | null;
  fallbackScript?: string;
}): void {
  const bits: string[] = [
    `${chalk.bold.yellow('[bica]')} Remote mkdir failed (exit ${options.exitCode}).`,
    `configured=${JSON.stringify(options.configuredPath)}`,
    `resolved=${JSON.stringify(options.resolveAbsolute ?? '(shell path)')}`,
    `ssh=${formatArgvForDiag(options.mkdirArgv)}`,
  ];
  if (options.probe !== null) {
    bits.push(
      `HOME_probe status=${options.probe.status} out=${JSON.stringify(options.probe.stdout.slice(0, 200))}`,
    );
    if (options.probe.stderr.trim().length > 0) {
      bits.push(
        `HOME_probe err=${JSON.stringify(options.probe.stderr.slice(0, 160))}`,
      );
    }
  }
  if (options.fallbackScript !== undefined) {
    bits.push(`fallback=${JSON.stringify(options.fallbackScript)}`);
  }
  if (options.mkdirStderr.trim().length > 0) {
    bits.push(`stderr=${JSON.stringify(options.mkdirStderr.slice(0, 200))}`);
  }
  if (process.env.BICA_DEBUG?.trim() !== '1') {
    bits.push(dim('Tip: BICA_DEBUG=1 for full remote script log.'));
  }
  process.stderr.write(`${bits.join(' ')}\n`);
}

/**
 * Some sshd/PAM setups print MOTD or banners to stdout before the remote command runs. Then a
 * naive `trim()` leaves `Welcome…\n/Users/you` which is not a valid directory path for mkdir.
 * Take the last line that looks like an absolute POSIX path (typical real $HOME).
 */
export function pickRemoteHomeFromSshStdout(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of [...lines].reverse()) {
    if (path.posix.isAbsolute(line) && line !== '/') {
      return line;
    }
  }
  return null;
}

/** Remote $HOME (POSIX), for expanding ~/… without fragile `zsh -c` quoting. Cached per host. */
function getRemoteHomeDir(sshHost: string): string | null {
  const cached = remoteHomeDirCache.get(sshHost);
  if (cached !== undefined) {
    return cached.length > 0 ? cached : null;
  }
  // Avoid `printf %s "$HOME"`: on macOS/BSD, printf with a missing or empty argument can exit 2
  // with "printf: usage: …". POSIX `cd` with no operands changes to $HOME; `pwd` prints it.
  const result = spawnSync('ssh', ['-T', sshHost, 'sh', '-c', 'cd && pwd'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const raw = typeof result.stdout === 'string' ? result.stdout : '';
  const err = result.stderr;
  lastRemoteHomeProbe = {
    sshHost,
    status: result.status,
    stdout: raw,
    stderr: err,
  };
  if (result.status !== 0) {
    return null;
  }
  const parsed = pickRemoteHomeFromSshStdout(raw);
  if (parsed === null) {
    return null;
  }
  remoteHomeDirCache.set(sshHost, parsed);
  return parsed;
}

/**
 * POSIX absolute path on the remote, or null if we need shell expansion (e.g. `~other/…`).
 */
export function tryResolveRemoteWorkspaceAbsolutePath(
  sshHost: string,
  remoteWorkspacePath: string,
): string | null {
  const p = remoteWorkspacePath.trim();
  if (p === '') {
    return null;
  }
  if (p.startsWith('~') && p !== '~' && !p.startsWith('~/')) {
    return null;
  }
  if (path.posix.isAbsolute(p)) {
    return sanitizeRemotePosixAbsolutePath(p);
  }
  const home = getRemoteHomeDir(sshHost);
  if (home === null) {
    return null;
  }
  if (p === '~') {
    return sanitizeRemotePosixAbsolutePath(home);
  }
  if (p.startsWith('~/')) {
    return sanitizeRemotePosixAbsolutePath(path.posix.join(home, p.slice(2)));
  }
  return sanitizeRemotePosixAbsolutePath(path.posix.join(home, p));
}

/**
 * argv for `ssh -T host <shell> … -c <script>` without sourcing login rc (quiet probe / mkdir).
 */
/**
 * Run a script on the remote by feeding it to the shell on **stdin**.
 *
 * The argv form (`ssh host zsh -f -c <script>`) cannot carry a multi-line script. ssh joins its
 * arguments with spaces into one string and the remote *login* shell parses that before anything else
 * sees it, so `zsh -f -c` receives only the first word and the remaining lines are executed by the
 * login shell instead. Single-line probes happened to survive; multi-line ones silently did not, which
 * is why `mise trust` never actually ran.
 *
 * stdin sidesteps the whole problem: nothing re-parses the script, so no quoting scheme is needed.
 */
export function runRemoteScriptOverStdin(
  sshHost: string,
  script: string,
): { status: number; stdout: string; stderr: string } {
  const shell = loginShellFromEnv();
  const runner = shell.includes('bash')
    ? [shell, '--noprofile', '--norc', '-s']
    : [shell, '-f', '-s'];
  const result = spawnSync('ssh', ['-T', sshHost, ...runner], {
    input: script,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function buildRemoteProbeSshArgv(sshHost: string, script: string): string[] {
  const shell = loginShellFromEnv();
  let runner: string[];
  if (shell.includes('bash') || path.basename(shell) === 'bash') {
    runner = [shell, '--noprofile', '--norc', '-c', script];
  } else if (shell.includes('zsh') || path.basename(shell) === 'zsh') {
    runner = [shell, '-f', '-c', script];
  } else {
    runner = [shell, '-c', script];
  }
  return ['ssh', '-T', sshHost, ...runner];
}

function resolvedAbsoluteDirExists(sshHost: string, clean: string): boolean {
  for (const argv of probeResolvedAbsoluteArgvs(sshHost, clean, 'exists')) {
    const { status } = spawnSshArgvSync(argv, 'quiet');
    if (status === 0) {
      return true;
    }
    if (status !== 127 && status !== 126) {
      return false;
    }
  }
  return false;
}

function resolvedAbsoluteMkdir(
  sshHost: string,
  clean: string,
  configuredPath: string,
  resolveAbsolute: string,
): number {
  const attempts = probeResolvedAbsoluteArgvs(sshHost, clean, 'mkdir');
  let last: { argv: string[]; status: number; stderr: string } | undefined;
  for (const argv of attempts) {
    const r = spawnSshArgvSync(argv, 'inheritStdout');
    last = { argv, status: r.status, stderr: r.stderr };
    if (r.status === 0) {
      return 0;
    }
  }
  if (last !== undefined && last.status !== 0) {
    writeRemoteMkdirFailureDiagnostics({
      sshHost,
      configuredPath,
      resolveAbsolute,
      exitCode: last.status,
      mkdirArgv: last.argv,
      mkdirStderr: last.stderr,
      probe: lastRemoteHomeProbe,
    });
  }
  return last?.status ?? 1;
}

/** Whether `remoteWorkspacePath` exists as a directory on the SSH host (no login rc). */
export function remoteWorkspaceDirExists(
  sshHost: string,
  remoteWorkspacePath: string,
): boolean {
  const absolute = tryResolveRemoteWorkspaceAbsolutePath(
    sshHost,
    remoteWorkspacePath,
  );
  if (absolute !== null) {
    const clean = sanitizeRemotePosixAbsolutePath(absolute);
    return resolvedAbsoluteDirExists(sshHost, clean);
  }
  const dir = remotePathExprForCd(remoteWorkspacePath);
  const script = `test -d ${dir}`;
  const argv = buildRemoteProbeSshArgv(sshHost, script);
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

/** `mkdir -p` for the workspace path on the SSH host (no login rc). */
export function remoteMkdirWorkspace(
  sshHost: string,
  remoteWorkspacePath: string,
): number {
  const absolute = tryResolveRemoteWorkspaceAbsolutePath(
    sshHost,
    remoteWorkspacePath,
  );
  if (absolute !== null) {
    const clean = sanitizeRemotePosixAbsolutePath(absolute);
    return resolvedAbsoluteMkdir(sshHost, clean, remoteWorkspacePath, absolute);
  }
  const dir = remotePathExprForCd(remoteWorkspacePath);
  const script = `mkdir -p -- ${dir}`;
  const argv = buildRemoteProbeSshArgv(sshHost, script);
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'pipe'],
    shell: false,
  });
  const code = result.status ?? 1;
  if (code !== 0) {
    const mkdirStderr = result.stderr;
    writeRemoteMkdirFailureDiagnostics({
      sshHost,
      configuredPath: remoteWorkspacePath,
      resolveAbsolute: null,
      exitCode: code,
      mkdirArgv: argv,
      mkdirStderr,
      probe: lastRemoteHomeProbe,
      fallbackScript: script,
    });
  }
  return code;
}

/**
 * `rm -rf` a lane workspace on the SSH host, passed as argv so no shell ever sees the path.
 *
 * Recursive remote deletion is the one genuinely destructive thing bica does, so the path is checked
 * twice: the caller must prove it derived from the configured base path plus a `-lane-<id>` suffix
 * (see `isLaneRemotePath`), and this function refuses anything that does not resolve to an absolute
 * path of at least two segments — never `/`, never a bare `$HOME`, never the base workspace.
 */
export function remoteRemoveLaneDirectory(
  sshHost: string,
  remoteLanePath: string,
): { ok: boolean; reason?: string } {
  const absolute = tryResolveRemoteWorkspaceAbsolutePath(
    sshHost,
    remoteLanePath,
  );
  if (absolute === null) {
    return {
      ok: false,
      reason: `could not resolve ${remoteLanePath} to an absolute remote path`,
    };
  }
  const clean = sanitizeRemotePosixAbsolutePath(absolute);
  const segments = clean.split('/').filter(Boolean);
  if (!path.posix.isAbsolute(clean) || segments.length < 2) {
    return {
      ok: false,
      reason: `refusing to remove ${clean}: too close to the filesystem root`,
    };
  }
  if (!/-lane-[a-z0-9-]+$/.test(clean)) {
    return {
      ok: false,
      reason: `refusing to remove ${clean}: not a lane workspace path`,
    };
  }
  for (const rm of ['/bin/rm', '/usr/bin/rm']) {
    const { status, stderr } = spawnSshArgvSync(
      sshTArgv(sshHost, rm, '-rf', '--', clean),
      'quiet',
    );
    if (status === 0) {
      return { ok: true };
    }
    if (status !== 127 && status !== 126) {
      return { ok: false, reason: stderr.trim() || `ssh exited ${String(status)}` };
    }
  }
  return { ok: false, reason: 'no usable rm on the remote host' };
}

/** Exit code the remote uses when another run took the workspace while this one was executing. */
export const REMOTE_CONTENT_MISMATCH_EXIT = 97;

export interface RecordedRemoteExit {
  /** Exit code the command recorded, when it got as far as recording one. */
  exitCode: number | null;
  /** Whether the recording belongs to the run that asked. */
  mine: boolean;
}

/**
 * Read the exit code a run recorded into its claim file.
 *
 * The claim doubles as the record so there is one file rather than two: `<runid> <host> <pid>` while
 * the command runs, with the exit code appended as a fourth field once it finishes.
 *
 * Consulted only when ssh itself reports 255, which is ambiguous — it is both ssh's own code for a
 * dropped connection and a legitimate exit code a command may choose. The recording settles it as a
 * fact, because the command writes it as its last act; its absence proves the connection died first.
 */
export function remoteReadRecordedExit(
  sshHost: string,
  claimPath: string,
  runId: string,
): RecordedRemoteExit {
  const result = runRemoteScriptOverStdin(sshHost, `cat ${claimPath} 2>/dev/null\n`);
  if (result.status !== 0) {
    return { exitCode: null, mine: false };
  }
  const fields = result.stdout.trim().split(/\s+/);
  const parsed = Number(fields[3]);
  return {
    exitCode: fields[3] !== undefined && Number.isInteger(parsed) ? parsed : null,
    mine: fields[0] === runId,
  };
}

/**
 * Mark a freshly created remote workspace as trusted by mise, if mise is installed there.
 *
 * A lane is a new directory, so a repo carrying `mise.toml` gets `Config files in … are not trusted`
 * the first time anything runs there. Today mise merely warns and the command still resolves tooling
 * from elsewhere — but that is the failure mode to head off, not tolerate: if `mise.toml` pins the
 * toolchain, an untrusted lane silently runs a *different* node or pnpm than the branch asks for, and
 * a verification that used the wrong toolchain looks exactly like one that used the right one.
 *
 * Best-effort and silent: no mise, no `mise.toml`, or a non-zero exit all leave the run unaffected.
 * Called only when the workspace was just created, so warm lanes pay nothing.
 */
export function buildMiseTrustScript(remoteWorkspacePath: string): string {
  const dir = remotePathExprForCd(remoteWorkspacePath);
  // Every line is a guard that exits 0, so a host without mise, or a repo without a mise config, is a
  // silent no-op rather than an error the caller has to interpret.
  return (
    `cd ${dir} 2>/dev/null || exit 0\n` +
    'command -v mise >/dev/null 2>&1 || exit 0\n' +
    '[ -f mise.toml ] || [ -f .mise.toml ] || exit 0\n' +
    'mise trust --yes >/dev/null 2>&1 || true\n'
  );
}

export function remoteTrustMiseWorkspace(
  sshHost: string,
  remoteWorkspacePath: string,
): void {
  runRemoteScriptOverStdin(sshHost, buildMiseTrustScript(remoteWorkspacePath));
}

/**
 * Joins shell lines into a script block, one statement per line.
 * Each call appends a trailing newline so blocks compose cleanly.
 */
function shBlock(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

function isBicaDebug(): boolean {
  return process.env.BICA_DEBUG?.trim() === '1';
}

/** Lines printed before ssh so users know KEY=value spam is usually remote zsh login rc. */
const REMOTE_LOGIN_RC_ENV_HINT_LINES = [
  'If many KEY=value lines appear once ssh connects, they usually come from the',
  'remote login shell (e.g. ~/.zprofile). In zsh, export with no variable names lists',
  'every export. That is not bica printing environment variables.',
  'More: packages/bica/README.md (Troubleshooting).',
] as const;

function remoteEnvHintBlock(isDebug: boolean): string {
  const label = isDebug
    ? chalk.bold.magenta('[bica-debug]')
    : chalk.bold.cyan('[bica]');
  const body = REMOTE_LOGIN_RC_ENV_HINT_LINES.map(
    (line) => `${label} ${dim(line)}`,
  ).join('\n');
  return `\n${body}\n`;
}

/** stderr before ssh: formatted env-dump explanation (not bica). */
function writeRemoteEnvHintToStderr(): void {
  if (process.stderr.isTTY) {
    process.stderr.write(remoteEnvHintBlock(false));
    return;
  }
  if (isBicaDebug()) {
    process.stderr.write(remoteEnvHintBlock(true));
  }
}

/** PATH + mise install globs when no remote-shell plugin (e.g. mise) is active. */
function defaultRemoteToolingPreamble(): string {
  return (
    shBlock(
      'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/share/pnpm:$PATH"',
    ) +
    shBlock(
      'for _d in "$HOME/.local/share/mise/installs/pnpm"/*/; do [ -d "$_d" ] && PATH="${_d%/}:$PATH"; done',
      'for _d in "$HOME/.local/share/mise/installs/node"/*/bin; do [ -d "$_d" ] && PATH="$_d:$PATH"; done',
      'export PATH="$PATH"',
    )
  );
}

function remoteLoginPreambleForRun(repoRoot: string): string {
  const resolved = resolveBicaPluginConfig(repoRoot);
  const active: RemoteShellPlugin[] = resolveActiveRemoteShellPlugins(
    repoRoot,
    resolved,
  );
  if (active.length === 0) {
    return defaultRemoteToolingPreamble();
  }
  const sorted = [...active].sort((a, b) => a.id.localeCompare(b.id));
  return sorted.map((p) => p.remoteShellPreamble({ repoRoot })).join('');
}

/**
 * Builds the `ssh` argv (sans the leading `ssh`) for a remote run.
 *
 * `interactive` gates PTY allocation: `-t` forces a PTY (color + `\r` spinners, for a real
 * terminal); `-T` disables it so remote tools (tsc, pnpm, vitest) auto-detect non-interactive
 * output and emit clean, line-buffered, color-free text — essential when bica's stdout is piped
 * or redirected. Pure for testability.
 */
export function buildRunRemoteSshArgs(opts: {
  interactive: boolean;
  sshHost: string;
  shell: string;
  flags: string[];
  remoteScript: string;
}): string[] {
  return [
    ...sshKeepaliveOpts(),
    opts.interactive ? '-t' : '-T',
    opts.sshHost,
    opts.shell,
    ...opts.flags,
    opts.remoteScript,
  ];
}

/** Exit code the remote uses when it cannot enter the workspace at all. */
export const REMOTE_CD_FAILED_EXIT = 96;

/**
 * Assemble the script the remote shell runs. Pure, so the safety-critical parts are testable without
 * an SSH connection.
 *
 * Written as statements rather than `cd && command` so the exit code can be captured *after* the
 * command without changing anything the command itself observes.
 *
 * The lease is taken before the rsync and lives outside the workspace — see `remoteClaim.ts` for why
 * both of those matter. What happens here is the other half: confirm the lease is still ours once the
 * command has finished, and record the exit code into it. The end-of-run check is what catches a run
 * that took the workspace after this one had already started, and without it that theft is reported as
 * this run's own result.
 */
export function buildRemoteRunScript(options: {
  preamble: string;
  /** Already-quoted `cd` expression for the workspace. */
  cdExpr: string;
  /** POSIX-quoted user command. */
  command: string;
  runId: string | undefined;
  /** Shell expression for the claim file, when this run holds a lease. */
  claimPathExpr?: string;
}): string {
  const { runId, claimPathExpr } = options;
  const leased = runId !== undefined && claimPathExpr !== undefined;
  const q = runId === undefined ? '' : shellSingleQuoteRemotePathForSh(runId);
  const verify = !leased
    ? ''
    : shBlock(
        `_bica_held=$(cut -d' ' -f1 ${claimPathExpr} 2>/dev/null)`,
        `if [ "$_bica_held" != ${q} ]; then`,
        '  echo "[bica] Another run took this workspace while this command was executing; discarding the result." >&2',
        `  exit ${String(REMOTE_CONTENT_MISMATCH_EXIT)}`,
        'fi',
        `printf '%s %s' "$(cat ${claimPathExpr})" "$_bica_ec" > ${claimPathExpr} 2>/dev/null || true`,
      );
  return (
    `${options.preamble}${options.cdExpr} || exit ${String(REMOTE_CD_FAILED_EXIT)}\n` +
    `${options.command}\n` +
    shBlock('_bica_ec=$?') +
    verify +
    shBlock('exit "$_bica_ec"')
  );
}

/**
 * Runs a command on the remote via SSH.
 *
 * Defaults to `zsh -lc` so macOS picks up ~/.zprofile / ~/.zshrc (pnpm, nvm, Homebrew, etc.).
 * Non-macOS remotes: set BICA_LOGIN_SHELL=bash (and optionally BICA_LOGIN_FLAGS=-lc).
 */
export function runRemoteCommand(
  sshHost: string,
  remoteWorkspacePath: string,
  command: string,
  repoRoot: string,
  options?: {
    /** Run id of the lease this run holds, for the end-of-run confirmation. */
    assertRunId?: string;
    /** Shell expression for that lease's file. */
    claimPathExpr?: string;
  },
): number {
  const cd = `cd ${remotePathExprForCd(remoteWorkspacePath)}`;

  const toolingPreamble = remoteLoginPreambleForRun(repoRoot);

  // Fallbacks for non-mise setups (nvm, npm global). Only runs if the mise globs above
  // left node/pnpm unfound, so mise users pay no cost.
  const nonMiseFallbacks = shBlock(
    '# nvm: source it if node is still missing',
    'if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then',
    '  . "$HOME/.nvm/nvm.sh" 2>/dev/null',
    'fi',
    '# npm global bin: add it if pnpm is still missing (covers `npm install -g pnpm`)',
    'if ! command -v pnpm >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then',
    '  _npm_bin="$(npm config get prefix 2>/dev/null)/bin"',
    '  [ -d "$_npm_bin" ] && PATH="$_npm_bin:$PATH" && export PATH="$PATH"',
    'fi',
  );

  const remoteScript = buildRemoteRunScript({
    preamble: `${toolingPreamble}${nonMiseFallbacks}`,
    cdExpr: cd,
    command,
    runId: options?.assertRunId,
    claimPathExpr: options?.claimPathExpr,
  });

  const shell = loginShellFromEnv();
  const flags = loginFlagsFromEnv();

  // Only force a PTY for a genuine interactive terminal. When piped/redirected, `-T` keeps
  // remote tool output clean (no ANSI color, no `\r` spinners, line-buffered).
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const sshArgs = buildRunRemoteSshArgs({
    interactive,
    sshHost,
    shell,
    flags,
    remoteScript,
  });
  if (isBicaDebug()) {
    process.stderr.write(
      `[bica-debug] ssh ${sshArgs[0]} ${sshArgs[1]} ${shell} ${flags.join(' ')}\n${remoteScript}\n---\n`,
    );
  }
  writeRemoteEnvHintToStderr();

  const result = spawnSync('ssh', sshArgs, {
    stdio: 'inherit',
    shell: false,
  });
  return result.status ?? 1;
}

/**
 * Interactive `ssh -t` into the host, `cd` to the workspace, then `exec` a login shell.
 */
export function openRemoteInteractiveSsh(
  sshHost: string,
  remoteWorkspacePath: string,
): number {
  const dir = remotePathExprForCd(remoteWorkspacePath);
  const shell = loginShellFromEnv();
  const remoteCmd = `cd ${dir} && exec ${shell} -l`;
  const result = spawnSync('ssh', [...sshKeepaliveOpts(), '-t', sshHost, remoteCmd], {
    stdio: 'inherit',
    shell: false,
  });
  return result.status ?? 1;
}
