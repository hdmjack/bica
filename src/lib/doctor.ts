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

import { buildLoadScript, loadIsWorthMentioning, parseLoad } from './remoteLeftovers';
import {
  describeMissingToolchain,
  rustupCanInstall,
} from './rustWorkspace';
import { describeEntryPoint } from './entryPoint';
import { findSyncInconsistencies } from './syncConsistency';

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
  /** What this repository keeps off the remote, for the companion-file check. */
  syncIgnorePaths: readonly string[];
  /**
   * Tools this repository declares it needs on the remote (`toolchain:` in bica.yml).
   *
   * Checked here rather than discovered by a run, which is the whole point: a missing `ninja` shows
   * up as exit 127 forty minutes into a build, under a command that looks like it failed.
   */
  toolchain?: readonly string[];
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
  /** Ids of the package-manager plugins active here, for the entry-point note. */
  packageManagerPluginIds?: readonly string[];
  /** The channel named in `rust-toolchain.toml`, when there is one. */
  pinnedToolchain?: string | null;
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

/**
 * Say whether an install preflight applies here, rather than leaving it to be discovered.
 *
 * Always `ok`: neither answer is a problem. A cmake or script-driven project is not misconfigured
 * for having no package manager, and the point is to state which world this repository is in.
 */
function checkEntryPoint(probes: DoctorProbes): CheckResult {
  const { detail, note } = describeEntryPoint({
    activePluginIds: probes.packageManagerPluginIds ?? [],
  });
  return {
    name: 'Install preflight',
    status: 'ok',
    detail,
    ...(note === undefined ? {} : { fix: note }),
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

/**
 * Config that sends one half of a matched pair and withholds the other.
 *
 * A warning rather than a problem: runs work, they simply produce answers about a state that exists
 * on no machine, which is worse than a failure and is why it is worth saying before it happens.
 */
function checkSyncConsistency(probes: DoctorProbes): CheckResult {
  const found = findSyncInconsistencies(probes.syncIgnorePaths ?? []);
  if (found.length === 0) {
    return {
      name: 'Sync ignores',
      status: 'ok',
      detail: 'build output and the records describing it come from the same side',
    };
  }
  return {
    name: 'Sync ignores',
    status: 'warning',
    detail: found.map((f) => `${f.rule.output} is ignored, ${f.rule.record} is not`).join('; '),
    fix: found.map((f) => f.message).join(' '),
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

  // The repository's own declared tools, asked the same way and in the same round trip spirit as the
  // built-in ones below.
  const declared = (probes.toolchain ?? []).filter((t) => t.length > 0);
  if (declared.length > 0) {
    const probe = probes.remoteScript(
      `${probes.toolingPreamble}for t in ${declared.join(' ')}; do command -v "$t" >/dev/null 2>&1 && echo "HAVE $t" || echo "MISS $t"; done\n`,
    );
    const absent = probe.stdout
      .split('\n')
      .filter((line) => line.startsWith('MISS '))
      .map((line) => line.slice('MISS '.length).trim())
      .filter((t) => t.length > 0);
    results.push(
      absent.length === 0
        ? {
            name: 'Declared toolchain',
            status: 'ok',
            detail: `${declared.join(', ')} are on PATH`,
          }
        : {
            name: 'Declared toolchain',
            status: 'problem',
            detail: `${host} has no ${absent.join(', ')}`,
            fix: `Install ${absent.join(', ')} on ${host}. Without it a run fails with 127 part-way through, which reads as the command failing.`,
          },
    );
  }

  // A pinned toolchain rustup cannot fetch for itself.
  //
  // The rust plugin assumes rustup reads `rust-toolchain.toml` and installs what it names, which is
  // true for a channel or a version and false for a locally linked one. `rustup toolchain link
  // blackfin build/host/stage1` exists only where it was run, and the remote cannot obtain it.
  const pinned = probes.pinnedToolchain;
  if (pinned !== undefined && pinned !== null && !rustupCanInstall(pinned)) {
    const listed = probes.remoteScript(
      `${probes.toolingPreamble}rustup toolchain list 2>/dev/null || true\n`,
    );
    const present = listed.stdout
      .split('\n')
      .some((line) => line.trim().split(/\s+/)[0] === pinned);
    results.push(
      present
        ? {
            name: 'Pinned toolchain',
            status: 'ok',
            detail: `${host} has \`${pinned}\``,
          }
        : {
            name: 'Pinned toolchain',
            status: 'problem',
            detail: `${host} has no rustup toolchain called \`${pinned}\``,
            fix: describeMissingToolchain({ channel: pinned, sshHost: host }),
          },
    );
  }

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

  // How hard the remote is working, which is the question "why is my machine loud" in another form.
  const load = parseLoad(probes.remoteScript(buildLoadScript()).stdout);
  if (load === null) {
    results.push({
      name: 'Remote load',
      status: 'skipped',
      detail: 'could not be read',
    });
  } else {
    const busy = loadIsWorthMentioning(load);
    results.push({
      name: 'Remote load',
      status: busy ? 'warning' : 'ok',
      detail: `${String(load.load)} on ${String(load.cores)} cores`,
      fix: busy
        ? `Something is working hard on ${host}. If it is not you, look for processes an earlier run ` +
          'left behind: `bica ssh`, then `/bin/ps -Ao pcpu,etime,command -r | head`. A server with a ' +
          'broken idle-exit once span for seven days before anyone noticed.'
        : undefined,
    });
  }

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
    checkEntryPoint(probes),
    checkSyncConsistency(probes),
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

/**
 * Gather the probes from this machine, run the checks and print the report.
 *
 * Here rather than in the CLI so that `bica init` can finish with it. Setup that ends in a verdict --
 * "Ready", or a list of what is left -- is the difference between knowing you are set up and finding
 * out during your first real command.
 */
export function reportOnThisMachine(options: {
  version: string;
  repoRoot: string | undefined;
  config: DoctorProbes['config'];
  toolingPreamble: string;
  runLocal: DoctorProbes['localCommand'];
  runRemote: (sshHost: string, script: string) => {
    status: number;
    stdout: string;
    stderr: string;
  };
  isGitignored: (repoRoot: string) => boolean;
  /** What this repository keeps off the remote; absent when there is no config to read. */
  syncIgnorePaths?: readonly string[];
  /** Tools this repository declares it needs on the remote; absent when there is no config. */
  toolchain?: readonly string[];
  /** Ids of the package-manager plugins active here. */
  packageManagerPluginIds?: readonly string[];
  /** The channel named in `rust-toolchain.toml`, when there is one. */
  pinnedToolchain?: string | null;
  write: (text: string) => void;
  decorate: Parameters<typeof formatReport>[1];
}): CheckResult[] {
  const { config } = options;
  const results = runChecks({
    localCommand: options.runLocal,
    remoteScript: (script) =>
      config.ok
        ? options.runRemote(config.sshHost, script)
        : { status: 1, stdout: '', stderr: 'no ssh host configured' },
    nodeVersion: process.version,
    platform: process.platform,
    config,
    bicaIsGitignored:
      options.repoRoot === undefined
        ? undefined
        : options.isGitignored(options.repoRoot),
    loginShell: process.env.BICA_LOGIN_SHELL?.trim() ?? 'zsh',
    toolingPreamble: options.toolingPreamble,
    syncIgnorePaths: options.syncIgnorePaths ?? [],
    toolchain: options.toolchain ?? [],
    packageManagerPluginIds: options.packageManagerPluginIds ?? [],
    pinnedToolchain: options.pinnedToolchain ?? null,
  });
  options.write(`\nbica ${options.version} on ${process.platform}\n\n`);
  options.write(formatReport(results, options.decorate));
  return results;
}

/**
 * Where this invocation is, and what it can tell about it.
 *
 * Deliberately total: every failure here becomes a check result rather than an exception, because the
 * situations it fails in — no bica.yml, no ssh host — are the ones the doctor exists to describe.
 */
export function doctorContextForThisRepo(options: {
  gitRoot: () => string | undefined;
  bicaRoot: () => string;
  remoteConfig: (repoRoot: string) => {
    sshHost: string;
    remoteWorkspacePath: string;
  };
  preamble: (repoRoot: string) => string;
}): {
  repoRoot: string | undefined;
  config: DoctorProbes['config'];
  toolingPreamble: string;
} {
  let repoRoot = options.gitRoot();
  let config: DoctorProbes['config'];
  try {
    repoRoot = options.bicaRoot();
    const resolved = options.remoteConfig(repoRoot);
    config = {
      ok: true,
      sshHost: resolved.sshHost,
      remoteWorkspacePath: resolved.remoteWorkspacePath,
    };
  } catch (e: unknown) {
    config = { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  let toolingPreamble = '';
  if (repoRoot !== undefined) {
    try {
      toolingPreamble = options.preamble(repoRoot);
    } catch {
      // Resolving it reads bica.yml, and a repository without one is the case this must survive.
    }
  }
  return { repoRoot, config, toolingPreamble };
}
