import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pnpmPackageManagerPlugin } from '../plugins/pnpmPackageManagerPlugin';
import { defaultLaneIdentity } from './lanes';
import {
  remoteMkdirWorkspace,
  remoteWorkspaceDirExists,
  runRemoteCommand,
} from './runRemote';
import { runRemoteCommandWithPmHooks } from './runWithPackageManagerPlugins';
import type { PackageManagerStateContext } from '../plugins/types';
import type { PrepareResult } from '../syncProject';

vi.mock('./runRemote', () => ({
  runRemoteCommand: vi.fn(() => 0),
  remoteWorkspaceDirExists: vi.fn(() => true),
  remoteMkdirWorkspace: vi.fn(() => 0),
}));

const BICA_YML = `sync:
  mode: one-way-replica
  ignore:
    paths:
      - node_modules
`;

function makeTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bica-pm-hooks-'));
}

function writePnpmWorkspace(repoRoot: string, lockfileBody: string): void {
  fs.writeFileSync(path.join(repoRoot, 'bica.yml'), BICA_YML, 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), lockfileBody, 'utf8');
}

/** Fingerprint storage for the default lane, which is what these tests exercise. */
function stateCtx(repoRoot: string): PackageManagerStateContext {
  return {
    repoRoot,
    stateDir: path.join(repoRoot, '.bica'),
    isDefaultLane: true,
  };
}

function makePrep(repoRoot: string): PrepareResult {
  return {
    repoRoot,
    projectFilePath: path.join(repoRoot, '.bica', 'project.yml'),
    sessionName: 'test-session',
    lane: defaultLaneIdentity(repoRoot),
    remoteSyncUrl: 'test-host:/remote/repo',
    returnFlowPaths: [],
    syncIgnorePaths: [],
    config: {
      sshHost: 'test-host',
      remoteWorkspacePath: '/remote/repo',
    },
  };
}

describe('runRemoteCommandWithPmHooks', () => {
  const runRemote = vi.mocked(runRemoteCommand);
  const dirExists = vi.mocked(remoteWorkspaceDirExists);
  const mkdirRemote = vi.mocked(remoteMkdirWorkspace);

  beforeEach(() => {
    runRemote.mockReset();
    runRemote.mockReturnValue(0);
    dirExists.mockReset();
    dirExists.mockReturnValue(true);
    mkdirRemote.mockReset();
    mkdirRemote.mockReturnValue(0);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs remote pnpm install then the user command when no install hash exists', async () => {
    const repoRoot = makeTempRepo();
    try {
      writePnpmWorkspace(repoRoot, "lockfileVersion: '9.0'\n");
      const prep = makePrep(repoRoot);
      const confirm = vi.fn().mockResolvedValue(true);

      const code = await runRemoteCommandWithPmHooks({
        prep,
        remoteArgv: ['pnpm', 'test'],
        autoYes: true,
        pmOverride: undefined,
        confirm,
      });

      expect(code).toBe(0);
      expect(confirm).not.toHaveBeenCalled();
      expect(runRemote).toHaveBeenCalledTimes(2);
      expect(runRemote.mock.calls[0]?.[2]).toBe('pnpm install');
      expect(runRemote.mock.calls[0]?.[3]).toBe(repoRoot);
      expect(runRemote.mock.calls[1]?.[2]).toContain('pnpm');
      expect(runRemote.mock.calls[1]?.[2]).toContain('test');
      expect(runRemote.mock.calls[1]?.[3]).toBe(repoRoot);

      const fp = pnpmPackageManagerPlugin.readLocalFingerprint(repoRoot);
      expect(fp).not.toBeNull();
      expect(pnpmPackageManagerPlugin.readStoredHash(stateCtx(repoRoot))).toBe(fp);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('auto-runs remote install on lockfile drift without prompting', async () => {
    const repoRoot = makeTempRepo();
    try {
      writePnpmWorkspace(repoRoot, "lockfileVersion: '9.0'\n");
      const fpOld = pnpmPackageManagerPlugin.readLocalFingerprint(repoRoot);
      expect(fpOld).not.toBeNull();
      pnpmPackageManagerPlugin.writeStoredHash(stateCtx(repoRoot), fpOld!);

      fs.writeFileSync(
        path.join(repoRoot, 'pnpm-lock.yaml'),
        "lockfileVersion: '9.0'\npackages: {}\n",
        'utf8',
      );

      const prep = makePrep(repoRoot);
      const confirm = vi.fn();

      await runRemoteCommandWithPmHooks({
        prep,
        remoteArgv: ['pnpm', 'test'],
        autoYes: false,
        pmOverride: undefined,
        confirm,
      });

      expect(confirm).not.toHaveBeenCalled();
      expect(runRemote).toHaveBeenCalledTimes(2);
      expect(runRemote.mock.calls[0]?.[2]).toBe('pnpm install');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('skips preflight install when stored hash matches the lockfile', async () => {
    const repoRoot = makeTempRepo();
    try {
      writePnpmWorkspace(repoRoot, "lockfileVersion: '9.0'\n");
      const fp = pnpmPackageManagerPlugin.readLocalFingerprint(repoRoot);
      expect(fp).not.toBeNull();
      pnpmPackageManagerPlugin.writeStoredHash(stateCtx(repoRoot), fp!);

      const prep = makePrep(repoRoot);
      const code = await runRemoteCommandWithPmHooks({
        prep,
        remoteArgv: ['pnpm', 'test'],
        autoYes: true,
        pmOverride: undefined,
        confirm: vi.fn(),
      });

      expect(code).toBe(0);
      expect(runRemote).toHaveBeenCalledTimes(1);
      expect(runRemote.mock.calls[0]?.[2]).toContain('test');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('does not run a second install when remote argv is already pnpm install', async () => {
    const repoRoot = makeTempRepo();
    try {
      writePnpmWorkspace(repoRoot, "lockfileVersion: '9.0'\n");
      const prep = makePrep(repoRoot);

      const code = await runRemoteCommandWithPmHooks({
        prep,
        remoteArgv: ['pnpm', 'install'],
        autoYes: true,
        pmOverride: undefined,
        confirm: vi.fn(),
      });

      expect(code).toBe(0);
      expect(runRemote).toHaveBeenCalledTimes(1);
      expect(runRemote.mock.calls[0]?.[2]).toContain('install');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('runs remote install when the lockfile changed since the last stored hash', async () => {
    const repoRoot = makeTempRepo();
    try {
      writePnpmWorkspace(repoRoot, "lockfileVersion: '9.0'\n");
      const fpOld = pnpmPackageManagerPlugin.readLocalFingerprint(repoRoot);
      expect(fpOld).not.toBeNull();
      pnpmPackageManagerPlugin.writeStoredHash(stateCtx(repoRoot), fpOld!);

      fs.writeFileSync(
        path.join(repoRoot, 'pnpm-lock.yaml'),
        "lockfileVersion: '9.0'\npackages: {}\n",
        'utf8',
      );

      const prep = makePrep(repoRoot);
      const code = await runRemoteCommandWithPmHooks({
        prep,
        remoteArgv: ['pnpm', 'test'],
        autoYes: true,
        pmOverride: undefined,
        confirm: vi.fn(),
      });

      expect(code).toBe(0);
      expect(runRemote).toHaveBeenCalledTimes(2);
      expect(runRemote.mock.calls[0]?.[2]).toBe('pnpm install');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('prompts to create remote workspace when the directory is missing', async () => {
    const repoRoot = makeTempRepo();
    try {
      writePnpmWorkspace(repoRoot, "lockfileVersion: '9.0'\n");
      pnpmPackageManagerPlugin.writeStoredHash(stateCtx(repoRoot),
        pnpmPackageManagerPlugin.readLocalFingerprint(repoRoot)!,
      );

      dirExists.mockReturnValue(false);
      const confirm = vi.fn().mockResolvedValue(true);

      const code = await runRemoteCommandWithPmHooks({
        prep: makePrep(repoRoot),
        remoteArgv: ['pnpm', 'test'],
        autoYes: false,
        pmOverride: undefined,
        confirm,
      });

      expect(code).toBe(0);
      expect(confirm).toHaveBeenCalled();
      expect(String(confirm.mock.calls[0]?.[0])).toContain('mkdir -p');
      expect(mkdirRemote).toHaveBeenCalledWith('test-host', '/remote/repo');
      expect(runRemote).toHaveBeenCalled();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('creates remote workspace without prompting when --yes and the directory is missing', async () => {
    const repoRoot = makeTempRepo();
    try {
      writePnpmWorkspace(repoRoot, "lockfileVersion: '9.0'\n");
      pnpmPackageManagerPlugin.writeStoredHash(stateCtx(repoRoot),
        pnpmPackageManagerPlugin.readLocalFingerprint(repoRoot)!,
      );

      dirExists.mockReturnValue(false);
      const confirm = vi.fn();

      const code = await runRemoteCommandWithPmHooks({
        prep: makePrep(repoRoot),
        remoteArgv: ['pnpm', 'test'],
        autoYes: true,
        pmOverride: undefined,
        confirm,
      });

      expect(code).toBe(0);
      expect(confirm).not.toHaveBeenCalled();
      expect(mkdirRemote).toHaveBeenCalledWith('test-host', '/remote/repo');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('aborts when the remote workspace is missing and mkdir is declined', async () => {
    const repoRoot = makeTempRepo();
    try {
      writePnpmWorkspace(repoRoot, "lockfileVersion: '9.0'\n");
      dirExists.mockReturnValue(false);
      const confirm = vi.fn().mockResolvedValue(false);

      const code = await runRemoteCommandWithPmHooks({
        prep: makePrep(repoRoot),
        remoteArgv: ['pnpm', 'test'],
        autoYes: false,
        pmOverride: undefined,
        confirm,
      });

      expect(code).toBe(1);
      expect(mkdirRemote).not.toHaveBeenCalled();
      expect(runRemote).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('records install hash after auto-running the initial install', async () => {
    const repoRoot = makeTempRepo();
    try {
      writePnpmWorkspace(repoRoot, "lockfileVersion: '9.0'\n");
      const prep = makePrep(repoRoot);
      const confirm = vi.fn();

      await runRemoteCommandWithPmHooks({
        prep,
        remoteArgv: ['pnpm', 'test'],
        autoYes: false,
        pmOverride: undefined,
        confirm,
      });

      expect(confirm).not.toHaveBeenCalled();
      expect(runRemote).toHaveBeenCalledTimes(2);
      expect(runRemote.mock.calls[0]?.[2]).toBe('pnpm install');
      const fp = pnpmPackageManagerPlugin.readLocalFingerprint(repoRoot);
      expect(fp).not.toBeNull();
      expect(pnpmPackageManagerPlugin.readStoredHash(stateCtx(repoRoot))).toBe(fp);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
