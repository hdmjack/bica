import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pnpmPackageManagerPlugin as plugin } from './pnpmPackageManagerPlugin';
import type { PackageManagerStateContext } from './types';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-pnpm-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function ctx(isDefault = true): PackageManagerStateContext {
  return {
    repoRoot: dir,
    stateDir: path.join(dir, '.bica'),
    isDefaultWorkspace: isDefault,
  };
}

describe('remoteInstallCommand', () => {
  it('runs under CI, because the remote never has a TTY', () => {
    // Without it pnpm aborts rather than recreating node_modules when the layout changed, with
    // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY -- which reads as a broken install, not a missing flag.
    expect(plugin.remoteInstallCommand).toContain('CI=true');
    expect(plugin.remoteInstallCommand).toContain('pnpm install');
  });
});

describe('fingerprinting', () => {
  it('has no fingerprint without a lockfile', () => {
    expect(plugin.readLocalFingerprint(dir)).toBeNull();
    expect(plugin.readStoredHash(ctx())).toBeNull();
  });

  it('round-trips a lockfile digest', () => {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const local = plugin.readLocalFingerprint(dir);
    expect(local).not.toBeNull();
    plugin.writeStoredHash(ctx(), local as string);
    expect(plugin.readStoredHash(ctx())).toBe(local);
  });

  it('changes when the lockfile changes, which is what triggers a reinstall', () => {
    const f = path.join(dir, 'pnpm-lock.yaml');
    fs.writeFileSync(f, 'lockfileVersion: 9\n');
    const before = plugin.readLocalFingerprint(dir);
    fs.writeFileSync(f, 'lockfileVersion: 9\npackages:\n  foo: 1\n');
    expect(plugin.readLocalFingerprint(dir)).not.toBe(before);
  });

  it('clearStoredHash forgets a recorded install', () => {
    // The record describes a *remote* workspace but lives locally, so it must be dropped whenever
    // that workspace is recreated, or the next run skips the install into an empty directory.
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    plugin.writeStoredHash(ctx(), plugin.readLocalFingerprint(dir) as string);
    plugin.clearStoredHash(ctx());
    expect(plugin.readStoredHash(ctx())).toBeNull();
  });
});

describe('argv matching', () => {
  it('recognises the installs that should refresh the fingerprint', () => {
    expect(plugin.isInstallArgv(['pnpm', 'install'])).toBe(true);
    expect(plugin.isInstallArgv(['pnpm', 'i'])).toBe(true);
    expect(plugin.isInstallArgv(['pnpm', 'add', 'lodash'])).toBe(true);
  });

  it('does not treat an ordinary command as an install', () => {
    expect(plugin.isInstallArgv(['pnpm', 'test'])).toBe(false);
    expect(plugin.isInstallArgv(['npm', 'install'])).toBe(false);
    expect(plugin.isInstallArgv(['pnpm'])).toBe(false);
  });
});

describe('autoDiscover', () => {
  it('applies when a pnpm lockfile is present', () => {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    expect(plugin.autoDiscover({ repoRoot: dir })).toBe(true);
  });

  it('applies when package.json names pnpm as its package manager', () => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@10.0.0' }),
    );
    expect(plugin.autoDiscover({ repoRoot: dir })).toBe(true);
  });

  it('does not apply to a project with neither', () => {
    expect(plugin.autoDiscover({ repoRoot: dir })).toBe(false);
  });
});
