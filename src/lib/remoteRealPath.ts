import { remotePathExprForCd, runRemoteScriptOverStdin } from './runRemote';
import { dim } from '../terminalStyle';

/**
 * The real directory behind a remote workspace path that is a symbolic link.
 *
 * Mutagen will not open a synchronization root that is a link: it reports `unable to open
 * synchronization root: too many levels of symbolic links` and retries every five seconds, however the
 * path is spelled (a trailing slash, `/.` and a doubled slash all fail the same way). A remote path
 * that is a link is ordinary -- a checkout moved to another volume leaves one behind so the old path
 * keeps working -- and every plain `bica run` into it stopped with exit 94.
 *
 * So the link is resolved here, once, and the real path is what bica uses for the workspace: the
 * sync, the lease, the install and run records are all named after it. That is also what makes the
 * link and its target one workspace instead of two. Before this, a checkout configured with the real
 * path and another configured with the link took different leases and could run into the same
 * directory together.
 *
 * Only a link at the end of the path is resolved. A link further up the path is opened through without
 * trouble, and rewriting the path of every workspace whose home directory happens to be a link would
 * give each one a new name for nothing.
 */

/** The script's answer: `real=<path>` for a link, `real=` for a path that is not one. */
export function buildRealPathProbeScript(remoteWorkspacePath: string): string {
  return [
    `w=${remotePathExprForCd(remoteWorkspacePath)}`,
    // A trailing slash makes `[ -L ]` follow the link it is asking about.
    'w="${w%/}"',
    'if [ -L "$w" ]; then',
    '  r=$(cd "$w" 2>/dev/null && pwd -P) || exit 3',
    '  printf \'real=%s\\n\' "$r"',
    'else',
    "  printf 'real=\\n'",
    'fi',
    '',
  ].join('\n');
}

/**
 * What the probe said: the real path, `''` for a path that is not a link, or null when it could not
 * be told (the answer was malformed, or the link leads nowhere).
 */
export function parseRealPathProbe(stdout: string): string | '' | null {
  const match = /^real=(.*)$/m.exec(stdout);
  if (match === null) {
    return null;
  }
  const real = match[1].trim();
  if (real === '') {
    return '';
  }
  // Absolute, and nothing a path cannot hold: it goes into a project file and a lease name.
  return real.startsWith('/') && !/[\0\r\n]/.test(real) ? real : null;
}

export type RemoteScriptRun = (
  sshHost: string,
  script: string,
  options?: { timeoutSeconds?: number },
) => { status: number; stdout: string; stderr: string };

const cache = new Map<string, string>();

/** Forget what has been resolved. For tests, which share a process. */
export function clearRealPathCache(): void {
  cache.clear();
}

/** Off for a host where the probe is unwanted, and for tests that must not reach one. */
export function realPathResolutionDisabled(): boolean {
  return process.env.BICA_RESOLVE_REMOTE_LINKS?.trim() === '0';
}

/**
 * The path bica should use for this workspace: the real directory when the configured path is a link,
 * and the configured path unchanged otherwise, or when the remote could not be asked.
 *
 * Never throws and never blocks for long. A host that is down is reported properly by whatever runs
 * next; this must not be the thing that hangs on it.
 */
export function resolveRemoteWorkspacePath(
  sshHost: string,
  remoteWorkspacePath: string,
  run: RemoteScriptRun = runRemoteScriptOverStdin,
  announce: (line: string) => void = (line) => {
    process.stderr.write(`${dim('[bica]')} ${dim(line)}\n`);
  },
): string {
  if (realPathResolutionDisabled()) {
    return remoteWorkspacePath;
  }
  const key = `${sshHost}\0${remoteWorkspacePath}`;
  const known = cache.get(key);
  if (known !== undefined) {
    return known;
  }
  const result = run(sshHost, buildRealPathProbeScript(remoteWorkspacePath), {
    timeoutSeconds: 10,
  });
  const real = result.status === 0 ? parseRealPathProbe(result.stdout) : null;
  // Remembered even when it could not be told, so one command does not ask a dead host four times.
  const chosen = real === null || real === '' ? remoteWorkspacePath : real;
  cache.set(key, chosen);
  if (chosen !== remoteWorkspacePath) {
    announce(
      `${remoteWorkspacePath} on ${sshHost} is a link to ${chosen}; using ${chosen}, which Mutagen can open.`,
    );
  }
  return chosen;
}
