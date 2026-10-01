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
 * Shell script that returns once the remote socket exists, or exits 1 when the deadline passes.
 *
 * Waiting on the remote rather than polling from here is one ssh connection instead of one per poll,
 * and the loop sees the socket the moment it appears rather than up to a poll interval later.
 *
 * `-S` rather than `-e`: the client's readiness test is "a socket is at this path", so anything else
 * there -- a leftover regular file from a server killed mid-write -- is not readiness, and treating it
 * as such would forward to something that can never answer.
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

/**
 * Start the remote process, wait for its socket, forward it, and stay until one end ends.
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

  const ready = runRemoteScriptAsync(
    sshHost,
    buildSocketReadyScript(remoteSocket, args.readyTimeoutSeconds),
  );
  // Raced against the command on purpose. A server that dies on startup -- a missing dependency, a
  // port of itself already bound -- would otherwise be reported only when the readiness deadline
  // passed, long after its own error had already scrolled past.
  const outcome = await Promise.race([
    ready.done.then((status) => ({ kind: 'ready' as const, status })),
    commandDone.then((code) => ({ kind: 'command' as const, code })),
  ]);

  if (outcome.kind === 'command') {
    ready.child.kill('SIGTERM');
    write(
      `${warn('[bica]')} The remote command exited (${String(outcome.code)}) before its socket appeared; ` +
        'nothing was forwarded. Its output is above.\n',
    );
    return outcome.code === 0 ? 1 : outcome.code;
  }
  if (outcome.status !== 0) {
    write(
      `${warn('[bica]')} ${remoteSocket} did not appear within ${String(args.readyTimeoutSeconds)}s. ` +
        'Stopping the remote command; raise --ready-timeout if it is simply slow to start.\n',
    );
    terminateLiveRemoteCommand();
    await commandDone;
    return 1;
  }

  const forward = spawn(
    'ssh',
    buildForwardSshArgs({
      sshHost,
      localSocket: args.localSocket,
      remoteSocket,
    }),
    { stdio: ['ignore', 'inherit', 'inherit'], shell: false },
  );
  let forwardAlive = true;
  const forwardClosed = new Promise<number>((resolve) => {
    forward.on('error', () => resolve(1));
    forward.on('close', (code) => resolve(code ?? 1));
  }).then((code) => {
    forwardAlive = false;
    return code;
  });

  write(
    `${dim('[bica]')} ${dim(`Tunnel up: ${args.localSocket} → ${sshHost}:${remoteSocket}. Ctrl+C to stop.`)}\n`,
  );
  write(
    `${dim('[bica]')} ${dim('Holding no workspace lease, so `bica run` still works while this is up.')}\n`,
  );

  /**
   * Take everything down and leave no socket behind.
   *
   * The local socket is unlinked here even though ssh usually removes it: the usually is the problem.
   * A socket file left at the path is, to the client, a server that is up, so every later request
   * would connect to nothing instead of falling back to a local parser.
   */
  const teardown = (): void => {
    if (forwardAlive) {
      forward.kill('SIGTERM');
    }
    terminateLiveRemoteCommand();
    try {
      if (fs.lstatSync(args.localSocket).isSocket()) {
        fs.unlinkSync(args.localSocket);
      }
    } catch {
      // Already gone, which is the outcome this wanted.
    }
  };

  // A stop the user asked for is not a failure, and the 255 that ssh reports when it is killed should
  // not be dressed up as the remote command's own verdict. Recorded here so the end of the run can
  // tell the two apart and answer with the conventional code for the signal instead.
  let stoppedBySignal: number | undefined;
  const onSignal = (signal: NodeJS.Signals, code: number): void => {
    stoppedBySignal = code;
    write(`${dim('[bica]')} ${dim(`${signal} — closing the tunnel…`)}\n`);
    teardown();
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
  process.on('exit', teardown);

  try {
    const ended = await Promise.race([
      commandDone.then((code) => ({ kind: 'command' as const, code })),
      forwardClosed.then((code) => ({ kind: 'forward' as const, code })),
    ]);
    if (stoppedBySignal !== undefined) {
      await commandDone;
      return stoppedBySignal;
    }
    if (ended.kind === 'command') {
      write(
        `${dim('[bica]')} ${dim(`The remote command exited (${String(ended.code)}); closing the tunnel.`)}\n`,
      );
    } else {
      write(
        `${warn('[bica]')} The forward closed (${String(ended.code)}); stopping the remote command. ` +
          'Stream-local forwarding needs OpenSSH 6.7 or later on both ends.\n',
      );
    }
    teardown();
    await commandDone;
    return ended.code;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGHUP', onSighup);
    process.removeListener('exit', teardown);
  }
}
