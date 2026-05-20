/* eslint-disable no-console -- interactive setup */
import * as fs from 'node:fs';
import * as path from 'node:path';
import prompts from 'prompts';

import { writeLocalBicaSettings } from './localBicaSettings';
import {
  collectHostAliasesFromSshConfigFile,
  DEFAULT_USER_SSH_CONFIG_PATH,
  resolveUnambiguousSshHostFromUserConfig,
} from './sshConfig';
import {
  BICA_SPEC_FILE,
  findBicaSpecPath,
  getGitRepoRoot,
} from './syncProject';
import { bold, dim, heading, ok, warn } from './terminalStyle';

/** [terkelg/prompts](https://github.com/terkelg/prompts) — lightweight TTY prompts; `initial` pre-fills the text field so users can edit the default. */
const PROMPT_OPTS: prompts.Options = {
  onCancel: () => {
    process.stdout.write('\n');
    process.exit(1);
  },
};

const DEFAULT_BICA_YML = `sync:
  mode: one-way-replica
  ignore:
    paths:
      - node_modules
      - .git
      # Build outputs (TS composite .d.ts, etc.): syncing dist from local can make
      # remote typecheck against stale declarations while src is up to date.
      - dist

# returnFlow: rsync these patterns from remote→local after \`bica run\`. Default values cover
# Jest/Vitest snapshots so tests run on the remote update the local repo. Set paths: [] to disable,
# or list additional gitignore-style globs (e.g. "**/*.png" for visual snapshots).
# returnFlow:
#   paths:
#     - "**/__snapshots__/**"
#     - "**/*.snap"

bica:
  pluginMode: auto
`;

const OTHER_HOST = '__bica_other__';
const SKIP_HOST = '__bica_skip__';

/** Plain-text prompt (avoid ANSI inside `prompts` for widest terminal support). */
const SSH_HOST_TEXT_MESSAGE =
  'SSH target (Host alias from ~/.ssh/config or user@hostname; saved to .bica/local.yml)';

/**
 * Interactive first-time setup: writes bica.yml and .bica/local.yml (gitignored SSH/path).
 */
export async function runSetupWizard(repoRoot: string): Promise<void> {
  if (findBicaSpecPath(repoRoot)) {
    console.log(
      warn(
        `${BICA_SPEC_FILE} (or legacy bica-workspace.yml) already exists — nothing to do.`,
      ),
    );
    return;
  }

  console.log();
  console.log(heading('Bica — workspace setup'));
  console.log(dim('Remote sync, SSH, and argv-safe `bica run` commands.'));
  console.log();

  const createSpec = await prompts(
    {
      type: 'confirm',
      name: 'yes',
      message: `Create ${BICA_SPEC_FILE} with default sync (one-way-replica, ignore node_modules/.git/dist)?`,
      initial: true,
    },
    PROMPT_OPTS,
  );

  if (!createSpec.yes) {
    console.log(
      warn(
        `Skipped. Create ${BICA_SPEC_FILE} manually, then re-run your command.`,
      ),
    );
    return;
  }

  const specPath = path.join(repoRoot, BICA_SPEC_FILE);
  fs.writeFileSync(specPath, DEFAULT_BICA_YML, 'utf8');
  console.log(
    ok(`Wrote ${path.relative(process.cwd(), specPath) || BICA_SPEC_FILE}`),
  );

  const hosts = collectHostAliasesFromSshConfigFile(
    DEFAULT_USER_SSH_CONFIG_PATH,
  );

  let sshInitial =
    process.env.BICA_SSH_HOST?.trim() ??
    resolveUnambiguousSshHostFromUserConfig() ??
    '';

  if (sshInitial === '' && hosts.length === 0) {
    console.log(
      dim(
        'No Host aliases found in ~/.ssh/config — enter user@hostname or an alias below.',
      ),
    );
  }

  if (sshInitial === '' && hosts.length > 1) {
    const picked = await prompts(
      {
        type: 'select',
        name: 'host',
        message:
          'Pick one SSH Host entry (from ~/.ssh/config) or choose manual entry',
        choices: [
          ...hosts.map((h) => ({ title: h, value: h })),
          {
            title: 'Different host — type in the next step',
            value: OTHER_HOST,
          },
          { title: 'Skip for now', value: SKIP_HOST },
        ],
        initial: 0,
      },
      PROMPT_OPTS,
    );

    if (picked.host === SKIP_HOST) {
      sshInitial = '';
    } else if (picked.host === OTHER_HOST) {
      sshInitial = '';
    } else if (typeof picked.host === 'string') {
      sshInitial = picked.host;
    }
  } else if (sshInitial === '' && hosts.length === 1) {
    sshInitial = hosts[0];
  }

  const sshAnswer = await prompts(
    {
      type: 'text',
      name: 'sshHost',
      message: SSH_HOST_TEXT_MESSAGE,
      initial: sshInitial,
    },
    PROMPT_OPTS,
  );

  const sshHost = (sshAnswer.sshHost ?? '').trim();

  const repoBasename = path.basename(repoRoot);
  const defaultRemote = `~/code/${repoBasename}`;

  const pathAnswer = await prompts(
    {
      type: 'text',
      name: 'remotePath',
      message: 'Remote workspace path (directory on the SSH host)',
      initial: defaultRemote,
    },
    PROMPT_OPTS,
  );

  const remotePathRaw = (pathAnswer.remotePath ?? '').trim();
  const remotePath = remotePathRaw.length > 0 ? remotePathRaw : defaultRemote;

  if (sshHost !== '') {
    writeLocalBicaSettings(repoRoot, { sshHost, remotePath });
    process.env.BICA_SSH_HOST = sshHost;
    process.env.BICA_REMOTE_PATH = remotePath;
    console.log(
      ok('Wrote .bica/local.yml (gitignored) with sshHost and remotePath.'),
    );
  } else {
    console.log(
      dim(
        'No SSH host saved. Set BICA_SSH_HOST or run `bica init` again from a TTY.',
      ),
    );
  }

  console.log();
  console.log(
    `${bold('Next:')} ${dim('bica prepare')}   then   ${dim('bica run pnpm install')}   then   ${dim('bica run pnpm test')}`,
  );
  console.log();
}

/**
 * If the repo has no Bica spec, run the wizard on TTY; otherwise throw with a clear message.
 */
export async function ensureBicaWorkspaceOrInteractiveSetup(
  subcommand: string,
): Promise<void> {
  let root: string;
  try {
    root = getGitRepoRoot();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${msg}\n(\`${subcommand}\` needs a Git checkout.)`);
  }

  if (findBicaSpecPath(root)) {
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `No Bica workspace file found. Create ${BICA_SPEC_FILE} at the repo root (or run \`bica init\` from a TTY).`,
    );
  }

  console.error(
    warn(`[bica] No ${BICA_SPEC_FILE} at ${root}. Starting interactive setup…`),
  );
  console.error();
  await runSetupWizard(root);
  if (!findBicaSpecPath(root)) {
    throw new Error(
      `Setup incomplete — add ${BICA_SPEC_FILE} or run \`bica init\`.`,
    );
  }
}

export async function cmdInit(): Promise<void> {
  const root = getGitRepoRoot();
  await runSetupWizard(root);
}
