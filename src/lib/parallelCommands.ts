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

/**
 * How long the progress loop waits between looks, and how that grows.
 *
 * It starts short because most runs are short: a fixed interval would add its own length to every
 * multi-command run, which a first version of this did -- two `echo`s took five seconds. It grows
 * because a run that is still going after half a minute is not one where a fraction of a second of
 * detection lag matters, and a tight loop over hours is just noise on the connection.
 */
const POLL_LADDER = [
  { afterPolls: 0, seconds: '0.2' },
  { afterPolls: 10, seconds: '1' },
  { afterPolls: 30, seconds: '5' },
];

/** Seconds between "still running" lines, measured against the clock rather than the poll count. */
const HEARTBEAT_SECONDS = 60;

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
export function buildParallelScript(
  commands: readonly ParallelCommand[],
  options: { heartbeatSeconds?: number } = {},
): string {
  const heartbeatSeconds = options.heartbeatSeconds ?? HEARTBEAT_SECONDS;
  if (commands.length === 0) {
    throw new Error('buildParallelScript needs at least one command');
  }
  const lines: string[] = [
    // Named, and explicitly under TMPDIR. Bare `mktemp -d` produces an anonymous `tmp.XXXX` in the
    // system temp -- and on BSD/macOS it ignores TMPDIR entirely -- so a directory orphaned by a
    // killed run could not be attributed to bica, or found by a test checking the trap fired.
    '_bica_dir=$(mktemp -d "${TMPDIR:-/tmp}/bica-run.XXXXXX")',
    // Even on a hard failure the workspace is left as it was found.
    "trap 'rm -rf \"$_bica_dir\"' EXIT",
    '_bica_t0=$(date +%s)',
  ];

  // Each command writes its exit code to a file of its own when it finishes.
  //
  // That file, rather than `wait`, is what tells the loop below a command is done: a finished child
  // that has not been reaped is a zombie, and `kill -0` on a zombie succeeds, so polling the process
  // table would report every command as still running until the moment it was collected.
  commands.forEach((c, i) => {
    const v = `_bica_p${String(i)}`;
    const body = c.argv.length === 0 ? 'true' : argvToPosixShCommand(c.argv);
    lines.push(
      `( ${body} > "$_bica_dir/${c.label}.log" 2>&1; echo $? > "$_bica_dir/${c.label}.rc" ) &`,
      `${v}=$!`,
      `_bica_ann${String(i)}=0`,
    );
  });

  // Say what is happening while it happens.
  //
  // Output is captured and replayed in order, which is what makes three concurrent commands readable
  // -- but it means a run says nothing at all until the slowest of them finishes. A three-command run
  // once sat silent for two hours and was reported as "no command ever started", because there was no
  // way to tell that from "two finished in a minute and the third is wedged". These lines go to
  // stderr, so a caller filtering stdout still gets the clean report, and they keep an otherwise idle
  // connection carrying traffic.
  const labelList = commands.map((c) => c.label).join(', ');
  lines.push(
    // No apostrophe in the message: the whole `printf` format is a single-quoted shell word, and
    // escaping one inside a template literal that is itself building shell quoting is how this line
    // first went wrong.
    `printf '[bica] running %s; output appears when all have finished\\n' ${shq(labelList)} >&2`,
    '_bica_tick=0',
    `_bica_nap=${POLL_LADDER[0].seconds}`,
    `_bica_beat=${String(heartbeatSeconds)}`,
    'while :; do',
  );

  commands.forEach((c, i) => {
    lines.push(
      `  if [ -f "$_bica_dir/${c.label}.rc" ] && [ "$_bica_ann${String(i)}" -eq 0 ]; then`,
      `    _bica_ann${String(i)}=1`,
      `    printf '[bica] %s finished (exit %s) after %ss\\n' ${shq(c.label)} "$(cat "$_bica_dir/${c.label}.rc")" "$(( $(date +%s) - _bica_t0 ))" >&2`,
      '  fi',
    );
  });

  lines.push('  _bica_pending=0');
  commands.forEach((c) => {
    lines.push(`  [ -f "$_bica_dir/${c.label}.rc" ] || _bica_pending=1`);
  });
  lines.push(
    '  [ "$_bica_pending" -eq 0 ] && break',
    '  sleep "$_bica_nap"',
    '  _bica_tick=$(( _bica_tick + 1 ))',
    ...POLL_LADDER.slice(1).map(
      (step) =>
        `  [ "$_bica_tick" -ge ${String(step.afterPolls)} ] && _bica_nap=${step.seconds}`,
    ),
    '  _bica_el=$(( $(date +%s) - _bica_t0 ))',
    '  if [ "$_bica_el" -ge "$_bica_beat" ]; then',
    `    _bica_beat=$(( _bica_beat + ${String(heartbeatSeconds)} ))`,
  );
  commands.forEach((c) => {
    lines.push(
      `    [ -f "$_bica_dir/${c.label}.rc" ] || printf '[bica] still running after %ss: %s\\n' "$_bica_el" ${shq(c.label)} >&2`,
    );
  });
  lines.push('  fi', 'done', 'wait');

  lines.push('_bica_failed=0');
  commands.forEach((c, i) => {
    lines.push(
      `_bica_rc${String(i)}=$(cat "$_bica_dir/${c.label}.rc")`,
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
