export type PluginMode = 'auto' | 'explicit';

export interface AutoDiscoverContext {
  repoRoot: string;
}

export type ConfirmFn = (
  message: string,
  defaultYes: boolean,
) => Promise<boolean>;

export interface CredentialsSyncContext {
  sshHost: string;
  confirm: ConfirmFn;
}

/**
 * Optional install / lockfile lifecycle for a package manager invoked as remote argv[0].
 */
export interface PackageManagerPlugin {
  readonly kind: 'packageManager';
  readonly id: string;
  /** Remote argv[0] values that activate this plugin (e.g. "pnpm"). */
  readonly argv0Aliases: readonly string[];
  autoDiscover(ctx: AutoDiscoverContext): boolean;
  /** Human-readable reason this workspace does or does not match the plugin. */
  explainAutoDiscover(ctx: AutoDiscoverContext): {
    applicable: boolean;
    summary: string;
  };
  /** Relative path under repo root for the last-recorded install fingerprint file. */
  readonly installHashRelativePath: string;
  /** Local lockfile / inputs digest, or null if nothing to compare. */
  readLocalFingerprint(repoRoot: string): string | null;
  readStoredHash(repoRoot: string): string | null;
  writeStoredHash(repoRoot: string, digest: string): void;
  /** True when remote argv denotes an install/add that should refresh the fingerprint. */
  isInstallArgv(remoteArgv: string[]): boolean;
  /** Single remote shell command to run a full install (POSIX-safe; no user argv). */
  readonly remoteInstallCommand: string;
}

export interface CredentialsPlugin {
  readonly kind: 'credentials';
  readonly id: string;
  autoDiscover(ctx: AutoDiscoverContext): boolean;
  explainAutoDiscover(ctx: AutoDiscoverContext): {
    applicable: boolean;
    summary: string;
  };
  sync(ctx: CredentialsSyncContext): Promise<void>;
}

/**
 * Injects POSIX shell before `cd` + user command on `bica run` (non-interactive SSH).
 * Used for optional remote tooling such as mise shims / quarantine cleanup.
 */
export interface RemoteShellPlugin {
  readonly kind: 'remoteShell';
  readonly id: string;
  autoDiscover(ctx: AutoDiscoverContext): boolean;
  explainAutoDiscover(ctx: AutoDiscoverContext): {
    applicable: boolean;
    summary: string;
  };
  /** Newline-terminated shell fragment(s); composed in stable id order with other active plugins. */
  remoteShellPreamble(ctx: AutoDiscoverContext): string;
}
