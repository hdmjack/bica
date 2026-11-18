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

/**
 * What became of each command of this run whose result never came back.
 *
 * The lease is kept after a lost connection because the command may still be running on the remote,
 * and a second run synced over it would corrupt both. That reason stops applying once the remote has
 * confirmed there is nothing left of it: the command's processes are ended, or were already gone, or
 * the workspace is no longer this run's. Keeping the lease then only refuses the next run for
 * nothing, and the "ending its remote command in the background" notice printed beside a message
 * saying it already had been was the same mistake said aloud.
 *
 * A process runs one `bica run`, so this is process-wide state. Anything not confirmed -- the host
 * could not be asked, a command killed by a signal, a lost command with no lease to name -- is
 * recorded as `unknown`, which keeps the lease as before.
 */
const lostCommands: (CommandEndOutcome | 'unknown')[] = [];

export function recordLostCommand(outcome: CommandEndOutcome | undefined): void {
  lostCommands.push(outcome ?? 'unknown');
}

/** True only when every lost command was confirmed to have nothing left running. */
export function lostCommandsAreConfirmedGone(): boolean {
  return (
    lostCommands.length > 0 &&
    lostCommands.every((o) => o === 'ended' || o === 'gone' || o === 'not-mine')
  );
}

/** For tests: a fresh process starts with nothing recorded. */
export function forgetLostCommands(): void {
  lostCommands.length = 0;
}
