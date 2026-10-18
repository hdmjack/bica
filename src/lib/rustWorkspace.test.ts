import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildSubmodulePointerScript,
  describeMissingToolchain,
  parseGitmodulesPaths,
  pinnedToolchain,
  readSubmodulePointers,
  rustupCanInstall,
  withCargoTargetIgnored,
} from './rustWorkspace';

let repo = '';

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-rust-'));
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('withCargoTargetIgnored', () => {
  it('declares target for a Rust repo that has not', () => {
    // `target/` is gitignored, so the local checkout usually has none, and a mirror that deletes
    // what the local side lacks removes it between runs -- making every build a clean build.
    fs.writeFileSync(path.join(repo, 'Cargo.toml'), '[package]\n');
    const result = withCargoTargetIgnored(repo, ['.git']);
    expect(result.paths).toContain('target');
    expect(result.added).toBe(true);
  });

  it('leaves a repo that already mentions target exactly as written', () => {
    fs.writeFileSync(path.join(repo, 'Cargo.toml'), '[package]\n');
    const result = withCargoTargetIgnored(repo, ['.git', 'target']);
    expect(result.added).toBe(false);
    expect(result.paths).toEqual(['.git', 'target']);
  });

  it('does not touch a repository that is not Rust', () => {
    expect(withCargoTargetIgnored(repo, ['.git']).added).toBe(false);
  });

  it('counts a lockfile alone as Rust', () => {
    fs.writeFileSync(path.join(repo, 'Cargo.lock'), '');
    expect(withCargoTargetIgnored(repo, []).added).toBe(true);
  });
});

describe('parseGitmodulesPaths', () => {
  it('reads the paths out of a .gitmodules', () => {
    expect(
      parseGitmodulesPaths(
        '[submodule "src/llvm-project"]\n\tpath = src/llvm-project\n\turl = https://x\n' +
          '[submodule "library/stdarch"]\n\tpath = library/stdarch\n\turl = https://y\n',
      ),
    ).toEqual(['src/llvm-project', 'library/stdarch']);
  });

  it('has nothing to say about a file with no submodules', () => {
    expect(parseGitmodulesPaths('')).toEqual([]);
  });
});

describe('readSubmodulePointers', () => {
  it('reads the one-line .git file a submodule has', () => {
    // Verbatim from a real submodule: it names a path relative to the submodule, into the parent's
    // `.git/modules`, which the parent `.git` copy has already put on the remote.
    fs.mkdirSync(path.join(repo, 'vendor', 'inner'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'vendor', 'inner', '.git'),
      'gitdir: ../../.git/modules/vendor/inner\n',
    );
    const pointers = readSubmodulePointers(repo, ['vendor/inner']);
    expect(pointers).toEqual([
      { path: 'vendor/inner', contents: 'gitdir: ../../.git/modules/vendor/inner\n' },
    ]);
  });

  it('skips a submodule that was never checked out', () => {
    expect(readSubmodulePointers(repo, ['vendor/missing'])).toEqual([]);
  });

  it('skips one whose .git is a real directory, which has nothing to point at', () => {
    fs.mkdirSync(path.join(repo, 'old', '.git'), { recursive: true });
    expect(readSubmodulePointers(repo, ['old'])).toEqual([]);
  });
});

describe('buildSubmodulePointerScript', () => {
  it('writes each pointer back, contents uninterpreted', () => {
    const script = buildSubmodulePointerScript({
      remoteWorkspaceWord: "~/'code/rustc'",
      pointers: [
        { path: 'vendor/inner', contents: 'gitdir: ../../.git/modules/vendor/inner\n' },
      ],
    });
    expect(script).toContain("cd ~/'code/rustc'");
    expect(script).toContain('gitdir: ../../.git/modules/vendor/inner');
    expect(script).toContain("<<'BICA_SUBMODULE_EOF'");
  });

  it('is empty when there are no submodules, so nothing is run', () => {
    expect(
      buildSubmodulePointerScript({ remoteWorkspaceWord: '/w', pointers: [] }),
    ).toBe('');
  });
});

describe('pinnedToolchain', () => {
  it('reads the channel out of rust-toolchain.toml', () => {
    fs.writeFileSync(
      path.join(repo, 'rust-toolchain.toml'),
      '[toolchain]\nchannel = "blackfin"\ncomponents = ["rustfmt"]\n',
    );
    expect(pinnedToolchain(repo)).toBe('blackfin');
  });

  it('is null when the repository pins nothing', () => {
    expect(pinnedToolchain(repo)).toBeNull();
  });
});

describe('rustupCanInstall', () => {
  it.each(['stable', 'nightly', 'beta', 'nightly-2026-01-02', '1.84.0', 'stable-aarch64-apple-darwin'])(
    'knows rustup fetches %s by itself',
    (channel) => {
      expect(rustupCanInstall(channel)).toBe(true);
    },
  );

  it.each(['blackfin', 'my-local-stage1'])(
    'knows %s must have been linked locally',
    (channel) => {
      // `rustup toolchain link` exists only where it was run; the remote cannot obtain it, which is
      // the assumption the rust plugin was making.
      expect(rustupCanInstall(channel)).toBe(false);
    },
  );
});

describe('describeMissingToolchain', () => {
  it('says how to link it rather than only that it is missing', () => {
    const said = describeMissingToolchain({ channel: 'blackfin', sshHost: 'mini' });
    expect(said).toContain('rustup toolchain link blackfin');
    expect(said).toContain('mini');
  });
});
