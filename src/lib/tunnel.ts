import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as net from 'node:net';

import { argvToPosixShCommand } from '../remoteArgvToShellCommand';
import { dim, warn } from '../terminalStyle';
import {
  runRemoteCommand,
  shellSingleQuoteRemotePathForSh,
  terminateLiveRemoteCommand,
  tryResolveRemoteWorkspaceAbsolutePath,
} from './runRemote';
import {
  describeTunnel,
  forwardSocketPathFor,
  removeTunnelRecord,
  writeTunnelRecord,
} from './tunnelState';
import type { RestartMode } from './tunnelState';
import {
  ForwardStderr,
  LOCAL_SOCKET_CHECK_MS,
  checkLocalSocket,
  describeBindFailure,
  inodeAt,
} from './tunnelSocketWatch';

/**
 * A long-lived remote process whose Unix socket is forwarded back to a local path.
 *
 * `bica run` exists for commands that finish; this is for the ones that stay. The motivating case is a
 * parser that costs 390 MB resident and is consulted thousands of times: the laptop cannot hold it
 * while an editor is open, and the remote already has every dependency warm because the test suite
 * runs there. Forwarding the socket rather than the port keeps the client unchanged -- it connects to
 * a path, and does not need to learn that the answer now comes from another machine.
 */

/** How long to wait for the remote command to create its socket before giving up. */
export const DEFAULT_READY_TIMEOUT_SECONDS = 60;

/** How often the remote readiness loop looks for the socket. */
const READY_POLL_SECONDS = '0.2';

/** How long a probe connection must stay open before ssh is asked whether it refused. */
const FORWARD_PROBE_SETTLE_MS = 100;

/** How long to wait for ssh to report a refusal it has not got round to printing yet. */
const FORWARD_REFUSAL_GRACE_MS = 400;

/** How often readiness is re-probed through the forward. */
const READY_PROBE_INTERVAL_MS = 500;

/** How long a client may wait for a reply before bica says that it is waiting. */
const UNANSWERED_REQUEST_MS = 20_000;

/** What the forward supervisor reports back the first time it has something to say. */
type FirstReady =
  | { kind: 'ready' }
  | { kind: 'timeout' }
  | { kind: 'bind-failed' }
  | { kind: 'command'; code: number };

export interface TunnelArgs {
  localSocket: string;
  remoteSocket: string;
  readyTimeoutSeconds: number;
  remoteArgv: string[];
  /** What to do when the remote command exits of its own accord. */
  restart: RestartMode;
  /** Run in the background, surviving the shell that started it. */
  detach: boolean;
  /**
   * A pattern the remote command prints when it is ready to serve.
   *
   * The only exact answer available. A socket that accepts a connection proves the server called
   * `listen`, which a server that has bound and not yet begun accepting also satisfies -- the kernel
   * queues those connections either way, so no probe can tell them apart. A server that loads a model
   * for a minute after binding therefore looks ready from outside and answers nothing, which is
   * precisely the failure this exists for. What the server says about itself settles it.
   */
  readyWhen?: RegExp;
}

export const TUNNEL_USAGE =
  'usage: bica tunnel --local=<path.sock> --remote=<path.sock> [--ready-timeout=<seconds>]\n' +
  '                   [--ready-when=<regex>] [--restart=never|on-exit|on-demand] [--detach]\n' +
  '                   -- <command> [args...]\n' +
  '       bica tunnel --list\n' +
  '       bica tunnel --stop <local-socket>';

const RESTART_MODES: readonly RestartMode[] = ['never', 'on-exit', 'on-demand'];

function requireValue(flag: string, token: string): string {
  const value = token.slice(flag.length + 1);
  if (value === '') {
    throw new Error(`${flag} needs a value.\n${TUNNEL_USAGE}`);
  }
  return value;
}

/**
 * Split `bica tunnel`'s own flags from the remote argv.
 *
 * The `--` is mandatory even though the flags all have an `=` form and could in principle be told
 * apart from a command. The remote argv is frequently a `uv run --with …` line of its own flags, and a
 * boundary that has to be inferred is one that can be inferred wrongly -- `bica run` makes the same
 * trade, where everything after the subcommand is argv and nothing else.
 */
/** Which form of `bica tunnel` an invocation is, before any of it is acted on. */
export type TunnelInvocation =
  | { kind: 'list' }
  | { kind: 'restart'; target: string | undefined }
  | { kind: 'stop'; target: string | undefined }
  | { kind: 'start' };

/**
 * Tell the forms apart from the flags alone.
 *
 * Extracted because two callers have to agree on the answer and did not. `cmdTunnel` dispatches on
 * it; `main` uses it to decide whether the command needs a workspace file. `main` had no way to look
 * inside, so every `tunnel` was treated as one that starts a tunnel, and `--stop` and `--list` were
 * refused outside a configured repository -- neither of which reads one. `--stop` is reached for
 * precisely when something has gone wrong, and answering it with "run `bica init` first" sends the
 * caller to configure a repository that has nothing to do with the tunnel they are trying to end.
 *
 * `--restart <path>` is not in that group. It revives a tunnel, so it starts one, and the process it
 * spawns inherits this directory and would fail there instead -- later, and into a log file.
 */
export function classifyTunnelInvocation(
  tail: readonly string[],
): TunnelInvocation {
  if (tail.length === 1 && tail[0] === '--list') {
    return { kind: 'list' };
  }
  const restartAt = tail.findIndex(
    (t) => t === '--restart' || t.startsWith('--restart='),
  );
  // `--restart <path>` revives a recorded tunnel; `--restart=<mode>` configures a new one. They are
  // told apart by what follows, which is unambiguous: a mode is never a path and a path never a mode.
  if (restartAt !== -1 && !tail.includes('--')) {
    const inline = tail[restartAt].startsWith('--restart=')
      ? tail[restartAt].slice('--restart='.length)
      : tail[restartAt + 1];
    return { kind: 'restart', target: inline };
  }
  const stopAt = tail.findIndex((t) => t === '--stop' || t.startsWith('--stop='));
  if (stopAt !== -1) {
    const inline = tail[stopAt].startsWith('--stop=')
      ? tail[stopAt].slice('--stop='.length)
      : tail[stopAt + 1];
    return { kind: 'stop', target: inline };
  }
  return { kind: 'start' };
}

/** Whether this invocation reads the repository's bica.yml, or only `~/.bica/tunnels`. */
export function tunnelNeedsWorkspace(tail: readonly string[]): boolean {
  const kind = classifyTunnelInvocation(tail).kind;
  return kind === 'start' || kind === 'restart';
}

export function parseTunnelArgs(
  tail: readonly string[],
  options: { detachedByGlobals?: boolean } = {},
): TunnelArgs {
  const separator = tail.indexOf('--');
  if (separator === -1) {
    throw new Error(
      `bica tunnel needs \`--\` before the command to run on the remote.\n${TUNNEL_USAGE}`,
    );
  }
  const flags = tail.slice(0, separator);
  const remoteArgv = tail.slice(separator + 1);
  if (remoteArgv.length === 0) {
    throw new Error(`No command given after \`--\`.\n${TUNNEL_USAGE}`);
  }

  let localSocket: string | undefined;
  let remoteSocket: string | undefined;
  let readyTimeoutSeconds = DEFAULT_READY_TIMEOUT_SECONDS;
  let restart: RestartMode = 'never';
  // `--detach` may never reach this function. The CLI lifts a few flags out of the whole command
  // line before it picks a subcommand -- `bica run --detach` needs them read from after the
  // subcommand -- and `--detach` joined that set when detached runs shipped. From that release on,
  // the token was stripped here before the tunnel could see it, so `tunnel --detach` quietly became
  // a foreground tunnel: it bound the socket, printed "Tunnel up" to a terminal nobody was reading,
  // and never returned. `--list` still showed it ready, because a foreground tunnel writes the same
  // record a detached one does, which is why the symptom looked like state left over from an
  // earlier tunnel rather than a missing flag.
  //
  // Passed in rather than pushed back onto `tail`, because the only safe place to re-insert it is
  // before `--`, and getting that wrong appends `--detach` to the command that runs on the remote.
  let detach = options.detachedByGlobals ?? false;
  let readyWhen: RegExp | undefined;

  for (const token of flags) {
    if (token.startsWith('--local=')) {
      localSocket = requireValue('--local', token);
    } else if (token.startsWith('--remote=')) {
      remoteSocket = requireValue('--remote', token);
    } else if (token.startsWith('--ready-timeout=')) {
      const raw = requireValue('--ready-timeout', token);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(
          `--ready-timeout must be a positive number of seconds (got ${JSON.stringify(raw)}).`,
        );
      }
      readyTimeoutSeconds = parsed;
    } else if (token.startsWith('--restart=')) {
      const raw = requireValue('--restart', token);
      if (!RESTART_MODES.includes(raw as RestartMode)) {
        throw new Error(
          `--restart must be one of ${RESTART_MODES.join(', ')} (got ${JSON.stringify(raw)}).`,
        );
      }
      restart = raw as RestartMode;
    } else if (token === '--restart') {
      // The bare form is the one people reach for, and silently meaning `never` would be a trap.
      throw new Error(
        `--restart needs a value: ${RESTART_MODES.join(', ')}.\n${TUNNEL_USAGE}`,
      );
    } else if (token.startsWith('--ready-when=')) {
      const raw = requireValue('--ready-when', token);
      try {
        readyWhen = new RegExp(raw);
      } catch {
        throw new Error(
          `--ready-when must be a regular expression (got ${JSON.stringify(raw)}).`,
        );
      }
    } else if (token === '--detach') {
      detach = true;
    } else {
      throw new Error(`Unknown option "${token}".\n${TUNNEL_USAGE}`);
    }
  }

  if (localSocket === undefined || remoteSocket === undefined) {
    throw new Error(`--local and --remote are both required.\n${TUNNEL_USAGE}`);
  }
  if (!path.isAbsolute(localSocket)) {
    throw new Error(
      `--local must be an absolute path (got ${JSON.stringify(localSocket)}).`,
    );
  }
  return {
    localSocket,
    remoteSocket,
    readyTimeoutSeconds,
    remoteArgv,
    restart,
    detach,
    readyWhen,
  };
}

/**
 * `ssh` argv (sans the leading `ssh`) for the forward itself.
 *
 * `-N` because the forward carries no command of its own -- the process it serves is already running
 * on the other connection. `StreamLocalBindUnlink=yes` lets ssh replace a socket left behind by a
 * tunnel that died without cleaning up, which is the normal state after a crash and not worth making
 * the user resolve by hand. `ExitOnForwardFailure=yes` is the important one: without it ssh connects
 * happily and the forward silently does not exist, so the client finds no socket and falls back to a
 * local server -- the exact failure this command is meant to prevent, reported as success.
 */
export function buildForwardSshArgs(opts: {
  sshHost: string;
  localSocket: string;
  remoteSocket: string;
  /** Seconds of unanswered keepalives before ssh gives up. Defaults to `tunnelDeadAfterSeconds()`. */
  deadAfterSeconds?: number;
}): string[] {
  return [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'StreamLocalBindUnlink=yes',
    ...forwardKeepaliveOptions(opts.deadAfterSeconds ?? tunnelDeadAfterSeconds()),
    '-L',
    `${opts.localSocket}:${opts.remoteSocket}`,
    opts.sshHost,
  ];
}

/** How often ssh asks the far end whether it is still there. */
const ALIVE_INTERVAL_SECONDS = 15;

/**
 * How long a forward may go unanswered before ssh declares it dead. One minute.
 *
 * A `bica run` tolerates ten, and deliberately: a quiet stretch in the middle of a compile is
 * ordinary, and tearing the run down for it would cost whatever work was in flight. A forward is the
 * opposite case. It carries requests somebody is waiting on, the server behind it survives a
 * re-established forward, and re-establishing costs about a second -- so the cheap mistake is to give
 * up too early and the expensive one is to wait.
 *
 * Ten minutes was the inherited setting and it was measured: a link died with a request in flight and
 * the client sat in silence for 10m32s, which is exactly `ServerAliveInterval=30` times
 * `ServerAliveCountMax=20`. Nothing was wrong with the server; nothing was wrong with the client.
 */
const DEAD_AFTER_SECONDS = 60;

/**
 * That figure, or `BICA_TUNNEL_DEAD_AFTER` when someone on a slower link needs more rope.
 *
 * Never below one interval, since a count of zero means ssh never gives up at all -- the opposite of
 * what anyone setting this would be asking for.
 */
export function tunnelDeadAfterSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.BICA_TUNNEL_DEAD_AFTER?.trim();
  if (raw === undefined || raw.length === 0) {
    return DEAD_AFTER_SECONDS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEAD_AFTER_SECONDS;
  }
  return Math.max(ALIVE_INTERVAL_SECONDS, Math.round(parsed));
}

/** The `-o` pair ssh needs to give up after roughly `deadAfterSeconds` of silence. */
export function forwardKeepaliveOptions(deadAfterSeconds: number): string[] {
  const count = Math.max(
    1,
    Math.round(deadAfterSeconds / ALIVE_INTERVAL_SECONDS),
  );
  return [
    '-o',
    `ServerAliveInterval=${String(ALIVE_INTERVAL_SECONDS)}`,
    '-o',
    `ServerAliveCountMax=${String(count)}`,
  ];
}

/**
 * Shell script that returns once the remote socket exists, or exits 1 at the deadline.
 *
 * POSIX `test -S` and nothing else, so it runs on any remote without an interpreter. See the note on
 * `awaitReady` for why the file is sufficient evidence here and what it does not cover.
 */
export function buildSocketReadyScript(
  remoteSocketAbsolutePath: string,
  timeoutSeconds: number,
): string {
  const q = shellSingleQuoteRemotePathForSh(remoteSocketAbsolutePath);
  return [
    `_bica_deadline=$(( $(date +%s) + ${String(Math.ceil(timeoutSeconds))} ))`,
    `while [ ! -S ${q} ]; do`,
    '  if [ "$(date +%s)" -ge "$_bica_deadline" ]; then exit 1; fi',
    `  sleep ${READY_POLL_SECONDS}`,
    'done',
    '',
  ].join('\n');
}

/**
 * Whether a line of ssh's stderr says it could not reach the remote socket.
 *
 * ssh's wording for a stream-local forward it cannot complete: `channel 3: open failed: connect
 * failed: …`. Matched on `open failed` alone, which is the stable half across versions and across the
 * reasons the far end gives -- refused, no such file, permission -- all of which mean the same thing
 * here: nothing is listening over there yet.
 *
 * Exported so the match itself can be tested. It is the one piece of this that depends on another
 * program's choice of words, which is exactly the kind of thing that changes without telling you.
 */
export function sshRefusedTheRemoteSocket(chunk: string): boolean {
  return /open failed/.test(chunk);
}

/**
 * Why the local path cannot be used for the forward, or `undefined` when it can.
 *
 * ssh would unlink a socket here itself, and that is wanted -- a stale one is the usual leftover. A
 * regular file or a directory is a different matter: it is far more likely to be something of the
 * user's that happens to share the name, and deleting it to make room for a tunnel is not a trade
 * anyone asked for.
 */
export function localSocketObstruction(localSocket: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(localSocket);
  } catch {
    return undefined;
  }
  if (stat.isSocket()) {
    return undefined;
  }
  const kind = stat.isDirectory() ? 'a directory' : 'a regular file';
  return `${localSocket} is ${kind}, not a socket. Refusing to replace it; pass a different --local path.`;
}

/** Run a script on the remote without blocking the event loop, resolving to its exit status. */
function runRemoteScriptAsync(
  sshHost: string,
  script: string,
  options?: { captureStdout?: boolean },
): { child: ChildProcess; done: Promise<number>; stdout: Promise<string> } {
  const capture = options?.captureStdout === true;
  const child = spawn('ssh', ['-T', sshHost, 'sh', '-s'], {
    stdio: ['pipe', capture ? 'pipe' : 'ignore', 'inherit'],
    shell: false,
  });
  child.stdin?.end(script);
  let collected = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    collected += chunk;
  });
  const done = new Promise<number>((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
  return { child, done, stdout: done.then(() => collected) };
}

/**
 * Clear the remote socket, and stop whatever is still listening on it.
 *
 * Removing the path alone was not enough, and the way it failed was quiet. A server whose ssh
 * session died -- a laptop that drops off the network, where the remote sshd may never learn the
 * client is gone -- keeps running and keeps the socket open. The next start unlinked the path and
 * launched a second server beside the first, which went on listening on a name that no longer
 * existed, reachable by nobody and holding its memory. Three of them were found on one machine,
 * two days old.
 *
 * Killing the holder is not an escalation over what this function already did: the `rm` makes that
 * server unreachable either way. The only question is whether it is left running afterwards.
 *
 * Scoped to processes holding this exact path, which is the narrowest identity available -- bica
 * cannot tell its own server from anything else listening there, and anything else listening there
 * is in the way of the tunnel the caller asked for.
 *
 * Pure, and written for `sh`. The pid lists are deliberately unquoted: each is several words, and
 * `kill` wants them as separate arguments.
 */
export function buildClearRemoteSocketScript(remoteSocket: string): string {
  const sock = shellSingleQuoteRemotePathForSh(remoteSocket);
  return [
    `_bica_sock=${sock}`,
    // No lsof, no way to name the holder: fall through to the unlink, which is what this did before.
    'if [ -S "$_bica_sock" ] && command -v lsof >/dev/null 2>&1; then',
    '  _bica_held="$(lsof -t -- "$_bica_sock" 2>/dev/null || true)"',
    '  if [ -n "$_bica_held" ]; then',
    `    printf '${SOCKET_HOLDER_MARKER} %s\\n' "$(echo $_bica_held | tr '\\n' ' ')"`,
    '    kill -TERM $_bica_held 2>/dev/null || true',
    '    _bica_i=0',
    `    while [ "$_bica_i" -lt ${String(SOCKET_HOLDER_TERM_TRIES)} ]; do`,
    '      if [ -z "$(lsof -t -- "$_bica_sock" 2>/dev/null || true)" ]; then',
    '        break',
    '      fi',
    '      sleep 0.25',
    '      _bica_i=$((_bica_i + 1))',
    '    done',
    '    _bica_left="$(lsof -t -- "$_bica_sock" 2>/dev/null || true)"',
    '    if [ -n "$_bica_left" ]; then',
    `      printf '${SOCKET_HOLDER_FORCED_MARKER} %s\\n' "$(echo $_bica_left | tr '\\n' ' ')"`,
    '      kill -KILL $_bica_left 2>/dev/null || true',
    '    fi',
    '  fi',
    'fi',
    'rm -f "$_bica_sock"',
    '',
  ].join('\n');
}

/** What the clear script said it stopped, if anything. */
export function parseClearedSocketHolders(stdout: string): {
  stopped: string[];
  forced: string[];
} {
  const pick = (marker: string): string[] => {
    const out: string[] = [];
    for (const line of stdout.split('\n')) {
      if (line.startsWith(`${marker} `)) {
        out.push(...line.slice(marker.length + 1).trim().split(/\s+/).filter(Boolean));
      }
    }
    return out;
  };
  return { stopped: pick(SOCKET_HOLDER_MARKER), forced: pick(SOCKET_HOLDER_FORCED_MARKER) };
}

/** Backoff between reconnection attempts: doubles from the first to the cap. */
/** How long to wait for the old listener to close before re-binding its path anyway. */
const LISTENER_CLOSE_GRACE_MS = 2_000;

/** How many quarter-seconds the remote waits for a terminated server to let go before SIGKILL. */
const SOCKET_HOLDER_TERM_TRIES = 20;

/** Markers the clear script prints, so the local side can say what it stopped. */
const SOCKET_HOLDER_MARKER = 'bica-socket-held-by';
const SOCKET_HOLDER_FORCED_MARKER = 'bica-socket-forced';

const RECONNECT_FIRST_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * How many attempts in a row may fail before the tunnel gives up.
 *
 * A tunnel is worth retrying because the thing that usually breaks it is the network, which comes
 * back. A command that cannot start does not come back, and retrying it forever would mean a tunnel
 * that never serves anything and never says so either -- it would simply sit there looking busy.
 */
const MAX_CONSECUTIVE_FAILURES = 10;

/**
 * How long to wait for the server to answer again after only the forward dropped.
 *
 * Short on purpose: the server either survived the drop and answers at once, or it did not and the
 * tunnel should get on with restarting it rather than spending the full startup budget finding out.
 */
const RECONNECT_PROBE_SECONDS = 5;

/** Wait, unless a stop arrives first. */
function delay(ms: number, stop: { promise: Promise<void> }): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void stop.promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Join a client to its upstream so each side's bytes reach the other, and neither is cut short.
 *
 * The hazard here is end-of-stream, and it cost a day of someone's debugging. `pipe` writes what the
 * destination can take and queues the rest, so a reply larger than a socket's buffer is still in that
 * queue when the sender closes. Destroying the client on the upstream's `close` therefore threw away
 * everything past the buffer: a 22 KB reply arrived as exactly 16,384 bytes -- Node's default
 * high-water mark -- and the client reported it as malformed output from the server, which had in fact
 * sent all of it. Smaller replies fit in one buffer and so were never truncated, which is what kept
 * this hidden.
 *
 * `pipe` already ends the destination when the source ends, and a socket flushes what it has queued
 * before closing. So the correct teardown is to leave the end-of-stream path alone and only intervene
 * on an error.
 *
 * The one asymmetry is deliberate. A client that has gone away cannot be flushed to, so its upstream
 * is destroyed outright rather than left reading a reply nobody will receive; the reverse is the case
 * this function exists to protect.
 */
export interface ProxiedRequest {
  client: net.Socket;
  upstream: net.Socket;
}

/**
 * End every request the forward was carrying, because it can no longer carry them.
 *
 * `destroy` rather than `end`: there is no reply coming, and a half-closed socket would leave the
 * client waiting exactly as it was. What the client sees is its connection closing, which is an
 * error it can report -- the alternative, and the reported failure, is silence for as long as ssh
 * takes to notice, which was ten and a half minutes.
 */
export function endRequestsInFlight(requests: Set<ProxiedRequest>): void {
  for (const request of requests) {
    request.upstream.destroy();
    request.client.destroy();
  }
  requests.clear();
}

export function joinSockets(client: net.Socket, upstream: net.Socket): void {
  const destroyBoth = (): void => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', destroyBoth);
  upstream.on('error', destroyBoth);
  client.on('close', () => {
    upstream.destroy();
  });
  client.pipe(upstream);
  upstream.pipe(client);
}

export interface RunTunnelOptions {
  repoRoot: string;
  sshHost: string;
  remoteWorkspacePath: string;
  args: TunnelArgs;
}

/** How long to wait for ssh to bind the forward socket once it has been told to. */
const FORWARD_BIND_TIMEOUT_MS = 10_000;

/** Poll interval while waiting for that socket to appear. */
const FORWARD_BIND_POLL_MS = 50;

function pathExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the tunnel until it is stopped, or until there is nothing left to serve.
 *
 * **bica owns the local socket, rather than ssh.** It used to be the other way round: ssh bound the
 * path the client knew about, and so the path existed only while one particular remote process did.
 * That made the two unseparable -- a server with a ten-minute idle timeout took the client's socket
 * with it when it exited, and every later request found nothing. Putting a listener of bica's own on
 * the path and forwarding to a private one underneath lets the socket outlive what is behind it, which
 * is what `--restart` needs and what clients that now *report* a missing socket rather than quietly
 * working around it deserve.
 *
 * The cost is a hop: a client's bytes cross a local socket pair before reaching ssh. For request/reply
 * traffic to a model that takes tens of milliseconds to answer, that is not a cost anyone can measure.
 *
 * Deliberately takes no workspace lease. A lease held for the lifetime of a tunnel would block every
 * `bica run` from this checkout for hours, and the audit that wants the tunnel runs tests through
 * `bica run` while using it. The safety a lease buys is not needed here either: the server reads the
 * source it loaded at startup, and a sync that changes that source changes the socket name the client
 * asks for, so a stale server stops being found rather than answering wrongly.
 */
export async function runTunnel(options: RunTunnelOptions): Promise<number> {
  const { sshHost, args } = options;
  /**
   * Everything bica says about this tunnel, stamped with the time.
   *
   * A tunnel's log is read hours later, by somebody working out whether a restart took thirty seconds
   * or never finished. Without a time on each line that cannot be answered at all: a report of this
   * exact failure had to say "the log has no timestamps, so I can't tell how long the restart took or
   * whether the remote command is still loading". Only bica's own lines are stamped; the remote
   * command's output is passed through as it was written.
   */
  const write = (text: string): void => {
    const at = new Date().toTimeString().slice(0, 8);
    process.stderr.write(
      text.replace(/^(\[bica\]|\u001b\[[0-9;]*m\[bica\])/, `${dim(at)} $1`),
    );
  };

  const obstruction = localSocketObstruction(args.localSocket);
  if (obstruction !== undefined) {
    write(`${warn('[bica]')} ${obstruction}\n`);
    return 1;
  }
  fs.mkdirSync(path.dirname(args.localSocket), { recursive: true });

  const remoteSocket = tryResolveRemoteWorkspaceAbsolutePath(
    sshHost,
    args.remoteSocket,
  );
  if (remoteSocket === null) {
    write(
      `${warn('[bica]')} Could not resolve ${args.remoteSocket} to an absolute path on ${sshHost}. ` +
        'Pass --remote as an absolute path.\n',
    );
    return 1;
  }

  const forwardPath = forwardSocketPathFor(args.localSocket);
  fs.mkdirSync(path.dirname(forwardPath), { recursive: true });

  interface Session {
    commandDone: Promise<number>;
    forward: ChildProcess | null;
    /** False once the remote command has exited; a session is never revived, only replaced. */
    alive: boolean;
  }

  let session: Session | null = null;
  let starting: Promise<boolean> | null = null;
  let stopping = false;
  let exitCode = 0;
  let failures = 0;
  let announcedLease = false;
  /** Said once: the second and third unanswered requests are the same news. */
  let saidNothingAnswers = false;
  // Set once the record exists; stamping readiness before that would write a record with no tunnel.
  let recordReady: (() => void) | undefined;
  let reportedReady = false;
  const markReady = (): void => {
    if (reportedReady) {
      return;
    }
    reportedReady = true;
    recordReady?.();
  };
  let wakeFromBackoff = (): void => {};
  const stop = {
    promise: new Promise<void>((resolve) => {
      wakeFromBackoff = resolve;
    }),
  };

  const unlinkIfSocket = (p: string): void => {
    try {
      if (fs.lstatSync(p).isSocket()) {
        fs.unlinkSync(p);
      }
    } catch {
      // Already gone, which is the outcome this wanted.
    }
  };

  /**
   * How many times ssh has reported that it could not reach the remote socket.
   *
   * ssh says so itself, on stderr, once per attempted connection: `channel 3: open failed: connect
   * failed: …`. That is the authoritative answer to "is anything listening over there", and the only
   * one available without an interpreter on the remote. Counted rather than read, so a probe can ask
   * whether the number moved while it was connecting.
   */
  let refusals = 0;

  /**
   * Wait until something answers through the forward, or the command gives up first.
   *
   * Two questions, cheapest first. The remote socket existing is asked in POSIX shell, costs one
   * connection for the whole wait, and rules out the common case without an interpreter on the far
   * side. That it exists is not enough, though -- it was all this used to ask, and it announced
   * "Tunnel up" for a server that had created its socket and not yet begun accepting, and for one
   * that had died leaving the file behind. So once the file is there, every poll asks the forward
   * itself whether a connection is answered.
   */
  const awaitReady = async (
    commandDone: Promise<number>,
    timeoutSeconds: number,
    saidReady?: Promise<void>,
  ): Promise<
    { kind: 'ready' } | { kind: 'timeout' } | { kind: 'command'; code: number }
  > => {
    let commandExit: number | undefined;
    // When the server says when it is ready, believe it and ask nothing else. A probe can only
    // establish that something is listening; only the server knows when it will answer.
    let announcedItself = false;
    void saidReady?.then(() => {
      announcedItself = true;
    });
    void commandDone.then((code) => {
      commandExit = code;
    });

    // The file first. Raced against the command on purpose: a server that dies on startup -- a
    // missing dependency, an address already in use -- would otherwise be reported only when the
    // deadline passed, long after its own error had scrolled past.
    const appeared = runRemoteScriptAsync(
      sshHost,
      buildSocketReadyScript(remoteSocket, timeoutSeconds),
    );
    const outcome = await Promise.race([
      appeared.done.then((status) => ({ kind: 'file' as const, status })),
      commandDone.then((code) => ({ kind: 'command' as const, code })),
      // A server that announces itself has necessarily bound its socket, so waiting for the file as
      // well would only add the poll interval.
      ...(saidReady === undefined
        ? []
        : [saidReady.then(() => ({ kind: 'file' as const, status: 0 }))]),
    ]);
    if (outcome.kind === 'command') {
      appeared.child.kill('SIGTERM');
      return outcome;
    }
    if (outcome.status !== 0) {
      return { kind: 'timeout' };
    }

    // Then the answer. A server may bind its socket and spend a minute loading a model before it
    // accepts; this is the part that waits for that rather than announcing a tunnel over it.
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (commandExit !== undefined) {
        return { kind: 'command', code: commandExit };
      }
      if (saidReady !== undefined) {
        // Its own word, and nothing else: a forward that answers would be the weaker claim here.
        if (announcedItself) {
          return { kind: 'ready' };
        }
      } else if (await forwardAnswers()) {
        return { kind: 'ready' };
      }
      await delay(READY_PROBE_INTERVAL_MS, stop);
      if (stopping) {
        return { kind: 'timeout' };
      }
    }
    return commandExit === undefined
      ? { kind: 'timeout' }
      : { kind: 'command', code: commandExit };
  };

  /**
   * Everything currently proxied through the forward.
   *
   * Tracked so that a forward which dies can be made to end the requests it was carrying. Without
   * this, a client waits on a socket whose other end is gone and learns nothing: in the reported
   * incident the wait was ten and a half minutes, of which the last fraction of a second was bica
   * noticing. Ending the connection gives the client an error it can report, which is the difference
   * between a failure and a hang.
   */
  const inFlight = new Set<{ client: net.Socket; upstream: net.Socket }>();

  const forwardStderr = new ForwardStderr();

  const spawnForward = (): ChildProcess => {
    const child = spawn(
      'ssh',
      buildForwardSshArgs({
        sshHost,
        localSocket: forwardPath,
        remoteSocket,
      }),
      { stdio: ['ignore', 'inherit', 'pipe'], shell: false },
    );
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // Kept as well as passed through: when the forward fails to bind, this is the only account of
      // why, and bica used to replace it with a guess about OpenSSH versions.
      forwardStderr.add(chunk);
      if (sshRefusedTheRemoteSocket(chunk)) {
        refusals += 1;
      }
      // Passed through: ssh's own words about the connection are worth seeing, and swallowing them
      // to count them would hide the one explanation a reader has.
      process.stderr.write(chunk);
    });
    return child;
  };

  /**
   * Whether anything actually answers through the forward.
   *
   * The file check this replaces could not see the case that matters here: a server that creates its
   * socket and then spends a minute loading a model before it accepts, or one that died leaving the
   * socket file behind. Both look identical to `test -S`, and bica announced "Tunnel up" for both --
   * after which every request went unanswered, with the log saying the tunnel was fine.
   *
   * A connection alone proves nothing, because ssh accepts locally before it knows whether the far
   * end exists. What settles it is ssh's own refusal on stderr: connect, wait briefly, and treat a new
   * `open failed` as the answer. An earlier attempt waited a fixed moment for the connection to stay
   * open and called that readiness, which reported ready four seconds before a server that binds late
   * was listening -- because ssh reports the failure more slowly than any settle window worth having.
   */
  const forwardAnswers = async (): Promise<boolean> => {
    if (!pathExists(forwardPath)) {
      return false;
    }
    const before = refusals;
    const connected = await new Promise<boolean>((resolve) => {
      const probe = net.connect(forwardPath);
      let settled = false;
      const settle = (ok: boolean): void => {
        if (!settled) {
          settled = true;
          probe.destroy();
          resolve(ok);
        }
      };
      probe.on('error', () => {
        settle(false);
      });
      probe.on('close', () => {
        settle(false);
      });
      probe.on('connect', () => {
        setTimeout(() => {
          settle(true);
        }, FORWARD_PROBE_SETTLE_MS);
      });
    });
    if (!connected) {
      return false;
    }
    // Give ssh a moment to say it could not reach the far end, which it does after accepting here.
    await delay(FORWARD_REFUSAL_GRACE_MS, stop);
    return refusals === before;
  };

  const awaitForwardBound = async (): Promise<boolean> => {
    const deadline = Date.now() + FORWARD_BIND_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (pathExists(forwardPath)) {
        return true;
      }
      await delay(FORWARD_BIND_POLL_MS, stop);
      if (stopping) {
        return false;
      }
    }
    return false;
  };

  /**
   * Keep a forward standing on top of a session, for as long as its command lives.
   *
   * A forward that drops is a network event; the server behind it usually survived. Re-establishing
   * costs a second, where restarting the server costs however long its model took to load -- so this
   * checks whether the server still answers before concluding the session is over.
   */
  const superviseForward = async (
    own: Session,
    reportFirstReady: (result: FirstReady) => void,
    saidReady?: Promise<void>,
  ): Promise<void> => {
    // Every forward this session ever has is spawned here, and nowhere else. Starting one in
    // `startSession` as well left two ssh processes alive per session: the second rebinds the path
    // (`StreamLocalBindUnlink`) and the first goes on running against a socket that is no longer
    // there, so it is never noticed and never cleaned up -- and a client connecting during the
    // handover got an empty reply, because the path it had just reached had been replaced underneath.
    let announced = false;
    const firstReady = (result: FirstReady): void => {
      if (!announced) {
        announced = true;
        reportFirstReady(result);
      }
    };
    try {
      let first = true;
      while (!stopping && own.alive) {
        forwardStderr.clear();
        const child = spawnForward();
        own.forward = child;
        const closed = new Promise<number>((resolve) => {
          child.on('error', () => resolve(1));
          child.on('close', (c) => resolve(c ?? 1));
        });
        if (!(await awaitForwardBound())) {
          firstReady({ kind: 'bind-failed' });
          child.kill('SIGTERM');
          own.forward = null;
          return;
        }
        // Readiness is checked through the forward, so it can only be checked once the forward
        // stands. On a re-establish this doubles as the question "did the server survive the drop?".
        const answers = await awaitReady(
          own.commandDone,
          first ? args.readyTimeoutSeconds : RECONNECT_PROBE_SECONDS,
          saidReady,
        );
        if (answers.kind !== 'ready') {
          if (first) {
            firstReady(answers);
          } else {
            // The watchdog kills the server when its own connection breaks, so a reset that takes the
            // forward has usually taken the server too. Say which it was: a restart that silently
            // reloads a language model looks like a hang to whoever is waiting on a parse.
            write(`${dim('[bica]')} ${dim('The server is gone as well.')}\n`);
            terminateLiveRemoteCommand();
          }
          child.kill('SIGTERM');
          own.forward = null;
          return;
        }
        firstReady({ kind: 'ready' });
        first = false;
        const code = await closed;
        own.forward = null;
        // Before anything else: whoever was mid-request is waiting on a connection that cannot now
        // be answered, and the re-establish below does nothing for them.
        endRequestsInFlight(inFlight);
        unlinkIfSocket(forwardPath);
        if (stopping || !own.alive) {
          return;
        }
        write(
          `${warn('[bica]')} The forward closed (${String(code)}); re-establishing it.\n`,
        );
        await delay(RECONNECT_FIRST_DELAY_MS, stop);
        if (stopping) {
          return;
        }
      }
    } finally {
      // A supervisor that returns before anything answered must still answer the caller waiting on
      // it, or `startSession` waits for a forward that is never coming.
      firstReady({ kind: 'bind-failed' });
    }
  };

  const endSession = (own: Session): void => {
    own.alive = false;
    own.forward?.kill('SIGTERM');
    own.forward = null;
    if (session === own) {
      session = null;
    }
  };

  /** Start the remote command and get a forward standing on it. Resolves false if that failed. */
  const startSession = async (): Promise<boolean> => {
    write(
      `${dim('[bica]')} ${dim(`Starting ${args.remoteArgv[0]} on ${sshHost}…`)}\n`,
    );
    // Clear the remote socket before starting, so readiness cannot be answered by the last server.
    //
    // A server that is on its way out -- the predecessor of a restart, say -- still answers a connect
    // for the moment it takes to die. The probe believes it, the forward goes up against a socket
    // that is about to be unlinked, and the first client through gets an empty reply from a server
    // that no longer exists. Removing the path first means the only thing that can answer is the
    // server this session just started. The server does the same unlinking itself when it binds, so
    // this claims nothing the command was not about to claim anyway.
    const cleared = runRemoteScriptAsync(
      sshHost,
      buildClearRemoteSocketScript(remoteSocket),
      { captureStdout: true },
    );
    await cleared.done;
    const holders = parseClearedSocketHolders(await cleared.stdout);
    if (holders.stopped.length > 0) {
      write(
        `${dim('[bica]')} ${dim(
          `Stopped the server still holding ${remoteSocket} on ${sshHost} (pid ${holders.stopped.join(', ')})` +
            `${holders.forced.length > 0 ? `; ${holders.forced.join(', ')} needed SIGKILL` : ''}.`,
        )}\n`,
      );
    }
    // No lease, and so no run id or claim: see the note on this function.
    // When the command says when it is ready, that is what is waited for.
    let announceSaidReady: () => void = () => {};
    const saidReady = new Promise<void>((resolve) => {
      announceSaidReady = resolve;
    });
    const pattern = args.readyWhen;
    const commandDone = runRemoteCommand(
      sshHost,
      options.remoteWorkspacePath,
      argvToPosixShCommand(args.remoteArgv),
      options.repoRoot,
      {
        dieWithConnection: true,
        onOutput:
          pattern === undefined
            ? undefined
            : (chunk) => {
                if (pattern.test(chunk)) {
                  announceSaidReady();
                }
              },
      },
    );
    // The forward goes up first now, because readiness is measured through it. Nothing is exposed to
    // clients until it answers: bica's own listener is the only thing on the path they know about.
    const own: Session = { commandDone, forward: null, alive: true };
    session = own;
    let reportFirstReady: (result: FirstReady) => void = () => {};
    const firstReady = new Promise<FirstReady>((resolve) => {
      reportFirstReady = resolve;
    });
    void superviseForward(own, reportFirstReady, pattern === undefined ? undefined : saidReady);
    const ready = await firstReady;

    if (ready.kind !== 'ready') {
      endSession(own);
      if (ready.kind === 'command') {
        write(
          `${warn('[bica]')} The remote command exited (${String(ready.code)}) before anything ` +
            'answered; nothing was forwarded. Its output is above.\n',
        );
        exitCode = ready.code === 0 ? 1 : ready.code;
        return false;
      }
      if (ready.kind === 'bind-failed') {
        write(
          `${warn('[bica]')} ${describeBindFailure({
            forwardPath,
            sshHost,
            stderr: forwardStderr.last,
          })}\n`,
        );
      } else {
        write(
          `${warn('[bica]')} Nothing answered on ${remoteSocket} within ` +
            `${String(args.readyTimeoutSeconds)}s. Stopping the remote command; raise ` +
            '--ready-timeout if it is simply slow to start.\n',
        );
      }
      terminateLiveRemoteCommand();
      await commandDone;
      exitCode = 1;
      return false;
    }

    void commandDone.then((code) => {
      if (!own.alive) {
        return;
      }
      endSession(own);
      if (stopping) {
        return;
      }
      write(
        `${dim('[bica]')} ${dim(`The remote command exited (${String(code)}).`)}\n`,
      );
      if (args.restart === 'never') {
        shutdown(code);
        return;
      }
      if (args.restart === 'on-exit') {
        void ensureUp();
        return;
      }
      // on-demand: the socket stays bound with nothing behind it, which is the point. A server with
      // an idle timeout exits precisely so its memory can go back; starting it again before anyone
      // asks would undo that, and the next client pays the startup instead of every client paying it
      // for nothing.
      write(
        `${dim('[bica]')} ${dim(`${args.localSocket} stays open; the next client starts it again.`)}\n`,
      );
    });
    write(
      `${dim('[bica]')} ${dim(`Tunnel up: ${args.localSocket} → ${sshHost}:${remoteSocket}. Ctrl+C to stop.`)}\n`,
    );
    markReady();
    if (!announcedLease) {
      write(
        `${dim('[bica]')} ${dim('Holding no workspace lease, so `bica run` still works while this is up.')}\n`,
      );
      announcedLease = true;
    }
    return true;
  };

  /**
   * Make sure something is serving, starting it if not.
   *
   * Collapsing concurrent callers onto one `starting` promise is what makes on-demand restart safe:
   * ten clients arriving while the server loads produce one server, and all ten wait for it, rather
   * than ten commands racing to bind the same remote path.
   */
  const ensureUp = async (): Promise<boolean> => {
    if (stopping) {
      return false;
    }
    if (session !== null && session.alive) {
      return true;
    }
    if (starting === null) {
      starting = (async () => {
        const ok = await startSession();
        if (ok) {
          failures = 0;
        } else {
          failures += 1;
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            write(
              `${warn('[bica]')} Gave up after ${String(failures)} attempts that never served a ` +
                'request. The errors above are from the last one.\n',
            );
            shutdown(exitCode === 0 ? 1 : exitCode);
          } else if (args.restart === 'on-exit') {
            // Eager restart is a loop, so it needs the backoff the on-demand path gets for free from
            // waiting on a client.
            const backoff = Math.min(
              RECONNECT_FIRST_DELAY_MS * 2 ** (failures - 1),
              RECONNECT_MAX_DELAY_MS,
            );
            write(
              `${dim('[bica]')} ${dim(`Retrying in ${String(Math.round(backoff / 1000))}s…`)}\n`,
            );
            await delay(backoff, stop);
            if (!stopping) {
              starting = null;
              void ensureUp();
            }
          } else if (args.restart === 'never') {
            shutdown(exitCode === 0 ? 1 : exitCode);
          }
        }
        return ok;
      })().finally(() => {
        starting = null;
      });
    }
    return starting;
  };

  /**
   * Say so when a client asks something and nothing comes back.
   *
   * The one thing no probe can establish is whether the server will *answer*: a socket that accepts
   * connections proves it called `listen`, and a server that binds and then loads a model for a
   * minute satisfies that while replying to nobody. The kernel queues those connections either way,
   * so from outside it is indistinguishable from a working server -- which is how a tunnel came to
   * log "Tunnel up" and then answer nothing for twenty minutes, with every line of its log looking
   * healthy.
   *
   * bica is the proxy, though, so it sees the bytes. A request that goes in with nothing coming back
   * is exactly the symptom, and saying it converts a silent failure into a named one.
   *
   * Said once per silent spell rather than once per tunnel: the flag is cleared as soon as something
   * answers again, so a repeat of the same news is suppressed while a fresh episode hours later is
   * not. A detached tunnel runs for days, and under the old rule one warning on its first morning
   * bought silence for every incident after it.
   */
  const watchForSilence = (client: net.Socket, upstream: net.Socket): void => {
    let asked = false;
    let answered = false;
    let timer: NodeJS.Timeout | undefined;
    client.on('data', () => {
      if (asked) {
        return;
      }
      asked = true;
      timer = setTimeout(() => {
        if (!answered && !saidNothingAnswers) {
          saidNothingAnswers = true;
          write(
            `${warn('[bica]')} A request has been waiting ${String(
              Math.round(UNANSWERED_REQUEST_MS / 1000),
            )}s with no reply. Either the remote is still starting -- a server that binds its ` +
              'socket before it can answer looks identical to a working one from here, and ' +
              '`--ready-when=<pattern>` makes bica wait for it to say otherwise -- or the link is ' +
              `gone, which ssh reports after ${String(tunnelDeadAfterSeconds())}s of silence.\n`,
          );
        }
      }, UNANSWERED_REQUEST_MS);
      timer.unref();
    });
    upstream.on('data', () => {
      answered = true;
      saidNothingAnswers = false;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
    client.on('close', () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
  };

  const listener = net.createServer((client) => {
    client.on('error', () => {
      client.destroy();
    });
    void (async () => {
      const up = await ensureUp();
      if (!up || stopping) {
        // Refused rather than left hanging. A client that cannot be served should find that out now
        // and say so, which is exactly what the callers of this socket have been taught to do.
        client.destroy();
        return;
      }
      const upstream = net.connect(forwardPath);
      upstream.on('connect', () => {
        const pair = { client, upstream };
        inFlight.add(pair);
        const forget = (): void => {
          inFlight.delete(pair);
        };
        client.on('close', forget);
        upstream.on('close', forget);
        watchForSilence(client, upstream);
        joinSockets(client, upstream);
      });
      upstream.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
    })();
  });

  /**
   * The inode behind `args.localSocket` at the moment this tunnel bound it.
   *
   * A unix socket is a path, and a path is not owned. Anything may unlink it and bind its own, after
   * which this listener still has its socket and its descriptor but no longer has the path, so every
   * client gets `ECONNREFUSED` while the tunnel looks healthy from the inside. Comparing inodes is
   * how a listener can tell that the name it answers to has been given to somebody else.
   */
  let ourSocketInode: number | undefined;
  let stopSocketWatch: () => void = () => {};

  let resolveFinished: (code: number) => void = () => {};
  const finished = new Promise<number>((resolve) => {
    resolveFinished = resolve;
  });

  function shutdown(code: number): void {
    if (stopping) {
      return;
    }
    stopping = true;
    wakeFromBackoff();
    stopSocketWatch();
    listener.close();
    if (session !== null) {
      endSession(session);
    }
    terminateLiveRemoteCommand();
    unlinkIfSocket(args.localSocket);
    unlinkIfSocket(forwardPath);
    removeTunnelRecord(args.localSocket);
    resolveFinished(code);
    // Leave even if something still holds the loop open.
    //
    // A tunnel spends its life holding ssh children, their stdin pipes and a listener, and after a
    // stop any one of them can keep node running with nothing left to do -- which looked, from the
    // outside, exactly like a tunnel refusing to die, and `--stop` reported it as one. The cleanup
    // above has already happened by this point, so exiting is not cutting anything short. Unref'd, so
    // a process that does drain on its own exits normally and this never fires.
    setTimeout(() => {
      process.exit(code);
    }, 1_000).unref();
  }

  const onSignal = (signal: NodeJS.Signals, code: number): void => {
    write(`${dim('[bica]')} ${dim(`${signal} — closing the tunnel…`)}\n`);
    shutdown(code);
  };
  const onSigint = (): void => {
    onSignal('SIGINT', 130);
  };
  const onSigterm = (): void => {
    onSignal('SIGTERM', 143);
  };
  const onSighup = (): void => {
    onSignal('SIGHUP', 129);
  };
  const onExit = (): void => {
    unlinkIfSocket(args.localSocket);
    unlinkIfSocket(forwardPath);
    removeTunnelRecord(args.localSocket);
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('SIGHUP', onSighup);
  process.on('exit', onExit);

  try {
    const bindLocalSocket = async (): Promise<void> => {
      // A `net.Server` refuses a second `listen`, so taking the path back means closing first. Bounded
      // rather than awaited outright: `close` waits for every open connection, and a tunnel whose path
      // was stolen may still be holding one that will never end on its own.
      if (listener.listening) {
        await Promise.race([
          new Promise<void>((resolve) => {
            listener.close(() => {
              resolve();
            });
          }),
          delay(LISTENER_CLOSE_GRACE_MS, stop),
        ]);
      }
      unlinkIfSocket(args.localSocket);
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(args.localSocket, () => {
          listener.off('error', reject);
          resolve();
        });
      });
      ourSocketInode = inodeAt(args.localSocket);
    };
    try {
      await bindLocalSocket();
    } catch (e: unknown) {
      // Scoped to the bind alone. It used to wrap the whole run, so any later failure -- a bug in the
      // supervisor, a rejected start -- was reported as "could not listen", which is a sentence about
      // the one thing that had demonstrably worked.
      write(
        `${warn('[bica]')} Could not listen on ${args.localSocket}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      shutdown(1);
      return 1;
    }
    const record = {
      localSocket: args.localSocket,
      remoteSocket,
      sshHost,
      remoteArgv: args.remoteArgv,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      restart: args.restart,
    };
    // Written before anything is serving, so `--list` and `--stop` can see a tunnel that is still
    // starting. What says it is *usable* is the readiness stamp added below.
    writeTunnelRecord(record);

    /**
     * Notice when the path this tunnel answers to stops leading to it.
     *
     * Nothing else can notice. The listener has no event for its name being taken, clients cannot
     * report what they are seeing because they never reach bica, and the log's last line stays
     * whatever it was -- which is how one tunnel spent two days refusing every request while
     * `--list` showed it up and its own log showed a network outage from the day before. Checked on
     * a timer rather than per request, because the symptom is precisely that no request arrives.
     */
    const socketWatch = setInterval(() => {
      if (stopping) {
        return;
      }
      void (async () => {
        const state = await checkLocalSocket(args.localSocket, ourSocketInode);
        if (state === 'ours') {
          return;
        }
        if (state === 'taken') {
          // Taking it back would break whatever is serving there now, which may be a newer tunnel
          // for the same socket. Standing down is the only move that cannot make things worse.
          write(
            `${warn('[bica]')} ${args.localSocket} now leads to something else, which is serving ` +
              'it. This tunnel cannot be reached any more, so it is stopping rather than fighting ' +
              'over the path.\n',
          );
          shutdown(1);
          return;
        }
        write(
          `${warn('[bica]')} ${args.localSocket} was replaced by a socket nothing is serving, so ` +
            'every client has been refused since. Taking the path back.\n',
        );
        try {
          await bindLocalSocket();
          write(`${dim('[bica]')} ${dim('Listening again.')}\n`);
        } catch (e: unknown) {
          write(
            `${warn('[bica]')} Could not take ${args.localSocket} back: ` +
              `${e instanceof Error ? e.message : String(e)}\n`,
          );
          shutdown(1);
        }
      })();
    }, LOCAL_SOCKET_CHECK_MS);
    socketWatch.unref();
    stopSocketWatch = () => {
      clearInterval(socketWatch);
    };
    recordReady = () => {
      writeTunnelRecord({ ...record, readyAt: new Date().toISOString() });
    };
    // Started eagerly even in on-demand mode: `--ready-timeout` is a promise that "tunnel up" means
    // ready, and the first client should not be the one that discovers the command was unrunnable.
    await ensureUp();
    return await finished;
  } catch (e: unknown) {
    write(
      `${warn('[bica]')} The tunnel failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    shutdown(1);
    return 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGHUP', onSighup);
    process.removeListener('exit', onExit);
  }
}

/** One line per recorded tunnel, for `bica tunnel --list`. */
export function formatTunnelList(
  entries: { record: TunnelRecordLike; alive: boolean }[],
): string {
  if (entries.length === 0) {
    return 'No tunnels recorded.';
  }
  return entries
    .map(({ record, alive }) => `  ${describeTunnel(record, alive)}`)
    .join('\n');
}

type TunnelRecordLike = Parameters<typeof describeTunnel>[0];
