/**
 * Check everything bica needs, and say what to do about whatever is missing.
 *
 * The audience is somebody who has just installed bica and has not read anything. For them, every
 * prerequisite is invisible until it fails, and it fails in the middle of something else: a missing
 * Mutagen surfaces as a sync that never starts, a remote without `pnpm` as a command not found three
 * minutes into a run, an ssh key that was never copied as a refusal to start. Each is a minute's work
 * to fix and an afternoon to identify, which is the wrong way round.
 *
 * Every check is independent and none of them stops the others. A first run on a new machine usually
 * has more than one thing wrong with it, and finding them one at a time -- fix, re-run, wait, fix --
 * is most of why setting a tool up feels long.
 */

export type CheckStatus = 'ok' | 'problem' | 'warning' | 'skipped';

export interface CheckResult {
  /** What was checked, phrased as the thing the user has rather than the act of looking. */
  name: string;
  status: CheckStatus;
  /** What was found. One line, concrete: a version, a path, an error. */
  detail: string;
  /** What to do about it. Only for a problem or a warning, and only if it is actionable. */
  fix?: string;
}

/** Everything the doctor needs from the outside world, so the checks themselves stay testable. */
export interface DoctorProbes {
  /** Runs a local command, resolving to its status and output. */
  localCommand: (
    command: string,
    args: string[],
  ) => { ok: boolean; stdout: string; stderr: string };
  /** Runs a script on the remote under `sh`. */
  remoteScript: (script: string) => {
    status: number;
    stdout: string;
    stderr: string;
  };
  nodeVersion: string;
  platform: string;
  /** Resolved configuration, or the reason there is none. */
  config:
    | { ok: true; sshHost: string; remoteWorkspacePath: string }
    | { ok: false; reason: string };
  /** Whether this repository ignores bica's local state directory. */
  bicaIsGitignored: boolean | undefined;
  /** The login shell bica will ask the remote for. */
  loginShell: string;
  /**
   * The PATH preamble bica puts in front of every remote command.
   *
   * Included so this asks the same question a run does. Without it the check reports node and pnpm
   * missing on a remote where every run finds them, because a version manager's shims are put on
   * PATH by this preamble rather than by the remote's own login files.
   */
  toolingPreamble: string;
}

const MUTAGEN_INSTALL_HINT =
  'macOS: brew install mutagen-io/mutagen/mutagen — Linux: the release binaries at https://mutagen.io/documentation/introduction/installation';

function checkNode(probes: DoctorProbes): CheckResult {
  const major = Number(/^v?(\d+)/.exec(probes.nodeVersion)?.[1] ?? '0');
  if (major >= 22) {
    return { name: 'Node', status: 'ok', detail: probes.nodeVersion };
  }
  return {
    name: 'Node',
    status: 'problem',
    detail: `${probes.nodeVersion}, and bica needs 22 or newer`,
    fix: 'Install Node 22+ (mise, nvm, or your package manager) and run bica from that shell.',
  };
}

function checkLocalTool(
  probes: DoctorProbes,
  options: { name: string; command: string; args: string[]; fix: string; required: boolean },
): CheckResult {
  const result = probes.localCommand(options.command, options.args);
  if (result.ok) {
    const firstLine = (result.stdout || result.stderr).split('\n')[0]?.trim();
    return {
      name: options.name,
      status: 'ok',
      detail: firstLine === undefined || firstLine === '' ? 'installed' : firstLine,
    };
  }
  return {
    name: options.name,
    status: options.required ? 'problem' : 'warning',
    detail: 'not found on PATH',
    fix: options.fix,
  };
}

function checkConfig(probes: DoctorProbes): CheckResult {
  if (!probes.config.ok) {
    return {
      name: 'Configuration',
      status: 'problem',
      detail: probes.config.reason,
      fix: 'Run `bica init` at the root of the repository you want to run commands for.',
    };
  }
  return {
    name: 'Configuration',
    status: 'ok',
    detail: `${probes.config.sshHost}:${probes.config.remoteWorkspacePath}`,
  };
}

function checkGitignore(probes: DoctorProbes): CheckResult {
  if (probes.bicaIsGitignored === undefined) {
    return {
      name: 'Local settings are private',
      status: 'skipped',
      detail: 'no repository here to check',
    };
  }
  if (probes.bicaIsGitignored) {
    return {
      name: 'Local settings are private',
      status: 'ok',
      detail: '.bica/ is gitignored',
    };
  }
  return {
    name: 'Local settings are private',
    status: 'warning',
    detail: '.bica/ is not gitignored, so your ssh host and local paths can be committed',
    fix: 'Add `.bica/` to this repository\'s .gitignore (`bica init` does this for you).',
  };
}

/**
 * The remote checks, which all depend on the first of them.
 *
 * Reported as skipped rather than failed when ssh does not work: a newcomer whose key is not set up
 * should see one problem to fix, not six consequences of it.
 */
function checkRemote(probes: DoctorProbes): CheckResult[] {
  if (!probes.config.ok) {
    return [
      {
        name: 'Remote',
        status: 'skipped',
        detail: 'no ssh host configured yet',
      },
    ];
  }
  const host = probes.config.sshHost;
  const reach = probes.remoteScript('echo BICA_OK\n');
  if (reach.status !== 0 || !reach.stdout.includes('BICA_OK')) {
    const why = reach.stderr.trim().split('\n')[0] ?? `ssh exited ${String(reach.status)}`;
    return [
      {
        name: `ssh ${host}`,
        status: 'problem',
        detail: why,
        fix: `Make \`ssh ${host}\` work from this shell first — a host in ~/.ssh/config, and a key the remote accepts.`,
      },
      {
        name: 'Remote tooling',
        status: 'skipped',
        detail: 'not checked, because the host could not be reached',
      },
    ];
  }

  const results: CheckResult[] = [
    { name: `ssh ${host}`, status: 'ok', detail: 'reachable' },
  ];

  const shell = probes.loginShell;
  const hasShell = probes.remoteScript(
    `command -v ${shell} >/dev/null 2>&1 && echo BICA_OK\n`,
  );
  results.push(
    hasShell.stdout.includes('BICA_OK')
      ? { name: `Remote ${shell}`, status: 'ok', detail: 'present' }
      : {
          name: `Remote ${shell}`,
          status: 'problem',
          detail: `${host} has no ${shell}, which is the shell bica runs commands under`,
          fix: 'Set BICA_LOGIN_SHELL to one it has — bash on most Linux hosts.',
        },
  );

  // Asked through a login shell, because that is where a version manager puts these on PATH, and
  // asking any other way answers a question nobody has.
  const tools = probes.remoteScript(
    `${probes.toolingPreamble}for t in node pnpm rsync git; do command -v "$t" >/dev/null 2>&1 && echo "HAVE $t" || echo "MISS $t"; done\n`,
  );
  const missing = tools.stdout
    .split('\n')
    .filter((line) => line.startsWith('MISS '))
    .map((line) => line.slice('MISS '.length).trim())
    .filter((t) => t.length > 0);
  results.push(
    missing.length === 0
      ? { name: 'Remote tooling', status: 'ok', detail: 'node, pnpm, rsync and git are on PATH' }
      : {
          name: 'Remote tooling',
          status: 'warning',
          detail: `${missing.join(', ')} not on the remote's PATH`,
          fix: `Install them on ${host}, or leave it if your commands do not need them. This is checked with the same PATH setup a run uses.`,
        },
  );

  const ssh = probes.remoteScript('ssh -V 2>&1 | head -1\n');
  const version = /OpenSSH_(\d+)\.(\d+)/.exec(ssh.stdout);
  if (version === null) {
    results.push({
      name: 'Remote OpenSSH (for `bica tunnel`)',
      status: 'skipped',
      detail: 'version could not be read',
    });
  } else {
    const [major, minor] = [Number(version[1]), Number(version[2])];
    const supportsStreamLocal = major > 6 || (major === 6 && minor >= 7);
    results.push({
      name: 'Remote OpenSSH (for `bica tunnel`)',
      status: supportsStreamLocal ? 'ok' : 'warning',
      detail: `OpenSSH ${String(major)}.${String(minor)}`,
      fix: supportsStreamLocal
        ? undefined
        : '`bica tunnel` forwards Unix sockets, which needs OpenSSH 6.7 or newer. Everything else works.',
    });
  }

  return results;
}

/** Run every check. Order is the order a newcomer meets these things. */
export function runChecks(probes: DoctorProbes): CheckResult[] {
  return [
    checkNode(probes),
    checkLocalTool(probes, {
      name: 'ssh',
      command: 'ssh',
      args: ['-V'],
      fix: 'Install OpenSSH.',
      required: true,
    }),
    checkLocalTool(probes, {
      name: 'rsync',
      command: 'rsync',
      args: ['--version'],
      fix: 'Install rsync — bica uses it for pinned runs, --write-back and return-flow.',
      required: true,
    }),
    checkLocalTool(probes, {
      name: 'Mutagen',
      command: 'mutagen',
      args: ['version'],
      fix: `Install Mutagen — ${MUTAGEN_INSTALL_HINT}`,
      required: true,
    }),
    checkConfig(probes),
    checkGitignore(probes),
    ...checkRemote(probes),
  ];
}

/** Whether anything found is bad enough that a run would fail. */
export function hasProblem(results: readonly CheckResult[]): boolean {
  return results.some((r) => r.status === 'problem');
}

/**
 * The report.
 *
 * Every check gets a line whatever its outcome, because "what did it not check?" is a question a
 * newcomer has, and fixes are gathered underneath rather than inline so the list stays scannable.
 */
export function formatReport(
  results: readonly CheckResult[],
  decorate: {
    ok: (s: string) => string;
    bad: (s: string) => string;
    warn: (s: string) => string;
    dim: (s: string) => string;
  },
): string {
  const mark: Record<CheckStatus, string> = {
    ok: decorate.ok('ok  '),
    problem: decorate.bad('BAD '),
    warning: decorate.warn('warn'),
    skipped: decorate.dim('--  '),
  };
  const lines = results.map(
    (r) => `  ${mark[r.status]}  ${r.name}: ${r.detail}`,
  );
  const fixes = results
    .filter((r) => r.fix !== undefined && (r.status === 'problem' || r.status === 'warning'))
    .map((r) => `  ${r.name}\n    ${r.fix ?? ''}`);

  const problems = results.filter((r) => r.status === 'problem').length;
  const warnings = results.filter((r) => r.status === 'warning').length;
  const verdict =
    problems > 0
      ? decorate.bad(
          `${String(problems)} thing${problems === 1 ? '' : 's'} to fix before bica will work.`,
        )
      : warnings > 0
        ? decorate.warn(
            `Ready. ${String(warnings)} thing${warnings === 1 ? '' : 's'} worth knowing about.`,
          )
        : decorate.ok('Ready.');

  return [
    lines.join('\n'),
    '',
    verdict,
    ...(fixes.length > 0 ? ['', 'What to do:', fixes.join('\n')] : []),
    '',
  ].join('\n');
}
