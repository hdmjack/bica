import * as fs from 'node:fs';
import * as net from 'node:net';

import { sshDiagnosticSummary } from './connectionLoss';

/**
 * Two ways a tunnel told somebody the wrong thing about why it was not working.
 *
 * The first is a message. When the forward failed to bind, bica said stream-local forwarding needs
 * OpenSSH 6.7 -- the only explanation it knew -- while ssh's own stderr, one line above, said
 * `connect to host 192.168.0.120 port 22: Operation timed out`. The host was simply off the network,
 * and the same pair of machines had forwarded that socket for two days. A guess printed next to the
 * evidence that contradicts it is worse than no guess, because it is the line the reader acts on.
 *
 * The second is a silence. A unix socket is a path, and a path is not owned: anything may unlink it
 * and bind its own. When that happens the listener keeps its socket, keeps its file descriptor, and
 * goes on believing it is serving -- but the path now leads to a different socket, so every client
 * gets `ECONNREFUSED` while `bica tunnel --list` still lists the tunnel as up. One tunnel sat in that
 * state for two days. The process was healthy, the log's last line was from the outage before it, and
 * the diagnosis that reached me was "it never retried after the host came back", which was reasonable
 * and wrong: it never retried because no client ever reached it to ask.
 */

/** How often a serving tunnel checks that its path still leads to it. */
export const LOCAL_SOCKET_CHECK_MS = 30_000;

/** The inode at a path, or undefined when nothing is there. */
export function inodeAt(socketPath: string): number | undefined {
  try {
    return fs.statSync(socketPath).ino;
  } catch {
    return undefined;
  }
}

/**
 * Whether anything is actually accepting on a path.
 *
 * The question a stolen path raises is not "is there a file" -- there is -- but "does it lead
 * anywhere". A refused connect means the socket was left behind by something that has gone, and the
 * path is free to take back. A connect that succeeds means somebody else is serving there now, and
 * taking it would be breaking a tunnel rather than fixing one.
 */
export function pathIsServed(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    let settled = false;
    const settle = (served: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      probe.destroy();
      resolve(served);
    };
    probe.on('connect', () => {
      settle(true);
    });
    probe.on('error', () => {
      settle(false);
    });
  });
}

export type LocalSocketState =
  /** The path still leads to this listener. */
  | 'ours'
  /** The path was replaced by a socket nothing is serving: free to take back. */
  | 'abandoned'
  /** Something else is serving there now. */
  | 'taken';

export async function checkLocalSocket(
  socketPath: string,
  ourInode: number | undefined,
): Promise<LocalSocketState> {
  const now = inodeAt(socketPath);
  if (now !== undefined && ourInode !== undefined && now === ourInode) {
    return 'ours';
  }
  // A path that is simply gone is abandoned by definition -- there is nothing there to serve.
  if (now === undefined) {
    return 'abandoned';
  }
  return (await pathIsServed(socketPath)) ? 'taken' : 'abandoned';
}

/**
 * ssh's stderr, kept so a failure can quote it.
 *
 * Only the tail: a forward that cannot connect says the same thing every few seconds, and the useful
 * line is always the most recent one.
 */
export class ForwardStderr {
  private text = '';

  add(chunk: string): void {
    this.text = `${this.text}${chunk}`.slice(-4_000);
  }

  clear(): void {
    this.text = '';
  }

  get last(): string {
    return this.text;
  }
}

/** What ssh says when the far end has no stream-local forwarding, as opposed to no network path. */
const STREAM_LOCAL_UNSUPPORTED =
  /(?:unix domain socket|stream.?local|forwarding).*(?:not supported|unsupported|refused)|Bad local forwarding specification|unknown port name/i;

/** ssh's vocabulary for a host it could not get to, as opposed to one that answered and refused. */
const COULD_NOT_REACH =
  /Operation timed out|Connection timed out|Connection refused|No route to host|Network is unreachable|Could not resolve hostname|Host is down|Permission denied \(|Host key verification failed/;

/**
 * What to say when the forward never bound.
 *
 * ssh is asked first and believed. The OpenSSH-version explanation is kept for the case it was
 * written for -- a remote that genuinely cannot forward a unix socket -- and offered as a possibility
 * only when ssh said nothing at all, which is the one situation where a guess is all there is.
 */
export function describeBindFailure(options: {
  forwardPath: string;
  sshHost: string;
  stderr: string;
}): string {
  const said = sshDiagnosticSummary(options.stderr);
  if (said === undefined) {
    return (
      `ssh did not bind ${options.forwardPath}, and said nothing about why. If ${options.sshHost} ` +
      'is reachable, stream-local forwarding needs OpenSSH 6.7 or later on both ends.'
    );
  }
  if (STREAM_LOCAL_UNSUPPORTED.test(options.stderr)) {
    return (
      `ssh did not bind ${options.forwardPath}: ${said}\n` +
      'Stream-local forwarding needs OpenSSH 6.7 or later on both ends.'
    );
  }
  if (COULD_NOT_REACH.test(options.stderr)) {
    return (
      `ssh did not bind ${options.forwardPath}, because it could not reach ${options.sshHost}: ` +
      `${said}\nNothing was forwarded. The next client will try again.`
    );
  }
  // Quoted without a theory attached. Saying only what ssh said is worth more than naming a cause
  // that may be the wrong one, which is the whole lesson of this file.
  return (
    `ssh did not bind ${options.forwardPath}. ssh said: ${said}\n` +
    'Nothing was forwarded. The next client will try again.'
  );
}
