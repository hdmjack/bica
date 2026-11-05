import type { CancelOutcome } from './remoteClaim';

/**
 * What a run does when it is told to stop by SIGTERM or SIGHUP, as a function of its parts so the
 * decision can be tested without a signal or a remote.
 *
 * The one decision that matters is the watchdog. It is the backstop for a run that dies before its
 * remote command is ended, and it was disarmed unconditionally after the cancel -- but the cancel is
 * one ssh round trip, and the signals that reach a run (an agent's shell tool stopping its jobs, a
 * task runner on timeout) usually reach that ssh too, because it is in the same process group. The
 * cancel then fails, the run says it is releasing the workspace, the watchdog is gone, and the remote
 * command and the lease stay behind until somebody runs `bica cancel`.
 *
 * So the watchdog is stood down only when the remote has said the claim is no longer this run's to
 * clean up. Anything less -- no answer, an ssh that died, a reply that names none of the three -- leaves
 * it armed, to cancel from its own connection once this process has exited.
 */
export interface SignalTeardownParts {
  /** One round trip that ends the remote command and removes the claim. May throw or report nothing. */
  cancelClaim: () => CancelOutcome;
  /** Stand the backstop down. Only called once the remote has confirmed there is nothing left to do. */
  disarmWatchdog: () => void;
  stopHeartbeat: () => void;
  /** Stop waiting on the local ssh connections. */
  terminateLocalConnections: () => void;
}

export interface SignalTeardownResult {
  /** The remote confirmed the claim is gone or was never this run's; the watchdog was disarmed. */
  confirmed: boolean;
}

/** Whether a cancel's reply means the remote has nothing of this run's left to clean up. */
export function cancelSettledTheClaim(outcome: CancelOutcome | undefined): boolean {
  if (outcome === undefined) {
    return false;
  }
  // `notMine`: another run holds the workspace now, so there is nothing of ours to remove and the
  // watchdog -- guarded by run id -- would do nothing either. `noClaim`: already released.
  return outcome.cleared || outcome.notMine || outcome.noClaim;
}

export function tearDownRunOnSignal(parts: SignalTeardownParts): SignalTeardownResult {
  let outcome: CancelOutcome | undefined;
  try {
    // Remote first: this signals the process group and removes the claim in one round trip, so the
    // workspace is never advertised as free while the command is still winding down.
    outcome = parts.cancelClaim();
  } catch {
    outcome = undefined;
  }
  const confirmed = cancelSettledTheClaim(outcome);
  if (confirmed) {
    parts.disarmWatchdog();
  }
  parts.stopHeartbeat();
  parts.terminateLocalConnections();
  return { confirmed };
}
