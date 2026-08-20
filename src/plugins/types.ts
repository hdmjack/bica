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
 * Where a package-manager plugin records what the *remote* workspace has installed.
 *
 * Each lane is a separate remote workspace with its own `node_modules`, so the fingerprint has to be
 * per-lane: a single shared file would let lane 2 conclude its dependencies are current because
 * lane 1 installed. `stateDir` is `<repo>/.bica` for the default run and `<repo>/.bica/lanes/<id>`
 * for a lane, which keeps the default lane's file exactly where earlier versions wrote it.
 */
export interface PackageManagerStateContext {
  repoRoot: string;
  /** Absolute directory holding this lane's bica state. */
  stateDir: string;
  /** False for lane runs; gates fallbacks to pre-lane fingerprint locations. */
  isDefaultLane: boolean;
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
  /** Relative path under {@link PackageManagerStateContext.stateDir} for the fingerprint file. */
  readonly installHashStateRelativePath: string;
  /** Local lockfile / inputs digest, or null if nothing to compare. Lane-independent. */
  readLocalFingerprint(repoRoot: string): string | null;
  readStoredHash(ctx: PackageManagerStateContext): string | null;
  writeStoredHash(ctx: PackageManagerStateContext, digest: string): void;
  /** Forget the recorded install, so the next run reinstalls. Used when the workspace is recreated. */
  clearStoredHash(ctx: PackageManagerStateContext): void;
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
