import { describe, expect, it } from 'vitest';

import { formatReport, hasProblem, runChecks } from './doctor';
import type { CheckResult, DoctorProbes } from './doctor';

/** A machine where everything is in order, which each test then breaks in one way. */
function healthy(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    localCommand: () => ({ ok: true, stdout: 'v1.2.3\n', stderr: '' }),
    remoteScript: (script) => {
      if (script.includes('echo BICA_OK')) {
        return { status: 0, stdout: 'BICA_OK\n', stderr: '' };
      }
      if (script.includes('command -v zsh')) {
        return { status: 0, stdout: 'BICA_OK\n', stderr: '' };
      }
      if (script.includes('for t in')) {
        return {
          status: 0,
          stdout: 'HAVE node\nHAVE pnpm\nHAVE rsync\nHAVE git\n',
          stderr: '',
        };
      }
      if (script.includes('ssh -V')) {
        return { status: 0, stdout: 'OpenSSH_9.6p1\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    nodeVersion: 'v22.17.0',
    platform: 'darwin',
    config: { ok: true, sshHost: 'mini', remoteWorkspacePath: '~/code/me/repo' },
    bicaIsGitignored: true,
    loginShell: 'zsh',
    toolingPreamble: 'export PATH="/shims:$PATH"\n',
    ...over,
  };
}

const find = (results: CheckResult[], name: string): CheckResult => {
  const hit = results.find((r) => r.name.startsWith(name));
  if (hit === undefined) {
    throw new Error(`no check named ${name} in ${results.map((r) => r.name).join(', ')}`);
  }
  return hit;
};

describe('what the doctor reports', () => {
  it('passes a machine that is set up', () => {
    const results = runChecks(healthy());
    expect(hasProblem(results)).toBe(false);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
  });

  it('fails an old Node, naming the version it needs', () => {
    const results = runChecks(healthy({ nodeVersion: 'v20.11.0' }));
    expect(find(results, 'Node').status).toBe('problem');
    expect(find(results, 'Node').detail).toContain('22');
  });

  it('fails a missing local tool with the command to install it', () => {
    const results = runChecks(
      healthy({
        localCommand: (command) =>
          command === 'mutagen'
            ? { ok: false, stdout: '', stderr: 'not found' }
            : { ok: true, stdout: 'ok\n', stderr: '' },
      }),
    );
    const mutagen = find(results, 'Mutagen');
    expect(mutagen.status).toBe('problem');
    expect(mutagen.fix).toContain('brew install');
  });

  it('reports one problem, not six, when ssh does not work', () => {
    // A newcomer whose key is not set up should see the cause, not every consequence of it.
    const results = runChecks(
      healthy({
        remoteScript: () => ({
          status: 255,
          stdout: '',
          stderr: 'ssh: Could not resolve hostname mini\n',
        }),
      }),
    );
    expect(results.filter((r) => r.status === 'problem')).toHaveLength(1);
    const ssh = find(results, 'ssh mini');
    expect(ssh.detail).toContain('Could not resolve hostname');
    expect(find(results, 'Remote tooling').status).toBe('skipped');
  });

  it('checks remote tooling with the PATH a run uses, not a bare login shell', () => {
    // Without bica's preamble a version manager's shims are absent, and the check would report node
    // and pnpm missing on a remote where every run finds them.
    let sawPreamble = false;
    runChecks(
      healthy({
        remoteScript: (script) => {
          if (script.includes('for t in')) {
            sawPreamble = script.includes('export PATH="/shims:$PATH"');
            return { status: 0, stdout: 'HAVE node\n', stderr: '' };
          }
          return { status: 0, stdout: 'BICA_OK\n', stderr: '' };
        },
      }),
    );
    expect(sawPreamble).toBe(true);
  });

  it('warns rather than fails when a tool the remote may not need is absent', () => {
    const results = runChecks(
      healthy({
        remoteScript: (script) =>
          script.includes('for t in')
            ? { status: 0, stdout: 'HAVE node\nMISS pnpm\nHAVE rsync\nHAVE git\n', stderr: '' }
            : { status: 0, stdout: 'BICA_OK\n', stderr: '' },
      }),
    );
    const tooling = find(results, 'Remote tooling');
    expect(tooling.status).toBe('warning');
    expect(tooling.detail).toContain('pnpm');
    expect(hasProblem(results)).toBe(false);
  });

  it('fails a remote without the login shell bica uses, and says which to set', () => {
    const results = runChecks(
      healthy({
        remoteScript: (script) =>
          script.includes('command -v zsh')
            ? { status: 1, stdout: '', stderr: '' }
            : script.includes('echo BICA_OK')
              ? { status: 0, stdout: 'BICA_OK\n', stderr: '' }
              : { status: 0, stdout: '', stderr: '' },
      }),
    );
    const shell = find(results, 'Remote zsh');
    expect(shell.status).toBe('problem');
    expect(shell.fix).toContain('BICA_LOGIN_SHELL');
  });

  it('warns about an OpenSSH too old for tunnels, without failing the rest', () => {
    const results = runChecks(
      healthy({
        remoteScript: (script) =>
          script.includes('ssh -V')
            ? { status: 0, stdout: 'OpenSSH_6.6p1\n', stderr: '' }
            : script.includes('for t in')
              ? { status: 0, stdout: 'HAVE node\n', stderr: '' }
              : { status: 0, stdout: 'BICA_OK\n', stderr: '' },
      }),
    );
    const openssh = find(results, 'Remote OpenSSH');
    expect(openssh.status).toBe('warning');
    expect(openssh.fix).toContain('6.7');
    expect(hasProblem(results)).toBe(false);
  });

  it('tells someone with no config to run init, and skips what it cannot know', () => {
    const results = runChecks(
      healthy({ config: { ok: false, reason: 'no bica.yml here' } }),
    );
    expect(find(results, 'Configuration').fix).toContain('bica init');
    expect(find(results, 'Remote').status).toBe('skipped');
  });

  it('warns when .bica is committable', () => {
    const results = runChecks(healthy({ bicaIsGitignored: false }));
    expect(find(results, 'Local settings').status).toBe('warning');
  });
});

describe('the report', () => {
  const plain = {
    ok: (s: string) => s,
    bad: (s: string) => s,
    warn: (s: string) => s,
    dim: (s: string) => s,
  };

  it('lists every check, including what it skipped', () => {
    const report = formatReport(
      [
        { name: 'A', status: 'ok', detail: 'fine' },
        { name: 'B', status: 'skipped', detail: 'not reached' },
      ],
      plain,
    );
    expect(report).toContain('A: fine');
    expect(report).toContain('B: not reached');
  });

  it('gathers the fixes under one heading rather than scattering them', () => {
    const report = formatReport(
      [
        { name: 'A', status: 'problem', detail: 'broken', fix: 'do this' },
        { name: 'B', status: 'ok', detail: 'fine' },
      ],
      plain,
    );
    expect(report).toContain('What to do:');
    expect(report).toContain('do this');
    expect(report).toContain('1 thing to fix');
  });

  it('says ready when nothing is wrong, and counts what is merely worth knowing', () => {
    expect(formatReport([{ name: 'A', status: 'ok', detail: 'fine' }], plain)).toContain(
      'Ready.',
    );
    const withWarning = formatReport(
      [{ name: 'A', status: 'warning', detail: 'hmm', fix: 'maybe' }],
      plain,
    );
    expect(withWarning).toContain('Ready.');
    expect(withWarning).toContain('1 thing worth knowing');
  });
});
