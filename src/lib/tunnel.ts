import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { argvToPosixShCommand } from '../remoteArgvToShellCommand';
import { dim, warn } from '../terminalStyle';
import {
  runRemoteCommand,
  shellSingleQuoteRemotePathForSh,
  terminateLiveRemoteCommand,
  tryResolveRemoteWorkspaceAbsolutePath,
} from './runRemote';

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
}

export const TUNNEL_USAGE =
  'usage: bica tunnel --local=<path.sock> --remote=<path.sock> [--ready-timeout=<seconds>] -- <command> [args...]';

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
  return { localSocket, remoteSocket, readyTimeoutSeconds, remoteArgv };
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

export interface RunTunnelOptions {
  repoRoot: string;
  sshHost: string;
  remoteWorkspacePath: string;
  args: TunnelArgs;
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

/**
 * Start the remote process, wait for its socket to answer, forward it, and hold it there.
 *
 * Reconnects rather than exiting when the connection drops. A tunnel is a thing you leave running for
 * hours next to work that makes its own ssh connections, and a reset in the middle of that -- which
 * happens, twice in an hour on a busy remote -- used to take the parser with it and leave the next
 * request to find nothing. The server has to be restarted along with the forward, because the watchdog
 * that stops it from outliving a broken connection has already done its job by then.
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

  /**
   * Remove the local socket, whatever state the attempt ended in.
   *
   * Called between attempts as well as at the end, and that is the point. While the tunnel is
   * reconnecting there is nothing behind the path, and a socket file with nothing behind it is worse
   * for a client than no file at all: it reads as "a server is up", so requests fail there instead of
   * falling back to a local one. ssh usually unlinks it; usually is not an invariant.
   */
  const unlinkLocalSocket = (): void => {
    try {
      if (fs.lstatSync(args.localSocket).isSocket()) {
        fs.unlinkSync(args.localSocket);
      }
    } catch {
      // Already gone, which is the outcome this wanted.
    }
  };

  let forward: ChildProcess | null = null;
  let stoppedBySignal: number | undefined;
  let wakeFromBackoff = (): void => {};
  const stop = {
    promise: new Promise<void>((resolve) => {
      wakeFromBackoff = resolve;
    }),
  };

  const stopEverything = (): void => {
    forward?.kill('SIGTERM');
    terminateLiveRemoteCommand();
    unlinkLocalSocket();
  };

  // A stop the user asked for is not a failure, and the 255 that ssh reports when it is killed should
  // not be dressed up as the remote command's own verdict. Recorded here so the end of the run can
  // tell the two apart and answer with the conventional code for the signal instead.
  const onSignal = (signal: NodeJS.Signals, code: number): void => {
    stoppedBySignal = code;
    write(`${dim('[bica]')} ${dim(`${signal} — closing the tunnel…`)}\n`);
    wakeFromBackoff();
    stopEverything();
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
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('SIGHUP', onSighup);
  process.on('exit', stopEverything);

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

  let announcedLease = false;
  let failures = 0;
  let backoffMs = RECONNECT_FIRST_DELAY_MS;
  let exitCode = 0;
  let finished = false;

  try {
    while (stoppedBySignal === undefined && !finished) {
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

      const start = await awaitReady(commandDone, args.readyTimeoutSeconds);
      let served = false;

      if (start.kind === 'command') {
        write(
          `${warn('[bica]')} The remote command exited (${String(start.code)}) before its socket ` +
            'answered; nothing was forwarded. Its output is above.\n',
        );
        exitCode = start.code === 0 ? 1 : start.code;
        // Exiting 0 without ever serving is a command that had nothing to do, not a broken
        // connection. Restarting it would just produce the same nothing, more slowly each time.
        finished = start.code === 0;
      } else if (start.kind === 'timeout') {
        write(
          `${warn('[bica]')} Nothing answered on ${remoteSocket} within ` +
            `${String(args.readyTimeoutSeconds)}s. Stopping the remote command; raise ` +
            '--ready-timeout if it is simply slow to start.\n',
        );
        exitCode = 1;
      } else {
        // The server is up. Everything in this loop is about keeping a forward on top of it: a
        // forward that drops is a network event, and re-establishing it costs a second, where
        // restarting the server costs however long its model took to load.
        while (stoppedBySignal === undefined) {
          const child = spawn(
            'ssh',
            buildForwardSshArgs({
              sshHost,
              localSocket: args.localSocket,
              remoteSocket,
            }),
            { stdio: ['ignore', 'inherit', 'inherit'], shell: false },
          );
          forward = child;
          const forwardClosed = new Promise<number>((resolve) => {
            child.on('error', () => resolve(1));
            child.on('close', (code) => resolve(code ?? 1));
          });

          write(
            `${dim('[bica]')} ${dim(`Tunnel up: ${args.localSocket} → ${sshHost}:${remoteSocket}. Ctrl+C to stop.`)}\n`,
          );
          if (!announcedLease) {
            write(
              `${dim('[bica]')} ${dim('Holding no workspace lease, so `bica run` still works while this is up.')}\n`,
            );
            announcedLease = true;
          }
          // Serving counts as a success even if it later breaks: the failure budget exists to stop a
          // tunnel that can never work, not one that worked for an hour and then lost the network.
          served = true;
          failures = 0;
          backoffMs = RECONNECT_FIRST_DELAY_MS;

          const ended = await Promise.race([
            commandDone.then((code) => ({ kind: 'command' as const, code })),
            forwardClosed.then((code) => ({ kind: 'forward' as const, code })),
          ]);
          forward = null;
          unlinkLocalSocket();
          if (stoppedBySignal !== undefined) {
            break;
          }
          exitCode = ended.code;
          if (ended.kind === 'command') {
            write(
              `${warn('[bica]')} The remote command exited (${String(ended.code)}).\n`,
            );
            finished = ended.code === 0;
            if (finished) {
              write(
                `${dim('[bica]')} ${dim('It finished on its own; closing the tunnel.')}\n`,
              );
            }
            break;
          }

          write(
            `${warn('[bica]')} The forward closed (${String(ended.code)}); re-establishing it.\n`,
          );
          await delay(RECONNECT_FIRST_DELAY_MS, stop);
          if (stoppedBySignal !== undefined) {
            break;
          }
          const again = await awaitReady(commandDone, RECONNECT_PROBE_SECONDS);
          if (again.kind !== 'ready') {
            // The watchdog kills the server when its own connection breaks, so a reset that takes the
            // forward has usually taken the server too. Say which it was: a restart that silently
            // reloads a language model looks like a hang to whoever is waiting on a parse.
            write(
              `${dim('[bica]')} ${dim('The server is gone as well; starting it again.')}\n`,
            );
            break;
          }
        }
      }

      // No forward to kill here: whichever path left the loop above already cleared it, and a signal
      // takes it down through the handler.
      terminateLiveRemoteCommand();
      await commandDone;
      unlinkLocalSocket();

      if (stoppedBySignal !== undefined || finished) {
        break;
      }
      if (!served) {
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          write(
            `${warn('[bica]')} Gave up after ${String(failures)} attempts that never served a ` +
              'request. The errors above are from the last one.\n',
          );
          break;
        }
      }
      write(
        `${dim('[bica]')} ${dim(`Reconnecting in ${String(Math.round(backoffMs / 1000))}s…`)}\n`,
      );
      await delay(backoffMs, stop);
      backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_DELAY_MS);
    }
    return stoppedBySignal ?? exitCode;
  } finally {
    stopEverything();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGHUP', onSighup);
    process.removeListener('exit', stopEverything);
  }
}
