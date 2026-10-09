import { claimPathExpr } from './remoteClaim';
import { runRemoteScriptOverStdin } from './runRemote';

/**
 * What a run left running on the remote, and how hard the remote is working.
 *
 * Neither is bica's to prevent. A command may background a server deliberately — a parser that keeps
 * a language model warm between runs is the motivating case, and killing it would be the bug. What
 * bica can do is notice, because nothing else is looking: three such servers once span at full tilt
 * for seven days, found only when the machine got loud enough to mention. Ten minutes of a broken
 * idle-timeout is nothing; seven days of three cores is a week of somebody's electricity and the fan
 * next to their desk.
 *
 * So this reports and never acts. The same reasoning as `--write-back`: tell the person who can
 * decide, name what you found, and leave it alone.
 */

export interface RemoteLeftover {
  pid: number;
  command: string;
}

export interface RemoteLoad {
  /** One-minute load average. */
  load: number;
  /** Cores, so the load means something without knowing the machine. */
  cores: number;
}

/** Processes still in this run's process groups once its command has finished. */
export function buildLeftoversScript(claimExpr: string): string {
  return (
    // The run's own shell has exited by the time this is asked, so anything still in its process
    // group outlived the command that started it.
    `_g=$(tr ' ' '\\n' < ${claimExpr} 2>/dev/null | grep '^rpid=' | cut -d= -f2)\n` +
    '[ -n "$_g" ] || exit 0\n' +
    'for _one in $_g; do\n' +
    '  ps -A -o pgid=,pid=,command= 2>/dev/null | awk -v g="$_one" \'$1 == g { $1=""; print }\'\n' +
    'done\n'
  );
}

export function parseLeftovers(stdout: string): RemoteLeftover[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const match = /^(\d+)\s+(.*)$/.exec(line);
      if (match === null) {
        return [];
      }
      return [{ pid: Number(match[1]), command: match[2] }];
    });
}

export function findRemoteLeftovers(
  sshHost: string,
  remoteWorkspacePath: string,
  run: typeof runRemoteScriptOverStdin = runRemoteScriptOverStdin,
): RemoteLeftover[] {
  const result = run(sshHost, buildLeftoversScript(claimPathExpr(remoteWorkspacePath)));
  return result.status === 0 ? parseLeftovers(result.stdout) : [];
}

/** `uptime` and the core count, in one round trip. */
export function buildLoadScript(): string {
  return (
    "uptime | sed -e 's/.*averages*: *//' -e 's/,/ /g' | awk '{print \"LOAD \" $1}'\n" +
    "(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 1) | awk '{print \"CORES \" $1}'\n"
  );
}

export function parseLoad(stdout: string): RemoteLoad | null {
  const load = /LOAD\s+([\d.]+)/.exec(stdout);
  const cores = /CORES\s+(\d+)/.exec(stdout);
  if (load === null || cores === null) {
    return null;
  }
  const parsed = { load: Number(load[1]), cores: Number(cores[1]) };
  return Number.isFinite(parsed.load) && parsed.cores > 0 ? parsed : null;
}

export function readRemoteLoad(
  sshHost: string,
  run: typeof runRemoteScriptOverStdin = runRemoteScriptOverStdin,
): RemoteLoad | null {
  const result = run(sshHost, buildLoadScript());
  return result.status === 0 ? parseLoad(result.stdout) : null;
}

/**
 * Whether the remote is working hard enough to be worth mentioning.
 *
 * One core's worth of load per core is ordinary for a machine running a test suite. Past that it is
 * either genuinely busy — in which case a run is about to be slow and the user may as well know — or
 * something is running that nobody meant to leave.
 */
export function loadIsWorthMentioning(load: RemoteLoad): boolean {
  return load.load > load.cores;
}

/** One line, or nothing when there is nothing to say. */
export function describeRemoteState(options: {
  sshHost: string;
  leftovers: readonly RemoteLeftover[];
  load: RemoteLoad | null;
}): string | undefined {
  const parts: string[] = [];
  if (options.leftovers.length > 0) {
    const named = options.leftovers
      .slice(0, 3)
      .map((p) => `${String(p.pid)} ${p.command.slice(0, 60)}`)
      .join('; ');
    const more =
      options.leftovers.length > 3
        ? ` (and ${String(options.leftovers.length - 3)} more)`
        : '';
    parts.push(
      `This run left ${String(options.leftovers.length)} process${options.leftovers.length === 1 ? '' : 'es'} running on ${options.sshHost}: ${named}${more}.`,
    );
  }
  if (options.load !== null && loadIsWorthMentioning(options.load)) {
    parts.push(
      `${options.sshHost} is at load ${String(options.load.load)} on ${String(options.load.cores)} cores.`,
    );
  }
  return parts.length === 0 ? undefined : parts.join(' ');
}
