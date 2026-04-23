import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AutoDiscoverContext, CredentialsPlugin } from './types';

const LOCAL_NPMRC = path.join(os.homedir(), '.npmrc');
const REMOTE_NPMRC = '~/.npmrc';

function evaluateNpmrcDiscovery(_ctx: AutoDiscoverContext): {
  applicable: boolean;
  summary: string;
} {
  if (fs.existsSync(LOCAL_NPMRC)) {
    return {
      applicable: true,
      summary: `Local npmrc exists (${LOCAL_NPMRC})`,
    };
  }
  return {
    applicable: false,
    summary: `No local npmrc (${LOCAL_NPMRC})`,
  };
}

export const npmrcCredentialsPlugin: CredentialsPlugin = {
  kind: 'credentials',
  id: 'npmrc',
  autoDiscover(ctx: AutoDiscoverContext): boolean {
    return evaluateNpmrcDiscovery(ctx).applicable;
  },
  explainAutoDiscover(ctx: AutoDiscoverContext): {
    applicable: boolean;
    summary: string;
  } {
    return evaluateNpmrcDiscovery(ctx);
  },
  async sync(ctx): Promise<void> {
    if (!fs.existsSync(LOCAL_NPMRC)) {
      throw new Error(
        `No ~/.npmrc found locally (expected at ${LOCAL_NPMRC}).`,
      );
    }

    const lines = fs.readFileSync(LOCAL_NPMRC, 'utf8').trimEnd().split('\n');
    const redacted = lines
      .map((l) =>
        l.includes('_authToken=') ? l.replace(/=.*/, '=<redacted>') : l,
      )
      .join('\n');

    console.log(`\nLocal ~/.npmrc to copy:\n\n${redacted}\n`);

    const ok = await ctx.confirm(
      `Copy ~/.npmrc to ${ctx.sshHost}:${REMOTE_NPMRC}?`,
      false,
    );
    if (!ok) {
      console.log('Skipped.');
      return;
    }

    const result = spawnSync(
      'scp',
      [LOCAL_NPMRC, `${ctx.sshHost}:${REMOTE_NPMRC}`],
      {
        stdio: 'inherit',
        shell: false,
      },
    );

    if (result.status !== 0) {
      throw new Error(`scp failed with exit code ${result.status ?? '?'}`);
    }

    console.log(`Copied ~/.npmrc to ${ctx.sshHost}:${REMOTE_NPMRC}`);
  },
};
