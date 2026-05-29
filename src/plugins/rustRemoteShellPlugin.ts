import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AutoDiscoverContext, RemoteShellPlugin } from './types';

const RUST_SPEC_FILES = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'] as const;

function shBlock(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

function explainRustDiscovery(ctx: AutoDiscoverContext): {
  applicable: boolean;
  summary: string;
} {
  const found = RUST_SPEC_FILES.filter((name) =>
    fs.existsSync(path.join(ctx.repoRoot, name)),
  );
  if (found.length > 0) {
    return {
      applicable: true,
      summary: `Found ${found.join(', ')} — remote run will put cargo/rustup on PATH (rustup honors rust-toolchain.toml)`,
    };
  }
  return {
    applicable: false,
    summary: `No ${RUST_SPEC_FILES.join(', ')} in repo — rust remote bootstrap is skipped`,
  };
}

/**
 * Puts cargo/rustup on PATH for non-interactive `bica run` SSH sessions. rustup reads the repo's
 * rust-toolchain.toml and auto-installs the pinned toolchain on first build.
 */
export const rustRemoteShellPlugin: RemoteShellPlugin = {
  kind: 'remoteShell',
  id: 'rust',
  autoDiscover(ctx: AutoDiscoverContext): boolean {
    return explainRustDiscovery(ctx).applicable;
  },
  explainAutoDiscover(ctx: AutoDiscoverContext) {
    return explainRustDiscovery(ctx);
  },
  remoteShellPreamble(_ctx: AutoDiscoverContext): string {
    return shBlock(
      // Source cargo env if present; tolerate its absence without a bracket test (zsh -lc parses
      // a bare `[ ... ]` here as a glob/parse error).
      '. "$HOME/.cargo/env" 2>/dev/null || true',
      'export PATH="$HOME/.cargo/bin:$PATH"',
    );
  },
};
