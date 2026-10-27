import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AutoDiscoverContext, PackageManagerPlugin } from './types';

const LOCKFILE = 'pnpm-lock.yaml';

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
  readLocalFingerprint(repoRoot: string): string | null {
    return digestFile(repoRoot, LOCKFILE);
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
  installedPath: 'node_modules',
};
