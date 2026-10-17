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
  /**
   * `--write-back`: copy home the files the command wrote, rather than only naming them.
   *
   * Implies a pinned run. A live session is designed to keep the remote an exact copy of local, so it
   * reverts the very writes this would be copying back; pinning is what holds them still.
   */
  writeBack: boolean;
  /**
   * `--detach`: start the command on the remote and return once it is running.
   *
   * Implies a pinned run. The tree is pushed once and then left alone, which is what a 50-minute
   * build wants: a live session would go on mirroring local edits into a tree being compiled.
   */
  detach: boolean;
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
  let writeBack = false;
  let detach = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') {
      autoYes = true;
    } else if (a === '--return-flow') {
      returnFlow = true;
    } else if (a === '--write-back') {
      writeBack = true;
    } else if (a === '--detach') {
      detach = true;
    } else if (a === '--pm') {
      pm = requireValue(argv, i, '--pm', 'a package-manager plugin id (e.g. pnpm)');
      i += 1;
    } else {
      rest.push(a);
    }
  }
  return { autoYes, pm, returnFlow, writeBack, detach, rest };
}
