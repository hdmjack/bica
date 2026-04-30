import * as readline from 'node:readline/promises';
import prompts from 'prompts';

import {
  readLocalBicaSettings,
  writeLocalBicaSettings,
} from '../localBicaSettings';
import {
  collectHostAliasesFromSshConfigFile,
  DEFAULT_USER_SSH_CONFIG_PATH,
  resolveUnambiguousSshHostFromUserConfig,
} from '../sshConfig';
import { getGitRepoRoot } from '../syncProject';

/**
 * Prompts on TTY; if stdin/stdout is not a TTY, returns defaultYes (for CI / piping).
 *
 * Uses [terkelg/prompts](https://github.com/terkelg/prompts) `confirm` so the default
 * (Y or N) is pre-highlighted — matches `bica init` UX.
 */
export async function confirm(
  message: string,
  defaultYes: boolean,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return defaultYes;
  }

  const result = await prompts(
    {
      type: 'confirm',
      name: 'value',
      message,
      initial: defaultYes,
    },
    {
      onCancel: () => {
        process.stdout.write('\n');
        process.exit(1);
      },
    },
  );

  return Boolean(result.value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export { sleep };

const REMOTE_HOST_ENV = 'BICA_SSH_HOST';

function saveHost(host: string): void {
  try {
    const root = getGitRepoRoot();
    const existing = readLocalBicaSettings(root);
    writeLocalBicaSettings(root, { ...existing, sshHost: host });
  } catch {
    // Best-effort; not critical if it fails.
  }
}

/**
 * Prompts the user to choose from a numbered list of SSH host aliases.
 * Returns the chosen host and saves it for future runs.
 */
async function promptHostChoice(hosts: string[]): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    process.stdout.write('Multiple SSH hosts found in ~/.ssh/config:\n');
    hosts.forEach((h, i) => process.stdout.write(`  ${i + 1}) ${h}\n`));

    const answer = await rl.question(`Choose a host [1–${hosts.length}]: `);
    const index = Number.parseInt(answer.trim(), 10) - 1;

    if (Number.isNaN(index) || index < 0 || index >= hosts.length) {
      throw new Error(
        `Invalid choice "${answer.trim()}". Enter a number between 1 and ${hosts.length}.`,
      );
    }

    const host = hosts[index];
    saveHost(host);
    process.stdout.write(
      `Using "${host}". Saved this choice for future runs.\n`,
    );
    return host;
  } finally {
    rl.close();
  }
}

function sshHostAlreadyResolved(): boolean {
  return Boolean(process.env[REMOTE_HOST_ENV]?.trim());
}

/**
 * Ensures BICA_SSH_HOST is set.
 *
 * Resolution order:
 *   1. BICA_SSH_HOST env var
 *   2. sshHost in .bica/local.yml (from bica init or saveHost)
 *   3. Single Host alias auto-detected from ~/.ssh/config
 *   4. Numbered prompt when multiple hosts exist (TTY only — saves the choice)
 *   5. Free-text prompt for manual entry (TTY only)
 *   6. Error with actionable hints (non-TTY)
 */
export async function ensureRemoteSshHostFromEnvOrPrompt(): Promise<void> {
  if (sshHostAlreadyResolved()) {
    return;
  }

  try {
    const root = getGitRepoRoot();
    const fromLocal = readLocalBicaSettings(root).sshHost?.trim();
    if (fromLocal !== undefined && fromLocal.length > 0) {
      process.env[REMOTE_HOST_ENV] = fromLocal;
      return;
    }
  } catch {
    // Not a git repo — fall through to ~/.ssh/config and prompts
  }

  const fromSshConfig = resolveUnambiguousSshHostFromUserConfig();
  if (fromSshConfig) {
    process.env[REMOTE_HOST_ENV] = fromSshConfig;
    return;
  }

  const found = collectHostAliasesFromSshConfigFile(
    DEFAULT_USER_SSH_CONFIG_PATH,
  );

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    let hostHint = '';
    if (found.length > 1) {
      hostHint =
        `Multiple Host entries found in ~/.ssh/config: ${found.join(', ')}.\n` +
        `Pick one and set it explicitly:\n  export ${REMOTE_HOST_ENV}=${found[0]}\n`;
    } else if (found.length === 0) {
      hostHint =
        'No Host entries found in ~/.ssh/config.\n' +
        'Add a Host block for your remote machine, or set the env var directly.\n';
    }
    throw new Error(
      `${REMOTE_HOST_ENV} is not set and could not be inferred from ~/.ssh/config.\n\n` +
        hostHint +
        '\nSet the host explicitly:\n' +
        `  export ${REMOTE_HOST_ENV}=<host>\n\n` +
        'Optional — remote directory (defaults to ~/code/<this repo folder>):\n' +
        '  export BICA_REMOTE_PATH=~/code/my-repo\n\n' +
        'Tip: set up key-based auth once so commands run without a password prompt:\n' +
        '  ssh-copy-id <host>',
    );
  }

  if (found.length > 1) {
    const host = await promptHostChoice(found);
    process.env[REMOTE_HOST_ENV] = host;
    return;
  }

  // Zero hosts in ssh config — fall back to free-text prompt.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const line = await rl.question(
      'Remote SSH host (alias from ~/.ssh/config or user@host): ',
    );
    const host = line.trim();
    if (!host) {
      throw new Error(
        `${REMOTE_HOST_ENV} is required. Set it or enter a host when prompted.`,
      );
    }
    saveHost(host);
    process.env[REMOTE_HOST_ENV] = host;
  } finally {
    rl.close();
  }
}
