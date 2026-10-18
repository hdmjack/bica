import type { SpawnSyncReturns } from 'node:child_process';

/**
 * Reading the whole of a subprocess's output, and saying so when we could not.
 *
 * Node caps a captured stdout at 1 MiB by default and, on reaching it, kills the child with SIGTERM
 * and sets `result.error` to ENOBUFS. Nothing about that resembles the truth from the outside: rsync
 * handles the signal and exits 20, so a caller reading only the status reports a transfer failure,
 * quotes a megabyte of perfectly ordinary itemised output as the evidence, and sends the reader to
 * look at rsync.
 *
 * Reported from an llvm-blackfin worktree, where every pinned run failed before the command started.
 * The tree has 180,677 files; a mirror whose timestamps differ lists all of them, and 1 MiB is about
 * 15,000 lines in. The command was `true`, so there was nothing to blame but bica.
 *
 * The size here is the one `writeBack.ts` already used for `git ls-tree` on the same trees. It is a
 * ceiling rather than an allocation, and the alternative -- streaming every one of these call sites
 * -- buys nothing until a tree's file list approaches a quarter of a gigabyte.
 */
export const SUBPROCESS_MAX_BUFFER = 256 * 1024 * 1024;

/** Longest stretch of a child's output worth putting in an error message. */
const QUOTED_OUTPUT_LIMIT = 2_000;

/**
 * Trim captured output down to something a person can read.
 *
 * A failure message carrying 15,000 itemised lines buries the one line that explains it, and the
 * explanation is nearly always at the end -- so the tail is what is kept.
 */
export function quoteSubprocessOutput(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= QUOTED_OUTPUT_LIMIT) {
    return trimmed;
  }
  const kept = trimmed.slice(-QUOTED_OUTPUT_LIMIT);
  const dropped = trimmed.length - QUOTED_OUTPUT_LIMIT;
  return `… ${String(dropped)} earlier characters omitted …\n${kept}`;
}

/**
 * What actually went wrong, preferring Node's own complaint to the child's exit status.
 *
 * `result.error` is set when the child never ran, or was killed by Node rather than by its own
 * logic. In both cases the exit status describes the consequence and not the cause, so a message
 * built from the status alone points at the wrong thing.
 */
export function describeSpawnFailure(
  result: Pick<SpawnSyncReturns<string>, 'error' | 'status' | 'stdout' | 'stderr'>,
  what: string,
): string {
  const output = quoteSubprocessOutput(
    `${result.stderr ?? ''}${result.stdout ?? ''}`,
  );
  const error = result.error as (Error & { code?: string }) | undefined;
  if (error !== undefined) {
    if (error.code === 'ENOBUFS') {
      return (
        `${what} produced more output than bica could hold, so it was killed part-way through. ` +
        'This is a bug in bica, not a failure of the transfer.'
      );
    }
    return `${what} could not be run: ${error.message}`;
  }
  return `${what} exited ${String(result.status ?? 1)}${output ? `: ${output}` : ''}`;
}
