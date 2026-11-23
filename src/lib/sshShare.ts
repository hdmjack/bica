import { spawnSync } from 'node:child_process';
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

/**
 * How long a shared call or an rsync may exchange nothing with the remote before ssh ends it.
 *
 * Seven `bica run`s sat for two hours and more in their `.git` rsync, at no CPU, printing nothing.
 * The remote half of each had exited and the remote sshd never collected it: ten finished sessions
 * were still on its books twelve hours later, which is its `MaxSessions`, so it also refused every
 * new one. The connection itself was healthy and answered its keepalives, and a keepalive is all
 * `ServerAliveInterval` asks about. Nothing was ever going to arrive on those channels, and nothing
 * on this side was counting.
 *
 * ssh can count: `ChannelTimeout` closes a session that has carried no bytes either way for this
 * long, and the client on it exits 255. It is kept by whichever process holds the channel, so it
 * works the same for a client on the shared connection and for one that fell back to its own.
 *
 * Silence is not proof of death, so the limit is generous. Everything that shares is short; the long
 * one is rsync, which is quiet while the sender walks a large tree and while the receiver deletes
 * one. `BICA_SSH_IDLE_SECONDS` changes it, and `0` turns it off.
 *
 * rsync's own `--timeout` is not the tool: the rsync macOS ships reports `poll: timeout` and then
 * waits for its ssh to exit, which is the process that is stuck.
 */
const DEFAULT_IDLE_SECONDS = 120;

export function sshIdleSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BICA_SSH_IDLE_SECONDS?.trim();
  if (raw === undefined || raw === '') {
    return DEFAULT_IDLE_SECONDS;
  }
  const seconds = Number(raw);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : DEFAULT_IDLE_SECONDS;
}

let idleLimitSupported: boolean | undefined;

/**
 * Whether the installed ssh knows `ChannelTimeout`, asked once per process. An older client stops at
 * an option it does not know, and `IgnoreUnknown` on the command line would displace the one in the
 * user's own configuration, which on macOS is usually what lets `UseKeychain` through. `-G` parses
 * the options and connects to nothing.
 */
function sshSupportsIdleLimit(): boolean {
  if (idleLimitSupported === undefined) {
    const probe = spawnSync(
      'ssh',
      ['-G', '-o', 'ChannelTimeout=session=1', 'bica-option-probe.invalid'],
      { stdio: 'ignore', timeout: 5000 },
    );
    idleLimitSupported = probe.status === 0;
  }
  return idleLimitSupported;
}

/** The ssh options that end a silent session, or none when the limit is off or ssh is too old. */
export function sshIdleLimitOptions(
  env: NodeJS.ProcessEnv = process.env,
  supported: () => boolean = sshSupportsIdleLimit,
): string[] {
  const seconds = sshIdleSeconds(env);
  if (seconds === 0 || !supported()) {
    return [];
  }
  return ['-o', `ChannelTimeout=session=${String(seconds)}`];
}

/**
 * What to add to a failure that the idle limit may have caused. ssh says nothing when it closes a
 * silent session; rsync says only `unexpected end of file`. Exit 255 is ssh's own, so it is the one
 * status worth explaining, and the explanation is hedged because a dropped link gives it too.
 */
export function idleLimitHint(
  status: number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const seconds = sshIdleSeconds(env);
  if (status !== 255 || seconds === 0 || sshShareDisabled(env)) {
    return '';
  }
  return (
    `ssh ended the connection. If that came after ${String(seconds)}s of nothing, the remote end had ` +
    'stopped answering and bica gave up on it rather than wait for ever; BICA_SSH_IDLE_SECONDS ' +
    'raises the limit for a remote that is only slow.'
  );
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
    // The suffix keeps this build off a connection opened by one before 0.10.11. The idle limit is
    // kept by the process that owns the connection, so a session on an older one has none.
    `ControlPath=${dir}/%C-i`,
    '-o',
    `ControlPersist=${String(PERSIST_SECONDS)}`,
    // Only the connection that becomes the master reads these. A master whose network has gone must
    // fail its clients within a minute rather than hold them for as long as TCP takes to give up.
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    // A keepalive proves the connection, not the session on it; see `sshIdleSeconds`.
    ...sshIdleLimitOptions(env),
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
