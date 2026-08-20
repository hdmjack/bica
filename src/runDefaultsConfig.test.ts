import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveBicaPluginConfig } from './bicaWorkspaceConfig';

const BASE_SYNC = `sync:
  mode: one-way-replica
  ignore:
    paths:
      - node_modules
`;

let repoRoot = '';
const TOUCHED_ENV = ['BICA_ASSUME_YES'] as const;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-run-defaults-'));
  for (const key of TOUCHED_ENV) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TOUCHED_ENV) {
    delete process.env[key];
  }
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

function writeSpec(extra = ''): void {
  fs.writeFileSync(path.join(repoRoot, 'bica.yml'), BASE_SYNC + extra, 'utf8');
}

describe('run defaults — no config', () => {
  it('keeps the historical behaviour: prompts on', () => {
    writeSpec();
    const c = resolveBicaPluginConfig(repoRoot);
    expect(c.runAssumeYes).toBe(false);
  });
});

describe('run defaults — bica.yml', () => {
  it('reads run.assumeYes', () => {
    writeSpec('run:\n  assumeYes: true\n');
    expect(resolveBicaPluginConfig(repoRoot).runAssumeYes).toBe(true);
  });

  it('rejects a non-boolean assumeYes rather than coercing it', () => {
    writeSpec('run:\n  assumeYes: "yes"\n');
    expect(() => resolveBicaPluginConfig(repoRoot)).toThrow(
      /run.assumeYes must be a boolean/,
    );
  });

  it('rejects a non-object run block', () => {
    writeSpec('run: auto\n');
    expect(() => resolveBicaPluginConfig(repoRoot)).toThrow(
      /run: must be an object/,
    );
  });
});

describe('run defaults — env overrides YAML', () => {
  it('BICA_ASSUME_YES=0 turns config-enabled auto-confirm back off', () => {
    writeSpec('run:\n  assumeYes: true\n');
    process.env.BICA_ASSUME_YES = '0';
    expect(resolveBicaPluginConfig(repoRoot).runAssumeYes).toBe(false);
  });

  it('BICA_ASSUME_YES=1 enables it without config', () => {
    writeSpec();
    process.env.BICA_ASSUME_YES = '1';
    expect(resolveBicaPluginConfig(repoRoot).runAssumeYes).toBe(true);
  });
});
