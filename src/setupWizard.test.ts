import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureBicaIsGitignored } from './lib/gitignore';
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

describe('init makes .bica private to the person who ran it', () => {
  const temp = (): string =>
    fs.mkdtempSync(path.join(os.tmpdir(), 'bica-gitignore-'));

  it('adds the rule when .gitignore does not mention it', () => {
    const dir = temp();
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
      expect(ensureBicaIsGitignored(dir)).toBe('added');
      const after = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      expect(after).toContain('node_modules');
      expect(after).toMatch(/^\.bica\/$/m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates .gitignore when the repository has none', () => {
    const dir = temp();
    try {
      expect(ensureBicaIsGitignored(dir)).toBe('added');
      expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toMatch(
        /^\.bica\/$/m,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['.bica', '.bica/', '/.bica/'])(
    'leaves an existing %s rule alone',
    (rule) => {
      const dir = temp();
      try {
        fs.writeFileSync(path.join(dir, '.gitignore'), `${rule}\n`);
        expect(ensureBicaIsGitignored(dir)).toBe('present');
        expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(
          `${rule}\n`,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('does not lose a trailing line that had no newline', () => {
    const dir = temp();
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'dist');
      ensureBicaIsGitignored(dir);
      const after = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      expect(after).toMatch(/^dist$/m);
      expect(after).toMatch(/^\.bica\/$/m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
