import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import YAML from 'yaml';

import {
  BICA_SPEC_FILE,
  BICA_WORKSPACE_SPEC_FILE,
  DEFAULT_RETURN_FLOW_PATHS,
  findBicaSpecPath,
  normalizeToSyncSpecYaml,
  resolveSyncSpecPath,
} from './syncProject';

describe('normalizeToSyncSpecYaml', () => {
  const repoRoot = '/tmp/float-javascript';

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
  float:
    mode: one-way-replica
`) as unknown;
    const n = normalizeToSyncSpecYaml(doc, repoRoot, 'bica.yml');
    expect(n.sync.float?.mode).toBe('one-way-replica');
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
