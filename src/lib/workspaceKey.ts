import { createHash } from 'node:crypto';
import * as path from 'node:path';

/**
 * A short name for one remote workspace, `host:path` as Mutagen lists it.
 *
 * Everything bica keeps for a sync -- the Mutagen project file and its lock, the session name, the
 * live-run marker -- is named after this, so two runs from one checkout into different workspaces
 * keep separate state. Before it, they shared one project file and one lock, and the second run was
 * told "already running" about a sync that pointed somewhere else.
 *
 * Derived from the string that both bica and `mutagen sync list` spell the same way, so a session
 * found in the listing can be traced back to its files without asking anyone.
 */
export function workspaceKey(remoteSyncUrl: string): string {
  return createHash('sha256').update(remoteSyncUrl).digest('hex').slice(0, 8);
}

/** The project file bica writes for one workspace, relative to the checkout. */
export function projectFileRelative(key: string): string {
  return path.join('.bica', `project-${key}.yml`);
}

/** The pre-0.9 project file, shared by every workspace of a checkout. Read only, to end its sync. */
export const LEGACY_PROJECT_FILE_RELATIVE = path.join('.bica', 'project.yml');

/** A Mutagen session name that cannot collide with another workspace's session from the same checkout. */
export function syncSessionName(baseName: string, remoteSyncUrl: string): string {
  return `${baseName}-${workspaceKey(remoteSyncUrl)}`;
}

/** Where a `bica run` records that it started this workspace's sync; see `ensureSyncReady.ts`. */
export function liveRunMarkerRelative(key: string): string {
  return path.join('.bica', `live-run-${key}`);
}

/** The pre-0.9 marker, one per checkout. Honoured when a session from an older bica is found. */
export const LEGACY_LIVE_RUN_MARKER_RELATIVE = path.join('.bica', 'live-run');
