import { describe, expect, it } from 'vitest';

import {
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
