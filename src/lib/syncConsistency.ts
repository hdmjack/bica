/**
 * Config that will mislead the remote compiler, named before it does.
 *
 * Some files describe others. A TypeScript composite build writes `dist` and a `*.tsbuildinfo` that
 * records what is in it; `tsc --build` reads the record, decides from it which projects are already
 * current, and typechecks consumers against the `.d.ts` files it believes are there. The two are one
 * fact in two files, and they have to arrive from the same side.
 *
 * Ignoring `dist` alone — which is the right thing to do, and which bica's own scaffold recommends —
 * pushes the record while withholding what it describes. The remote compiler then skips rebuilding a
 * package it has been told is current and typechecks against a `dist` left by whichever branch last
 * built there. The result is several dozen type errors that exist neither locally nor in CI, blamed
 * on the code, and sticky until something forces a full rebuild.
 *
 * That took an afternoon to diagnose from the compiler output alone, which is why this says it up
 * front instead.
 */

export interface CompanionRule {
  /** The output, as it appears in `sync.ignore.paths`. */
  output: string;
  /** The record describing it. */
  record: string;
  why: string;
}

export const COMPANION_RULES: readonly CompanionRule[] = [
  {
    output: 'dist',
    record: '*.tsbuildinfo',
    why:
      '`tsc --build` reads *.tsbuildinfo to decide which packages are already built. Sent without the ' +
      'dist it describes, it makes the remote skip rebuilding them and typecheck against whatever is ' +
      'there — type errors that exist on no machine.',
  },
];

/** Whether a pattern list covers a path, by exact match or by the obvious glob. */
function covers(patterns: readonly string[], target: string): boolean {
  return patterns.some((raw) => {
    const pattern = raw.trim().replace(/^["']|["']$/g, '');
    if (pattern === target) {
      return true;
    }
    if (target.startsWith('*.') && pattern.endsWith(target.slice(1))) {
      return true;
    }
    return false;
  });
}

export interface SyncInconsistency {
  rule: CompanionRule;
  message: string;
}

/**
 * Ignore lists where one half of a pair is withheld and the other is sent.
 *
 * Only ever this direction. Ignoring the record while sending the output is harmless — the remote
 * rebuilds what it cannot prove is current, which is slower and correct.
 */
export function findSyncInconsistencies(
  ignorePaths: readonly string[],
): SyncInconsistency[] {
  return COMPANION_RULES.filter(
    (rule) => covers(ignorePaths, rule.output) && !covers(ignorePaths, rule.record),
  ).map((rule) => ({
    rule,
    message:
      `sync.ignore.paths keeps \`${rule.output}\` off the remote but sends \`${rule.record}\`. ` +
      `${rule.why} Add \`"${rule.record}"\` to the same list.`,
  }));
}

/**
 * The records an ignored output needs ignored with it, added for a config that has not said.
 *
 * The warning alone did not get the line written: float-javascript's checkouts printed it before every
 * run for two days while a typecheck reported names that exist in no tree. So for a config that
 * ignores the output and says nothing about the record, bica ignores the record too, the way it adds
 * Rust's `target`.
 *
 * Never overrides a decision. Any pattern that mentions the record -- to ignore it, or `!` to send it
 * -- is left exactly as written.
 */
export function withCompanionRecordsIgnored(ignorePaths: readonly string[]): {
  paths: string[];
  added: string[];
} {
  const added = COMPANION_RULES.filter((rule) => {
    const suffix = rule.record.replace(/^\*/, '');
    return (
      covers(ignorePaths, rule.output) &&
      !ignorePaths.some((p) => p.includes(suffix))
    );
  }).map((rule) => rule.record);
  return { paths: [...ignorePaths, ...added], added };
}

