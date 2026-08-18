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
  /** `--lane <id|auto>`; undefined means the default single workspace. */
  lane: string | undefined;
  /** `--lanes N`: lane pool size for this invocation. */
  lanes: number | undefined;
  /** `--return-flow`: opt a lane run back into pulling remote artifacts. */
  returnFlow: boolean;
  /** `--ref <rev>`: pin a lane run to a commit instead of the live working tree. */
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
  let lane: string | undefined;
  let lanes: number | undefined;
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
    } else if (a === '--lane') {
      lane = requireValue(argv, i, '--lane', 'a lane id or "auto"');
      i += 1;
    } else if (a === '--lanes') {
      const raw = requireValue(argv, i, '--lanes', 'a lane pool size (integer)');
      const n = Number(raw);
      if (!Number.isInteger(n)) {
        throw new Error('usage: --lanes requires a lane pool size (integer)');
      }
      lanes = n;
      i += 1;
    } else {
      rest.push(a);
    }
  }
  return { autoYes, pm, lane, lanes, returnFlow, ref, rest };
}
