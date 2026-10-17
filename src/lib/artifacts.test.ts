import { describe, expect, it } from 'vitest';

import {
  artifactDestination,
  artifactsNotProtected,
  buildArtifactRsyncArgs,
  describeArtifactPull,
  parseItemizedChanges,
  pullArtifacts,
} from './artifacts';
import type { RsyncRunner } from './artifacts';

/**
 * The request's own test: "`artifacts:` with a symlinked binary inside an ignored `build/`: the local
 * copy is the real file. A second run that doesn't rebuild transfers nothing."
 *
 * Both halves are rsync's behaviour rather than bica's -- `-L` resolves the link, and rsync skips a
 * file whose size and time already match -- so what is asserted here is that bica asks for them, and
 * that it reports the answer correctly. The itemize fixture is rsync's real output format.
 */

describe('buildArtifactRsyncArgs', () => {
  const base = { remoteSyncUrl: 'mini:/Users/x/code/llvm', repoRoot: '/local/llvm' };

  it('follows symlinks, because the binary is what is wanted locally', () => {
    // `build/bin/clang` is a link to `clang-23`; copying the link gives a path this machine has not
    // got.
    expect(
      buildArtifactRsyncArgs({ ...base, artifactPath: 'build/bin/clang' }),
    ).toContain('-L');
  });

  it('keeps the artifact at its own path rather than dropping it in the repo root', () => {
    // The first version leaned on `--relative` and a `/./` marker, which openrsync -- what macOS
    // ships -- ignores: it recreated the remote's whole absolute path under the repo root, so the
    // binary landed at `./Users/haakonjack/code/.../build/bin/llc`.
    const args = buildArtifactRsyncArgs({ ...base, artifactPath: 'build/bin/llc' });
    expect(args).toContain('mini:/Users/x/code/llvm/build/bin/llc');
    expect(args.at(-1)).toBe('/local/llvm/build/bin/');
  });

  it('does not pass options openrsync rejects', () => {
    const args = buildArtifactRsyncArgs({ ...base, artifactPath: 'build/bin/llc' });
    expect(args.some((a) => a.startsWith('--info'))).toBe(false);
    expect(args).not.toContain('--relative');
  });

  it('asks rsync to say what it transferred', () => {
    expect(
      buildArtifactRsyncArgs({ ...base, artifactPath: 'build/bin/llc' }),
    ).toContain('--itemize-changes');
  });

  it('takes a directory artifact as written', () => {
    // rustc's case: `build/host/stage1/` is a tree, not a file.
    const args = buildArtifactRsyncArgs({ ...base, artifactPath: 'build/host/stage1/' });
    expect(args).toContain('mini:/Users/x/code/llvm/build/host/stage1/');
    expect(args.at(-1)).toBe('/local/llvm/build/host/stage1/');
  });

  it('never deletes anything, in either direction', () => {
    const args = buildArtifactRsyncArgs({ ...base, artifactPath: 'build/bin/llc' });
    expect(args).not.toContain('--delete');
  });
});

describe('parseItemizedChanges', () => {
  // GNU rsync's `--itemize-changes`: eleven flag characters.
  const FIRST_FETCH =
    '>f+++++++++ build/bin/llc\n' +
    'cd+++++++++ build/\n' +
    'cd+++++++++ build/bin/\n' +
    '>f+++++++++ build/bin/clang\n';

  /** openrsync's, captured from a real fetch off `mini`: nine, not eleven. */
  const OPENRSYNC_FETCH = '>f+++++++ llc\n';

  it('names the files that came across', () => {
    expect(parseItemizedChanges(FIRST_FETCH)).toEqual([
      'build/bin/llc',
      'build/bin/clang',
    ]);
  });

  it('does not count the directories it had to create', () => {
    // Counting those would report "copied" for a run that brought back nothing new.
    expect(parseItemizedChanges(FIRST_FETCH)).not.toContain('build/');
  });

  it('reads openrsync\'s shorter flag block, which is what macOS has', () => {
    // Slicing at a fixed column took three characters off the front of every name it reported.
    expect(parseItemizedChanges(OPENRSYNC_FETCH)).toEqual(['llc']);
  });

  it('is empty for a run that rebuilt nothing', () => {
    // The second half of the request's test: no transfer when the binary has not changed.
    expect(parseItemizedChanges('')).toEqual([]);
    expect(parseItemizedChanges('.f          build/bin/llc\n')).toEqual([]);
  });
});

describe('artifactDestination', () => {
  it('puts a file in its own directory', () => {
    expect(artifactDestination('/l', 'build/bin/llc')).toBe('/l/build/bin/');
  });

  it('puts a tree at the matching tree', () => {
    expect(artifactDestination('/l', 'build/host/stage1/')).toBe(
      '/l/build/host/stage1/',
    );
  });

  it('handles an artifact at the repo root', () => {
    expect(artifactDestination('/l', 'llc')).toBe('/l/');
  });
});

describe('pullArtifacts', () => {
  it('fetches each configured artifact', () => {
    const asked: string[][] = [];
    const run: RsyncRunner = (args) => {
      asked.push([...args]);
      return { status: 0, stdout: '>f+++++++++ build/bin/llc\n', stderr: '' };
    };
    const outcomes = pullArtifacts({
      artifacts: ['build/bin/llc', 'build/bin/clang'],
      remoteSyncUrl: 'mini:/r',
      repoRoot: '/l',
      run,
    });
    expect(asked).toHaveLength(2);
    expect(outcomes[0].changed).toEqual(['build/bin/llc']);
  });

  it('calls a source the build has not produced missing, not an error', () => {
    // The common case, and not a failure: an artifact names what a build *will* make, and before it
    // has -- or when the build stopped short of it -- the honest report is that there is nothing to
    // bring home. Reporting it as an rsync error put `rsync(350): warning: receiver has empty file
    // list: exiting` under an ordinary run.
    const outcomes = pullArtifacts({
      artifacts: ['build/bin/llc'],
      remoteSyncUrl: 'mini:/r',
      repoRoot: '/l',
      run: () => ({
        status: 23,
        stdout: '',
        stderr: 'rsync: link_stat "/r/build/bin/llc" failed: No such file or directory (2)\n',
      }),
    });
    expect(outcomes[0]).toMatchObject({ changed: [], missing: true });
    expect(outcomes[0].error).toBeUndefined();
  });

  it('still reports a fetch that failed for a real reason', () => {
    const outcomes = pullArtifacts({
      artifacts: ['build/bin/llc'],
      remoteSyncUrl: 'mini:/r',
      repoRoot: '/l',
      run: () => ({
        status: 12,
        stdout: '',
        stderr: 'rsync: connection unexpectedly closed\n',
      }),
    });
    expect(outcomes[0].error).toContain('connection unexpectedly closed');
    expect(outcomes[0].missing).toBeUndefined();
  });
});

describe('describeArtifactPull', () => {
  it('names a single binary, which is why it was named in the config', () => {
    const said = describeArtifactPull([
      { path: 'build/bin/llc', changed: ['build/bin/llc'] },
    ]);
    expect(said).toContain('Brought home build/bin/llc');
  });

  it('counts a directory rather than listing thousands of files', () => {
    const said = describeArtifactPull([
      {
        path: 'build/host/stage1/',
        changed: Array.from({ length: 412 }, (_, i) => `f${String(i)}`),
      },
    ]);
    expect(said).toContain('412 files');
  });

  it('says nothing is there yet when the build has not produced it', () => {
    expect(
      describeArtifactPull([{ path: 'build/bin/llc', changed: [], missing: true }]),
    ).toContain('Nothing to bring home yet');
  });

  it('says so when nothing changed, which is not the same as not having looked', () => {
    expect(
      describeArtifactPull([{ path: 'build/bin/llc', changed: [] }]),
    ).toContain('unchanged');
  });

  it('reports what could not be fetched', () => {
    const said = describeArtifactPull([
      { path: 'build/bin/llc', changed: [], error: 'No such file or directory (2)' },
    ]);
    expect(said).toContain('Could not bring home build/bin/llc');
  });

  it('has nothing to say when no artifacts are configured', () => {
    expect(describeArtifactPull([])).toBeUndefined();
  });
});

describe('artifactsNotProtected', () => {
  it('is quiet when the artifact sits in an ignored tree', () => {
    expect(
      artifactsNotProtected({
        artifacts: ['build/bin/llc'],
        syncIgnorePaths: ['build'],
        generatedPaths: [],
      }),
    ).toEqual([]);
  });

  it('names an artifact the mirror will delete before the pull can see it', () => {
    // The file exists remotely and not locally, which is the exact predicate `--delete` acts on, so
    // the pull afterwards finds nothing and says nothing. Worth catching up front.
    expect(
      artifactsNotProtected({
        artifacts: ['out/llc'],
        syncIgnorePaths: ['build'],
        generatedPaths: [],
      }),
    ).toEqual(['out/llc']);
  });

  it('accepts a generated path as protection too', () => {
    expect(
      artifactsNotProtected({
        artifacts: ['gen/icons/Icon.tsx'],
        syncIgnorePaths: [],
        generatedPaths: ['gen/icons'],
      }),
    ).toEqual([]);
  });

  it('does not treat a prefix of a name as a parent directory', () => {
    // `build` must not protect `builds/`.
    expect(
      artifactsNotProtected({
        artifacts: ['builds/llc'],
        syncIgnorePaths: ['build'],
        generatedPaths: [],
      }),
    ).toEqual(['builds/llc']);
  });
});
