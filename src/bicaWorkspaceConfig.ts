import * as fs from 'node:fs';
import { isPlainObject } from 'es-toolkit';
import YAML from 'yaml';

import { resolveSyncSpecPath } from './syncProject';
import type { PluginMode } from './plugins/types';

const ENV_PLUGIN_MODE = 'BICA_PLUGIN_MODE';
const ENV_PACKAGE_MANAGER_PLUGINS = 'BICA_PACKAGE_MANAGER_PLUGINS';
const ENV_CREDENTIALS_PLUGINS = 'BICA_CREDENTIALS_PLUGINS';
const ENV_REMOTE_SHELL_PLUGINS = 'BICA_REMOTE_SHELL_PLUGINS';
const ENV_GIT_SYNC = 'BICA_GIT_SYNC';
const ENV_ASSUME_YES = 'BICA_ASSUME_YES';

export interface BicaYamlSection {
  pluginMode?: string;
  packageManagerPlugins?: unknown;
  credentialsPlugins?: unknown;
  remoteShellPlugins?: unknown;
}

/**
 * Read the top-level `git.sync` boolean from the workspace YAML.
 * `git:` is a sibling of `bica:`, not nested inside it.
 */
function readGitSyncFromYaml(doc: unknown): boolean | undefined {
  if (!isPlainObject(doc) || !('git' in doc)) {
    return undefined;
  }
  const gitUnknown: unknown = doc.git;
  if (!isPlainObject(gitUnknown) || !('sync' in gitUnknown)) {
    return undefined;
  }
  const sync: unknown = gitUnknown.sync;
  if (typeof sync !== 'boolean') {
    throw new Error('git.sync must be a boolean (true/false)');
  }
  return sync;
}

/**
 * Read the top-level `run:` block — per-repo defaults for `bica run`, so the common invocation does
 * not need flags. `run:` is a sibling of `bica:`.
 */
function readRunDefaultsFromYaml(doc: unknown): { assumeYes?: boolean } {
  if (!isPlainObject(doc) || !('run' in doc)) {
    return {};
  }
  const runUnknown: unknown = doc.run;
  if (!isPlainObject(runUnknown)) {
    throw new Error('run: must be an object (run.assumeYes)');
  }
  const out: { assumeYes?: boolean } = {};
  if ('assumeYes' in runUnknown) {
    const assumeYes: unknown = runUnknown.assumeYes;
    if (typeof assumeYes !== 'boolean') {
      throw new Error('run.assumeYes must be a boolean (true/false)');
    }
    out.assumeYes = assumeYes;
  }
  return out;
}

/** Parse a boolean-ish env var: "1"/"true" → true, "0"/"false" → false, unset → undefined. */
function parseBoolEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const t = raw.trim().toLowerCase();
  if (t === '1' || t === 'true') {
    return true;
  }
  if (t === '0' || t === 'false' || t === '') {
    return false;
  }
  return undefined;
}

function parsePluginMode(
  raw: string | undefined,
  sourceLabel: string,
): PluginMode | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const t = raw.trim().toLowerCase();
  if (t === 'auto' || t === 'explicit') {
    return t;
  }
  throw new Error(
    `${sourceLabel} pluginMode must be "auto" or "explicit" (got ${JSON.stringify(raw)}).`,
  );
}

function parsePluginModeFromYaml(
  raw: unknown,
  sourceLabel: string,
): PluginMode | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new Error(`${sourceLabel}: bica.pluginMode must be a string`);
  }
  return parsePluginMode(raw, sourceLabel);
}

function parseIdListEnv(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts;
}

function stringArrayFromYaml(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`bica.${field} must be an array of plugin ids`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`bica.${field} must contain only non-empty strings`);
    }
    out.push(item.trim());
  }
  return out;
}

function readBicaSection(doc: unknown): BicaYamlSection | undefined {
  if (!isPlainObject(doc) || !('bica' in doc)) {
    return undefined;
  }
  const bicaUnknown: unknown = doc.bica;
  if (!isPlainObject(bicaUnknown)) {
    return undefined;
  }
  return {
    pluginMode:
      'pluginMode' in bicaUnknown && typeof bicaUnknown.pluginMode === 'string'
        ? bicaUnknown.pluginMode
        : undefined,
    packageManagerPlugins:
      'packageManagerPlugins' in bicaUnknown
        ? bicaUnknown.packageManagerPlugins
        : undefined,
    credentialsPlugins:
      'credentialsPlugins' in bicaUnknown
        ? bicaUnknown.credentialsPlugins
        : undefined,
    remoteShellPlugins:
      'remoteShellPlugins' in bicaUnknown
        ? bicaUnknown.remoteShellPlugins
        : undefined,
  };
}

export interface ResolvedBicaPluginConfig {
  pluginMode: PluginMode;
  /** When set (including empty), env or YAML fully specified the id list for PM plugins. */
  packageManagerPluginIds: string[] | undefined;
  credentialsPluginIds: string[] | undefined;
  remoteShellPluginIds: string[] | undefined;
  /**
   * When true, `bica run` rsyncs the local `.git` directory to the remote before running the
   * command so git-dependent commands (e.g. `vitest --changed`, `jest --changed`) see the same
   * history/HEAD/refs as local. Defaults to false.
   */
  syncGit: boolean;
  /** Default `--yes`: auto-confirm the prompts a run needs, such as creating the remote directory. */
  runAssumeYes: boolean;
}

/**
 * Loads the workspace YAML file and resolves plugin-related settings.
 * Env vars replace YAML lists / mode when set (no merge).
 */
export function resolveBicaPluginConfig(
  repoRoot: string,
): ResolvedBicaPluginConfig {
  const { absolutePath, displayName } = resolveSyncSpecPath(repoRoot);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const doc = YAML.parse(raw) as unknown;
  const bica = readBicaSection(doc);

  const yamlMode = parsePluginModeFromYaml(bica?.pluginMode, displayName);
  const envMode = parsePluginMode(
    process.env[ENV_PLUGIN_MODE],
    ENV_PLUGIN_MODE,
  );
  const pluginMode: PluginMode = envMode ?? yamlMode ?? 'auto';

  const yamlPm = stringArrayFromYaml(
    bica?.packageManagerPlugins,
    'packageManagerPlugins',
  );
  const envPm = parseIdListEnv(process.env[ENV_PACKAGE_MANAGER_PLUGINS]);
  const packageManagerPluginIds = envPm ?? yamlPm;

  const yamlCred = stringArrayFromYaml(
    bica?.credentialsPlugins,
    'credentialsPlugins',
  );
  const envCred = parseIdListEnv(process.env[ENV_CREDENTIALS_PLUGINS]);
  const credentialsPluginIds = envCred ?? yamlCred;

  const yamlRemoteShell = stringArrayFromYaml(
    bica?.remoteShellPlugins,
    'remoteShellPlugins',
  );
  const envRemoteShell = parseIdListEnv(process.env[ENV_REMOTE_SHELL_PLUGINS]);
  const remoteShellPluginIds = envRemoteShell ?? yamlRemoteShell;

  const yamlGitSync = readGitSyncFromYaml(doc);
  const envGitSync = parseBoolEnv(process.env[ENV_GIT_SYNC]);
  const syncGit = envGitSync ?? yamlGitSync ?? false;

  const yamlRun = readRunDefaultsFromYaml(doc);
  const envAssumeYes = parseBoolEnv(process.env[ENV_ASSUME_YES]);
  const runAssumeYes = envAssumeYes ?? yamlRun.assumeYes ?? false;

  return {
    pluginMode,
    packageManagerPluginIds,
    credentialsPluginIds,
    remoteShellPluginIds,
    syncGit,
    runAssumeYes,
  };
}
