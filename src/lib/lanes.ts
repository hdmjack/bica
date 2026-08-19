import * as path from 'node:path';

/**
 * Lanes let several `bica run` invocations from one checkout execute at the same time without
 * crossing.
 *
 * Everything a run mutates is keyed by lane: the remote workspace directory, the Mutagen session
 * name, the local state directory (`.bica/lanes/<id>`) that holds the package-manager install
 * fingerprint, and the local lock that keeps two runs off the same lane. The default (no `--lane`)
 * run keeps the historical identity exactly — base remote path, base session name, `.bica` as its
 * state directory — so single-run behaviour is unchanged.
 *
 * Lanes are *named and reused*, not created per run. A fresh remote workspace has no
 * `node_modules` (the sync ignores it), so it must install before it can run anything; paying that
 * per run would dwarf the time parallelism saves. A small pool of long-lived lanes pays it once per
 * lane instead. `bica lanes prepare` warms the pool up front.
 */

/** Default pool size for `--lane auto` when neither `--lanes` nor `parallel.lanes` is set. */
export const DEFAULT_LANE_POOL_SIZE = 4;

/** Hard ceiling on the pool, so a typo in `--lanes` cannot fan out to hundreds of workspaces. */
export const MAX_LANE_POOL_SIZE = 32;

/** Sentinel `--lane` value meaning "pick the first free lane in the pool". */
export const AUTO_LANE = 'auto';

/**
 * Lane ids become part of a remote directory name and a Mutagen session name, so they are
 * restricted to lowercase alphanumerics and dashes — no separators, no leading dash, no expansion
 * characters.
 */
const LANE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export interface LaneIdentity {
  /** Lane id, or null for the default (non-lane) run. */
  id: string | null;
  /** True when this is the historical single-workspace run. */
  isDefault: boolean;
  /** Suffix appended to the remote path and session name (`''` for the default lane). */
  suffix: string;
  /** Absolute local directory holding this lane's bica state (install fingerprints, project file). */
  stateDir: string;
  /** Short label for log lines (`default` or the lane id). */
  label: string;
}

export function assertValidLaneId(id: string): void {
  if (id === AUTO_LANE) {
    throw new Error(
      `"${AUTO_LANE}" is reserved: it asks bica to pick a free lane, so it cannot also be a lane id.`,
    );
  }
  // `none` matches the id pattern, so without this a `--lane none` meant as "use the default
  // workspace" would silently create a lane called "none" instead.
  if (id === 'none') {
    throw new Error(
      '"none" is reserved: it asks bica for the default workspace, so it cannot also be a lane id.',
    );
  }
  if (!LANE_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid lane id ${JSON.stringify(id)}: use 1–32 lowercase letters, digits or dashes ` +
        '(a lane id becomes part of a remote directory name and a sync session name).',
    );
  }
}

/** Absolute directory that holds every lane's local state. */
export function lanesRootDir(repoRoot: string): string {
  return path.join(repoRoot, '.bica', 'lanes');
}

/** Absolute directory that holds the run locks (one file per lane). */
export function lockRootDir(repoRoot: string): string {
  return path.join(repoRoot, '.bica', 'locks');
}

export function defaultLaneIdentity(repoRoot: string): LaneIdentity {
  return {
    id: null,
    isDefault: true,
    suffix: '',
    stateDir: path.join(repoRoot, '.bica'),
    label: 'default',
  };
}

export function laneIdentity(repoRoot: string, laneId: string): LaneIdentity {
  assertValidLaneId(laneId);
  return {
    id: laneId,
    isDefault: false,
    suffix: `-lane-${laneId}`,
    stateDir: path.join(lanesRootDir(repoRoot), laneId),
    label: laneId,
  };
}

/**
 * Remote workspace directory for a lane: the configured base path with the lane suffix appended.
 * Any trailing slash on the base path is dropped first so `~/code/repo/` and `~/code/repo` derive
 * the same lane directory rather than `~/code/repo/-lane-1`.
 */
export function laneRemoteWorkspacePath(
  baseRemotePath: string,
  lane: LaneIdentity,
): string {
  if (lane.isDefault) {
    return baseRemotePath;
  }
  const trimmed = baseRemotePath.trim().replace(/\/+$/, '');
  return `${trimmed}${lane.suffix}`;
}

/** Mutagen session name for a lane: the spec's session name with the lane suffix appended. */
export function laneSessionName(
  baseSessionName: string,
  lane: LaneIdentity,
): string {
  return lane.isDefault ? baseSessionName : `${baseSessionName}${lane.suffix}`;
}

/**
 * True when `remotePath` is a lane workspace derived from `baseRemotePath` — i.e. it is the base
 * path plus a `-lane-<id>` suffix. Destructive operations (`bica lanes clean`) check this so they
 * can never target the base workspace.
 */
export function isLaneRemotePath(
  baseRemotePath: string,
  remotePath: string,
): boolean {
  const base = baseRemotePath.trim().replace(/\/+$/, '');
  if (!remotePath.startsWith(`${base}-lane-`)) {
    return false;
  }
  const id = remotePath.slice(`${base}-lane-`.length);
  return LANE_ID_PATTERN.test(id);
}

/** Candidate lane ids for a pool of `size` lanes: `1`, `2`, … */
export function laneIdsForPool(size: number): string[] {
  return Array.from({ length: size }, (_, i) => String(i + 1));
}

export function normalizeLanePoolSize(
  raw: number | undefined,
  sourceLabel: string,
): number {
  if (raw === undefined) {
    return DEFAULT_LANE_POOL_SIZE;
  }
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_LANE_POOL_SIZE) {
    throw new Error(
      `${sourceLabel} must be an integer between 1 and ${String(MAX_LANE_POOL_SIZE)} (got ${String(raw)}).`,
    );
  }
  return raw;
}
