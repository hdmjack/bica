import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AutoDiscoverContext,
  PackageManagerPlugin,
  PackageManagerStateContext,
} from './types';

const LOCKFILE = 'Cargo.lock';
const MANIFEST = 'Cargo.toml';

/** Relative to the lane's state dir, so `.bica/hashes/…` for the default run. */
const CARGO_FETCH_HASH_RELATIVE = path.join('hashes', 'cargo-fetch');

/**
 * argv1 values that resolve / mutate the lockfile and so should refresh the recorded fingerprint.
 */
const INSTALL_FIRST_ARGS = new Set([
  'fetch',
  'update',
  'add',
  'generate-lockfile',
]);

function digestFile(repoRoot: string, relativePath: string): string | null {
  const abs = path.join(repoRoot, relativePath);
  if (!fs.existsSync(abs)) {
    return null;
  }
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function evaluateCargoDiscovery(ctx: AutoDiscoverContext): {
  applicable: boolean;
  summary: string;
} {
  if (fs.existsSync(path.join(ctx.repoRoot, MANIFEST))) {
    return { applicable: true, summary: `${MANIFEST} is present` };
  }
  if (fs.existsSync(path.join(ctx.repoRoot, LOCKFILE))) {
    return { applicable: true, summary: `${LOCKFILE} is present` };
  }
  return {
    applicable: false,
    summary: `No ${MANIFEST} and no ${LOCKFILE}`,
  };
}

export const cargoPackageManagerPlugin: PackageManagerPlugin = {
  kind: 'packageManager',
  id: 'cargo',
  argv0Aliases: ['cargo'],
  autoDiscover(ctx: AutoDiscoverContext): boolean {
    return evaluateCargoDiscovery(ctx).applicable;
  },
  explainAutoDiscover(ctx: AutoDiscoverContext): {
    applicable: boolean;
    summary: string;
  } {
    return evaluateCargoDiscovery(ctx);
  },
  installHashStateRelativePath: CARGO_FETCH_HASH_RELATIVE,
  readLocalFingerprint(repoRoot: string): string | null {
    return digestFile(repoRoot, LOCKFILE);
  },
  readStoredHash(ctx: PackageManagerStateContext): string | null {
    const p = path.join(ctx.stateDir, CARGO_FETCH_HASH_RELATIVE);
    try {
      const t = fs.readFileSync(p, 'utf8').trim();
      return t.length > 0 ? t : null;
    } catch {
      return null;
    }
  },
  writeStoredHash(ctx: PackageManagerStateContext, digest: string): void {
    const p = path.join(ctx.stateDir, CARGO_FETCH_HASH_RELATIVE);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${digest}\n`, 'utf8');
  },
  clearStoredHash(ctx: PackageManagerStateContext): void {
    try {
      fs.rmSync(path.join(ctx.stateDir, CARGO_FETCH_HASH_RELATIVE), { force: true });
    } catch {
      // Nothing recorded, or unreadable. Either way the next run installs, which is the safe default.
    }
  },
  isInstallArgv(remoteArgv: string[]): boolean {
    if (remoteArgv[0] !== 'cargo') {
      return false;
    }
    return INSTALL_FIRST_ARGS.has(remoteArgv[1] ?? '');
  },
  remoteInstallCommand: 'cargo fetch --locked',
};
