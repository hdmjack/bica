import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isProcessAlive } from './fileLock';
import { tunnelStateDir } from './workspacePaths';

/**
 * The registry of running tunnels.
 *
 * A tunnel is a process that owns a path in the filesystem, and until this existed nothing recorded
 * which process that was. Start the same one twice and both are alive, one of them long since
 * disconnected on the remote side, with no way to tell from the outside which socket belongs to which
 * -- the only cleanup available was `pkill`. A record per local socket makes the ownership a fact that
 * can be read, which is what `--list` reads and what a second start refuses against.
 */

export interface TunnelRecord {
  /** The local socket path, which is what identifies a tunnel. */
  localSocket: string;
  remoteSocket: string;
  sshHost: string;
  remoteArgv: string[];
  pid: number;
  startedAt: string;
  /**
   * When something first answered through this tunnel, if it has.
   *
   * Its absence means the tunnel is still starting: the socket is bound, because bica binds it before
   * the remote command runs so that the path never disappears under a client, but nothing is behind
   * it yet. `--detach` waits for this rather than for the record, which it used to -- and so returned
   * in under a second, with the socket present and the server not yet started, leaving the very next
   * client to fail.
   */
  readyAt?: string;
  /** Where a detached tunnel's output goes; absent when it runs in the foreground. */
  logPath?: string;
  restart: RestartMode;
}

export type RestartMode = 'never' | 'on-exit' | 'on-demand';

/**
 * One file per socket, named by a digest of its path.
 *
 * The path itself cannot be the file name -- it contains separators and can be longer than a name is
 * allowed to be -- and the digest keeps the mapping one-to-one without needing an index to consult.
 */
export function recordPathFor(localSocket: string): string {
  const digest = createHash('sha256')
    .update(path.resolve(localSocket))
    .digest('hex')
    .slice(0, 16);
  return path.join(tunnelStateDir(), `${digest}.json`);
}

function parseRecord(raw: string): TunnelRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const r = parsed as Partial<TunnelRecord>;
  if (
    typeof r.localSocket !== 'string' ||
    typeof r.pid !== 'number' ||
    typeof r.sshHost !== 'string'
  ) {
    return null;
  }
  return r as TunnelRecord;
}

export function readTunnelRecord(localSocket: string): TunnelRecord | null {
  try {
    return parseRecord(fs.readFileSync(recordPathFor(localSocket), 'utf8'));
  } catch {
    return null;
  }
}

export function writeTunnelRecord(record: TunnelRecord): void {
  fs.mkdirSync(tunnelStateDir(), { recursive: true });
  fs.writeFileSync(
    recordPathFor(record.localSocket),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

export function removeTunnelRecord(localSocket: string): void {
  try {
    fs.unlinkSync(recordPathFor(localSocket));
  } catch {
    // Already gone, which is the outcome this wanted.
  }
}

/** Every recorded tunnel, live ones first, with the dead ones marked rather than hidden. */
export function listTunnelRecords(): {
  record: TunnelRecord;
  alive: boolean;
}[] {
  let names: string[];
  try {
    names = fs.readdirSync(tunnelStateDir());
  } catch {
    return [];
  }
  const out: { record: TunnelRecord; alive: boolean }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    let record: TunnelRecord | null;
    try {
      record = parseRecord(
        fs.readFileSync(path.join(tunnelStateDir(), name), 'utf8'),
      );
    } catch {
      record = null;
    }
    if (record !== null) {
      out.push({ record, alive: isProcessAlive(record.pid) });
    }
  }
  return out.sort((a, b) => {
    if (a.alive !== b.alive) {
      return a.alive ? -1 : 1;
    }
    return a.record.localSocket.localeCompare(b.record.localSocket);
  });
}

export type ClaimOutcome =
  | { kind: 'free' }
  | { kind: 'taken'; by: TunnelRecord }
  | { kind: 'stale'; previous: TunnelRecord };

/**
 * Whether this process may serve `localSocket`.
 *
 * A record whose process is gone is not a conflict, it is litter: a tunnel that was killed outright
 * never got to clean up after itself, and refusing on its behalf would mean every hard kill needed a
 * manual rescue. Saying which of the two happened matters, though -- taking over silently would hide
 * a tunnel that had been dying repeatedly.
 */
export function claimLocalSocket(localSocket: string): ClaimOutcome {
  const existing = readTunnelRecord(localSocket);
  if (existing === null) {
    return { kind: 'free' };
  }
  if (isProcessAlive(existing.pid)) {
    return { kind: 'taken', by: existing };
  }
  return { kind: 'stale', previous: existing };
}

/** One line describing a tunnel, for `--list` and for the refusal that names the owner. */
export function describeTunnel(record: TunnelRecord, alive: boolean): string {
  const age = Date.parse(record.startedAt);
  const since = Number.isNaN(age)
    ? record.startedAt
    : `${String(Math.round((Date.now() - age) / 60_000))}m ago`;
  const state = alive ? `pid ${String(record.pid)}` : 'not running';
  const bits = [
    record.localSocket,
    `→ ${record.sshHost}:${record.remoteSocket}`,
    `(${state}, started ${since}, restart=${record.restart})`,
  ];
  if (record.logPath !== undefined) {
    bits.push(`log ${record.logPath}`);
  }
  return bits.join(' ');
}

/**
 * The socket ssh forwards to, which is bica's business rather than the client's.
 *
 * The client's path and the forward's are now two different things. bica listens on the first and
 * connects to the second, so that the path a client knows about can stay bound across a restart of
 * the thing behind it -- the whole point of the restart modes, and impossible when ssh owned the
 * path the client used.
 */
export function forwardSocketPathFor(localSocket: string): string {
  return recordPathFor(localSocket).replace(/\.json$/, '.fwd');
}

/** Where a detached tunnel's output goes: beside its record, so the two are found together. */
export function tunnelLogPathFor(localSocket: string): string {
  return recordPathFor(localSocket).replace(/\.json$/, '.log');
}

/**
 * Clear up after a tunnel whose process is gone.
 *
 * A tunnel that is stopped cleans up after itself; one that is killed outright cannot, and what it
 * leaves is worse than nothing. The socket file stays on disk with no listener behind it, so clients
 * get a refused connection where an absent path would have told them plainly that no tunnel is
 * running -- and for a client that now reports a missing server rather than working around it, those
 * two outcomes read very differently.
 *
 * Nothing can be done from inside a process that is already dead, so this is done by the next bica
 * command that looks. Returns what it removed, so the caller can say so rather than tidying silently.
 */
export function cleanUpAfterDeadTunnel(record: TunnelRecord): string[] {
  const removed: string[] = [];
  removed.push(...killOrphanedSsh(record).map((pid) => `ssh (pid ${pid})`));
  for (const p of [
    record.localSocket,
    forwardSocketPathFor(record.localSocket),
  ]) {
    try {
      if (fs.lstatSync(p).isSocket()) {
        fs.unlinkSync(p);
        removed.push(p);
      }
    } catch {
      // Already gone, which is the outcome this wanted.
    }
  }
  return removed;
}

/**
 * Kill the ssh processes a dead tunnel left running.
 *
 * A tunnel that is killed outright does not take its children with it. The forwarding ssh is the one
 * that lasts: it holds no pipe to its parent, so nothing tells it the tunnel is gone, and it sits
 * there bound to a socket that has been unlinked, holding a connection open to the remote -- which is
 * why the server on the other end stays alive long after the tunnel that started it.
 *
 * Matched by argv rather than by recorded pids, because the pids change every time a forward is
 * re-established and a record written on each reconnect would be a file written for every network
 * hiccup.
 *
 * The match is deliberately narrow, and the first version of it was not. It also searched for the
 * *remote* socket path, which is an ordinary name the user chose -- `/tmp/parser.sock` and the like --
 * and `pgrep -f` compares it against every command line on the machine. So listing your tunnels could
 * SIGTERM a local server started with the same path, a tail on a log of that name, or a live tunnel of
 * someone else's pointing at the same remote socket. Only the forward socket is used now: it is a
 * digest under bica's own state directory, it appears in no command line but this tunnel's forward,
 * and the process found must be an `ssh` before anything is signalled.
 */
function killOrphanedSsh(record: TunnelRecord): number[] {
  const pattern = forwardSocketPathFor(record.localSocket);
  const found = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  if (found.error !== undefined) {
    // No pgrep: the sweep is off rather than silently believed to have happened.
    return [];
  }
  const killed: number[] = [];
  for (const line of (found.stdout ?? '').split('\n')) {
    const pid = Number(line.trim());
    // Never this process: a bica command cleaning up after a tunnel has that path in its own argv.
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      continue;
    }
    if (!processIsSsh(pid)) {
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
      killed.push(pid);
    } catch {
      // Gone between finding it and signalling it, which is the outcome this wanted.
    }
  }
  return killed;
}

/**
 * Whether a pid is an `ssh`, asked of the process table rather than inferred.
 *
 * The belt to the digest's braces. Signalling by pattern match is only ever as good as the pattern,
 * and the cost of being wrong here is somebody else's process dying.
 */
function processIsSsh(pid: number): boolean {
  const ps = spawnSync('/bin/ps', ['-o', 'comm=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  if (ps.error !== undefined || ps.status !== 0) {
    return false;
  }
  return path.basename((ps.stdout ?? '').trim()) === 'ssh';
}
