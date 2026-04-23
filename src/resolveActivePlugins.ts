import {
  BUILTIN_CREDENTIALS_PLUGINS,
  BUILTIN_PACKAGE_MANAGER_PLUGINS,
  BUILTIN_REMOTE_SHELL_PLUGINS,
  getCredentialsPluginById,
  getPackageManagerPluginById,
  getRemoteShellPluginById,
} from './plugins/builtIns';
import type { ResolvedBicaPluginConfig } from './bicaWorkspaceConfig';
import type {
  AutoDiscoverContext,
  CredentialsPlugin,
  PackageManagerPlugin,
  RemoteShellPlugin,
} from './plugins/types';

function discoverApplicable(
  plugins: readonly PackageManagerPlugin[],
  ctx: AutoDiscoverContext,
): PackageManagerPlugin[] {
  return plugins.filter((p) => p.autoDiscover(ctx));
}

function discoverApplicableCredentials(
  plugins: readonly CredentialsPlugin[],
  ctx: AutoDiscoverContext,
): CredentialsPlugin[] {
  return plugins.filter((p) => p.autoDiscover(ctx));
}

function discoverApplicableRemoteShell(
  plugins: readonly RemoteShellPlugin[],
  ctx: AutoDiscoverContext,
): RemoteShellPlugin[] {
  return plugins.filter((p) => p.autoDiscover(ctx));
}

/**
 * Resolves which package manager plugins are active for this workspace.
 */
export function resolveActivePackageManagerPlugins(
  repoRoot: string,
  resolved: ResolvedBicaPluginConfig,
): PackageManagerPlugin[] {
  const ctx: AutoDiscoverContext = { repoRoot };
  const mode = resolved.pluginMode;
  const list = resolved.packageManagerPluginIds;

  if (mode === 'explicit') {
    if (list === undefined) {
      return [];
    }
    const out: PackageManagerPlugin[] = [];
    for (const id of list) {
      const p = getPackageManagerPluginById(id);
      if (p === undefined) {
        continue;
      }
      if (p.autoDiscover(ctx)) {
        out.push(p);
      }
    }
    return out;
  }

  // auto
  if (list === undefined) {
    return discoverApplicable(BUILTIN_PACKAGE_MANAGER_PLUGINS, ctx);
  }
  const constrained: PackageManagerPlugin[] = [];
  for (const id of list) {
    const p = getPackageManagerPluginById(id);
    if (p === undefined) {
      continue;
    }
    if (p.autoDiscover(ctx)) {
      constrained.push(p);
    }
  }
  return constrained;
}

/**
 * Resolves which credentials plugins are active for this workspace.
 */
export function resolveActiveCredentialsPlugins(
  repoRoot: string,
  resolved: ResolvedBicaPluginConfig,
): CredentialsPlugin[] {
  const ctx: AutoDiscoverContext = { repoRoot };
  const mode = resolved.pluginMode;
  const list = resolved.credentialsPluginIds;

  if (mode === 'explicit') {
    if (list === undefined) {
      return [];
    }
    const out: CredentialsPlugin[] = [];
    for (const id of list) {
      const p = getCredentialsPluginById(id);
      if (p === undefined) {
        continue;
      }
      if (p.autoDiscover(ctx)) {
        out.push(p);
      }
    }
    return out;
  }

  if (list === undefined) {
    return discoverApplicableCredentials(BUILTIN_CREDENTIALS_PLUGINS, ctx);
  }
  const constrained: CredentialsPlugin[] = [];
  for (const id of list) {
    const p = getCredentialsPluginById(id);
    if (p === undefined) {
      continue;
    }
    if (p.autoDiscover(ctx)) {
      constrained.push(p);
    }
  }
  return constrained;
}

/**
 * Resolves which remote-shell plugins are active for `bica run` SSH sessions.
 */
export function resolveActiveRemoteShellPlugins(
  repoRoot: string,
  resolved: ResolvedBicaPluginConfig,
): RemoteShellPlugin[] {
  const ctx: AutoDiscoverContext = { repoRoot };
  const mode = resolved.pluginMode;
  const list = resolved.remoteShellPluginIds;

  if (mode === 'explicit') {
    if (list === undefined) {
      return [];
    }
    const out: RemoteShellPlugin[] = [];
    for (const id of list) {
      const p = getRemoteShellPluginById(id);
      if (p === undefined) {
        continue;
      }
      if (p.autoDiscover(ctx)) {
        out.push(p);
      }
    }
    return out;
  }

  if (list === undefined) {
    return discoverApplicableRemoteShell(BUILTIN_REMOTE_SHELL_PLUGINS, ctx);
  }
  const constrained: RemoteShellPlugin[] = [];
  for (const id of list) {
    const p = getRemoteShellPluginById(id);
    if (p === undefined) {
      continue;
    }
    if (p.autoDiscover(ctx)) {
      constrained.push(p);
    }
  }
  return constrained;
}

/**
 * Selects credentials plugins to run. Empty `requestedIds` means all active plugins.
 * Preserves the order of `requestedIds`. Throws if an id is unknown or not active.
 */
export function pickCredentialsPluginsForSync(
  active: readonly CredentialsPlugin[],
  requestedIds: string[],
): CredentialsPlugin[] {
  if (requestedIds.length === 0) {
    return [...active];
  }
  const unknown: string[] = [];
  for (const id of requestedIds) {
    if (getCredentialsPluginById(id) === undefined) {
      unknown.push(id);
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `Unknown credentials plugin id(s): ${unknown.join(', ')}. Run \`bica plugins list\` for built-in ids.`,
    );
  }
  const activeById = new Map(active.map((p) => [p.id, p] as const));
  const missing: string[] = [];
  for (const id of requestedIds) {
    if (!activeById.has(id)) {
      missing.push(id);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Credentials plugin(s) not active for this workspace: ${missing.join(', ')}. Adjust bica.yml / BICA_* env or plugin conditions (see \`bica plugins list\`).`,
    );
  }
  return requestedIds.map((id) => {
    const p = activeById.get(id);
    if (p === undefined) {
      throw new Error(
        `Internal error: plugin "${id}" was active then missing.`,
      );
    }
    return p;
  });
}

/**
 * Picks PM plugins whose argv[0] matches the remote command. If `--pm` is set, keep only that id.
 */
export function matchingPackageManagerPlugins(
  candidates: readonly PackageManagerPlugin[],
  remoteArgv: string[],
  pmOverride: string | undefined,
): PackageManagerPlugin[] {
  const argv0 = remoteArgv[0];
  if (!argv0) {
    return [];
  }
  let matched = candidates.filter(
    (p) => p.id === argv0 || p.argv0Aliases.includes(argv0),
  );
  if (pmOverride !== undefined && pmOverride.trim() !== '') {
    const want = pmOverride.trim();
    matched = matched.filter((p) => p.id === want);
  }
  return matched;
}
