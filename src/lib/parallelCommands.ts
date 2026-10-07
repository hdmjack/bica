/**
 * Naming the commands of a run that executes several at once.
 *
 * One workspace rather than one per command is the measured choice: commands reading the same files
 * do not need separate copies of them. Three checks in one workspace ran in 32s against 43s for one
 * workspace each, using a third of the disk, syncing the tree once instead of three times and
 * building `dist` once instead of three identical times. The isolation a separate workspace provides
 * is only worth its cost when the *content* differs.
 *
 * The labels derived here are what each command's output is prefixed with while it streams, and what
 * the exit-code summary names. They used to title a block of captured output in a shell script
 * generated for the remote; that script is gone, and with it the reason a run could say nothing until
 * its slowest command had finished.
 */

export interface ParallelCommand {
  /** Short name for the output prefix and the summary line. */
  label: string;
  /** Remote argv, POSIX-quoted by the same rules as a single run. */
  argv: string[];
}

/**
 * Subcommands that name no work of their own. `pnpm exec eslint …` and `pnpm run lint` are about
 * eslint and lint; labelling them `pnpm-exec` and `pnpm-run` tells a reader nothing and makes two
 * different checks collide.
 */
const PASSTHROUGH_SUBCOMMANDS = new Set(['exec', 'run', 'dlx', '--']);

/**
 * Derive a stable, readable label from argv — the prefix a reader scans for.
 *
 * `pnpm test:run libs/src` becomes `pnpm-test-run`; `pnpm exec eslint libs` becomes `pnpm-eslint`,
 * because the interesting word is the tool, not the runner that launched it.
 */
export function labelForArgv(argv: readonly string[]): string {
  const words: string[] = [];
  for (const word of argv) {
    if (words.length >= 2) {
      break;
    }
    if (words.length === 1 && PASSTHROUGH_SUBCOMMANDS.has(word)) {
      continue;
    }
    words.push(word);
  }
  const safe = words
    .join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe === '' ? 'cmd' : safe.slice(0, 40);
}

/** Make labels unique, so two `pnpm exec …` commands do not share a prefix. */
export function assignLabels(argvs: readonly string[][]): ParallelCommand[] {
  const seen = new Map<string, number>();
  return argvs.map((argv) => {
    const base = labelForArgv(argv);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { label: n === 1 ? base : `${base}-${String(n)}`, argv };
  });
}
