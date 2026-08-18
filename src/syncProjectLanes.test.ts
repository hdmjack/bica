import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { laneIdentity } from './lib/lanes';
import { prepareSyncProjectFile } from './syncProject';

const BICA_YML = `sync:
  mode: one-way-replica
  ignore:
    paths:
      - node_modules
returnFlow:
  paths:
    - '**/*.snap'
`;

let repoRoot = '';
let previousCwd = '';

beforeEach(() => {
  previousCwd = process.cwd();
  // macOS /var → /private/var symlink: realpath so the value matches what `git rev-parse` reports.
  repoRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bica-lane-prep-')),
  );
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, 'bica.yml'), BICA_YML, 'utf8');
  process.chdir(repoRoot);
  process.env.BICA_SSH_HOST = 'test-host';
  process.env.BICA_REMOTE_PATH = '~/code/repo';
});

afterEach(() => {
  process.chdir(previousCwd);
  delete process.env.BICA_SSH_HOST;
  delete process.env.BICA_REMOTE_PATH;
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

function readSessions(projectFilePath: string): Record<string, { beta?: string }> {
  const doc = YAML.parse(fs.readFileSync(projectFilePath, 'utf8')) as {
    sync: Record<string, { beta?: string }>;
  };
  return doc.sync;
}

describe('prepareSyncProjectFile — default lane', () => {
  it('writes .bica/project.yml with the unsuffixed session and base remote path', () => {
    const prep = prepareSyncProjectFile({ verbose: false });
    expect(prep.projectFilePath).toBe(
      path.join(repoRoot, '.bica', 'project.yml'),
    );
    expect(prep.config.remoteWorkspacePath).toBe('~/code/repo');
    expect(prep.remoteSyncUrl).toBe('test-host:~/code/repo');
    expect(prep.lane.isDefault).toBe(true);
    expect(Object.keys(readSessions(prep.projectFilePath))).toEqual([
      path.basename(repoRoot).replace(/[^a-z0-9-]+/gi, '-').toLowerCase(),
    ]);
  });
});

describe('prepareSyncProjectFile — lanes', () => {
  it('gives the lane its own remote workspace, session name and project file', () => {
    const prep = prepareSyncProjectFile({
      verbose: false,
      lane: laneIdentity(repoRoot, '2'),
    });
    expect(prep.config.remoteWorkspacePath).toBe('~/code/repo-lane-2');
    expect(prep.sessionName).toMatch(/-lane-2$/);
    expect(prep.projectFilePath).toBe(
      path.join(repoRoot, '.bica', 'lanes', '2', 'project.yml'),
    );
  });

  it('keeps each lane project file to its own session, so no two claim one name', () => {
    // Spreading the spec's session map into the file would re-emit the unsuffixed session and have
    // every lane's project file start a session called the same thing.
    const one = prepareSyncProjectFile({
      verbose: false,
      lane: laneIdentity(repoRoot, '1'),
    });
    const two = prepareSyncProjectFile({
      verbose: false,
      lane: laneIdentity(repoRoot, '2'),
    });
    const namesOne = Object.keys(readSessions(one.projectFilePath));
    const namesTwo = Object.keys(readSessions(two.projectFilePath));
    expect(namesOne).toHaveLength(1);
    expect(namesTwo).toHaveLength(1);
    expect(namesOne[0]).not.toBe(namesTwo[0]);
  });

  it('points the lane session at the lane remote workspace', () => {
    const prep = prepareSyncProjectFile({
      verbose: false,
      lane: laneIdentity(repoRoot, '3'),
    });
    const sessions = readSessions(prep.projectFilePath);
    expect(sessions[prep.sessionName]?.beta).toBe('test-host:~/code/repo-lane-3');
  });

  it('does not disturb the default lane project file', () => {
    const base = prepareSyncProjectFile({ verbose: false });
    const baseBefore = fs.readFileSync(base.projectFilePath, 'utf8');
    prepareSyncProjectFile({ verbose: false, lane: laneIdentity(repoRoot, '1') });
    expect(fs.readFileSync(base.projectFilePath, 'utf8')).toBe(baseBefore);
  });

  it('carries the spec ignore and return-flow config into every lane unchanged', () => {
    const prep = prepareSyncProjectFile({
      verbose: false,
      lane: laneIdentity(repoRoot, '1'),
    });
    expect(prep.syncIgnorePaths).toEqual(['node_modules']);
    expect(prep.returnFlowPaths).toEqual(['**/*.snap']);
  });

  it('appends the suffix to an explicit remote path with a trailing slash', () => {
    process.env.BICA_REMOTE_PATH = '/srv/work/repo/';
    const prep = prepareSyncProjectFile({
      verbose: false,
      lane: laneIdentity(repoRoot, '1'),
    });
    expect(prep.config.remoteWorkspacePath).toBe('/srv/work/repo-lane-1');
  });
});
