import { describe, expect, it } from 'vitest';

import { buildReturnFlowRsyncArgs } from './returnFlow';

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
