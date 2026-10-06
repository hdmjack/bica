import { claimFileName } from './remoteClaim';
import { runRemoteScriptOverStdin, shellSingleQuoteRemotePathForSh } from './runRemote';

/**
 * What the remote workspace has installed, recorded where the thing it describes actually lives.
 *
 * This used to be a file in the local checkout, and the mismatch cost someone an afternoon. The
 * record describes one remote `node_modules`; several checkouts can share that one directory, because
 * a remote path is just a path and sibling worktrees routinely point at the same one. So checkout A
 * installs its lockfile and writes its own record; checkout B, with a different lockfile, reinstalls
 * and prunes what A added; A runs again, compares its lockfile against its own untouched record,
 * concludes it is up to date, and fails on a module that is no longer there. Nothing in that sequence
 * is wrong except where the record was kept.
 *
 * Keeping it on the remote makes the claim answerable by the only machine that can answer it. It sits
 * beside the workspace leases in `~/.bica`, deliberately outside any synced tree: a record inside the
 * workspace would be deleted by the next mirroring sync, which is the same confusion in another form.
 */

/** Where install records live on the remote — alongside the claims, and never inside a workspace. */
const REMOTE_INSTALL_DIR = '~/.bica/installs';

/** How a remote script is run. Injectable so the shape of these scripts can be tested without ssh. */
export type RemoteRunner = (
  sshHost: string,
  script: string,
) => { status: number; stdout: string; stderr: string };

/**
 * One record per workspace per package manager.
 *
 * Keyed by the remote path rather than by the checkout, which is the whole point: two checkouts
 * pointing at one workspace must read and write the same record, and that is what makes one of them
 * notice what the other did.
 */
export function installRecordPathExpr(
  remoteWorkspacePath: string,
  pluginId: string,
): string {
  const safeId = pluginId.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${REMOTE_INSTALL_DIR}/${claimFileName(remoteWorkspacePath)}.${safeId}`;
}

export function buildReadInstallRecordScript(pathExpr: string): string {
  // `cat` of a missing file is not an error here: no record simply means nothing has installed yet.
  return `cat ${pathExpr} 2>/dev/null || true\n`;
}

export function buildWriteInstallRecordScript(
  pathExpr: string,
  digest: string,
): string {
  const dir = REMOTE_INSTALL_DIR;
  return (
    `mkdir -p ${dir} && printf '%s\\n' ${shellSingleQuoteRemotePathForSh(digest)} > ${pathExpr}\n`
  );
}

export function buildClearInstallRecordScript(pathExpr: string): string {
  return `rm -f ${pathExpr}\n`;
}

/** The fingerprint the remote workspace last installed from, or null when it has no record. */
export function readRemoteInstallRecord(
  sshHost: string,
  remoteWorkspacePath: string,
  pluginId: string,
  run: RemoteRunner = runRemoteScriptOverStdin,
): string | null {
  const result = run(
    sshHost,
    buildReadInstallRecordScript(
      installRecordPathExpr(remoteWorkspacePath, pluginId),
    ),
  );
  if (result.status !== 0) {
    // A record that cannot be read is not a record. Reinstalling is the safe reading of that: the
    // install is idempotent when nothing has changed, where skipping it on a guess is not.
    return null;
  }
  const text = result.stdout.trim();
  return text.length > 0 ? text : null;
}

export function writeRemoteInstallRecord(
  sshHost: string,
  remoteWorkspacePath: string,
  pluginId: string,
  digest: string,
  run: RemoteRunner = runRemoteScriptOverStdin,
): void {
  run(
    sshHost,
    buildWriteInstallRecordScript(
      installRecordPathExpr(remoteWorkspacePath, pluginId),
      digest,
    ),
  );
}

/** Forget what the workspace installed, so the next run installs. */
export function clearRemoteInstallRecord(
  sshHost: string,
  remoteWorkspacePath: string,
  pluginId: string,
  run: RemoteRunner = runRemoteScriptOverStdin,
): void {
  run(
    sshHost,
    buildClearInstallRecordScript(
      installRecordPathExpr(remoteWorkspacePath, pluginId),
    ),
  );
}
