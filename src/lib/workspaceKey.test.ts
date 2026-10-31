import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareSyncProjectFile } from '../syncProject';
import { projectFileRelative, syncSessionName, workspaceKey } from './workspaceKey';

describe('workspaceKey', () => {
  it('is stable for one workspace and differs between two', () => {
    expect(workspaceKey('mini:~/code/a')).toBe(workspaceKey('mini:~/code/a'));
    expect(workspaceKey('mini:~/code/a')).not.toBe(workspaceKey('mini:~/code/b'));
    expect(workspaceKey('mini:~/code/a')).not.toBe(workspaceKey('other:~/code/a'));
    expect(workspaceKey('mini:~/code/a')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('names session and project file after the key, in a form Mutagen accepts', () => {
    const url = 'mini:~/code/a';
    expect(syncSessionName('repo', url)).toBe(`repo-${workspaceKey(url)}`);
    expect(syncSessionName('repo', url)).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(projectFileRelative(workspaceKey(url))).toBe(
      path.join('.bica', `project-${workspaceKey(url)}.yml`),
    );
  });
});

/**
 * Two runs from one checkout into different workspaces used to write one project file and share one
 * lock, so the second was told a sync was "already running" that pointed at the first's workspace.
 */
describe('prepareSyncProjectFile, one checkout and two workspaces', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-two-workspaces-'));
    fs.writeFileSync(
      path.join(repoRoot, 'bica.yml'),
      'sync:\n  mode: one-way-replica\n  ignore:\n    paths: []\n',
    );
    vi.spyOn(process, 'cwd').mockReturnValue(repoRoot);
    vi.stubEnv('BICA_SSH_HOST', 'somehost');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  const prepare = (remotePath: string) => {
    vi.stubEnv('BICA_REMOTE_PATH', remotePath);
    return prepareSyncProjectFile({ verbose: false });
  };

  it('gives each workspace its own project file, session name and key', () => {
    const first = prepare('~/code/one');
    const second = prepare('~/code/two');
    expect(second.projectFilePath).not.toBe(first.projectFilePath);
    expect(second.sessionName).not.toBe(first.sessionName);
    expect(second.workspaceKey).not.toBe(first.workspaceKey);
    // Writing the second must leave the first as it was: that is what the first run is still using.
    const firstDoc = YAML.parse(fs.readFileSync(first.projectFilePath, 'utf8')) as {
      sync: Record<string, { beta: string }>;
    };
    expect(firstDoc.sync[first.sessionName].beta).toBe('somehost:~/code/one');
    const secondDoc = YAML.parse(fs.readFileSync(second.projectFilePath, 'utf8')) as {
      sync: Record<string, { beta: string }>;
    };
    expect(secondDoc.sync[second.sessionName].beta).toBe('somehost:~/code/two');
  });

  it('gives the same workspace the same files every time, so its lock is found again', () => {
    const first = prepare('~/code/one');
    const again = prepare('~/code/one');
    expect(again.projectFilePath).toBe(first.projectFilePath);
    expect(again.sessionName).toBe(first.sessionName);
  });
});
