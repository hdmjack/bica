import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const DEFAULT_USER_SSH_CONFIG_PATH = path.join(
  os.homedir(),
  '.ssh',
  'config',
);

function isWildcardHostPattern(name: string): boolean {
  return name.includes('*') || name.includes('?');
}

/**
 * Collects `Host` aliases from a single OpenSSH config file (no `Include` expansion).
 * Skips wildcard-only patterns (e.g. `Host *`).
 */
export function collectHostAliasesFromSshConfigFile(
  filePath: string,
): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const found = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const match = /^\s*Host\s+(.*)$/i.exec(line);
    if (!match) {
      continue;
    }

    const tokens = match[1].trim().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      if (!isWildcardHostPattern(token)) {
        found.add(token);
      }
    }
  }

  return [...found].sort();
}

/**
 * When ~/.ssh/config defines exactly one concrete `Host` alias, returns it.
 * Otherwise returns null (zero or multiple aliases — ambiguous).
 */
export function resolveUnambiguousSshHostFromUserConfig(
  configPath: string = DEFAULT_USER_SSH_CONFIG_PATH,
): string | null {
  const aliases = collectHostAliasesFromSshConfigFile(configPath);
  if (aliases.length === 1) {
    return aliases[0];
  }
  return null;
}
