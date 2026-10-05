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
