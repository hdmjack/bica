import { describe, expect, it } from 'vitest';

import {
  buildReturnFlowExcludes,
  buildReturnFlowMirrorArgs,
  buildReturnFlowRsyncArgs,
} from './returnFlow';

describe('buildReturnFlowRsyncArgs', () => {
  it('emits include filters for every pattern, plus a final exclude', () => {
    const args = buildReturnFlowRsyncArgs([
      '**/__snapshots__/**',
      '**/*.snap',
    ]);
    expect(args).toEqual([
      '--prune-empty-dirs',
      '--filter=+ */',
      '--filter=+ **/__snapshots__/**',
      '--filter=+ **/*.snap',
      '--filter=- *',
    ]);
  });

  it('still emits the include-dir + exclude-everything filters when patterns is empty', () => {
    const args = buildReturnFlowRsyncArgs([]);
    expect(args).toEqual([
      '--prune-empty-dirs',
      '--filter=+ */',
      '--filter=- *',
    ]);
  });

  it('rules out excluded trees before anything else so rsync never descends into them', () => {
    const args = buildReturnFlowRsyncArgs(
      ['**/*.snap'],
      ['.git', 'node_modules', 'dist'],
    );
    expect(args).toEqual([
      '--prune-empty-dirs',
      '--filter=- .git',
      '--filter=- node_modules',
      '--filter=- dist',
      '--filter=+ */',
      '--filter=+ **/*.snap',
      '--filter=- *',
    ]);
    // First matching rule wins: the excludes must precede the descend-everywhere include.
    expect(args.indexOf('--filter=- node_modules')).toBeLessThan(
      args.indexOf('--filter=+ */'),
    );
  });
});

describe('buildReturnFlowExcludes', () => {
  it('always excludes .git, which is mirrored separately', () => {
    expect(buildReturnFlowExcludes([])).toContain('.git');
  });

  it('always excludes .bica, so a pull cannot reach the lock directory', () => {
    expect(buildReturnFlowExcludes([])).toContain('.bica');
  });

  it('excludes the trees each side owns independently', () => {
    expect(
      buildReturnFlowExcludes(['node_modules', 'dist', '.playwright-mcp']),
    ).toEqual(['.git', '.bica', 'node_modules', 'dist', '.playwright-mcp']);
  });

  it('does not repeat .git when the config also ignores it', () => {
    expect(buildReturnFlowExcludes(['.git', 'node_modules'])).toEqual([
      '.git',
      '.bica',
      'node_modules',
    ]);
  });

  it('drops blanks and Mutagen negations, which say nothing about return-flow ownership', () => {
    expect(
      buildReturnFlowExcludes(['  node_modules  ', '', '!dist/keep']),
    ).toEqual(['.git', '.bica', 'node_modules']);
  });
});

describe('buildReturnFlowMirrorArgs', () => {
  const patterns = ['**/__snapshots__/**', '**/*.snap'];

  it('scopes --delete with the whitelist filters and puts source before dest', () => {
    const args = buildReturnFlowMirrorArgs(
      patterns,
      'mini:~/code/foo/',
      '/local/foo/',
    );
    expect(args).toEqual([
      '-az',
      '--delete',
      '--prune-empty-dirs',
      '--filter=+ */',
      '--filter=+ **/__snapshots__/**',
      '--filter=+ **/*.snap',
      '--filter=- *',
      'mini:~/code/foo/',
      '/local/foo/',
    ]);
  });

  it('passes excluded trees through, keeping --delete out of them entirely', () => {
    const args = buildReturnFlowMirrorArgs(
      patterns,
      'mini:~/code/foo/',
      '/local/foo/',
      ['.git', 'node_modules'],
    );
    // Excluded paths are protected from deletion as well as transfer, so a dependency's own
    // snapshots never cross the wire and local-only ignored trees are left alone.
    expect(args).toContain('--filter=- node_modules');
    expect(args.indexOf('--filter=- node_modules')).toBeLessThan(
      args.indexOf('--filter=+ */'),
    );
  });

  it('places --delete before the trailing exclude so non-matching files stay protected', () => {
    const args = buildReturnFlowMirrorArgs(patterns, 'src/', 'dst/');
    // --delete removes only extraneous *included* files; the final "- *" protects everything else
    // (on the receiver) from deletion.
    expect(args.indexOf('--delete')).toBeLessThan(args.indexOf('--filter=- *'));
  });

  it('is direction-agnostic — same builder used for push (local→remote) and pull (remote→local)', () => {
    const push = buildReturnFlowMirrorArgs(patterns, '/local/', 'mini:~/r/');
    const pull = buildReturnFlowMirrorArgs(patterns, 'mini:~/r/', '/local/');
    expect(push.slice(-2)).toEqual(['/local/', 'mini:~/r/']);
    expect(pull.slice(-2)).toEqual(['mini:~/r/', '/local/']);
    // Only the trailing source/dest differ; the flags are identical.
    expect(push.slice(0, -2)).toEqual(pull.slice(0, -2));
  });
});
