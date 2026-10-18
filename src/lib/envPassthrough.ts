import { shellSingleQuoteRemotePathForSh } from './runRemote';

/**
 * Local environment variables carried to the remote command, by name.
 *
 * ssh does not forward environment by default, and the ones that matter to a compiled build are set
 * locally for the occasion: `RUSTFLAGS` for a target feature, `CARGO_TARGET_DIR` to point at a tree
 * the remote owns, `CMAKE_BUILD_TYPE` for one run of many. Without this they are simply absent on the
 * other side, so the build runs with different settings from the ones asked for and nothing says so.
 *
 * By name and never wholesale. Copying the local environment across would carry credentials,
 * `PATH`, `HOME` and whatever else the shell happens to hold into a machine's login shell, which is
 * both a leak and a way to break a remote in ways that are very hard to see. A declared list is a
 * decision; a copy is an accident waiting for the right variable.
 */

/** Variables bica will not forward whatever the config says, because they would break the remote. */
const NEVER_FORWARD = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'PWD',
  'OLDPWD',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'SSH_CONNECTION',
  'SSH_CLIENT',
  'SSH_TTY',
]);

export interface EnvForwarding {
  /** Shell lines to put in front of the command, or '' when there is nothing to forward. */
  script: string;
  /** Names actually forwarded, for reporting. */
  forwarded: string[];
  /** Declared but not set locally: worth saying, since the user expected them to travel. */
  unset: string[];
  /** Declared but refused. */
  refused: string[];
}

export function buildEnvForwarding(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): EnvForwarding {
  const forwarded: string[] = [];
  const unset: string[] = [];
  const refused: string[] = [];
  const lines: string[] = [];
  for (const name of names) {
    if (NEVER_FORWARD.has(name)) {
      refused.push(name);
      continue;
    }
    const value = env[name];
    if (value === undefined) {
      // Not an error. A variable that is only set for some runs is the normal case, and exporting an
      // empty string in its place is worse than leaving it absent: an unset variable and an empty
      // one mean different things to cargo and to cmake alike.
      unset.push(name);
      continue;
    }
    lines.push(
      `export ${name}=${shellSingleQuoteRemotePathForSh(value)}`,
    );
    forwarded.push(name);
  }
  return {
    script: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
    forwarded,
    unset,
    refused,
  };
}

/** What to say about forwarding, or undefined when there is nothing worth a line. */
export function describeEnvForwarding(
  forwarding: EnvForwarding,
): string | undefined {
  const parts: string[] = [];
  if (forwarding.forwarded.length > 0) {
    parts.push(`Forwarding ${forwarding.forwarded.join(', ')} to the remote.`);
  }
  if (forwarding.unset.length > 0) {
    parts.push(
      `${forwarding.unset.join(', ')} ${forwarding.unset.length === 1 ? 'is' : 'are'} in \`env:\` but not set here, so ${forwarding.unset.length === 1 ? 'it is' : 'they are'} not forwarded.`,
    );
  }
  if (forwarding.refused.length > 0) {
    parts.push(
      `${forwarding.refused.join(', ')} cannot be forwarded: ${forwarding.refused.length === 1 ? 'it describes' : 'they describe'} this machine, and setting ${forwarding.refused.length === 1 ? 'it' : 'them'} on the remote would break the run.`,
    );
  }
  return parts.length === 0 ? undefined : parts.join(' ');
}
