import * as fs from 'node:fs';
import { isPlainObject } from 'es-toolkit';
import YAML from 'yaml';

import { resolveSyncSpecPath } from './syncProject';
import type { PluginMode } from './plugins/types';

const ENV_PLUGIN_MODE = 'BICA_PLUGIN_MODE';
const ENV_PACKAGE_MANAGER_PLUGINS = 'BICA_PACKAGE_MANAGER_PLUGINS';
const ENV_CREDENTIALS_PLUGINS = 'BICA_CREDENTIALS_PLUGINS';
const ENV_REMOTE_SHELL_PLUGINS = 'BICA_REMOTE_SHELL_PLUGINS';

export interface BicaYamlSection {
  pluginMode?: string;
  packageManagerPlugins?: unknown;
  credentialsPlugins?: unknown;
  remoteShellPlugins?: unknown;
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

  return {
    pluginMode,
    packageManagerPluginIds,
    credentialsPluginIds,
    remoteShellPluginIds,
  };
}
