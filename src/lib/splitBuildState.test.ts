import { describe, expect, it } from 'vitest';

import {
  describeSplitBuildState,
  detectSplitBuildState,
} from './splitBuildState';

/**
 * The configuration that produced two reports, both of which read as a broken sync.
 *
 * `dist` ignored (so it stays on the remote and belongs to whoever built last) and
 * `common/tsconfig.tsbuildinfo` not ignored (so it is copied from the caller's machine).
 */
const floatJavascript = {
  ignorePaths: [
    'node_modules',
    '.git',
    'dist',
    'e2e/logs',
    'coverage',
    '.eslintcache',
  ],
  buildInfoPaths: [
    'common/tsconfig.tsbuildinfo',
    'ui/tsconfig.tsbuildinfo',
    'web/tsconfig.tsbuildinfo',
    'theme/tsconfig.tsbuildinfo',
    'dist/tsconfig.tsbuildinfo',
  ],
};

describe('detectSplitBuildState', () => {
  it('catches the output and its record being owned by different machines', () => {
    const split = detectSplitBuildState(floatJavascript);
    expect(split?.ignoredOutputs).toEqual(['dist']);
    expect(split?.buildInfo).toContain('common/tsconfig.tsbuildinfo');
  });

  it('ignores a record that lives inside the ignored output, since it does not travel either', () => {
    // `dist/tsconfig.tsbuildinfo` stays on the remote with the `dist` it describes. It is the one
    // file in that list which is not part of the problem.
    expect(detectSplitBuildState(floatJavascript)?.buildInfo).not.toContain(
      'dist/tsconfig.tsbuildinfo',
    );
  });

  it('says nothing once both halves are ignored', () => {
    expect(
      detectSplitBuildState({
        ...floatJavascript,
        ignorePaths: [...floatJavascript.ignorePaths, '*.tsbuildinfo'],
      }),
    ).toBeUndefined();
  });

  it('says nothing when the output travels too, so both halves agree', () => {
    // Nothing is split: the remote gets this machine's record and this machine's output.
    expect(
      detectSplitBuildState({
        ...floatJavascript,
        ignorePaths: ['node_modules', '.git', 'coverage'],
      }),
    ).toBeUndefined();
  });

  it('says nothing for a tree with no incremental build state at all', () => {
    expect(
      detectSplitBuildState({ ...floatJavascript, buildInfoPaths: [] }),
    ).toBeUndefined();
  });

  it('names the fix rather than the symptom', () => {
    const line = describeSplitBuildState(
      detectSplitBuildState(floatJavascript) as never,
    );
    expect(line).toContain('"*.tsbuildinfo"');
    expect(line).toContain('dist');
  });

  it('does not list every file when a monorepo has dozens', () => {
    const many = Array.from(
      { length: 12 },
      (_, i) => `pkg${String(i)}/tsconfig.tsbuildinfo`,
    );
    const line = describeSplitBuildState(
      detectSplitBuildState({ ...floatJavascript, buildInfoPaths: many }) as never,
    );
    expect(line).toContain('and 9 more');
  });
});
