import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AutoDiscoverContext,
  PackageManagerPlugin,
  PackageManagerStateContext,
} from './types';

const LOCKFILE = 'pnpm-lock.yaml';

/** Relative to the lane's state dir, so `.bica/hashes/…` for the default run. */
const PNPM_INSTALL_HASH_RELATIVE = path.join('hashes', 'pnpm-install');

/** Legacy single hash file from pre–Phase B (migrate read-only). */
const LEGACY_REMOTE_INSTALL_HASH = path.join('.mutagen', 'remote-install-hash');

const INSTALL_FIRST_ARGS = new Set(['install', 'i', 'add']);

function digestFile(repoRoot: string, relativePath: string): string | null {
  const abs = path.join(repoRoot, relativePath);
  if (!fs.existsSync(abs)) {
    return null;
  }
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function evaluatePnpmDiscovery(ctx: AutoDiscoverContext): {
  applicable: boolean;
  summary: string;
} {
  if (fs.existsSync(path.join(ctx.repoRoot, LOCKFILE))) {
    return { applicable: true, summary: `${LOCKFILE} is present` };
  }
  const pkg = path.join(ctx.repoRoot, 'package.json');
  if (!fs.existsSync(pkg)) {
    return {
      applicable: false,
      summary: `No ${LOCKFILE} and no package.json`,
    };
  }
  try {
    const raw = fs.readFileSync(pkg, 'utf8');
    const parsed: unknown = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'packageManager' in parsed &&
      typeof (parsed as { packageManager?: unknown }).packageManager ===
        'string'
    ) {
      const pm = (parsed as { packageManager: string }).packageManager;
      if (pm.includes('pnpm')) {
        return {
          applicable: true,
          summary: 'package.json packageManager references pnpm',
        };
      }
    }
    return {
      applicable: false,
      summary: `No ${LOCKFILE} and package.json packageManager does not reference pnpm`,
    };
  } catch {
    return {
      applicable: false,
      summary: 'package.json could not be parsed as JSON',
    };
  }
}

export const pnpmPackageManagerPlugin: PackageManagerPlugin = {
  kind: 'packageManager',
  id: 'pnpm',
  argv0Aliases: ['pnpm'],
  autoDiscover(ctx: AutoDiscoverContext): boolean {
    return evaluatePnpmDiscovery(ctx).applicable;
  },
  explainAutoDiscover(ctx: AutoDiscoverContext): {
    applicable: boolean;
    summary: string;
  } {
    return evaluatePnpmDiscovery(ctx);
  },
  installHashStateRelativePath: PNPM_INSTALL_HASH_RELATIVE,
  readLocalFingerprint(repoRoot: string): string | null {
    return digestFile(repoRoot, LOCKFILE);
  },
  readStoredHash(ctx: PackageManagerStateContext): string | null {
    const p = path.join(ctx.stateDir, PNPM_INSTALL_HASH_RELATIVE);
    try {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t.length > 0) {
        return t;
      }
    } catch {
      // fall through to legacy path
    }
    // The legacy file predates lanes and describes the base workspace only. Reading it for a lane
    // would claim a never-installed lane is up to date.
    if (!ctx.isDefaultLane) {
      return null;
    }
    try {
      const legacyPath = path.join(ctx.repoRoot, LEGACY_REMOTE_INSTALL_HASH);
      const t = fs.readFileSync(legacyPath, 'utf8').trim();
      return t.length > 0 ? t : null;
    } catch {
      return null;
    }
  },
  writeStoredHash(ctx: PackageManagerStateContext, digest: string): void {
    const p = path.join(ctx.stateDir, PNPM_INSTALL_HASH_RELATIVE);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${digest}\n`, 'utf8');
  },
  clearStoredHash(ctx: PackageManagerStateContext): void {
    try {
      fs.rmSync(path.join(ctx.stateDir, PNPM_INSTALL_HASH_RELATIVE), { force: true });
    } catch {
      // Nothing recorded, or unreadable. Either way the next run installs, which is the safe default.
    }
  },
  isInstallArgv(remoteArgv: string[]): boolean {
    if (remoteArgv[0] !== 'pnpm') {
      return false;
    }
    return INSTALL_FIRST_ARGS.has(remoteArgv[1] ?? '');
  },
  // `CI=true` because this install always runs over ssh with no TTY. When pnpm needs to recreate
  // `node_modules` -- a changed layout, a switch of linker mode -- it asks for confirmation, and
  // without a TTY it aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY, which reads as a broken
  // install rather than a missing flag. Observed while testing an alternative store layout.
  //
  // The side effect is deliberate: under CI, `pnpm install` behaves as `--frozen-lockfile`. That is
  // the right default here, because bica triggers this install from a *lockfile* fingerprint, so the
  // lockfile is the thing being reproduced. The alternative -- pnpm silently updating the lockfile on
  // the remote so it no longer matches the local one -- is the worse failure.
  remoteInstallCommand: 'CI=true pnpm install',
};
