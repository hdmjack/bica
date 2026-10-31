import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * One ssh connection reused for a run's short calls.
 *
 * A no-op `bica run true` made seventeen connections one after another: the lease probes, the
 * rsyncs, the heartbeat, the artifact checks. Each paid a full handshake, 0.3 s to 1.2 s, so the
 * run spent more time greeting the remote than working. With one shared connection the same run
 * took 4 s against 7 s to 17 s.
 *
 * What does not share is the command's own connection, deliberately. Everything bica knows about a
 * dropped link comes from that ssh's own debug output, and a client riding someone else's
 * connection prints none of it. Its remote process also lives and dies with that one connection,
 * which is what the lease's liveness checks rely on. So the command, the follow-a-log tail and the
 * tunnel stay on their own, and everything short and stateless shares.
 *
 * `BICA_SSH_SHARE=0` turns it off, for a host that refuses multiplexing.
 */

/** How long the shared connection outlives its last user, so back-to-back runs reuse it too. */
const PERSIST_SECONDS = 60;

/**
 * Where the control sockets live: fixed under `/tmp` because a socket path must stay under about 104
 * bytes and macOS's per-user temp folder alone is half of that. Private to this user, and refused
 * unless it is a plain directory they own, since a folder somebody else made first would let them
 * stand in for the remote.
 */
function socketDir(): string | null {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    return null;
  }
  const uid = process.getuid();
  const dir = path.join('/tmp', `bica-ssh-${String(uid)}`);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch {
    // Exists already, which is the usual case; checked below.
  }
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
      return null;
    }
    return dir;
  } catch {
    return null;
  }
}

export function sshShareDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BICA_SSH_SHARE?.trim() === '0';
}

/**
 * ssh options that make a call share the one connection to its host, or none when sharing is off or
 * cannot be made safe. `%C` is a hash of the connection's whole identity, so two hosts, two users or
 * two ports never meet.
 */
export function sharedSshOptions(env: NodeJS.ProcessEnv = process.env): string[] {
  if (sshShareDisabled(env)) {
    return [];
  }
  const dir = socketDir();
  if (dir === null) {
    return [];
  }
  return [
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${dir}/%C`,
    '-o',
    `ControlPersist=${String(PERSIST_SECONDS)}`,
    // Only the connection that becomes the master reads these. A master whose network has gone must
    // fail its clients within a minute rather than hold them for as long as TCP takes to give up.
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
  ];
}

/**
 * Make every rsync bica starts share the connection too, through the variable rsync reads for its
 * remote shell. One place rather than a `-e` on each of the call sites, none of which then changes
 * its arguments. A value the caller already set is theirs.
 */
export function shareSshWithRsync(env: NodeJS.ProcessEnv = process.env): void {
  if (env.RSYNC_RSH !== undefined && env.RSYNC_RSH !== '') {
    return;
  }
  const options = sharedSshOptions(env);
  if (options.length === 0) {
    return;
  }
  env.RSYNC_RSH = ['ssh', ...options].join(' ');
}
