import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
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
  options?: {
    /**
     * Source the remote login files. Off by default -- probes are faster without them and do not care.
     * Required for anything that invokes tooling installed by a version manager, because that tooling
     * only exists on PATH once the login shell has activated it.
     */
    login?: boolean;
  },
): { status: number; stdout: string; stderr: string } {
  const login = options?.login === true;
  // A probe runs under plain `sh`, not under the configured login shell.
  //
  // These scripts are POSIX and need no tooling: they read a claim file, test a directory, write a
  // record. Running them through `zsh` -- the default, because the *commands* usually want a login
  // shell that a version manager has set up -- made every one of them depend on zsh existing on the
  // remote. On a Linux host without it, every probe returned 127, and because a failed claim probe
  // was indistinguishable from a held lease, the user was told to wait for a run that did not exist.
  // `sh` is the one shell POSIX guarantees.
  const shell = login ? loginShellFromEnv() : 'sh';
  const runner = login ? [shell, '-l', '-s'] : [shell, '-s'];
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
  // Claim layout is `runId host clientPid [tag=value...] [exitCode]`. The exit code is whatever trails
  // the three mandatory fields and is a bare integer -- reading a fixed index would mistake a tag for
  // it, and reading the last field unconditionally would report the client pid as an exit code for a
  // run that has not finished. Every tag is dropped, not just the ones that exist today: the claim has
  // grown two of them already, and a filter naming them individually is one that silently rots.
  const fields = result.stdout.trim().split(/\s+/);
  const trailing = fields.slice(3).filter((f) => !/^[a-z]+=/.test(f));
  const last = trailing[trailing.length - 1];
  const parsed = Number(last);
  return {
    exitCode: last !== undefined && Number.isInteger(parsed) ? parsed : null,
    mine: fields[0] === runId,
  };
}

/**
 * Mark a freshly created remote workspace as trusted by mise, if mise is installed there.
 *
 * A fresh workspace is a new directory, so a repo carrying `mise.toml` gets `Config files in … are not trusted`
 * the first time anything runs there. Today mise merely warns and the command still resolves tooling
 * from elsewhere — but that is the failure mode to head off, not tolerate: if `mise.toml` pins the
 * toolchain, an untrusted workspace silently runs a *different* node or pnpm than the branch asks for, and
 * a verification that used the wrong toolchain looks exactly like one that used the right one.
 *
 * Best-effort and silent: no mise, no `mise.toml`, or a non-zero exit all leave the run unaffected.
 * Called only when the workspace was just created, so warm workspaces pay nothing.
 */
export function buildMiseTrustScript(remoteWorkspacePath: string): string {
  const dir = remotePathExprForCd(remoteWorkspacePath);
  // Every line is a guard that exits 0, so a host without mise, or a repo without a mise config, is a
  // silent no-op rather than an error the caller has to interpret.
  return (
    `cd ${dir} 2>/dev/null || exit 0\n` +
    'command -v mise >/dev/null 2>&1 || exit 0\n' +
    '[ -f mise.toml ] || [ -f .mise.toml ] || exit 0\n' +
    'mise trust --yes >/dev/null 2>&1 || exit 0\n' +
    // Say so. A step that is silent whether or not it worked cannot be verified, and this one was
    // broken twice over without anyone noticing.
    "printf 'BICA_MISE_TRUSTED\\n'\n"
  );
}

export function remoteTrustMiseWorkspace(
  sshHost: string,
  remoteWorkspacePath: string,
): boolean {
  // A login shell, because `mise` is put on PATH by the remote login files. Run without them the
  // script's own `command -v mise` guard fails and it exits 0 having trusted nothing -- which is what
  // it did, silently, even after the transport bug that also broke it was fixed. Two independent
  // faults in one best-effort step that reports nothing on success is what kept it broken.
  const r = runRemoteScriptOverStdin(
    sshHost,
    buildMiseTrustScript(remoteWorkspacePath),
    { login: true },
  );
  return r.status === 0 && r.stdout.includes('BICA_MISE_TRUSTED');
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

/**
 * The PATH setup bica puts in front of every command, exported so that a check of the remote's
 * tooling asks the same question a run does.
 *
 * A bare login shell on the remote frequently has neither node nor pnpm: a version manager's shims
 * are added here, not there. Checking without this reports tools missing that every run can find.
 */
export function remoteLoginPreambleForRun(repoRoot: string): string {
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
    // Quoted, so that the shell bica asked for receives the whole script as one argument.
    //
    // ssh does not pass argv through: it joins its arguments with spaces and the remote's *own* login
    // shell parses the result. Unquoted, `zsh -lc <script>` therefore became `zsh -lc export` --
    // `-c` taking only the first word -- followed by every remaining line executed by the outer shell
    // instead. Two consequences, both of which were visible for months and explained as something
    // else: a bare `export` lists every exported variable, which is the wall of KEY=value every run
    // printed and which bica's own help attributed to the user's `.zprofile`; and the preamble that
    // puts a version manager's tools on PATH ran in the outer shell, never in the one it was written
    // for. It also meant a missing login shell failed to fail: the script ran anyway, minus its first
    // line.
    shellSingleQuoteRemotePathForSh(opts.remoteScript),
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
  /** Whether to append this command's exit code to the claim. See the option of the same name. */
  recordExitCode?: boolean;
}): string {
  const { runId, claimPathExpr } = options;
  const leased = runId !== undefined && claimPathExpr !== undefined;
  const q = runId === undefined ? '' : shellSingleQuoteRemotePathForSh(runId);
  // Publish this shell's pid into the claim before the command starts.
  //
  // The claim already records the *client's* pid, but the client and this shell have different
  // lifetimes: this one follows the ssh connection, so it outlives any interruption that takes the
  // client without taking the ssh. Without the remote pid, the next run judges such a claim stale from
  // a dead client, breaks the lease, and rsyncs over a command that is still executing right here.
  //
  // Guarded on ownership so a run whose lease was already broken appends to nobody else's claim; it
  // still runs, and the end-of-run check below is what discards its result.
  const publishPid = !leased
    ? ''
    : shBlock(
        `_bica_pre=$(cut -d' ' -f1 ${claimPathExpr} 2>/dev/null)`,
        `if [ "$_bica_pre" = ${q} ]; then`,
        `  printf ' rpid=%s' "$$" >> ${claimPathExpr} 2>/dev/null || true`,
        'fi',
      );
  const verify = !leased
    ? ''
    : shBlock(
        `_bica_held=$(cut -d' ' -f1 ${claimPathExpr} 2>/dev/null)`,
        `if [ "$_bica_held" != ${q} ]; then`,
        '  echo "[bica] Another run took this workspace while this command was executing; discarding the result." >&2',
        `  exit ${String(REMOTE_CONTENT_MISMATCH_EXIT)}`,
        'fi',
        ...(options.recordExitCode === false
          ? []
          : [
              `printf '%s %s' "$(cat ${claimPathExpr})" "$_bica_ec" > ${claimPathExpr} 2>/dev/null || true`,
            ]),
      );
  return (
    `${options.preamble}${options.cdExpr} || exit ${String(REMOTE_CD_FAILED_EXIT)}\n` +
    publishPid +
    `${options.command}\n` +
    shBlock('_bica_ec=$?') +
    verify +
    shBlock('exit "$_bica_ec"')
  );
}

/**
 * Wrap a command so that losing the ssh connection kills it.
 *
 * Without this, a silent long-lived process survives its own tunnel. Dropping the local ssh closes the
 * connection, but with no PTY in play sshd sends no `SIGHUP` to the remote session: a command normally
 * learns its caller is gone by writing to a closed descriptor and taking `SIGPIPE`. Test suites print
 * constantly and so die immediately, which is why `bica run` never needed this. A socket server that
 * prints one line at startup and then waits has nothing to write, so it is reparented to init and runs
 * until somebody logs in to kill it -- holding its socket, so the next tunnel binds a second one and
 * the client talks to whichever it finds.
 *
 * `cat` on stdin is the watchdog. The caller holds that pipe open and writes nothing, so the read
 * blocks for exactly as long as the connection lives and returns the moment it does not.
 *
 * The last statement is a subshell `exit` rather than a plain one: it leaves `$?` as the command's own
 * status for whatever the enclosing script appends, instead of ending the script here.
 */
export function wrapCommandToDieWithConnection(command: string): string {
  return shBlock(
    `${command} &`,
    '_bica_cmd=$!',
    '( cat > /dev/null 2>&1; kill -TERM "$_bica_cmd" 2>/dev/null ) &',
    '_bica_watch=$!',
    'wait "$_bica_cmd"',
    '_bica_ec=$?',
    'kill "$_bica_watch" 2>/dev/null',
    '(exit "$_bica_ec")',
  );
}

/**
 * Runs a command on the remote via SSH.
 *
 * Defaults to `zsh -lc` so macOS picks up ~/.zprofile / ~/.zshrc (pnpm, nvm, Homebrew, etc.).
 * Non-macOS remotes: set BICA_LOGIN_SHELL=bash (and optionally BICA_LOGIN_FLAGS=-lc).
 */

/** Hosts whose login shell has been confirmed to exist, so the check costs one probe per host. */
const confirmedLoginShells = new Map<string, boolean>();

/**
 * Whether the configured login shell exists on the remote.
 *
 * Worth a probe because its absence does not fail -- it half-succeeds, which is worse. ssh joins its
 * arguments into one string and the remote's *own* login shell parses the result, so when `zsh` is
 * missing the first line of the script becomes a "command not found" and every following line is
 * executed by whatever shell the remote actually has. The run then proceeds without its PATH preamble
 * and fails later, somewhere else, for a reason that looks nothing like the cause.
 *
 * Probed under `sh`, which POSIX guarantees, so this check cannot itself depend on the thing it is
 * checking for.
 */
export function remoteLoginShellExists(sshHost: string, shell: string): boolean {
  const key = `${sshHost}\u0000${shell}`;
  const cached = confirmedLoginShells.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const { status } = runRemoteScriptOverStdin(
    sshHost,
    `command -v ${shellSingleQuoteRemotePathForSh(shell)} >/dev/null 2>&1\n`,
  );
  const exists = status === 0;
  confirmedLoginShells.set(key, exists);
  return exists;
}

/**
 * Copy a stream through, putting a label at the start of every line.
 *
 * Line-buffered, because a prefix belongs at the start of a line and chunk boundaries fall wherever
 * the network put them. A trailing partial line is held until its newline arrives, and flushed when
 * the stream ends so nothing is swallowed.
 */
function forwardOutput(
  source: NodeJS.ReadableStream | null,
  label: string | undefined,
  sink: NodeJS.WritableStream,
  tap?: (chunk: string) => void,
): void {
  if (source === null) {
    return;
  }
  if (label === undefined) {
    // Observed but not labelled: the output goes through exactly as written, which is what a single
    // command's progress bars and colour depend on.
    source.setEncoding('utf8');
    source.on('data', (chunk: string) => {
      tap?.(chunk);
      sink.write(chunk);
    });
    return;
  }
  const prefix = `${dim(`[${label}]`)} `;
  let pending = '';
  source.setEncoding('utf8');
  source.on('data', (chunk: string) => {
    pending += chunk;
    tap?.(chunk);
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      sink.write(`${prefix}${line}\n`);
    }
  });
  source.on('end', () => {
    if (pending.length > 0) {
      sink.write(`${prefix}${pending}\n`);
      pending = '';
    }
  });
}

/**
 * Every ssh carrying work for this run.
 *
 * A set rather than a slot. A second *run* in one process still does not exist -- the workspace lease
 * sees to that -- but a single run now opens one connection per command, so several are in flight at
 * once and a signal has to reach all of them.
 */
const liveRemotes = new Set<ChildProcess>();

/**
 * Drop the ssh carrying the run, which takes the remote command with it.
 *
 * Killing the local ssh closes the connection, sshd hangs up the session, and the remote process group
 * gets `SIGHUP`. That chain was verified: it is the one teardown that reliably reaches the remote,
 * which is also why an orphaned ssh is so damaging -- the remote has no other way to learn its caller
 * is gone.
 *
 * Returns whether there was anything to kill, so a caller can tell "torn down" from "already over".
 */
export function terminateLiveRemoteCommand(
  signal: NodeJS.Signals = 'SIGTERM',
): boolean {
  let signalled = false;
  for (const child of liveRemotes) {
    if (child.exitCode === null) {
      child.kill(signal);
      signalled = true;
    }
  }
  return signalled;
}

export async function runRemoteCommand(
  sshHost: string,
  remoteWorkspacePath: string,
  command: string,
  repoRoot: string,
  options?: {
    /** Run id of the lease this run holds, for the end-of-run confirmation. */
    assertRunId?: string;
    /** Shell expression for that lease's file. */
    claimPathExpr?: string;
    /**
     * Keep a pipe on the command's stdin and have the remote kill it when that pipe closes, so a
     * process that outlives the connection cannot be left behind. For commands that stay up; a
     * command that finishes on its own does not need it.
     */
    dieWithConnection?: boolean;
    /**
     * Prefix every line of output with this label instead of passing the stream through untouched.
     *
     * For a run of several commands at once, where the alternative is three streams braided into one
     * unreadable column. Absent for a single command, which keeps its output exactly as the remote
     * wrote it -- including the carriage returns and colour a progress bar depends on.
     */
    label?: string;
    /**
     * Called with everything the command writes, as it writes it.
     *
     * The output still goes where it was going; this is a tap, not a diversion. A long-lived server
     * usually says when it is ready to serve, and that line is the only trustworthy statement of
     * readiness available -- a connection proves the socket is listening, which a server that has
     * bound but not begun accepting also satisfies.
     */
    onOutput?: (chunk: string) => void;
    /**
     * Whether this command appends its exit code to the lease when it finishes.
     *
     * True for the only command of a run. False for each of several, because they would race: the
     * record is written by rewriting the whole claim line, and concurrent writers produce a line with
     * several exit codes in it, or none. The orchestrator records one result for the run instead.
     */
    recordExitCode?: boolean;
  },
): Promise<number> {
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

  const dieWithConnection = options?.dieWithConnection === true;
  const remoteScript = buildRemoteRunScript({
    preamble: `${toolingPreamble}${nonMiseFallbacks}`,
    cdExpr: cd,
    command: dieWithConnection
      ? wrapCommandToDieWithConnection(command)
      : command,
    runId: options?.assertRunId,
    claimPathExpr: options?.claimPathExpr,
    recordExitCode: options?.recordExitCode ?? true,
  });

  const shell = loginShellFromEnv();
  const flags = loginFlagsFromEnv();
  if (!remoteLoginShellExists(sshHost, shell)) {
    process.stderr.write(
      `[bica] ${sshHost} has no \`${shell}\`, which is the shell bica runs commands under, so nothing ran.\n` +
        `[bica] Set BICA_LOGIN_SHELL to one it does have (bash on most Linux hosts): BICA_LOGIN_SHELL=bash bica run …\n` +
        '[bica] Checked rather than attempted because a missing login shell does not fail cleanly: ssh hands the\n' +
        "[bica] script to the remote's own shell, which runs most of it without the setup line and fails later.\n",
    );
    return REMOTE_CD_FAILED_EXIT;
  }

  // Only force a PTY for a genuine interactive terminal. When piped/redirected, `-T` keeps
  // remote tool output clean (no ANSI color, no `\r` spinners, line-buffered).
  // Never a PTY when the watchdog is in play: `cat` would read the terminal rather than the pipe, so
  // the signal it waits for would be a keystroke instead of the connection ending.
  const interactive =
    !dieWithConnection && Boolean(process.stdin.isTTY && process.stdout.isTTY);
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
  // Deliberately async, where this was `spawnSync` for most of its life. `spawnSync` pins the event
  // loop for the entire run, so a `SIGTERM` handler registered by the CLI could not run until the
  // remote command had already finished -- the signal would appear to do nothing, then be honoured
  // minutes late. Handling a caller's timeout at all requires the loop to stay free. `stdio: 'inherit'`
  // keeps the output path identical to before: the child writes to bica's own descriptors.
  const label = options?.label;
  const onOutput = options?.onOutput;
  const observing = label !== undefined || onOutput !== undefined;
  const child = spawn('ssh', sshArgs, {
    // The pipe is the watchdog's lifeline: held open and never written, it closes only when this
    // process does, which is precisely when the remote command should stop.
    stdio: !observing
      ? dieWithConnection
        ? ['pipe', 'inherit', 'inherit']
        : 'inherit'
      : [dieWithConnection ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    shell: false,
  });
  if (observing) {
    forwardOutput(child.stdout, label, process.stdout, onOutput);
    forwardOutput(child.stderr, label, process.stderr, onOutput);
  }
  liveRemotes.add(child);
  try {
    return await new Promise<number>((resolve) => {
      // `error` fires instead of `close` when ssh could not be spawned at all; 1 matches what
      // `spawnSync` returned for that case.
      child.on('error', () => resolve(1));
      child.on('close', (code) => {
        resolve(code ?? 1);
      });
    });
  } finally {
    liveRemotes.delete(child);
  }
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
