import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pnpmPackageManagerPlugin } from '../plugins/pnpmPackageManagerPlugin';
import {
  remoteMkdirWorkspace,
  remoteWorkspaceDirExists,
  runRemoteCommand,
} from './runRemote';
import { installRecordPathExpr } from './remoteInstallState';
import { CONNECTION_LOST_EXIT } from './connectionLoss';
import {
  aggregateExitCode,
  runRemoteCommandWithPmHooks,
} from './runWithPackageManagerPlugins';
import type { PrepareResult } from '../syncProject';

/**
 * The remote filesystem, as far as these tests are concerned: the install records bica keeps there.
 *
 * A map rather than a stub per call, because the point of the record moving to the remote is that two
 * checkouts share one. Only a shared store can show that, and the scripts are small enough to read.
 */
const remoteFiles = vi.hoisted(() => new Map<string, string>());

vi.mock('./runRemote', () => ({
  // The real values, because `aggregateExitCode` compares against them and a mock that invented its
  // own numbers would agree with itself while disagreeing with every run.
  REMOTE_CD_FAILED_EXIT: 96,
  REMOTE_CONTENT_MISMATCH_EXIT: 97,
  runRemoteCommand: vi.fn(() => Promise.resolve(0)),
  remoteWorkspaceDirExists: vi.fn(() => true),
  remoteMkdirWorkspace: vi.fn(() => 0),
  shellSingleQuoteRemotePathForSh: (v: string) =>
    `'${v.replaceAll("'", `'\\''`)}'`,
  runRemoteScriptOverStdin: vi.fn((_host: string, script: string) => {
    const write = /printf '%s\\n' '(.+)' > (\S+)/.exec(script);
    if (write) {
      remoteFiles.set(write[2], `${write[1]}\n`);
      return { status: 0, stdout: '', stderr: '' };
    }
    const read = /^cat (\S+) /.exec(script);
    if (read) {
      return { status: 0, stdout: remoteFiles.get(read[1]) ?? '', stderr: '' };
    }
    const remove = /^rm -f (\S+)/.exec(script);
    if (remove) {
      remoteFiles.delete(remove[1]);
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected remote script: ${script}`);
  }),
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

/** What the remote says this workspace installed from, as the production code would read it. */
function remoteRecord(remoteWorkspacePath = '/remote/repo'): string | null {
  const stored = remoteFiles.get(
    installRecordPathExpr(remoteWorkspacePath, 'pnpm'),
  );
  return stored === undefined ? null : stored.trim();
}

/** Record an install against a remote workspace, the way a previous run would have left it. */
function recordRemoteInstall(
  digest: string,
  remoteWorkspacePath = '/remote/repo',
): void {
  remoteFiles.set(
    installRecordPathExpr(remoteWorkspacePath, 'pnpm'),
    `${digest}\n`,
  );
}

function makePrep(repoRoot: string): PrepareResult {
  return {
    repoRoot,
    projectFilePath: path.join(repoRoot, '.bica', 'project.yml'),
    sessionName: 'test-session',
    remoteSyncUrl: 'test-host:/remote/repo',
    returnFlowPaths: [],
    generatedPaths: [],
    generatedCommand: undefined,
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
    remoteFiles.clear();
    runRemote.mockReset();
    runRemote.mockResolvedValue(0);
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

      const code = await runRemoteCommandWithPmHooks({
        prep,
        remoteArgv: ['pnpm', 'test'],
        pmOverride: undefined,
      });

      expect(code).toBe(0);
      expect(runRemote).toHaveBeenCalledTimes(2);
      expect(runRemote.mock.calls[0]?.[2]).toBe(
        pnpmPackageManagerPlugin.remoteInstallCommand,
      );
      expect(runRemote.mock.calls[0]?.[3]).toBe(repoRoot);
      expect(runRemote.mock.calls[1]?.[2]).toContain('pnpm');
      expect(runRemote.mock.calls[1]?.[2]).toContain('test');
      expect(runRemote.mock.calls[1]?.[3]).toBe(repoRoot);

      const fp = pnpmPackageManagerPlugin.readLocalFingerprint(repoRoot);
      expect(fp).not.toBeNull();
      expect(remoteRecord()).toBe(fp);
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
      recordRemoteInstall(fpOld!);

      fs.writeFileSync(
        path.join(repoRoot, 'pnpm-lock.yaml'),
        "lockfileVersion: '9.0'\npackages: {}\n",
        'utf8',
      );

      const prep = makePrep(repoRoot);

      await runRemoteCommandWithPmHooks({
        prep,
        remoteArgv: ['pnpm', 'test'],
        pmOverride: undefined,
      });

      expect(runRemote).toHaveBeenCalledTimes(2);
      expect(runRemote.mock.calls[0]?.[2]).toBe(
        pnpmPackageManagerPlugin.remoteInstallCommand,
      );
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
      recordRemoteInstall(fp!);

      const prep = makePrep(repoRoot);
      const code = await runRemoteCommandWithPmHooks({
        prep,
        remoteArgv: ['pnpm', 'test'],
        pmOverride: undefined,
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
        pmOverride: undefined,
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
      recordRemoteInstall(fpOld!);

      fs.writeFileSync(
        path.join(repoRoot, 'pnpm-lock.yaml'),
        "lockfileVersion: '9.0'\npackages: {}\n",
        'utf8',
      );

      const prep = makePrep(repoRoot);
      const code = await runRemoteCommandWithPmHooks({
        prep,
        remoteArgv: ['pnpm', 'test'],
        pmOverride: undefined,
      });

      expect(code).toBe(0);
      expect(runRemote).toHaveBeenCalledTimes(2);
      expect(runRemote.mock.calls[0]?.[2]).toBe(
        pnpmPackageManagerPlugin.remoteInstallCommand,
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('creates remote workspace without prompting when --yes and the directory is missing', async () => {
    const repoRoot = makeTempRepo();
    try {
      writePnpmWorkspace(repoRoot, "lockfileVersion: '9.0'\n");
      recordRemoteInstall(
        pnpmPackageManagerPlugin.readLocalFingerprint(repoRoot)!,
      );

      dirExists.mockReturnValue(false);

      const code = await runRemoteCommandWithPmHooks({
        prep: makePrep(repoRoot),
        remoteArgv: ['pnpm', 'test'],
        pmOverride: undefined,
      });

      expect(code).toBe(0);
      expect(mkdirRemote).toHaveBeenCalledWith('test-host', '/remote/repo');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('records install hash after auto-running the initial install', async () => {
    const repoRoot = makeTempRepo();
    try {
      writePnpmWorkspace(repoRoot, "lockfileVersion: '9.0'\n");
      const prep = makePrep(repoRoot);

      await runRemoteCommandWithPmHooks({
        prep,
        remoteArgv: ['pnpm', 'test'],
        pmOverride: undefined,
      });

      expect(runRemote).toHaveBeenCalledTimes(2);
      expect(runRemote.mock.calls[0]?.[2]).toBe(
        pnpmPackageManagerPlugin.remoteInstallCommand,
      );
      const fp = pnpmPackageManagerPlugin.readLocalFingerprint(repoRoot);
      expect(fp).not.toBeNull();
      expect(remoteRecord()).toBe(fp);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('runs the install preflight for a multi-command run, matching the user commands', async () => {
    // A multi-command run executes `sh -c <wrapper>`, and plugins match on argv[0]. Matching the
    // wrapper matches nothing, so the preflight silently did not run and a fresh workspace executed
    // against no node_modules. Matching is done against the user's commands instead.
    const repoRoot = makeTempRepo();
    writePnpmWorkspace(repoRoot, 'lockfileVersion: 9\n');
    const code = await runRemoteCommandWithPmHooks({
      prep: makePrep(repoRoot),
      remoteArgv: ['sh', '-c', 'pnpm lint & pnpm test & wait'],
      matchArgvs: [
        ['pnpm', 'lint'],
        ['pnpm', 'test'],
      ],
      pmOverride: undefined,
    });
    expect(code).toBe(0);
    expect(runRemote.mock.calls[0]?.[2]).toBe(
      pnpmPackageManagerPlugin.remoteInstallCommand,
    );
    expect(remoteRecord()).toBe(
      pnpmPackageManagerPlugin.readLocalFingerprint(repoRoot),
    );
  });

  it('does not treat a wrapped run as an install just because a command mentions one', async () => {
    const repoRoot = makeTempRepo();
    writePnpmWorkspace(repoRoot, 'lockfileVersion: 9\n');
    recordRemoteInstall(
      pnpmPackageManagerPlugin.readLocalFingerprint(repoRoot)!,
    );
    await runRemoteCommandWithPmHooks({
      prep: makePrep(repoRoot),
      remoteArgv: ['sh', '-c', 'wrapped'],
      matchArgvs: [['pnpm', 'lint']],
      pmOverride: undefined,
    });
    // Fingerprint already current, so the only remote call is the command itself.
    expect(runRemote.mock.calls).toHaveLength(1);
  });
});
describe('two checkouts sharing one remote workspace', () => {
  const runRemote = vi.mocked(runRemoteCommand);
  const made: string[] = [];

  beforeEach(() => {
    remoteFiles.clear();
    runRemote.mockReset();
    runRemote.mockResolvedValue(0);
    vi.mocked(remoteWorkspaceDirExists).mockReturnValue(true);
  });

  afterEach(() => {
    for (const dir of made.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const checkout = (lockfile: string): string => {
    const root = makeTempRepo();
    made.push(root);
    writePnpmWorkspace(root, lockfile);
    return root;
  };

  const installCommands = (): string[] =>
    runRemote.mock.calls
      .map((call) => String(call[2]))
      .filter((cmd) => cmd === pnpmPackageManagerPlugin.remoteInstallCommand);

  /**
   * The failure this file exists to prevent, as it actually happened: a dev dependency added in one
   * worktree, pruned by a run from a sibling worktree pointing at the same remote path, and the first
   * worktree then skipping its install because the record it consulted was its own.
   */
  it('reinstalls for A after B installed a different lockfile into the same remote', async () => {
    const a = checkout("lockfileVersion: '9.0'\npackages:\n  a: {}\n");
    const b = checkout("lockfileVersion: '9.0'\npackages:\n  b: {}\n");

    await runRemoteCommandWithPmHooks({
      prep: makePrep(a),
      remoteArgv: ['pnpm', 'typecheck'],
      pmOverride: undefined,
    });
    expect(installCommands()).toHaveLength(1);

    await runRemoteCommandWithPmHooks({
      prep: makePrep(b),
      remoteArgv: ['pnpm', 'test'],
      pmOverride: undefined,
    });
    expect(installCommands()).toHaveLength(2);

    // A's own lockfile has not changed, and under a per-checkout record this skipped the install and
    // ran against a `node_modules` B had since pruned.
    await runRemoteCommandWithPmHooks({
      prep: makePrep(a),
      remoteArgv: ['pnpm', 'typecheck'],
      pmOverride: undefined,
    });
    expect(installCommands()).toHaveLength(3);
    expect(remoteRecord()).toBe(
      pnpmPackageManagerPlugin.readLocalFingerprint(a),
    );
  });

  it('still skips the install when the other checkout installed the same lockfile', async () => {
    const lockfile = "lockfileVersion: '9.0'\npackages:\n  same: {}\n";
    const a = checkout(lockfile);
    const b = checkout(lockfile);

    await runRemoteCommandWithPmHooks({
      prep: makePrep(a),
      remoteArgv: ['pnpm', 'typecheck'],
      pmOverride: undefined,
    });
    await runRemoteCommandWithPmHooks({
      prep: makePrep(b),
      remoteArgv: ['pnpm', 'test'],
      pmOverride: undefined,
    });

    // One install between them: identical lockfiles describe one `node_modules`, whoever asked first.
    expect(installCommands()).toHaveLength(1);
  });

  it('keeps separate records for checkouts pointing at different remote workspaces', async () => {
    const lockfile = "lockfileVersion: '9.0'\npackages:\n  one: {}\n";
    const a = checkout(lockfile);
    const b = checkout(lockfile);
    const prepB = makePrep(b);
    prepB.config.remoteWorkspacePath = '/remote/other';

    await runRemoteCommandWithPmHooks({
      prep: makePrep(a),
      remoteArgv: ['pnpm', 'typecheck'],
      pmOverride: undefined,
    });
    await runRemoteCommandWithPmHooks({
      prep: prepB,
      remoteArgv: ['pnpm', 'test'],
      pmOverride: undefined,
    });

    // Two workspaces are two `node_modules`, so each needs its own install and its own record.
    expect(installCommands()).toHaveLength(2);
    expect(remoteRecord('/remote/other')).toBe(remoteRecord('/remote/repo'));
  });
});

describe('one exit code for several commands', () => {
  it('reports a dropped connection ahead of the failure it looks like', () => {
    // The reported run: `pnpm-test-run=95 pnpm-typecheck=0`. Collapsing that to 1 would say the
    // tests failed, which is exactly the claim nobody is in a position to make.
    expect(aggregateExitCode([CONNECTION_LOST_EXIT, 0])).toBe(
      CONNECTION_LOST_EXIT,
    );
    expect(aggregateExitCode([CONNECTION_LOST_EXIT, 1])).toBe(
      CONNECTION_LOST_EXIT,
    );
  });

  it('keeps the two definite verdicts about the workspace above it', () => {
    // 97 and 96 each name something to do; a drop names only an unknown.
    expect(aggregateExitCode([CONNECTION_LOST_EXIT, 97])).toBe(97);
    expect(aggregateExitCode([CONNECTION_LOST_EXIT, 96])).toBe(96);
  });

  it('is unchanged for runs where nothing dropped', () => {
    expect(aggregateExitCode([0, 0])).toBe(0);
    expect(aggregateExitCode([0, 1])).toBe(1);
  });
});
