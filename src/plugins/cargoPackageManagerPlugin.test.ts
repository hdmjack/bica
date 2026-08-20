import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { cargoPackageManagerPlugin as plugin } from './cargoPackageManagerPlugin';
import type { PackageManagerStateContext } from './types';

/** Fingerprint storage for the default lane, which is where these tests write. */
function stateCtx(repoRoot: string): PackageManagerStateContext {
  return {
    repoRoot,
    stateDir: path.join(repoRoot, '.bica'),
    isDefaultLane: true,
  };
}

describe('cargoPackageManagerPlugin', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not autoDiscover without a Cargo manifest or lockfile', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-cargo-'));
    const ctx = { repoRoot: dir };
    expect(plugin.autoDiscover(ctx)).toBe(false);
    expect(plugin.explainAutoDiscover(ctx).applicable).toBe(false);
  });

  it('autoDiscovers when Cargo.toml exists', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-cargo-'));
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\n', 'utf8');
    expect(plugin.autoDiscover({ repoRoot: dir })).toBe(true);
  });

  it('autoDiscovers when only Cargo.lock exists', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-cargo-'));
    fs.writeFileSync(path.join(dir, 'Cargo.lock'), 'version = 4\n', 'utf8');
    expect(plugin.autoDiscover({ repoRoot: dir })).toBe(true);
  });

  it('fingerprints Cargo.lock and round-trips the stored hash', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-cargo-'));
    expect(plugin.readLocalFingerprint(dir)).toBeNull();
    expect(plugin.readStoredHash(stateCtx(dir))).toBeNull();

    fs.writeFileSync(path.join(dir, 'Cargo.lock'), 'version = 4\n', 'utf8');
    const expected = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(dir, 'Cargo.lock')))
      .digest('hex');
    const local = plugin.readLocalFingerprint(dir);
    expect(local).toBe(expected);

    plugin.writeStoredHash(stateCtx(dir), local as string);
    expect(plugin.readStoredHash(stateCtx(dir))).toBe(local);
    expect(fs.existsSync(path.join(dir, '.bica', 'hashes', 'cargo-fetch'))).toBe(
      true,
    );
  });

  it('treats lockfile-mutating subcommands as install argv', () => {
    expect(plugin.isInstallArgv(['cargo', 'fetch'])).toBe(true);
    expect(plugin.isInstallArgv(['cargo', 'update'])).toBe(true);
    expect(plugin.isInstallArgv(['cargo', 'add', 'serde'])).toBe(true);
    expect(plugin.isInstallArgv(['cargo', 'generate-lockfile'])).toBe(true);

    expect(plugin.isInstallArgv(['cargo', 'build'])).toBe(false);
    expect(plugin.isInstallArgv(['cargo', 'nextest', 'run'])).toBe(false);
    expect(plugin.isInstallArgv(['cargo'])).toBe(false);
    expect(plugin.isInstallArgv(['pnpm', 'add'])).toBe(false);
  });

  it('runs a locked fetch as its remote install command', () => {
    expect(plugin.remoteInstallCommand).toBe('cargo fetch --locked');
  });

  it('clearStoredHash forgets a recorded install, so a recreated workspace reinstalls', () => {
    // The fingerprint describes a *remote* workspace but lives locally, so removing that workspace
    // leaves it asserting an install that no longer exists. Without this the next run skips the
    // install and executes against an empty directory.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-cargo-'));
    fs.writeFileSync(path.join(dir, 'Cargo.lock'), 'version = 4\n', 'utf8');
    const local = plugin.readLocalFingerprint(dir);
    plugin.writeStoredHash(stateCtx(dir), local as string);
    expect(plugin.readStoredHash(stateCtx(dir))).toBe(local);

    plugin.clearStoredHash(stateCtx(dir));
    expect(plugin.readStoredHash(stateCtx(dir))).toBeNull();
  });

  it('clearStoredHash is a no-op when nothing was recorded', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-cargo-'));
    expect(() => {
      plugin.clearStoredHash(stateCtx(dir));
    }).not.toThrow();
  });
});
