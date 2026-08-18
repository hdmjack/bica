import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NO_LANE, resolveBicaPluginConfig } from './bicaWorkspaceConfig';

const BASE_SYNC = `sync:
  mode: one-way-replica
  ignore:
    paths:
      - node_modules
`;

let repoRoot = '';
const TOUCHED_ENV = ['BICA_LANE', 'BICA_ASSUME_YES', 'BICA_LANES'] as const;

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
  it('keeps the historical behaviour: default workspace, prompts on', () => {
    writeSpec();
    const c = resolveBicaPluginConfig(repoRoot);
    expect(c.runLane).toBe(NO_LANE);
    expect(c.runAssumeYes).toBe(false);
  });
});

describe('run defaults — bica.yml', () => {
  it('reads run.lane and run.assumeYes', () => {
    writeSpec('run:\n  lane: auto\n  assumeYes: true\n');
    const c = resolveBicaPluginConfig(repoRoot);
    expect(c.runLane).toBe('auto');
    expect(c.runAssumeYes).toBe(true);
  });

  it('accepts a named lane', () => {
    writeSpec('run:\n  lane: verify\n');
    expect(resolveBicaPluginConfig(repoRoot).runLane).toBe('verify');
  });

  it('treats `lane: false` as the default workspace', () => {
    // `false` is what a YAML author naturally writes for "no lane".
    writeSpec('run:\n  lane: false\n');
    expect(resolveBicaPluginConfig(repoRoot).runLane).toBe(NO_LANE);
  });

  it('rejects a non-boolean assumeYes rather than coercing it', () => {
    writeSpec('run:\n  assumeYes: "yes"\n');
    expect(() => resolveBicaPluginConfig(repoRoot)).toThrow(
      /run.assumeYes must be a boolean/,
    );
  });

  it('rejects an empty lane', () => {
    writeSpec('run:\n  lane: ""\n');
    expect(() => resolveBicaPluginConfig(repoRoot)).toThrow(/run.lane must be/);
  });

  it('rejects a non-object run block', () => {
    writeSpec('run: auto\n');
    expect(() => resolveBicaPluginConfig(repoRoot)).toThrow(
      /run: must be an object/,
    );
  });
});

describe('run defaults — env overrides YAML', () => {
  it('BICA_LANE replaces run.lane', () => {
    writeSpec('run:\n  lane: auto\n');
    process.env.BICA_LANE = '3';
    expect(resolveBicaPluginConfig(repoRoot).runLane).toBe('3');
  });

  it('BICA_LANE=none opts a lane-by-default repo back out', () => {
    writeSpec('run:\n  lane: auto\n');
    process.env.BICA_LANE = NO_LANE;
    expect(resolveBicaPluginConfig(repoRoot).runLane).toBe(NO_LANE);
  });

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
