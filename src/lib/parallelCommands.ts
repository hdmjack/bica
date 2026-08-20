import { argvToPosixShCommand } from '../remoteArgvToShellCommand';

/**
 * Run several commands at once inside one remote workspace.
 *
 * This replaces a pool of separate workspaces for the case it was mostly used for. Commands that
 * read the same files
 * do not need separate copies of them: measured on a real monorepo, three checks as background
 * processes in one workspace ran in 32s against 43s for one workspace each, using a third of the disk,
 * syncing the tree once instead of three times, and building `dist` once instead of three identical
 * times. The isolation a workspace provides is only worth its cost when the *content* differs.
 *
 * What the caller wants that a bare `sh -c '… & … & wait'` does not give:
 *
 * - per-command exit codes, not just the last one
 * - output that does not interleave into an unreadable braid
 * - a single non-zero exit when any command fails, so a caller can branch on it
 * - no quoting archaeology
 */

export interface ParallelCommand {
  /** Short name for the section header and the summary line. */
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
 * Derive a stable, filename-safe label from argv — the section header a reader scans for.
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

/** Make labels unique, so two `pnpm exec …` commands do not share a log file. */
export function assignLabels(argvs: readonly string[][]): ParallelCommand[] {
  const seen = new Map<string, number>();
  return argvs.map((argv) => {
    const base = labelForArgv(argv);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { label: n === 1 ? base : `${base}-${String(n)}`, argv };
  });
}

/**
 * Shell for running every command concurrently and reporting each one.
 *
 * Output is captured per command and replayed in the order given, so a reader sees three coherent
 * blocks rather than three interleaved streams. The summary line and the exit code are the machine
 * -readable part: any failure makes the whole run non-zero, and the line says which.
 *
 * Log files go in a temp directory that is removed afterwards, so nothing lands in the workspace where
 * the next sync would have to reason about it. Pure, for testability.
 */
export function buildParallelScript(commands: readonly ParallelCommand[]): string {
  if (commands.length === 0) {
    throw new Error('buildParallelScript needs at least one command');
  }
  const lines: string[] = [
    '_bica_dir=$(mktemp -d)',
    // Even on a hard failure the workspace is left as it was found.
    "trap 'rm -rf \"$_bica_dir\"' EXIT",
  ];

  commands.forEach((c, i) => {
    const v = `_bica_p${String(i)}`;
    lines.push(
      `${c.argv.length === 0 ? 'true' : argvToPosixShCommand(c.argv)} > "$_bica_dir/${c.label}.log" 2>&1 &`,
      `${v}=$!`,
    );
  });

  commands.forEach((c, i) => {
    lines.push(`wait "$_bica_p${String(i)}"; _bica_rc${String(i)}=$?`);
  });

  lines.push('_bica_failed=0');
  commands.forEach((c, i) => {
    lines.push(
      `printf '\\n===== %s =====\\n' ${shq(c.label)}`,
      `cat "$_bica_dir/${c.label}.log"`,
      `[ "$_bica_rc${String(i)}" -ne 0 ] && _bica_failed=1`,
    );
  });

  const summary = commands
    .map((c, i) => `${c.label}=$_bica_rc${String(i)}`)
    .join(' ');
  lines.push(
    `printf '\\n[bica] %s\\n' ${shq('exit codes:')}" ${summary}"`,
    'exit "$_bica_failed"',
  );
  return lines.join('\n') + '\n';
}

/** Single-quote for POSIX sh. */
function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
