import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveBicaPluginConfig } from './bicaWorkspaceConfig';
import { miseRemoteShellPlugin } from './plugins/miseRemoteShellPlugin';
import { npmrcCredentialsPlugin } from './plugins/npmrcCredentialsPlugin';
import {
  pickCredentialsPluginsForSync,
  resolveActiveRemoteShellPlugins,
} from './resolveActivePlugins';

describe('pickCredentialsPluginsForSync', () => {
  it('returns all active plugins when no ids requested', () => {
    const active = [npmrcCredentialsPlugin];
    expect(pickCredentialsPluginsForSync(active, [])).toEqual([
      npmrcCredentialsPlugin,
    ]);
  });

  it('returns requested plugins in order when they are active', () => {
    const active = [npmrcCredentialsPlugin];
    expect(pickCredentialsPluginsForSync(active, ['npmrc'])).toEqual([
      npmrcCredentialsPlugin,
    ]);
  });

  it('throws for unknown id', () => {
    expect(() =>
      pickCredentialsPluginsForSync([npmrcCredentialsPlugin], ['nope']),
    ).toThrow(/Unknown credentials plugin/);
  });

  it('throws when id is not active', () => {
    expect(() => pickCredentialsPluginsForSync([], ['npmrc'])).toThrow(
      /not active for this workspace/,
    );
  });
});

const MIN_SYNC = `sync:
  t:
    alpha: "."
    beta: "host:path"
`;

describe('resolveActiveRemoteShellPlugins', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('returns mise when auto mode and mise spec exists', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-rs-'));
    fs.writeFileSync(
      path.join(dir, 'bica-workspace.yml'),
      `${MIN_SYNC}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(dir, 'mise.toml'), '[tools]\n', 'utf8');
    const resolved = resolveBicaPluginConfig(dir);
    const active = resolveActiveRemoteShellPlugins(dir, resolved);
    expect(active.map((p) => p.id)).toEqual(['mise']);
  });

  it('returns empty when auto mode and no mise spec', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-rs-'));
    fs.writeFileSync(path.join(dir, 'bica-workspace.yml'), MIN_SYNC, 'utf8');
    const resolved = resolveBicaPluginConfig(dir);
    expect(resolveActiveRemoteShellPlugins(dir, resolved)).toEqual([]);
  });

  it('explicit mode with undefined list yields no remote shell plugins', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-rs-'));
    fs.writeFileSync(
      path.join(dir, 'bica-workspace.yml'),
      `${MIN_SYNC}bica:\n  pluginMode: explicit\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, '.mise.toml'),
      'min_version = "2024.1.1"\n',
      'utf8',
    );
    const resolved = resolveBicaPluginConfig(dir);
    expect(resolveActiveRemoteShellPlugins(dir, resolved)).toEqual([]);
  });

  it('explicit mode with mise id includes plugin when spec exists', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-rs-'));
    fs.writeFileSync(
      path.join(dir, 'bica-workspace.yml'),
      `${MIN_SYNC}bica:\n  pluginMode: explicit\n  remoteShellPlugins:\n    - mise\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(dir, '.tool-versions'), 'node 22\n', 'utf8');
    const resolved = resolveBicaPluginConfig(dir);
    expect(resolveActiveRemoteShellPlugins(dir, resolved)).toEqual([
      miseRemoteShellPlugin,
    ]);
  });
});
