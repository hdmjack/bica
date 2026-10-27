import { execSync } from 'node:child_process';
import { withCargoTargetIgnored } from './lib/rustWorkspace';
import { withCompanionRecordsIgnored } from './lib/syncConsistency';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isPlainObject } from 'es-toolkit';
import YAML from 'yaml';

import { validateGeneratedPath } from './lib/generatedPaths';

import { readLocalBicaSettings } from './localBicaSettings';
import type { LocalBicaSettings } from './localBicaSettings';

/** Preferred single-file workspace spec (sync + optional bica:). */
export const BICA_SPEC_FILE = 'bica.yml';

/** Legacy filename; still read if bica.yml is absent. */
export const BICA_WORKSPACE_SPEC_FILE = 'bica-workspace.yml';

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
  generated?: { paths: string[]; command?: string; inputs?: string[] };
  /**
   * Named outputs to copy remote to local after a run, from trees the sync leaves alone. Unlike
   * return-flow these are not patterns and are not mirrored; see `artifacts.ts`.
   */
  artifacts?: string[];
  /** Tools the remote must have on PATH for this repo's commands; checked by `bica doctor`. */
  toolchain?: string[];
  /** Names of local environment variables to forward to every remote command. */
  env?: string[];
  /** Whether bica added `target` to the ignore list because this looks like a Rust repository. */
  cargoTargetIgnored?: boolean;
  /** Records bica ignored because their output is ignored; see `withCompanionRecordsIgnored`. */
  companionRecordsIgnored?: string[];
  /**
   * The user's configured `sync.ignore.paths`, *before* the return-flow patterns are merged in.
   * These name trees each side owns independently (node_modules, dist, …); return-flow must not
   * mirror artifacts across them in either direction.
   */
  syncIgnorePaths: string[];
}

/**
 * Default return-flow whitelist (gitignore/rsync-filter globs). Test snapshot artifacts and log
 * files produced on the remote should always flow back to the local repo.
 */
export const DEFAULT_RETURN_FLOW_PATHS: readonly string[] = [
  '**/__snapshots__/**',
  '**/*.snap',
  // No leading **/ : rsync treats a slash-containing pattern as a full-path match (so **/*.log
  // would skip root-level logs). A bare basename pattern matches *.log at any depth.
  '*.log',
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
  const generated = parseGenerated(doc.generated, sourceLabel);
  const artifacts = parseArtifacts(doc.artifacts, sourceLabel);
  const toolchain = parseNameList(doc.toolchain, 'toolchain', sourceLabel);
  const env = parseNameList(doc.env, 'env', sourceLabel);

  if (!looksLikeFlatSync && allValuesArePlainObjects) {
    if (keys.length !== 1) {
      throw new Error(
        `${sourceLabel}: define exactly one session under sync: (found ${String(keys.length)}).`,
      );
    }
    const sessionName = keys[0];
    const session = syncObj[sessionName] as WorkspaceSyncSession;
    const cargoIgnore = withCargoTargetIgnored(
      repoRoot,
      session.ignore?.paths ?? [],
    );
    const companions = withCompanionRecordsIgnored(cargoIgnore.paths);
    const sessionIgnore = { ...cargoIgnore, paths: companions.paths };
    return {
      sync: {
        [sessionName]: applyReturnFlowToSession(
          { ...session, ignore: { paths: sessionIgnore.paths } },
          [...returnFlow.paths, ...generated.paths],
        ),
      },
      returnFlow,
      generated,
      artifacts,
      toolchain,
      env,
      syncIgnorePaths: [
        ...new Set([...sessionIgnore.paths, ...generated.paths]),
      ],
      cargoTargetIgnored: sessionIgnore.added,
      companionRecordsIgnored: companions.added,
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
  const cargoIgnore = withCargoTargetIgnored(repoRoot, ignore?.paths ?? []);
  const companions = withCompanionRecordsIgnored(cargoIgnore.paths);
  const flatIgnore = { ...cargoIgnore, paths: companions.paths };
  if (flatIgnore.added || companions.added.length > 0) {
    ignore = { paths: flatIgnore.paths };
  }

  return {
    sync: {
      [sessionName]: applyReturnFlowToSession(
        {
          mode,
          ...(ignore !== undefined ? { ignore } : {}),
        },
        [...returnFlow.paths, ...generated.paths],
      ),
    },
    returnFlow,
    generated,
    artifacts,
    toolchain,
    env,
    syncIgnorePaths: [...new Set([...flatIgnore.paths, ...generated.paths])],
    cargoTargetIgnored: flatIgnore.added,
    companionRecordsIgnored: companions.added,
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
 * Parse a plain list of names (`toolchain:`, `env:`) from the spec root.
 *
 * Both are lists of bare identifiers rather than paths, and both are absent by default: bica cannot
 * guess what a repository builds with, and checking for tools nobody declared would turn `doctor`
 * into noise.
 */
function parseNameList(
  raw: unknown,
  key: string,
  sourceLabel: string,
): string[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${sourceLabel}: ${key}: must be a list of names.`);
  }
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new Error(`${sourceLabel}: ${key}: must be a list of names.`);
    }
    const trimmed = entry.trim();
    if (trimmed === '') {
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_.+-]*$/.test(trimmed)) {
      // These end up in a remote shell -- as `command -v <name>` or as `export NAME=...` -- so a
      // name with a space or a quote in it would be a hole rather than a typo.
      throw new Error(
        `${sourceLabel}: ${key}: ${entry} is not a plain name.`,
      );
    }
    names.push(trimmed);
  }
  return names;
}

/**
 * Parse `artifacts:` from bica.yml root -- a plain list of paths, absent meaning the feature is off.
 *
 * Deliberately not merged into `sync.ignore.paths` the way return-flow and `generated` are. Those
 * merges exist so the mirror cannot delete what they describe; an artifact lives inside a tree the
 * user has already excluded, and quietly excluding its parent here would change what the sync
 * carries on the strength of a list about copying things home.
 */
function parseArtifacts(raw: unknown, sourceLabel: string): string[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${sourceLabel}: artifacts: must be a list of paths.`);
  }
  const paths: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new Error(`${sourceLabel}: artifacts: must be a list of paths.`);
    }
    const trimmed = entry.trim();
    if (trimmed === '') {
      continue;
    }
    if (trimmed.startsWith('/') || trimmed.includes('..')) {
      // An artifact is a path inside the workspace. An absolute path or one that climbs out of it
      // would have rsync write somewhere nobody asked for.
      throw new Error(
        `${sourceLabel}: artifacts: ${entry} must be a path inside the repository.`,
      );
    }
    paths.push(trimmed);
  }
  return paths;
}

/**
 * Parse `generated:` from bica.yml root — paths the remote produces and must have before a command
 * runs. Absent means the feature is off, which is the default: bica cannot guess what a repo
 * generates, and probing for nothing would cost a round trip for no benefit.
 *
 * Declaring a path here also adds it to the sync's ignore list, the same way return-flow paths are
 * merged. That is not a convenience — it is required for the feature to work at all. Without it the
 * mirror deletes the output as fast as the repair command produces it, because the files exist
 * remotely and not locally, which is the whole predicate `--delete` acts on. Verified the hard way:
 * the repair ran, generated 346 files, and the live session removed every one before the command
 * saw them.
 */
function parseGenerated(
  raw: unknown,
  sourceLabel: string,
): { paths: string[]; command?: string; inputs?: string[] } {
  if (raw === undefined) {
    return { paths: [] };
  }
  if (!isPlainObject(raw)) {
    throw new Error(`${sourceLabel}: generated: must be an object.`);
  }
  const commandUnknown = (raw as { command?: unknown }).command;
  if (commandUnknown !== undefined && typeof commandUnknown !== 'string') {
    throw new Error(`${sourceLabel}: generated.command must be a string.`);
  }
  const command =
    typeof commandUnknown === 'string' && commandUnknown.trim() !== ''
      ? commandUnknown.trim()
      : undefined;
  const paths = parseGeneratedList(
    (raw as { paths?: unknown }).paths,
    'paths',
    sourceLabel,
  );
  const inputs = parseGeneratedList(
    (raw as { inputs?: unknown }).inputs,
    'inputs',
    sourceLabel,
  );
  return {
    paths,
    ...(command !== undefined ? { command } : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
  };
}

function parseGeneratedList(
  listUnknown: unknown,
  key: 'paths' | 'inputs',
  sourceLabel: string,
): string[] {
  if (listUnknown === undefined) {
    return [];
  }
  if (!Array.isArray(listUnknown)) {
    throw new Error(
      `${sourceLabel}: generated.${key} must be a list of strings.`,
    );
  }
  const list: string[] = [];
  for (const item of listUnknown) {
    if (typeof item !== 'string') {
      throw new Error(
        `${sourceLabel}: generated.${key} must contain only strings.`,
      );
    }
    // Validate at parse time so a bad entry is a config error naming the file, not a confusing
    // failure deep in a run.
    list.push(validateGeneratedPath(item));
  }
  return list;
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

/**
 * Paths bica must never mirror into, whatever the config says.
 *
 * The first destructive push makes the remote directory an exact copy of the local repo, deleting
 * whatever else is in it. A path one level short of the intended one -- `~/code` where `~/code/repo`
 * was meant -- therefore deletes every sibling checkout on that machine, and `~` takes the home
 * directory with it. Both are ordinary typos, and until now nothing stood between them and the
 * `--delete`.
 */
function assertRemoteWorkspacePathIsSafe(remotePath: string): void {
  const trimmed = remotePath.trim().replace(/\/+$/, '');
  const forbidden = new Set(['~', '', '/', '.', '..', '$HOME', '~/']);
  if (forbidden.has(trimmed)) {
    throw new Error(
      `remotePath ${JSON.stringify(remotePath)} is a home or root directory, and bica mirrors the ` +
        'repository into it with deletions. Point it at a directory of its own, e.g. ' +
        '~/code/<repo>-<yourname>.',
    );
  }
  // A single segment under the home directory is the "one level short" case: `~/code` instead of
  // `~/code/<repo>`. Not forbidden outright -- somebody may genuinely keep one checkout at `~/work`
  // -- but worth naming, because the cost of being wrong is every sibling checkout under it.
  const segments = trimmed
    .replace(/^~\/?/, '')
    .split('/')
    .filter((seg) => seg.length > 0);
  if (segments.length === 0) {
    throw new Error(
      `remotePath ${JSON.stringify(remotePath)} resolves to the remote home directory itself.`,
    );
  }
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
  // The default includes the local username, so that teammates sharing a remote login do not all
  // land on one workspace. They would not collide quietly: the second is refused by the lease, and
  // once the first finishes, the second's push mirrors over its tree and reinstalls from a different
  // lockfile. One directory per person costs nothing and removes the whole class.
  return `~/code/${os.userInfo().username}/${repoBasename}`;
}

export function loadRemoteEnvConfig(repoRoot: string): RemoteEnvConfig {
  const local = readLocalBicaSettings(repoRoot);
  const sshHost = readSshHost(repoRoot);
  if (!sshHost) {
    throw new Error(
      'SSH host not configured: set BICA_SSH_HOST, run `bica init`, or run from a TTY to be prompted (see `bica help`).',
    );
  }

  const remoteWorkspacePath = readRemoteWorkspacePath(repoRoot, local);
  // Checked here rather than at each destructive step, because every one of them -- the mirroring
  // sync, the pinned push, the `.git` mirror -- takes this one value and deletes what it does not
  // recognise.
  assertRemoteWorkspacePathIsSafe(remoteWorkspacePath);
  if (!isSshHostSafe(sshHost)) {
    throw new Error(
      `sshHost ${JSON.stringify(sshHost)} starts with "-", which ssh would read as an option rather ` +
        'than a host. Rename the host in ~/.ssh/config or .bica/local.yml.',
    );
  }

  return { sshHost, remoteWorkspacePath };
}

/**
 * An ssh host that begins with `-` is an option, not a host.
 *
 * `-oProxyCommand=…` in the host position is local command execution, and the value reaches us from a
 * config file. Cheap to refuse, and there is no legitimate host of that shape.
 */
function isSshHostSafe(sshHost: string): boolean {
  return !sshHost.trim().startsWith('-');
}

export interface PrepareResult {
  repoRoot: string;
  projectFilePath: string;
  sessionName: string;
  /** Remote sync target: `sshHost:remotePath`. */
  remoteSyncUrl: string;
  /** Glob patterns to rsync remote→local after `bica run`. Empty list = disabled. */
  returnFlowPaths: string[];
  /** Paths the remote must have before the command runs; see generatedPaths.ts. */
  generatedPaths: string[];
  /** Command that regenerates them, run on the remote when any is missing. */
  generatedCommand: string | undefined;
  /** Tracked files the generated output is made from; a change to them reruns the command. */
  generatedInputs: string[];
  /**
   * `sync.ignore.paths` as configured by the user (return-flow patterns not merged in). Trees each
   * side owns on its own — return-flow excludes them so it never mirrors artifacts across them.
   */
  syncIgnorePaths: string[];
  /** Named outputs copied home after a run; see artifacts.ts. Empty list = feature off. */
  artifacts: string[];
  /** Tools the remote must have on PATH, checked by `bica doctor`. */
  toolchain: string[];
  /** Local environment variables forwarded to every remote command. */
  env: string[];
  /** Whether `target` was added to the ignore list on this repo's behalf. */
  cargoTargetIgnored: boolean;
  /** Build records added to the ignore list on this repo's behalf, for `bica doctor` to suggest. */
  companionRecordsIgnored: string[];
  config: RemoteEnvConfig;
}

/**
 * The parts of a workspace spec that describe what to copy home, without touching the environment.
 *
 * `prepareSyncProjectFile` also resolves the remote host from env vars and writes a sync project
 * file, neither of which `bica wait` has any business doing: it is running in a different shell from
 * the one that launched the build, often minutes later, and it already knows the host from the run's
 * own record. Reading the spec alone is all it needs.
 */
export function readArtifactSpec(repoRoot: string): {
  artifacts: string[];
  syncIgnorePaths: string[];
  generatedPaths: string[];
} {
  const { absolutePath, displayName } = resolveSyncSpecPath(repoRoot);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const docUnknown: unknown = YAML.parse(raw);
  const doc = normalizeToSyncSpecYaml(docUnknown, repoRoot, displayName);
  return {
    artifacts: doc.artifacts ?? [],
    syncIgnorePaths: doc.syncIgnorePaths,
    generatedPaths: doc.generated?.paths ?? [],
  };
}

/**
 * Writes the sync project file with local root and remote target.
 *
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

  const specSessionName = getPrimarySessionName(doc, displayName);
  const sessionUnknown: unknown = Object.getOwnPropertyDescriptor(
    doc.sync,
    specSessionName,
  )?.value;
  if (sessionUnknown === undefined) {
    throw new Error(`Invalid ${displayName}: missing sync.${specSessionName}.`);
  }
  if (typeof sessionUnknown !== 'object' || sessionUnknown === null) {
    throw new Error(
      `Invalid ${displayName}: sync.${specSessionName} must be an object.`,
    );
  }
  const session = sessionUnknown as WorkspaceSyncSession;
  const sessionName = specSessionName;

  const mergedSync: SyncSpecYaml['sync'] = {
    [sessionName]: {
      ...session,
      // Mutagen requires these key names: local root and remote URL.
      alpha: repoRoot,
      beta: remoteSyncUrl,
    },
  };

  const projectFilePath = path.join(repoRoot, MUTAGEN_PROJECT_RELATIVE);
  fs.mkdirSync(path.dirname(projectFilePath), { recursive: true });
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
    generatedPaths: doc.generated?.paths ?? [],
    generatedCommand: doc.generated?.command,
    generatedInputs: doc.generated?.inputs ?? [],
    syncIgnorePaths: doc.syncIgnorePaths,
    artifacts: doc.artifacts ?? [],
    toolchain: doc.toolchain ?? [],
    env: doc.env ?? [],
    cargoTargetIgnored: doc.cargoTargetIgnored ?? false,
    companionRecordsIgnored: doc.companionRecordsIgnored ?? [],
    config,
  };
}
