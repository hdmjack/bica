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
  /** bica's local pid, the liveness oracle when the claim belongs to this machine. */
  pid: number;
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

export function parseOwner(raw: string): ClaimOwner | null {
  const [runId, host, pid] = raw.trim().split(/\s+/);
  const parsed = Number(pid);
  if (runId === undefined || host === undefined || !Number.isInteger(parsed)) {
    return null;
  }
  return { runId, host, pid: parsed };
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
 * A claim owned by *this* machine is checkable: bica's pid either exists or it does not, the same
 * oracle the local lock uses, with the same accepted pid-reuse caveat (it errs towards refusing).
 * A claim from another machine cannot be interrogated from here, so it is honoured — refusing costs a
 * re-run, and guessing costs a wrong answer.
 */
export function claimIsStale(
  heldBy: ClaimOwner | null,
  isProcessAlive: (pid: number) => boolean,
): boolean {
  if (heldBy === null) {
    // Unreadable content cannot be one of ours: a claim is published complete, by `ln`.
    return true;
  }
  if (heldBy.host !== os.hostname()) {
    return false;
  }
  return !isProcessAlive(heldBy.pid);
}

/** The real lease operations against a host, for callers that are not tests. */
export function sshLeaseOps(sshHost: string): {
  acquire: (remoteWorkspacePath: string, owner: ClaimOwner) => ClaimResult;
  break: (remoteWorkspacePath: string, held: ClaimOwner) => void;
  release: (remoteWorkspacePath: string, owner: ClaimOwner) => void;
} {
  return {
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
  const { runId, host, pid } = result.heldBy;
  return `run ${runId} from ${host} (pid ${String(pid)})`;
}
