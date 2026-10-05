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
const DEFAULT_READY_TIMEOUT_SECONDS = 60;

/** How often the remote readiness loop looks for the socket. */
const READY_POLL_SECONDS = '0.2';

export interface TunnelArgs {
  localSocket: string;
  remoteSocket: string;
  readyTimeoutSeconds: number;
  remoteArgv: string[];
  /** What to do when the remote command exits of its own accord. */
  restart: RestartMode;
  /** Run in the background, surviving the shell that started it. */
  detach: boolean;
}

export const TUNNEL_USAGE =
  'usage: bica tunnel --local=<path.sock> --remote=<path.sock> [--ready-timeout=<seconds>]\n' +
  '                   [--restart=never|on-exit|on-demand] [--detach] -- <command> [args...]\n' +
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
export function parseTunnelArgs(tail: readonly string[]): TunnelArgs {
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
  let detach = false;

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
}): string[] {
  return [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'StreamLocalBindUnlink=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=20',
    '-L',
    `${opts.localSocket}:${opts.remoteSocket}`,
    opts.sshHost,
  ];
}

/**
 * Shell script that returns once something is *listening* on the remote socket, or exits 1 at the
 * deadline.
 *
 * The file existing is not the same as a server answering, and the gap between them is exactly where a
 * slow server lives: a parser that loads a language model takes twenty seconds to bind, and a socket
 * file left by a previous server that was killed sits at the path for the whole of that time. Judging
 * readiness by the file meant forwarding to a path nothing was listening on, and the client's first
 * request died with "connect failed" instead of waiting.
 *
 * So the test is a real `connect()`. The file check stays as the cheap first half, because it rejects
 * the common case without paying for an interpreter.
 *
 * A connect is not free of consequence: a server reads it as a client that hung up without asking
 * anything. That is the same thing it sees whenever a client is interrupted, so it is a case any such
 * server already has to survive.
 *
 * Waiting on the remote rather than polling from here is one ssh connection instead of one per poll,
 * and the loop sees the socket the moment it answers rather than up to a poll interval later.
 */
export function buildSocketReadyScript(
  remoteSocketAbsolutePath: string,
  timeoutSeconds: number,
): string {
  const q = shellSingleQuoteRemotePathForSh(remoteSocketAbsolutePath);
  // No single quotes inside: the whole program is a single-quoted argument to the remote `sh`.
  const connectProgram = [
    'import socket,sys',
    's=socket.socket(socket.AF_UNIX)',
    's.settimeout(2)',
    'try:',
    '    s.connect(sys.argv[1])',
    'except OSError:',
    '    sys.exit(1)',
    's.close()',
  ].join('\n');
  return [
    `_bica_deadline=$(( $(date +%s) + ${String(Math.ceil(timeoutSeconds))} ))`,
    '_bica_answers() {',
    `  [ -S ${q} ] || return 1`,
    // Without an interpreter to connect with, the file is the only evidence available. Saying so in
    // the script keeps the fallback visible rather than making the whole feature depend on python3.
    '  command -v python3 >/dev/null 2>&1 || return 0',
    `  python3 -c '${connectProgram}' ${q} 2>/dev/null`,
    '}',
    'while ! _bica_answers; do',
    '  if [ "$(date +%s)" -ge "$_bica_deadline" ]; then exit 1; fi',
    `  sleep ${READY_POLL_SECONDS}`,
    'done',
    '',
  ].join('\n');
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
): { child: ChildProcess; done: Promise<number> } {
  const child = spawn('ssh', ['-T', sshHost, 'sh', '-s'], {
    stdio: ['pipe', 'ignore', 'inherit'],
    shell: false,
  });
  child.stdin?.end(script);
  const done = new Promise<number>((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
  return { child, done };
}

/** Backoff between reconnection attempts: doubles from the first to the cap. */
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
  const write = (text: string): void => {
    process.stderr.write(text);
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

  /** Wait for something to answer on the remote socket, or for the command to give up first. */
  const awaitReady = async (
    commandDone: Promise<number>,
    timeoutSeconds: number,
  ): Promise<
    { kind: 'ready' } | { kind: 'timeout' } | { kind: 'command'; code: number }
  > => {
    const ready = runRemoteScriptAsync(
      sshHost,
      buildSocketReadyScript(remoteSocket, timeoutSeconds),
    );
    // Raced against the command on purpose. A server that dies on startup -- a missing dependency, an
    // address already in use -- would otherwise be reported only when the readiness deadline passed,
    // long after its own error had already scrolled past.
    const outcome = await Promise.race([
      ready.done.then((status) => ({ kind: 'ready' as const, status })),
      commandDone.then((code) => ({ kind: 'command' as const, code })),
    ]);
    if (outcome.kind === 'command') {
      ready.child.kill('SIGTERM');
      return outcome;
    }
    return outcome.status === 0 ? { kind: 'ready' } : { kind: 'timeout' };
  };

  const spawnForward = (): ChildProcess =>
    spawn(
      'ssh',
      buildForwardSshArgs({
        sshHost,
        localSocket: forwardPath,
        remoteSocket,
      }),
      { stdio: ['ignore', 'inherit', 'inherit'], shell: false },
    );

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
  const superviseForward = async (own: Session): Promise<void> => {
    while (!stopping && own.alive) {
      const child = spawnForward();
      own.forward = child;
      const code = await new Promise<number>((resolve) => {
        child.on('error', () => resolve(1));
        child.on('close', (c) => resolve(c ?? 1));
      });
      own.forward = null;
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
      const again = await awaitReady(own.commandDone, RECONNECT_PROBE_SECONDS);
      if (again.kind !== 'ready') {
        // The watchdog kills the server when its own connection breaks, so a reset that takes the
        // forward has usually taken the server too. Say which it was: a restart that silently reloads
        // a language model looks like a hang to whoever is waiting on a parse.
        write(
          `${dim('[bica]')} ${dim('The server is gone as well.')}\n`,
        );
        terminateLiveRemoteCommand();
        return;
      }
      if (!(await awaitForwardBound())) {
        return;
      }
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
    // No lease, and so no run id or claim: see the note on this function.
    const commandDone = runRemoteCommand(
      sshHost,
      options.remoteWorkspacePath,
      argvToPosixShCommand(args.remoteArgv),
      options.repoRoot,
      { dieWithConnection: true },
    );
    const ready = await awaitReady(commandDone, args.readyTimeoutSeconds);
    if (ready.kind === 'command') {
      write(
        `${warn('[bica]')} The remote command exited (${String(ready.code)}) before its socket ` +
          'answered; nothing was forwarded. Its output is above.\n',
      );
      exitCode = ready.code === 0 ? 1 : ready.code;
      return false;
    }
    if (ready.kind === 'timeout') {
      write(
        `${warn('[bica]')} Nothing answered on ${remoteSocket} within ` +
          `${String(args.readyTimeoutSeconds)}s. Stopping the remote command; raise ` +
          '--ready-timeout if it is simply slow to start.\n',
      );
      terminateLiveRemoteCommand();
      await commandDone;
      exitCode = 1;
      return false;
    }

    const own: Session = { commandDone, forward: spawnForward(), alive: true };
    session = own;
    if (!(await awaitForwardBound())) {
      write(
        `${warn('[bica]')} ssh did not bind ${forwardPath}. Stream-local forwarding needs ` +
          'OpenSSH 6.7 or later on both ends.\n',
      );
      endSession(own);
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
    void superviseForward(own);

    write(
      `${dim('[bica]')} ${dim(`Tunnel up: ${args.localSocket} → ${sshHost}:${remoteSocket}. Ctrl+C to stop.`)}\n`,
    );
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
      upstream.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
      upstream.on('connect', () => {
        client.pipe(upstream);
        upstream.pipe(client);
      });
      client.on('close', () => {
        upstream.destroy();
      });
      upstream.on('close', () => {
        client.destroy();
      });
    })();
  });

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
    try {
      unlinkIfSocket(args.localSocket);
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(args.localSocket, () => {
          listener.off('error', reject);
          resolve();
        });
      });
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
    writeTunnelRecord({
      localSocket: args.localSocket,
      remoteSocket,
      sshHost,
      remoteArgv: args.remoteArgv,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      restart: args.restart,
    });
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
