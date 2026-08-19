import { describe, expect, it } from 'vitest';

import { buildMiseTrustScript } from './runRemote';

describe('buildMiseTrustScript', () => {
  it('expands a tilde path, which single quotes would not', () => {
    const script = buildMiseTrustScript('~/code/repo-lane-1');
    expect(script).toContain('cd "$HOME/code/repo-lane-1"');
  });

  it('quotes an absolute path', () => {
    expect(buildMiseTrustScript('/srv/work/repo-lane-1')).toContain(
      'cd "/srv/work/repo-lane-1"',
    );
  });

  it('is a no-op when the workspace is missing', () => {
    // The lane may have been removed between creation and this call; that is not an error.
    expect(buildMiseTrustScript('~/x')).toMatch(/cd .* 2>\/dev\/null \|\| exit 0/);
  });

  it('is a no-op when mise is not installed on the host', () => {
    // bica must not require mise; it is one optional remote-shell plugin among several.
    expect(buildMiseTrustScript('~/x')).toContain(
      'command -v mise >/dev/null 2>&1 || exit 0',
    );
  });

  it('is a no-op when the repo has no mise config', () => {
    const script = buildMiseTrustScript('~/x');
    expect(script).toContain('[ -f mise.toml ] || [ -f .mise.toml ] || exit 0');
  });

  it('trusts non-interactively — a prompt here would hang the run', () => {
    expect(buildMiseTrustScript('~/x')).toContain('mise trust --yes');
  });

  it('never fails the run, whatever mise decides', () => {
    // A convenience step before the real command; its failure must not mask the run's result. It exits
    // 0 without printing the marker, so the caller learns nothing was trusted and carries on.
    expect(buildMiseTrustScript('~/x')).toMatch(/mise trust --yes .*\|\| exit 0/);
  });

  it('announces success, so a step that silently does nothing cannot hide', () => {
    // It hid twice: once behind an ssh transport bug, once behind running in a shell where mise is not
    // on PATH. Both were invisible because success and failure looked identical from outside.
    expect(buildMiseTrustScript('~/x')).toContain('BICA_MISE_TRUSTED');
  });

  it('produces no output on success, so it cannot pollute captured stdout', () => {
    const script = buildMiseTrustScript('~/x');
    expect(script).toContain('mise trust --yes >/dev/null 2>&1');
  });

  it('guards before trusting, so ordering cannot invert', () => {
    const script = buildMiseTrustScript('~/x');
    expect(script.indexOf('command -v mise')).toBeLessThan(
      script.indexOf('mise trust'),
    );
    expect(script.indexOf('mise.toml')).toBeLessThan(
      script.indexOf('mise trust'),
    );
  });
});
