import { spawnSync } from 'node:child_process';

/**
 * Notice when a workspace is assembled from two different builds.
 *
 * An incremental build tool keeps two things: the output, and a record of what produced it. They
 * only mean anything together. `sync.ignore.paths` can separate them, and when it does the result is
 * wrong answers rather than a failure.
 *
 * The case this came from, twice, reported both times as a defect in the sync. `dist` is ignored, so
 * it stays on the remote and belongs to whichever checkout built last. `common/tsconfig.tsbuildinfo`
 * sits *outside* `dist`, so nothing ignores it and it is copied from the caller's machine on every
 * run. The remote then holds one tree's record of what it built next to another tree's declarations.
 * `tsgo --build` reads the record, concludes the project is current, and typechecks against the
 * other tree's `.d.ts` -- reporting errors on exports that are present in the source it was handed,
 * three feet away.
 *
 * Nothing about that looks like a configuration problem from the inside. The source on the remote is
 * correct, the commit is correct, git is correct, and the error names a symbol that plainly exists.
 * The first diagnosis was "the sync is broken"; the second was "timestamps are preserved, so the
 * source lands older than the output" -- which measurement later disproved. It is worth one line.
 */

/** Directory names that hold build output rather than source, when one is ignored. */
const OUTPUT_DIR_NAMES: readonly string[] = [
  'dist',
  'build',
  'out',
  'lib',
  '.next',
  '.turbo',
];

/** Whether any ignore rule covers the build-state files themselves. */
function ignoresBuildState(ignorePaths: readonly string[]): boolean {
  return ignorePaths.some((p) => p.includes('tsbuildinfo'));
}

/** Ignore rules that name a build-output directory. */
function ignoredOutputDirs(ignorePaths: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of ignorePaths) {
    const p = raw.trim().replace(/^!/, '').replace(/^\/+|\/+$/g, '');
    if (p !== '' && OUTPUT_DIR_NAMES.includes(p.split('/').pop() ?? '')) {
      out.push(raw.trim());
    }
  }
  return out;
}

export interface SplitBuildState {
  /** Build-state files the sync carries from this machine. */
  buildInfo: string[];
  /** Output directories the sync leaves on the remote. */
  ignoredOutputs: string[];
}

/**
 * Decide whether this configuration splits a build across two owners.
 *
 * Pure. Discovery is the caller's, both so this can be tested without a tree and so the cost of
 * looking is paid once and visibly.
 */
export function detectSplitBuildState(options: {
  ignorePaths: readonly string[];
  /** `*.tsbuildinfo` paths found in the tree, relative to the repo root. */
  buildInfoPaths: readonly string[];
}): SplitBuildState | undefined {
  if (options.buildInfoPaths.length === 0) {
    return undefined;
  }
  if (ignoresBuildState(options.ignorePaths)) {
    // Both halves stay on the remote, which is the configuration this warning asks for.
    return undefined;
  }
  const ignoredOutputs = ignoredOutputDirs(options.ignorePaths);
  if (ignoredOutputs.length === 0) {
    // The output travels too, so both halves come from this machine and agree with each other.
    return undefined;
  }
  // A build-state file *inside* an ignored output directory is not carried either, so it is not
  // part of the split. Only the ones that travel matter.
  const carried = options.buildInfoPaths.filter(
    (p) =>
      !ignoredOutputs.some((dir) => {
        const name = dir.replace(/^\/+|\/+$/g, '');
        return p === name || p.startsWith(`${name}/`) || p.includes(`/${name}/`);
      }),
  );
  if (carried.length === 0) {
    return undefined;
  }
  return { buildInfo: carried.sort(), ignoredOutputs };
}

/** The `*.tsbuildinfo` files in this tree, bounded so the look costs nothing worth measuring. */
export function findBuildInfoPaths(repoRoot: string): string[] {
  const result = spawnSync(
    'find',
    [
      '.',
      '-maxdepth',
      '4',
      '(',
      '-name',
      'node_modules',
      '-o',
      '-name',
      '.git',
      ')',
      '-prune',
      '-o',
      '-name',
      '*.tsbuildinfo',
      '-print',
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: false },
  );
  if (result.error !== undefined) {
    return [];
  }
  return (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/^\.\//, ''))
    .filter((line) => line !== '');
}

/** The line to print, naming the fix rather than the symptom. */
export function describeSplitBuildState(split: SplitBuildState): string {
  const shown = split.buildInfo.slice(0, 3).join(', ');
  const more =
    split.buildInfo.length > 3
      ? ` and ${String(split.buildInfo.length - 3)} more`
      : '';
  const travel = split.buildInfo.length === 1 ? 'travels' : 'travel';
  return (
    `${shown}${more} ${travel} to the remote, but ${split.ignoredOutputs.join(', ')} does not — so the ` +
    'remote gets this machine\'s record of what was built next to output built by whatever ran ' +
    'there last.\n' +
    'An incremental build reads the record, believes the output is current, and compiles against ' +
    'another tree\'s results. That reports errors on code that is correct.\n' +
    'Keep the pair together by ignoring both:\n' +
    '  sync:\n' +
    '    ignore:\n' +
    '      paths:\n' +
    '        - "*.tsbuildinfo"'
  );
}
