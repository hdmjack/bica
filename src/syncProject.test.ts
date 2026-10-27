import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import YAML from 'yaml';

import {
  BICA_SPEC_FILE,
  loadRemoteEnvConfig,
  BICA_WORKSPACE_SPEC_FILE,
  DEFAULT_RETURN_FLOW_PATHS,
  findBicaSpecPath,
  normalizeToSyncSpecYaml,
  resolveSyncSpecPath,
} from './syncProject';

describe('normalizeToSyncSpecYaml', () => {
  const repoRoot = '/tmp/web-app';

  it('reads generated.inputs, and keeps them in the sync because the remote needs them', () => {
    const doc = YAML.parse(`
sync:
  ignore:
    paths:
      - node_modules
generated:
  paths:
    - ui/src/icons/essentials/Icon*.tsx
  inputs:
    - ui/src/icons/essentials/assets/*.svg
  command: pnpm --filter @float/ui run generate-icons
`) as unknown;
    const n = normalizeToSyncSpecYaml(doc, repoRoot, 'bica.yml');
    expect(n.generated?.inputs).toEqual(['ui/src/icons/essentials/assets/*.svg']);
    expect(n.syncIgnorePaths).toContain('ui/src/icons/essentials/Icon*.tsx');
    expect(n.syncIgnorePaths).not.toContain('ui/src/icons/essentials/assets/*.svg');
  });

  it('refuses a generated.inputs entry that leaves the workspace', () => {
    const doc = YAML.parse(`
sync:
  ignore:
    paths: []
generated:
  inputs:
    - ../elsewhere/*.svg
`) as unknown;
    expect(() => normalizeToSyncSpecYaml(doc, repoRoot, 'bica.yml')).toThrow(/\.\./);
  });

  it('accepts flat sync: { mode, ignore }', () => {
    const doc = YAML.parse(`
sync:
  mode: one-way-replica
  ignore:
    paths:
      - node_modules
returnFlow:
  paths: []
`) as unknown;
    const n = normalizeToSyncSpecYaml(doc, repoRoot, 'bica.yml');
    const keys = Object.keys(n.sync);
    expect(keys).toHaveLength(1);
    const session = n.sync[keys[0]];
    expect(session?.mode).toBe('one-way-replica');
    expect(session?.ignore?.paths).toEqual(['node_modules']);
  });

  it('ignores *.tsbuildinfo with dist for a bica.yml that has not said, as float-javascript\'s had not', () => {
    const doc = YAML.parse(`
sync:
  ignore:
    paths:
      - node_modules
      - dist
returnFlow:
  paths: []
`) as unknown;
    const n = normalizeToSyncSpecYaml(doc, repoRoot, 'bica.yml');
    const session = n.sync[Object.keys(n.sync)[0]];
    // What the sync is configured with, not only what the report says.
    expect(session?.ignore?.paths).toEqual(['node_modules', 'dist', '*.tsbuildinfo']);
    expect(n.syncIgnorePaths).toContain('*.tsbuildinfo');
    expect(n.companionRecordsIgnored).toEqual(['*.tsbuildinfo']);
  });

  it('defaults mode when only ignore is set (flat sync)', () => {
    const doc = YAML.parse(`
sync:
  ignore:
    paths:
      - node_modules
returnFlow:
  paths: []
`) as unknown;
    const n = normalizeToSyncSpecYaml(doc, repoRoot, 'bica.yml');
    const name = Object.keys(n.sync)[0];
    expect(n.sync[name]?.mode).toBe('one-way-replica');
    expect(n.sync[name]?.ignore?.paths).toEqual(['node_modules']);
  });

  it('accepts legacy single named session', () => {
    const doc = YAML.parse(`
sync:
  web:
    mode: one-way-replica
`) as unknown;
    const n = normalizeToSyncSpecYaml(doc, repoRoot, 'bica.yml');
    expect(n.sync.web?.mode).toBe('one-way-replica');
  });

  it('rejects multiple legacy sessions', () => {
    const doc = YAML.parse(`
sync:
  a: { mode: x }
  b: { mode: x }
`) as unknown;
    expect(() => normalizeToSyncSpecYaml(doc, repoRoot, 'bica.yml')).toThrow(
      /exactly one session/,
    );
  });

  it('rejects empty sync', () => {
    expect(() =>
      normalizeToSyncSpecYaml({ sync: {} }, repoRoot, 'bica.yml'),
    ).toThrow(/empty/);
  });

  it('applies default returnFlow patterns when returnFlow is absent', () => {
    const doc = YAML.parse(`
sync:
  mode: one-way-replica
`) as unknown;
    const n = normalizeToSyncSpecYaml(doc, repoRoot, 'bica.yml');
    expect(n.returnFlow?.paths).toEqual([...DEFAULT_RETURN_FLOW_PATHS]);
    const session = n.sync[Object.keys(n.sync)[0]];
    for (const pattern of DEFAULT_RETURN_FLOW_PATHS) {
      expect(session?.ignore?.paths).toContain(pattern);
    }
  });

  it('merges returnFlow paths into forward ignore without duplicating user entries', () => {
    const doc = YAML.parse(`
sync:
  mode: one-way-replica
  ignore:
    paths:
      - node_modules
      - "**/*.snap"
returnFlow:
  paths:
    - "**/*.snap"
    - "**/snapshots/**"
`) as unknown;
    const n = normalizeToSyncSpecYaml(doc, repoRoot, 'bica.yml');
    expect(n.returnFlow?.paths).toEqual(['**/*.snap', '**/snapshots/**']);
    const session = n.sync[Object.keys(n.sync)[0]];
    const ignored = session?.ignore?.paths ?? [];
    expect(ignored).toEqual(['node_modules', '**/*.snap', '**/snapshots/**']);
  });

  it('disables return-flow when returnFlow.paths is an empty list', () => {
    const doc = YAML.parse(`
sync:
  mode: one-way-replica
returnFlow:
  paths: []
`) as unknown;
    const n = normalizeToSyncSpecYaml(doc, repoRoot, 'bica.yml');
    expect(n.returnFlow?.paths).toEqual([]);
    const session = n.sync[Object.keys(n.sync)[0]];
    expect(session?.ignore?.paths ?? undefined).toBeUndefined();
  });
});

describe('findBicaSpecPath / resolveSyncSpecPath', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-spec-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prefers bica.yml over bica-workspace.yml', () => {
    fs.writeFileSync(
      path.join(dir, BICA_WORKSPACE_SPEC_FILE),
      'sync:\n  x: { mode: a }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, BICA_SPEC_FILE),
      'sync:\n  mode: one-way-replica\n',
      'utf8',
    );
    expect(findBicaSpecPath(dir)?.displayName).toBe(BICA_SPEC_FILE);
    expect(resolveSyncSpecPath(dir).displayName).toBe(BICA_SPEC_FILE);
  });

  it('falls back to bica-workspace.yml', () => {
    fs.writeFileSync(
      path.join(dir, BICA_WORKSPACE_SPEC_FILE),
      'sync:\n  only: { mode: x }\n',
      'utf8',
    );
    expect(findBicaSpecPath(dir)?.displayName).toBe(BICA_WORKSPACE_SPEC_FILE);
  });
});

describe('the remote workspace path is guarded before anything deletes into it', () => {
  const unsafe = ['~', '~/', '/', '.', '..', '$HOME', '  ~  '];

  it.each(unsafe)('refuses %j', (value) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-remote-path-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, 'bica.yml'),
        'sync:\n  mode: one-way-replica\n  ignore:\n    paths: []\n',
      );
      fs.mkdirSync(path.join(repoRoot, '.bica'), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, '.bica', 'local.yml'),
        // Quoted: a bare `~` is null in YAML, so it would never reach the guard being tested.
        `sshHost: somehost\nremotePath: ${JSON.stringify(value)}\n`,
      );
      // The first push mirrors the repo into this directory with deletions, so a home or root path
      // takes everything else there with it.
      expect(() => loadRemoteEnvConfig(repoRoot)).toThrow(
        /home or root directory|home directory itself/,
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('accepts an ordinary workspace path', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-remote-path-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, 'bica.yml'),
        'sync:\n  mode: one-way-replica\n  ignore:\n    paths: []\n',
      );
      fs.mkdirSync(path.join(repoRoot, '.bica'), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, '.bica', 'local.yml'),
        'sshHost: somehost\nremotePath: ~/code/me/repo\n',
      );
      expect(loadRemoteEnvConfig(repoRoot).remoteWorkspacePath).toBe(
        '~/code/me/repo',
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('refuses an ssh host that ssh would read as an option', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-remote-path-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, 'bica.yml'),
        'sync:\n  mode: one-way-replica\n  ignore:\n    paths: []\n',
      );
      fs.mkdirSync(path.join(repoRoot, '.bica'), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, '.bica', 'local.yml'),
        'sshHost: -oProxyCommand=touch /tmp/pwned\nremotePath: ~/code/me/repo\n',
      );
      expect(() => loadRemoteEnvConfig(repoRoot)).toThrow(/reads? as an option|starts with/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('what reaches the remote, by pattern rather than by exit code', () => {
  /** The ignore list a scaffolded project gets, as it arrives in the sync spec. */
  function ignorePathsFor(ignore: string[]): string[] {
    const doc = {
      sync: { mode: 'one-way-replica', ignore: { paths: ignore } },
    };
    const normalized = normalizeToSyncSpecYaml(doc, '/repo', 'bica.yml');
    return (
      (normalized.sync as Record<string, { ignore?: { paths?: string[] } }>)[
        Object.keys(normalized.sync as object)[0]
      ]?.ignore?.paths ?? []
    );
  }

  it('carries a build-info glob through to the sync spec', () => {
    // A regression here is silent: the run exits non-zero with plausible compiler output, blaming
    // the code for a remote build state that came half from one machine and half from another. So
    // the assertion is on the pattern reaching the sync, not on anything a run returns.
    expect(ignorePathsFor(['node_modules', 'dist', '*.tsbuildinfo'])).toContain(
      '*.tsbuildinfo',
    );
  });

  it('keeps every pattern it was given, in order', () => {
    const paths = ['node_modules', '.git', 'dist', '*.tsbuildinfo', 'coverage'];
    expect(ignorePathsFor(paths)).toEqual(expect.arrayContaining(paths));
  });
});
