import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AutoDiscoverContext, RemoteShellPlugin } from './types';

const MISE_SPEC_FILES = ['mise.toml', '.mise.toml', '.tool-versions'] as const;

function shBlock(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

function hasMiseSpecInRepo(repoRoot: string): boolean {
  for (const name of MISE_SPEC_FILES) {
    if (fs.existsSync(path.join(repoRoot, name))) {
      return true;
    }
  }
  return false;
}

function explainMiseDiscovery(ctx: AutoDiscoverContext): {
  applicable: boolean;
  summary: string;
} {
  const found = MISE_SPEC_FILES.filter((name) =>
    fs.existsSync(path.join(ctx.repoRoot, name)),
  );
  if (found.length > 0) {
    return {
      applicable: true,
      summary: `Found ${found.join(', ')} — remote run will prepend mise shims and clear macOS quarantine on mise installs`,
    };
  }
  return {
    applicable: false,
    summary: `No ${MISE_SPEC_FILES.join(', ')} in repo — mise remote bootstrap is skipped (generic PATH + mise install globs still run)`,
  };
}

/**
 * When active: same remote PATH / glob / xattr sequence bica historically inlined in runRemote.
 */
export const miseRemoteShellPlugin: RemoteShellPlugin = {
  kind: 'remoteShell',
  id: 'mise',
  autoDiscover(ctx: AutoDiscoverContext): boolean {
    return hasMiseSpecInRepo(ctx.repoRoot);
  },
  explainAutoDiscover(ctx: AutoDiscoverContext) {
    return explainMiseDiscovery(ctx);
  },
  remoteShellPreamble(_ctx: AutoDiscoverContext): string {
    const pathBoost = shBlock(
      'export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/share/pnpm:$PATH"',
    );
    const misePaths = shBlock(
      'for _d in "$HOME/.local/share/mise/installs/pnpm"/*/; do [ -d "$_d" ] && PATH="${_d%/}:$PATH"; done',
      'for _d in "$HOME/.local/share/mise/installs/node"/*/bin; do [ -d "$_d" ] && PATH="$_d:$PATH"; done',
      'export PATH="$PATH"',
    );
    const removeQuarantine = shBlock(
      'xattr -dr com.apple.quarantine "$HOME/.local/share/mise/installs" 2>/dev/null || true',
    );
    return `${pathBoost}${misePaths}${removeQuarantine}`;
  },
};
