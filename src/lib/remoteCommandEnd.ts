import { PROCESS_TREE_SH } from './remoteProcessTree';

/**
 * Ending one command of a run when its connection is gone.
 *
 * Each command publishes the pid of the shell leading its process group into the claim, but the claim
 * does not say which command that was, and a run of several commands has several. So every command also
 * writes its own pid to a file named for it, which is how the client finds the one whose connection
 * dropped without touching the others, which may well still be running and reporting.
 */

/** A name for a command's pid file: its label made safe to put in a path, or `run` for a lone command. */
export function commandTagFor(label: string | undefined): string {
  const safe = (label ?? '').replace(/[^A-Za-z0-9_-]/g, '_');
  return safe === '' ? 'run' : safe;
}

/** Where, relative to the claim, the command with this tag keeps its process group's pid. */
export function commandPidFileExpr(claimExpr: string, tag: string): string {
  return `${claimExpr}.pid.${tag}`;
}

/** What came of asking the remote to end one command. */
export type CommandEndOutcome =
  /** Its processes were there, and have been signalled. */
  | 'ended'
  /** Nothing of it was left: it had already ended, or never started. */
  | 'gone'
  /** The remote could not be asked, or did not answer in time. */
  | 'unreachable'
  /** The lease was no longer this run's, so nothing was touched. */
  | 'not-mine';

/**
 * The `sh` that ends one command's processes, guarded on the run id so a workspace another run has
 * taken since is left alone. `quotedRunId` is already quoted for `sh`.
 */
export function buildCommandEndScript(
  claimExpr: string,
  quotedRunId: string,
  tag: string,
): string {
  const file = commandPidFileExpr(claimExpr, tag);
  return (
    `[ "$(cut -d' ' -f1 ${claimExpr} 2>/dev/null)" = ${quotedRunId} ] || { echo BICA_NOT_MINE; exit 0; }\n` +
    `[ -f ${file} ] || { echo BICA_GONE; exit 0; }\n` +
    PROCESS_TREE_SH +
    `_g=$(cat ${file} 2>/dev/null)\n` +
    `rm -f ${file}\n` +
    '[ -n "$_g" ] || { echo BICA_GONE; exit 0; }\n' +
    'if _bica_end_tree "$_g"; then echo BICA_ENDED; else echo BICA_GONE; fi\n'
  );
}

export function parseCommandEndOutcome(
  status: number,
  stdout: string,
): CommandEndOutcome {
  if (status !== 0) {
    return 'unreachable';
  }
  if (stdout.includes('BICA_ENDED')) {
    return 'ended';
  }
  if (stdout.includes('BICA_NOT_MINE')) {
    return 'not-mine';
  }
  if (stdout.includes('BICA_GONE')) {
    return 'gone';
  }
  return 'unreachable';
}
