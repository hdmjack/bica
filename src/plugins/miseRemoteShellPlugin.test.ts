import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { miseRemoteShellPlugin } from './miseRemoteShellPlugin';

describe('miseRemoteShellPlugin', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not autoDiscover without mise spec files', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-mise-'));
    const ctx = { repoRoot: dir };
    expect(miseRemoteShellPlugin.autoDiscover(ctx)).toBe(false);
    expect(miseRemoteShellPlugin.explainAutoDiscover(ctx).applicable).toBe(
      false,
    );
  });

  it('autoDiscovers when .tool-versions exists', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-mise-'));
    fs.writeFileSync(path.join(dir, '.tool-versions'), 'node 22\n', 'utf8');
    const ctx = { repoRoot: dir };
    expect(miseRemoteShellPlugin.autoDiscover(ctx)).toBe(true);
  });

  it('remoteShellPreamble includes shims and quarantine cleanup', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-mise-'));
    const p = miseRemoteShellPlugin.remoteShellPreamble({ repoRoot: dir });
    expect(p).toContain('mise/shims');
    expect(p).toContain('com.apple.quarantine');
  });
});
