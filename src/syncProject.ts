import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPlainObject } from 'es-toolkit';
import YAML from 'yaml';

import { readLocalBicaSettings } from './localBicaSettings';
import type { LocalBicaSettings } from './localBicaSettings';

/** Preferred single-file workspace spec (sync + optional bica:). */
export const BICA_SPEC_FILE = 'bica.yml';

/** Legacy filename; still read if bica.yml is absent. */
export const BICA_WORKSPACE_SPEC_FILE = 'bica-workspace.yml';

/** @deprecated Use BICA_SPEC_FILE */
export const SYNC_SPEC_FILE = BICA_SPEC_FILE;

export const MUTAGEN_PROJECT_RELATIVE = path.join('.bica', 'project.yml');

/**
 * One Mutagen sync session (written to `.bica/project.yml`). Property names are Mutagen’s sync schema.
 */
export interface WorkspaceSyncSession {
  /** Local repository root. */
  alpha?: string;
  /** Remote URL: `host:path`. */
  beta?: string;
  mode?: string;
  ignore?: { paths?: string[] };
}

/** Sync spec YAML `sync:` map — session names are defined by YAML, not fixed keys. */
export interface SyncSpecYaml {
  sync: {
    [sessionName: string]: WorkspaceSyncSession;
  };
  /** Return-flow patterns: files that should rsync remote→local after `bica run`. */
  returnFlow?: { paths: string[] };
}

/**
 * Default return-flow whitelist (gitignore/rsync-filter globs). Test snapshot artifacts produced
 * on the remote should always flow back to the local repo.
 */
export const DEFAULT_RETURN_FLOW_PATHS: readonly string[] = [
  '**/__snapshots__/**',
  '**/*.snap',
];

export function findBicaSpecPath(repoRoot: string): {
  absolutePath: string;
  displayName: string;
} | null {
  const candidates = [[BICA_SPEC_FILE], [BICA_WORKSPACE_SPEC_FILE]] as const;
  for (const [name] of candidates) {
    const p = path.join(repoRoot, name);
    if (fs.existsSync(p)) {
      return { absolutePath: p, displayName: name };
    }
  }
  return null;
}

function isWorkspaceRootCandidate(root: string): boolean {
  return findBicaSpecPath(root) !== null;
}

/**
 * Git repository root (does not require bica.yml). Use before workspace exists.
 */
export function getGitRepoRoot(): string {
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) {
      return out;
    }
  } catch {
    // Not a git repo or git unavailable
  }
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, '.git'))) {
    return cwd;
  }
  throw new Error(
    'Not inside a Git repository (no .git and git rev-parse failed). Run `bica init` from your repo root.',
  );
}

export function getRepoRoot(): string {
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out && isWorkspaceRootCandidate(out)) {
      return out;
    }
  } catch {
    // Not a git repo or git unavailable — fall through
  }

  const cwd = process.cwd();
  if (isWorkspaceRootCandidate(cwd)) {
    return cwd;
  }

  throw new Error(
    `Bica workspace not found: add ${BICA_SPEC_FILE} (or legacy ${BICA_WORKSPACE_SPEC_FILE}) at the repository root, or run \`bica init\` from a TTY.`,
  );
}

/**
 * Source YAML path used to generate the sync project file.
 */
export function resolveSyncSpecPath(repoRoot: string): {
  absolutePath: string;
  displayName: string;
} {
  const found = findBicaSpecPath(repoRoot);
  if (found) {
    return found;
  }
  throw new Error(
    `No Bica spec found: expected ${BICA_SPEC_FILE} or ${BICA_WORKSPACE_SPEC_FILE} under ${repoRoot}. Run \`bica init\`.`,
  );
}

function sanitizeSessionName(base: string): string {
  const s = base
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return s.length > 0 ? s : 'workspace';
}

/**
 * Accepts either legacy `sync: { sessionName: { mode, ignore } }` or simplified
 * `sync: { mode, ignore }` (single session name derived from repo basename).
 */
export function normalizeToSyncSpecYaml(
  doc: unknown,
  repoRoot: string,
  sourceLabel: string,
): SyncSpecYaml {
  if (!isPlainObject(doc)) {
    throw new Error(`${sourceLabel}: root must be a YAML object`);
  }
  const syncUnknown = doc.sync;
  if (!isPlainObject(syncUnknown)) {
    throw new Error(
      `${sourceLabel}: sync: must be an object (use mode/ignore or one named session).`,
    );
  }
  const syncObj = syncUnknown as Record<string, unknown>;
  const keys = Object.keys(syncObj);
  if (keys.length === 0) {
    throw new Error(
      `${sourceLabel}: sync: is empty. Add mode/ignore or a session block, or run \`bica init\`.`,
    );
  }

  const looksLikeFlatSync =
    'mode' in syncObj ||
    'ignore' in syncObj ||
    ('alpha' in syncObj && typeof syncObj.alpha === 'string') ||
    ('beta' in syncObj && typeof syncObj.beta === 'string');

  const allValuesArePlainObjects = keys.every((k) => isPlainObject(syncObj[k]));

  const returnFlow = parseReturnFlow(doc.returnFlow, sourceLabel);

  if (!looksLikeFlatSync && allValuesArePlainObjects) {
    if (keys.length !== 1) {
      throw new Error(
        `${sourceLabel}: define exactly one session under sync: (found ${String(keys.length)}).`,
      );
    }
    const sessionName = keys[0];
    const session = syncObj[sessionName] as WorkspaceSyncSession;
    return {
      sync: {
        [sessionName]: applyReturnFlowToSession(session, returnFlow.paths),
      },
      returnFlow,
    };
  }

  const sessionName = sanitizeSessionName(path.basename(repoRoot));
  const modeRaw = syncObj.mode;
  const mode =
    typeof modeRaw === 'string' && modeRaw.trim() !== ''
      ? modeRaw.trim()
      : 'one-way-replica';

  let ignore: WorkspaceSyncSession['ignore'];
  if (isPlainObject(syncObj.ignore)) {
    const ign = syncObj.ignore as { paths?: unknown };
    if (Array.isArray(ign.paths)) {
      const paths = ign.paths.filter((x) => typeof x === 'string');
      ignore = { paths };
    }
  }

  return {
    sync: {
      [sessionName]: applyReturnFlowToSession(
        {
          mode,
          ...(ignore !== undefined ? { ignore } : {}),
        },
        returnFlow.paths,
      ),
    },
    returnFlow,
  };
}

/**
 * Parse `returnFlow:` block from bica.yml root. Falls back to DEFAULT_RETURN_FLOW_PATHS when absent.
 * An explicit empty list (`paths: []`) disables return-flow.
 */
function parseReturnFlow(
  raw: unknown,
  sourceLabel: string,
): { paths: string[] } {
  if (raw === undefined) {
    return { paths: [...DEFAULT_RETURN_FLOW_PATHS] };
  }
  if (!isPlainObject(raw)) {
    throw new Error(`${sourceLabel}: returnFlow: must be an object.`);
  }
  const pathsUnknown = (raw as { paths?: unknown }).paths;
  if (pathsUnknown === undefined) {
    return { paths: [...DEFAULT_RETURN_FLOW_PATHS] };
  }
  if (!Array.isArray(pathsUnknown)) {
    throw new Error(`${sourceLabel}: returnFlow.paths must be a list of strings.`);
  }
  const paths = pathsUnknown.filter((x): x is string => typeof x === 'string');
  return { paths };
}

/**
 * Merge return-flow patterns into a session's `ignore.paths` so the forward sync does not push
 * stale local copies of remote-owned files.
 */
function applyReturnFlowToSession(
  session: WorkspaceSyncSession,
  returnFlowPaths: string[],
): WorkspaceSyncSession {
  if (returnFlowPaths.length === 0) {
    return session;
  }
  const existing = session.ignore?.paths ?? [];
  const merged = Array.from(new Set([...existing, ...returnFlowPaths]));
  return {
    ...session,
    ignore: { paths: merged },
  };
}

export function isSyncSpec(value: unknown): value is SyncSpecYaml {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const sync = (value as { sync?: unknown }).sync;
  if (typeof sync !== 'object' || sync === null) {
    return false;
  }
  return Object.keys(sync).length > 0;
}

export function getPrimarySessionName(
  doc: SyncSpecYaml,
  specDisplayName: string,
): string {
  const keys = Object.keys(doc.sync);
  if (keys.length !== 1) {
    throw new Error(
      `${specDisplayName} must define exactly one session under sync: (found ${String(keys.length)}).`,
    );
  }
  return keys[0];
}

/** Session name from the sync spec only (no env vars). For list/monitor-style commands. */
export function readPrimarySessionNameFromSpec(): string {
  const repoRoot = getRepoRoot();
  const { absolutePath, displayName } = resolveSyncSpecPath(repoRoot);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const docUnknown: unknown = YAML.parse(raw);
  const normalized = normalizeToSyncSpecYaml(docUnknown, repoRoot, displayName);
  return getPrimarySessionName(normalized, displayName);
}

export interface RemoteEnvConfig {
  sshHost: string;
  /** Directory on the remote machine, e.g. ~/code/my-repo */
  remoteWorkspacePath: string;
}

function readSshHost(repoRoot: string): string | undefined {
  const fromEnv = process.env.BICA_SSH_HOST?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const local = readLocalBicaSettings(repoRoot).sshHost?.trim();
  if (local !== undefined && local.length > 0) {
    return local;
  }
  return undefined;
}

function readRemoteWorkspacePath(
  repoRoot: string,
  local: LocalBicaSettings,
): string {
  const fromEnv = process.env.BICA_REMOTE_PATH?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const fromFile = local.remotePath?.trim();
  if (fromFile !== undefined && fromFile.length > 0) {
    return fromFile;
  }
  const repoBasename = path.basename(repoRoot);
  return `~/code/${repoBasename}`;
}

export function loadRemoteEnvConfig(repoRoot: string): RemoteEnvConfig {
  const local = readLocalBicaSettings(repoRoot);
  const sshHost = readSshHost(repoRoot);
  if (!sshHost) {
    throw new Error(
      'SSH host not configured: set BICA_SSH_HOST, run `bica init`, or run from a TTY to be prompted (see `bica help`).',
    );
  }

  return {
    sshHost,
    remoteWorkspacePath: readRemoteWorkspacePath(repoRoot, local),
  };
}

export interface PrepareResult {
  repoRoot: string;
  projectFilePath: string;
  sessionName: string;
  /** Remote sync target: `sshHost:remotePath`. */
  remoteSyncUrl: string;
  /** Glob patterns to rsync remote→local after `bica run`. Empty list = disabled. */
  returnFlowPaths: string[];
  config: RemoteEnvConfig;
}

/**
 * Writes the sync project file with local root and remote target.
 */
export function prepareSyncProjectFile(options: {
  verbose?: boolean;
}): PrepareResult {
  const verbose = Boolean(options.verbose);
  const repoRoot = getRepoRoot();
  const { absolutePath: sourcePath, displayName } =
    resolveSyncSpecPath(repoRoot);
  const config = loadRemoteEnvConfig(repoRoot);
  const remoteSyncUrl = `${config.sshHost}:${config.remoteWorkspacePath}`;

  const raw = fs.readFileSync(sourcePath, 'utf8');
  const docUnknown: unknown = YAML.parse(raw);
  const doc = normalizeToSyncSpecYaml(docUnknown, repoRoot, displayName);

  const sessionName = getPrimarySessionName(doc, displayName);
  const sessionUnknown: unknown = Object.getOwnPropertyDescriptor(
    doc.sync,
    sessionName,
  )?.value;
  if (sessionUnknown === undefined) {
    throw new Error(`Invalid ${displayName}: missing sync.${sessionName}.`);
  }
  if (typeof sessionUnknown !== 'object' || sessionUnknown === null) {
    throw new Error(
      `Invalid ${displayName}: sync.${sessionName} must be an object.`,
    );
  }
  const session = sessionUnknown as WorkspaceSyncSession;

  const mergedSync: SyncSpecYaml['sync'] = {
    ...doc.sync,
    [sessionName]: {
      ...session,
      // Mutagen requires these key names: local root and remote URL.
      alpha: repoRoot,
      beta: remoteSyncUrl,
    },
  };

  const outDir = path.join(repoRoot, '.bica');
  fs.mkdirSync(outDir, { recursive: true });
  const projectFilePath = path.join(repoRoot, MUTAGEN_PROJECT_RELATIVE);
  const mutagenDoc = { sync: mergedSync };
  fs.writeFileSync(
    projectFilePath,
    `${YAML.stringify(mutagenDoc, { indent: 2 })}\n`,
    'utf8',
  );

  if (verbose) {
    console.log('Wrote sync project file.');
    console.log(`  local:  ${repoRoot}`);
    console.log(`  remote: ${remoteSyncUrl}`);
  }

  return {
    repoRoot,
    projectFilePath,
    sessionName,
    remoteSyncUrl,
    returnFlowPaths: doc.returnFlow?.paths ?? [],
    config,
  };
}
