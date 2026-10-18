import { describe, expect, it } from 'vitest';

import { buildEnvForwarding, describeEnvForwarding } from './envPassthrough';

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
