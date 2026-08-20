/**
 * Global option parsing for the `bica` CLI.
 *
 * Kept out of `cli.ts` so it can be tested without importing the module that runs `main()` on load.
 * Globals are pulled from the *whole* argv, including after `run`, which is why every one of them
 * must be stripped from `rest`: whatever remains after `run` becomes argv on the remote.
 */

export interface ParsedGlobals {
  autoYes: boolean;
  pm: string | undefined;
  /** `--return-flow`: pull remote artifacts back for a pinned run. */
  returnFlow: boolean;
  /** `--ref <rev>`: run a commit's content instead of the live working tree. */
  ref: string | undefined;
  rest: string[];
}

function requireValue(argv: string[], i: number, flag: string, hint: string): string {
  if (i + 1 >= argv.length) {
    throw new Error(`usage: ${flag} requires ${hint}`);
  }
  const next = argv[i + 1];
  if (next.startsWith('-')) {
    throw new Error(`usage: ${flag} requires ${hint}`);
  }
  return next;
}

export function parseArgs(argv: string[]): ParsedGlobals {
  const rest: string[] = [];
  let autoYes = false;
  let pm: string | undefined;
  let returnFlow = false;
  let ref: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') {
      autoYes = true;
    } else if (a === '--return-flow') {
      returnFlow = true;
    } else if (a === '--pm') {
      pm = requireValue(argv, i, '--pm', 'a package-manager plugin id (e.g. pnpm)');
      i += 1;
    } else if (a === '--ref') {
      ref = requireValue(argv, i, '--ref', 'a git ref (branch, tag or commit)');
      i += 1;
    } else {
      rest.push(a);
    }
  }
  return { autoYes, pm, returnFlow, ref, rest };
}
