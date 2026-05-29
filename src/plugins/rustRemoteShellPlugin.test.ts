import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { rustRemoteShellPlugin as plugin } from './rustRemoteShellPlugin';

describe('rustRemoteShellPlugin', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not autoDiscover without rust spec files', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-rust-'));
    const ctx = { repoRoot: dir };
    expect(plugin.autoDiscover(ctx)).toBe(false);
    expect(plugin.explainAutoDiscover(ctx).applicable).toBe(false);
  });

  it.each(['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'])(
    'autoDiscovers when %s exists',
    (name) => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-rust-'));
      fs.writeFileSync(path.join(dir, name), '\n', 'utf8');
      expect(plugin.autoDiscover({ repoRoot: dir })).toBe(true);
    },
  );

  it('remoteShellPreamble puts cargo on PATH and sources cargo env', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-rust-'));
    const p = plugin.remoteShellPreamble({ repoRoot: dir });
    expect(p).toContain('.cargo/env');
    expect(p).toContain('$HOME/.cargo/bin:$PATH');
  });
});
