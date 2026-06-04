import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveBicaPluginConfig } from './bicaWorkspaceConfig';

const ENV_PLUGIN_MODE = 'BICA_PLUGIN_MODE';
const ENV_PM = 'BICA_PACKAGE_MANAGER_PLUGINS';
const ENV_CRED = 'BICA_CREDENTIALS_PLUGINS';
const ENV_REMOTE_SHELL = 'BICA_REMOTE_SHELL_PLUGINS';
const ENV_GIT_SYNC = 'BICA_GIT_SYNC';

function writeWorkspace(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, 'bica-workspace.yml'), content, 'utf8');
}

const MIN_SYNC = `
sync:
  t:
    alpha: "."
    beta: "host:path"
`;

describe('resolveBicaPluginConfig', () => {
  let dir: string;
  let prevPluginMode: string | undefined;
  let prevPm: string | undefined;
  let prevCred: string | undefined;
  let prevRemoteShell: string | undefined;
  let prevGitSync: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-ws-'));
    prevPluginMode = process.env[ENV_PLUGIN_MODE];
    prevPm = process.env[ENV_PM];
    prevCred = process.env[ENV_CRED];
    prevRemoteShell = process.env[ENV_REMOTE_SHELL];
    prevGitSync = process.env[ENV_GIT_SYNC];
    Reflect.deleteProperty(process.env, ENV_PLUGIN_MODE);
    Reflect.deleteProperty(process.env, ENV_PM);
    Reflect.deleteProperty(process.env, ENV_CRED);
    Reflect.deleteProperty(process.env, ENV_REMOTE_SHELL);
    Reflect.deleteProperty(process.env, ENV_GIT_SYNC);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, prev] of [
      [ENV_PLUGIN_MODE, prevPluginMode],
      [ENV_PM, prevPm],
      [ENV_CRED, prevCred],
      [ENV_REMOTE_SHELL, prevRemoteShell],
      [ENV_GIT_SYNC, prevGitSync],
    ] as const) {
      if (prev === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = prev;
      }
    }
  });

  it('defaults to auto when bica section omitted', () => {
    writeWorkspace(dir, MIN_SYNC);
    const r = resolveBicaPluginConfig(dir);
    expect(r.pluginMode).toBe('auto');
    expect(r.packageManagerPluginIds).toBeUndefined();
    expect(r.credentialsPluginIds).toBeUndefined();
    expect(r.remoteShellPluginIds).toBeUndefined();
    expect(r.syncGit).toBe(false);
  });

  it('reads git.sync from YAML', () => {
    writeWorkspace(dir, `${MIN_SYNC}\ngit:\n  sync: true\n`);
    expect(resolveBicaPluginConfig(dir).syncGit).toBe(true);
  });

  it('env BICA_GIT_SYNC overrides YAML git.sync', () => {
    writeWorkspace(dir, `${MIN_SYNC}\ngit:\n  sync: true\n`);
    process.env[ENV_GIT_SYNC] = '0';
    expect(resolveBicaPluginConfig(dir).syncGit).toBe(false);
    process.env[ENV_GIT_SYNC] = '1';
    expect(resolveBicaPluginConfig(dir).syncGit).toBe(true);
  });

  it('reads bica.pluginMode and plugin lists from YAML', () => {
    writeWorkspace(
      dir,
      `${MIN_SYNC}
bica:
  pluginMode: explicit
  packageManagerPlugins:
    - pnpm
  credentialsPlugins:
    - npmrc
  remoteShellPlugins:
    - mise
`,
    );
    const r = resolveBicaPluginConfig(dir);
    expect(r.pluginMode).toBe('explicit');
    expect(r.packageManagerPluginIds).toEqual(['pnpm']);
    expect(r.credentialsPluginIds).toEqual(['npmrc']);
    expect(r.remoteShellPluginIds).toEqual(['mise']);
  });

  it('replaces YAML with env when env lists are set', () => {
    writeWorkspace(
      dir,
      `${MIN_SYNC}
bica:
  packageManagerPlugins:
    - pnpm
  credentialsPlugins:
    - npmrc
`,
    );
    process.env[ENV_PM] = '';
    process.env[ENV_CRED] = 'npmrc';
    process.env[ENV_REMOTE_SHELL] = 'mise';
    const r = resolveBicaPluginConfig(dir);
    expect(r.packageManagerPluginIds).toEqual([]);
    expect(r.credentialsPluginIds).toEqual(['npmrc']);
    expect(r.remoteShellPluginIds).toEqual(['mise']);
  });
});
