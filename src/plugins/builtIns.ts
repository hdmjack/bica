import { miseRemoteShellPlugin } from './miseRemoteShellPlugin';
import { npmrcCredentialsPlugin } from './npmrcCredentialsPlugin';
import { pnpmPackageManagerPlugin } from './pnpmPackageManagerPlugin';
import type {
  CredentialsPlugin,
  PackageManagerPlugin,
  RemoteShellPlugin,
} from './types';

export const BUILTIN_PACKAGE_MANAGER_PLUGINS: readonly PackageManagerPlugin[] =
  [pnpmPackageManagerPlugin];

export const BUILTIN_CREDENTIALS_PLUGINS: readonly CredentialsPlugin[] = [
  npmrcCredentialsPlugin,
];

export const BUILTIN_REMOTE_SHELL_PLUGINS: readonly RemoteShellPlugin[] = [
  miseRemoteShellPlugin,
];

export function getPackageManagerPluginById(
  id: string,
): PackageManagerPlugin | undefined {
  return BUILTIN_PACKAGE_MANAGER_PLUGINS.find((p) => p.id === id);
}

export function getCredentialsPluginById(
  id: string,
): CredentialsPlugin | undefined {
  return BUILTIN_CREDENTIALS_PLUGINS.find((p) => p.id === id);
}

export function getRemoteShellPluginById(
  id: string,
): RemoteShellPlugin | undefined {
  return BUILTIN_REMOTE_SHELL_PLUGINS.find((p) => p.id === id);
}
