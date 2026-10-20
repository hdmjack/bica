/**
 * Splitting `bica run`'s argv into the commands it should run at once.
 *
 * `--` used to be the separator, and it was the wrong choice in a way that lost people's arguments.
 * `--` is how every runner in common use is told "the rest belongs to the program, not to you":
 * `cargo run -p x -- 1 1024`, `pnpm test -- --coverage`, `npm run build -- --watch`. bica read those
 * as two commands, ran the first without the arguments it had been given, and ran `1 1024` as a
 * program. The cargo case was reported after it exited 0 -- the binary defaulted to the very values
 * that had been dropped, so the output looked right.
 *
 * So `--` belongs to the program, and parallel commands are separated by `--also`, which nothing
 * else claims. Running whole commands side by side is bica's own idea and can have bica's own word.
 *
 * One release of transition, because the old form is written down in people's notes and in at least
 * one agent's standing instructions. A `--` in the old shape is refused rather than quietly
 * reinterpreted: two commands would otherwise silently become one long one, failing somewhere that
 * says nothing about why. "Old shape" is deliberately narrow -- see {@link looksLikeOldParallelForm}.
 */

export const PARALLEL_SEPARATOR = '--also';

/**
 * Programs whose name just after a `--` almost certainly meant "and then run this one".
 *
 * The ones bica has plugins for, plus the runners people chain. This list only has to hold for one
 * release, and only has to catch the form that was being recommended: `pnpm lint -- pnpm typecheck`.
 */
const KNOWN_RUNNERS: ReadonlySet<string> = new Set([
  'pnpm',
  'npm',
  'yarn',
  'bun',
  'cargo',
  'node',
  'python',
  'python3',
  'make',
  'ninja',
  'just',
  'go',
  'deno',
  'ruby',
]);

/**
 * Whether a `--` here more likely meant "another command" than "the rest is arguments".
 *
 * Narrow on purpose, and the two kinds of mistake are not symmetric. A false positive refuses a
 * command that would have worked, and says exactly how to write it. A false negative runs somebody's
 * old two-command line as one, which fails visibly and at once. The test is that the token after
 * `--` names a runner, or repeats the program the line already began with: true of
 * `pnpm lint -- pnpm typecheck`, false of `cargo run -p x -- 1 1024`.
 */
export function looksLikeOldParallelForm(
  first: readonly string[],
  afterSeparator: string | undefined,
): boolean {
  if (afterSeparator === undefined || afterSeparator.startsWith('-')) {
    return false;
  }
  return KNOWN_RUNNERS.has(afterSeparator) || afterSeparator === first[0];
}

/**
 * Split `a b --also c d` into argv lists, leaving every `--` exactly where the caller put it.
 *
 * Never shell-splits: each token stays one argument, or `pnpm test "a b"` would become two.
 */
export function splitParallelCommands(tail: readonly string[]): string[][] {
  const out: string[][] = [[]];
  for (const token of tail) {
    if (token === PARALLEL_SEPARATOR) {
      out.push([]);
      continue;
    }
    out[out.length - 1].push(token);
  }
  const commands = out.filter((c) => c.length > 0);

  for (const cmd of commands) {
    if (cmd[0].startsWith('-')) {
      throw new Error(
        `"${cmd[0]}" cannot start a command — bica expects a program to run.\n` +
          'If it is a flag for the command before it, it belongs on the same side of ' +
          `\`${PARALLEL_SEPARATOR}\`; everything after \`run\` reaches the remote as argv:\n` +
          '  bica run pnpm test --coverage\n' +
          `\`${PARALLEL_SEPARATOR}\` separates whole commands that should run at the same time:\n` +
          `  bica run pnpm lint ${PARALLEL_SEPARATOR} pnpm typecheck\n` +
          'If it is meant as a bica option, it is not one; see `bica help`.',
      );
    }
  }

  // The transition, and only while the caller has not said `--also` anywhere. Once they have, they
  // are writing the new syntax and their `--` means what `--` means everywhere else.
  if (commands.length === 1) {
    const at = commands[0].indexOf('--');
    const next = commands[0][at + 1];
    if (at !== -1 && looksLikeOldParallelForm(commands[0], next)) {
      const before = commands[0].slice(0, at).join(' ');
      const after = commands[0].slice(at + 1).join(' ');
      throw new Error(
        '`--` no longer separates commands at bica run, because it is how a program is given its ' +
          `own arguments everywhere else.\n"${String(next)}" after it names a program, so bica ` +
          'cannot tell which you meant and is refusing rather than guessing.\n\n' +
          'If they are two commands to run at once:\n' +
          `  bica run ${before} ${PARALLEL_SEPARATOR} ${after}\n\n` +
          'If it is one command and `--` belongs to the program, nothing needs changing in\n' +
          'general — a `--` followed by anything that does not name a program already passes\n' +
          'straight through, as in `cargo run -p x -- 1 1024`. This case is ambiguous only\n' +
          `because "${String(next)}" happens to be a program name too.\n\n` +
          'This refusal applies only while the old meaning is still in circulation. It goes away\n' +
          'in the next release, after which `--` always belongs to the program.',
      );
    }
  }

  return commands;
}
