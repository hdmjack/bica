import * as os from 'node:os';

import {
  runRemoteScriptOverStdin,
  shellSingleQuoteRemotePathForSh,
} from './runRemote';

/**
 * A lease on a remote workspace, held for the whole run.
 *
 * Three earlier attempts at this got it wrong in the same way each time, so the reasoning is worth
 * keeping:
 *
 * 1. A lock in `<checkout>/.bica/locks` is the right idea at the wrong scope. The contended resource
 *    is a directory on a remote host and this machine has seven clones of the repo, so a lock held in
 *    one clone says nothing about what a run from another clone is doing to the same directory.
 * 2. A marker *inside* the workspace is at the right scope but cannot survive: the pinned push runs
 *    `rsync --delete`, the marker does not exist locally, so the push deletes the very thing meant to
 *    gate it. Demonstrated — a second run then saw a free workspace, ran against the first run's
 *    files, and exited 0.
 * 3. A marker recording only *state* ("in progress") has no recovery predicate. A killed run leaves it
 *    set forever and wedges the workspace, and the only ways out are a clock or a manual reset.
 *
 * So: the claim lives outside the workspace, where no sync can reach it; it is taken *before* the
 * rsync, because the rsync is the destructive act; and it records an owner, so staleness is decided by
 * asking whether that owner still exists rather than by how long it has been there.
 */

/** Where claims live on the remote — deliberately not inside any synced workspace. */
const REMOTE_CLAIM_DIR = '~/.bica/claims';

export interface ClaimOwner {
  runId: string;
  /** Host of the machine running bica, so a claim can be attributed across machines. */
  host: string;
  /** bica's local pid. Necessary for liveness but not sufficient — see {@link claimIsStale}. */
  pid: number;
  /**
   * Pid of the remote shell executing the command, published by the run script once it starts.
   *
   * Absent until then, and absent for a run that never reached the remote. Present means something is
   * or was executing *in* the workspace, which is the thing the lease actually protects.
   *
   * Doubles as a process *group* id: sshd starts the command in its own session, so the shell leads
   * the group and everything it spawns joins it. That is what makes it answerable — see
   * {@link remoteRunIsAlive}.
   */
  remotePid?: number;
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; heldBy: ClaimOwner | null; raw: string };

/** Stable filename for a workspace path: one claim per remote directory. */
export function claimFileName(remoteWorkspacePath: string): string {
  return remoteWorkspacePath
    .trim()
    .replace(/\/+$/, '')
    .replace(/^~\/?/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_');
}

export function claimPathExpr(remoteWorkspacePath: string): string {
  return `${REMOTE_CLAIM_DIR}/${claimFileName(remoteWorkspacePath)}`;
}

export function describeSelfAsOwner(runId: string): ClaimOwner {
  return { runId, host: os.hostname(), pid: process.pid };
}

export function formatOwner(owner: ClaimOwner): string {
  // The claim is space-delimited and the remote reads field 1 with `cut`, so a run id containing
  // whitespace would silently compare against a fragment of itself and every check would fail.
  // Constrain it here rather than quoting around a value that can never legitimately contain a space.
  if (/\s/.test(owner.runId) || owner.runId === '') {
    throw new Error(
      `Run id must be non-empty and free of whitespace (got ${JSON.stringify(owner.runId)}).`,
    );
  }
  return `${owner.runId} ${owner.host} ${String(owner.pid)}`;
}

/**
 * Parse a claim line: `runId host clientPid [rpid=N] [exitCode]`.
 *
 * The remote pid is a *tagged* field rather than a fourth positional one because the claim already
 * grows a positional field — the exit code the run script appends when it finishes. Two optional
 * positionals cannot be told apart, and reading an exit code of `0` as a pid would be actively
 * harmful: `kill -0 0` succeeds, so a finished run's claim would read as live and wedge the workspace
 * forever. The tag also means a claim written by an older bica parses correctly rather than
 * accidentally.
 */
export function parseOwner(raw: string): ClaimOwner | null {
  const fields = raw.trim().split(/\s+/);
  const [runId, host, pid] = fields;
  const parsed = Number(pid);
  if (runId === undefined || host === undefined || !Number.isInteger(parsed)) {
    return null;
  }
  const remote = fields.slice(3).find((f) => /^rpid=\d+$/.test(f));
  const owner: ClaimOwner = { runId, host, pid: parsed };
  if (remote !== undefined) {
    owner.remotePid = Number(remote.slice('rpid='.length));
  }
  return owner;
}

function runRemoteScript(
  sshHost: string,
  script: string,
): { status: number; stdout: string } {
  const r = runRemoteScriptOverStdin(sshHost, script);
  return { status: r.status, stdout: r.stdout.trim() };
}

/**
 * The `sh` that takes the lease, as a string, so it can be run directly against a temp directory in
 * a test instead of only over ssh. The shell is the part that has to be right -- `ln` failing on an
 * existing target is what makes the claim exclusive -- and it was previously reachable only through
 * a live remote, which is why it went untested.
 *
 * `dir` is a parameter for the same reason: a test points it at `$TMPDIR`, production passes
 * `~/.bica/claims`.
 *
 * The temp name uses `$$`, which is unique per *process* and not per subshell — two `( ... ) &`
 * subshells of one shell share it and will delete each other's temp file. That is safe here because
 * every acquire is its own ssh session and so its own shell, but it does mean this script must not be
 * batched twice into a single remote invocation.
 */
export function buildClaimAcquireScript(
  claimExpr: string,
  ownerLine: string,
  dir: string,
): string {
  const payload = shellSingleQuoteRemotePathForSh(ownerLine);
  return (
    `mkdir -p ${dir} 2>/dev/null || exit 1\n` +
    `_t=${claimExpr}.tmp.$$\n` +
    `printf '%s' ${payload} > "$_t" || exit 1\n` +
    `if ln "$_t" ${claimExpr} 2>/dev/null; then rm -f "$_t"; echo OK; else rm -f "$_t"; printf 'HELD '; cat ${claimExpr} 2>/dev/null; echo; fi\n`
  );
}

/**
 * The `sh` that drops the lease, matching on the run id field only. See {@link removeClaimOwnedBy}
 * for why a whole-line comparison was wrong.
 */
export function buildClaimReleaseScript(
  claimExpr: string,
  runId: string,
): string {
  const q = shellSingleQuoteRemotePathForSh(runId);
  return `[ "$(cut -d' ' -f1 ${claimExpr} 2>/dev/null)" = ${q} ] && rm -f ${claimExpr}\nexit 0\n`;
}

/**
 * The `sh` that ends a run and drops its lease, in one round-trip.
 *
 * One script rather than "kill, then release" as two calls, because the gap between them is a window
 * where the claim is gone and the remote may still be winding down — which is precisely the state the
 * lease exists to make impossible. Signalling first and removing the claim afterwards means the
 * workspace is never advertised as free while anything is still in it.
 *
 * The signal goes to the *group* (`kill -TERM -$p`), for the reason {@link remoteRunIsAlive} checks
 * the group: the recorded pid is the remote shell, and signalling it alone leaves its children running
 * in the workspace.
 *
 * `runId` narrows it to one run when the caller knows which it is tearing down. Passing `null` cancels
 * whatever holds the claim, which is what `bica cancel` needs when the run it is clearing up belongs
 * to a client that no longer exists.
 */
export function buildClaimCancelScript(
  claimExpr: string,
  runId: string | null,
): string {
  const guard =
    runId === null
      ? ''
      : `[ "$(cut -d' ' -f1 ${claimExpr} 2>/dev/null)" = ${shellSingleQuoteRemotePathForSh(runId)} ] || { echo BICA_NOT_MINE; exit 0; }\n`;
  return (
    `[ -f ${claimExpr} ] || { echo BICA_NO_CLAIM; exit 0; }\n` +
    guard +
    `_p=$(tr ' ' '\\n' < ${claimExpr} 2>/dev/null | grep '^rpid=' | cut -d= -f2)\n` +
    'if [ -n "$_p" ]; then\n' +
    '  if kill -TERM -"$_p" 2>/dev/null; then echo BICA_SIGNALLED; else echo BICA_GROUP_GONE; fi\n' +
    'else\n' +
    '  echo BICA_NEVER_RAN\n' +
    'fi\n' +
    `rm -f ${claimExpr}\n` +
    'echo BICA_CLEARED\n'
  );
}

/** What a cancel actually did, so the caller can say something true rather than "done". */
export interface CancelOutcome {
  cleared: boolean;
  /** The remote process group was still there and has been signalled. */
  signalled: boolean;
  /** A claim existed but named a different run; nothing was touched. */
  notMine: boolean;
  noClaim: boolean;
  /** The claim recorded no remote pid: the run was cancelled before its command ever started. */
  neverRan: boolean;
}

export function remoteCancelClaim(
  sshHost: string,
  remoteWorkspacePath: string,
  runId: string | null,
): CancelOutcome {
  const { stdout } = runRemoteScript(
    sshHost,
    buildClaimCancelScript(claimPathExpr(remoteWorkspacePath), runId),
  );
  return {
    cleared: stdout.includes('BICA_CLEARED'),
    signalled: stdout.includes('BICA_SIGNALLED'),
    notMine: stdout.includes('BICA_NOT_MINE'),
    noClaim: stdout.includes('BICA_NO_CLAIM'),
    neverRan: stdout.includes('BICA_NEVER_RAN'),
  };
}

/** Who holds the claim right now, without trying to take it. */
export function remoteReadClaim(
  sshHost: string,
  remoteWorkspacePath: string,
): ClaimOwner | null {
  const { status, stdout } = runRemoteScript(
    sshHost,
    `cat ${claimPathExpr(remoteWorkspacePath)} 2>/dev/null\n`,
  );
  if (status !== 0 || stdout === '') {
    return null;
  }
  return parseOwner(stdout);
}

/**
 * Take the lease, or report who holds it.
 *
 * Published with `ln` from a fully-written temp file rather than a `set -C` redirect. The redirect
 * repeats the mistake this whole area started with: it creates the file empty and fills it afterwards,
 * so a reader arriving in between sees a claim with no owner. `ln` fails outright if the target exists,
 * and the content is already there when the name appears.
 */
export function remoteAcquireClaim(
  sshHost: string,
  remoteWorkspacePath: string,
  owner: ClaimOwner,
): ClaimResult {
  const script = buildClaimAcquireScript(
    claimPathExpr(remoteWorkspacePath),
    formatOwner(owner),
    REMOTE_CLAIM_DIR,
  );
  const { status, stdout } = runRemoteScript(sshHost, script);
  if (status !== 0) {
    return { ok: false, heldBy: null, raw: `claim probe failed (ssh exit ${String(status)})` };
  }
  if (stdout.startsWith('OK')) {
    return { ok: true };
  }
  const raw = stdout.replace(/^HELD\s*/, '');
  return { ok: false, heldBy: parseOwner(raw), raw };
}

/**
 * Remove a claim, but only if it still names `runId`.
 *
 * Matching on the run id field rather than the whole line matters: the run script appends its exit
 * code as a fourth field when it finishes, so a whole-line comparison stops matching at exactly the
 * moment release is called, and the lease is never dropped. That left every completed run holding its
 * workspace forever — the wedge, arriving by a different route.
 */
function removeClaimOwnedBy(
  sshHost: string,
  remoteWorkspacePath: string,
  runId: string,
): void {
  const script = buildClaimReleaseScript(
    claimPathExpr(remoteWorkspacePath),
    runId,
  );
  runRemoteScript(sshHost, script);
}

/** Drop the lease. Safe when we do not hold it: it only removes a claim naming this run. */
export function remoteReleaseClaim(
  sshHost: string,
  remoteWorkspacePath: string,
  owner: ClaimOwner,
): void {
  removeClaimOwnedBy(sshHost, remoteWorkspacePath, owner.runId);
}

/**
 * Clear a claim established as dead, then let the caller retry.
 * Scoped to the run id we inspected, so a live run that arrived meanwhile is not evicted.
 */
export function remoteBreakClaim(
  sshHost: string,
  remoteWorkspacePath: string,
  expected: ClaimOwner,
): void {
  removeClaimOwnedBy(sshHost, remoteWorkspacePath, expected.runId);
}

/**
 * Whether a claim can be taken over, decided structurally rather than by elapsed time.
 *
 * Two liveness questions, asked in the order that costs least:
 *
 * 1. Is the *client* still running? Only answerable for a claim from this machine; a claim from
 *    another machine cannot be interrogated from here, so it is honoured — refusing costs a re-run,
 *    and guessing costs a wrong answer.
 * 2. If the client is gone, is the *remote* still running? This is the question that matters, and for
 *    a long time it was not asked at all. The client and the remote command have different lifetimes:
 *    the remote one follows the ssh connection, so any interruption that takes the client without
 *    taking the ssh — an obvious `pkill` matching `cli.ts run` does exactly this — leaves the command
 *    executing in the workspace with nothing local to point at. Judging that claim stale from the
 *    client pid alone breaks the lease and syncs over a live run, which is the precise outcome the
 *    lease exists to prevent.
 *
 * A dead client with no remote pid recorded is stale: the run never got as far as executing, so
 * nothing is in the workspace to protect. Pid reuse on the remote errs the same way it does locally —
 * towards refusing — which is the safe direction.
 *
 * `isRemoteProcessAlive` is only consulted when the answer would otherwise be "stale", so a contended
 * workspace whose holder is plainly alive still costs no extra round-trip.
 */
export function claimIsStale(
  heldBy: ClaimOwner | null,
  isProcessAlive: (pid: number) => boolean,
  isRemoteProcessAlive: (pid: number) => boolean,
): boolean {
  if (heldBy === null) {
    // Unreadable content cannot be one of ours: a claim is published complete, by `ln`.
    return true;
  }
  if (heldBy.host !== os.hostname()) {
    return false;
  }
  if (isProcessAlive(heldBy.pid)) {
    return false;
  }
  if (heldBy.remotePid === undefined) {
    return true;
  }
  return !isRemoteProcessAlive(heldBy.remotePid);
}

/**
 * Whether anything from a remote run is still executing.
 *
 * Asks about the process *group*, not the recorded pid. Killing the remote shell does not take its
 * children with it: a `sleep` started by that shell was observed still running in the workspace after
 * the shell was gone, so `kill -0 <shell>` would have reported the workspace free while a process was
 * still sitting in it. sshd gives the command its own session, so the shell leads the group and every
 * descendant is in it — one question that covers the whole job.
 *
 * Answers with a token rather than with ssh's exit status, because the two failures it has to separate
 * look identical there: a genuinely empty process group, and ssh failing to connect at all. Only an
 * explicit `DEAD` is read as dead; anything else — a dropped connection, a host that is down,
 * unparseable output — reports alive, so an unanswerable question refuses to break the lease instead
 * of breaking it on a transport error.
 *
 * Deliberately not `pgrep -g`: a remote without `pgrep` would answer "dead" for every live run, which
 * is the dangerous direction to fail in. `ps -A -o pgid=` is present wherever ssh is.
 */
export function remoteRunIsAlive(sshHost: string, remotePid: number): boolean {
  if (!Number.isInteger(remotePid) || remotePid <= 0) {
    return false;
  }
  const { status, stdout } = runRemoteScript(
    sshHost,
    `if ps -A -o pgid= 2>/dev/null | tr -d ' ' | grep -qx ${String(remotePid)}; then echo BICA_ALIVE; else echo BICA_DEAD; fi\n`,
  );
  if (status !== 0) {
    return true;
  }
  return stdout.trim() !== 'BICA_DEAD';
}

/** The real lease operations against a host, for callers that are not tests. */
export function sshLeaseOps(sshHost: string): {
  acquire: (remoteWorkspacePath: string, owner: ClaimOwner) => ClaimResult;
  break: (remoteWorkspacePath: string, held: ClaimOwner) => void;
  release: (remoteWorkspacePath: string, owner: ClaimOwner) => void;
  remotePidAlive: (pid: number) => boolean;
} {
  return {
    remotePidAlive: (pid) => remoteRunIsAlive(sshHost, pid),
    acquire: (p, owner) => remoteAcquireClaim(sshHost, p, owner),
    break: (p, held) => {
      remoteBreakClaim(sshHost, p, held);
    },
    release: (p, owner) => {
      remoteReleaseClaim(sshHost, p, owner);
    },
  };
}

/** Human-readable, for the refusal message. */
export function describeClaim(result: ClaimResult): string {
  if (result.ok) {
    return 'free';
  }
  if (result.heldBy === null) {
    return result.raw === '' ? 'an unidentified run' : result.raw;
  }
  const { runId, host, pid, remotePid } = result.heldBy;
  const remote =
    remotePid === undefined ? '' : `, remote pid ${String(remotePid)}`;
  return `run ${runId} from ${host} (pid ${String(pid)}${remote})`;
}
