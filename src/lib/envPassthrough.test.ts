import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  buildEnvForwarding,
  describeEnvForwarding,
  describeEnvNotForwarded,
} from './envPassthrough';

/**
 * `env:` from the feature request: "CMAKE_*, CARGO_*, RUSTFLAGS and CCACHE_DIR set locally for a
 * run, forwarded explicitly".
 *
 * Explicitly is the whole design. ssh forwards nothing by default, and the alternative -- copying the
 * local environment across -- would carry credentials, PATH and HOME into a remote login shell,
 * which is both a leak and a very hard-to-see way to break a machine.
 */

describe('buildEnvForwarding', () => {
  it('exports a declared variable that is set here', () => {
    const f = buildEnvForwarding(['RUSTFLAGS'], {
      RUSTFLAGS: '-C target-cpu=blackfin',
    });
    expect(f.script).toContain("export RUSTFLAGS='-C target-cpu=blackfin'");
    expect(f.forwarded).toEqual(['RUSTFLAGS']);
  });

  it('quotes a value with shell metacharacters in it', () => {
    // These go into a remote shell; a value with a quote in it would otherwise be a hole.
    const f = buildEnvForwarding(['X'], { X: "a'b; rm -rf /" });
    expect(f.script).toContain("export X='a'\\''b; rm -rf /'");
  });

  it('leaves a declared variable that is unset here unset there', () => {
    // An unset variable and an empty one mean different things to cargo and to cmake alike.
    const f = buildEnvForwarding(['CARGO_TARGET_DIR'], {});
    expect(f.script).toBe('');
    expect(f.unset).toEqual(['CARGO_TARGET_DIR']);
  });

  it('refuses the variables that describe this machine', () => {
    const f = buildEnvForwarding(['PATH', 'HOME', 'SSH_AUTH_SOCK'], {
      PATH: '/usr/bin',
      HOME: '/Users/x',
      SSH_AUTH_SOCK: '/tmp/s',
    });
    expect(f.script).toBe('');
    expect(f.refused).toEqual(['PATH', 'HOME', 'SSH_AUTH_SOCK']);
  });

  it('forwards nothing when nothing is declared', () => {
    expect(buildEnvForwarding([], { RUSTFLAGS: 'x' }).script).toBe('');
  });
});

describe('describeEnvForwarding', () => {
  it('says what travelled and what did not', () => {
    const said = describeEnvForwarding(
      buildEnvForwarding(['RUSTFLAGS', 'CARGO_TARGET_DIR', 'PATH'], {
        RUSTFLAGS: '-C opt-level=3',
        PATH: '/usr/bin',
      }),
    );
    expect(said).toContain('Forwarding RUSTFLAGS');
    expect(said).toContain('CARGO_TARGET_DIR');
    expect(said).toContain('not set here');
    expect(said).toContain('PATH cannot be forwarded');
  });

  it('has nothing to say when nothing was declared', () => {
    expect(describeEnvForwarding(buildEnvForwarding([], {}))).toBeUndefined();
  });
});

/**
 * As reported against 0.9.4: `E2E_PW_DEPLOYMENT=... bica run ...` never reached the command, the suite
 * fell back to a local backend, and the only symptom was `connect ECONNREFUSED 127.0.0.1:8444`.
 */
describe('describeEnvNotForwarded', () => {
  it('says how to forward a variable when a run fails and nothing is declared', () => {
    const said = describeEnvNotForwarded(undefined, 1);
    expect(said).toContain('env:');
    expect(said).toContain('bica.yml');
    expect(describeEnvNotForwarded([], 1)).toBe(said);
  });

  it('stays quiet when something is declared, or the run passed', () => {
    expect(describeEnvNotForwarded(['RUSTFLAGS'], 1)).toBeUndefined();
    expect(describeEnvNotForwarded(undefined, 0)).toBeUndefined();
  });

  it('stays quiet when the exit says nothing about the command', () => {
    for (const code of [93, 94, 95, 96, 97, 98]) {
      expect(describeEnvNotForwarded(undefined, code)).toBeUndefined();
    }
  });
});

describe('a declared variable reaches a command run by a shell', () => {
  it.each(['sh', 'zsh'])('under %s, and an undeclared one does not', (shell) => {
    const f = buildEnvForwarding(['E2E_PW_DEPLOYMENT'], {
      E2E_PW_DEPLOYMENT: 'develop-preview',
      NOT_DECLARED_HERE: 'x',
    });
    const out = spawnSync(shell, ['-c', `${f.script}env`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    }).stdout;
    expect(out).toContain('E2E_PW_DEPLOYMENT=develop-preview');
    expect(out).not.toContain('NOT_DECLARED_HERE');
  });
});
