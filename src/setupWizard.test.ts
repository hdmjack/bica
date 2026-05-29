import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { scaffoldForRepo } from './setupWizard';

describe('scaffoldForRepo', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('emits the node scaffold when no Cargo manifest is present', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-wiz-'));
    const scaffold = scaffoldForRepo(dir);
    expect(scaffold.kind).toBe('node');
    expect(scaffold.yaml).toContain('node_modules');
    expect(scaffold.yaml).toContain('- dist');
  });

  it('emits the rust scaffold ignoring target when Cargo.toml exists', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-wiz-'));
    fs.writeFileSync(
      path.join(dir, 'Cargo.toml'),
      '[package]\nname = "myapp"\n',
      'utf8',
    );
    const scaffold = scaffoldForRepo(dir);
    expect(scaffold.kind).toBe('rust');
    expect(scaffold.yaml).toContain('- target');
    expect(scaffold.yaml).toContain('target/debug/myapp');
    expect(scaffold.yaml).toContain('target/debug/*.dylib');
  });

  it('falls back to the repo basename when Cargo.toml has no package name', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zedlike-'));
    // virtual workspace root: no [package] section
    fs.writeFileSync(
      path.join(dir, 'Cargo.toml'),
      '[workspace]\nmembers = ["crates/*"]\n',
      'utf8',
    );
    const scaffold = scaffoldForRepo(dir);
    expect(scaffold.kind).toBe('rust');
    expect(scaffold.yaml).toContain(`target/debug/${path.basename(dir)}`);
  });
});
