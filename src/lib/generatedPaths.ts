import { runRemoteScriptOverStdin } from './runRemote';

/**
 * Paths the remote must have before a command runs, because something on the remote produces them
 * rather than the sync delivering them.
 *
 * The case this exists for is narrow and was expensive to diagnose twice. A `postinstall` generates
 * files that are gitignored, so a fresh clone or a `git worktree` does not have them locally. Naming
 * them in `sync.ignore.paths` stops the mirror deleting the remote's copies — but that only protects
 * copies that already exist. On a workspace where they are simply absent, nothing puts them there:
 * the install fingerprint keys on the lockfile, a worktree does not change the lockfile, so the
 * install never runs and `postinstall` never runs with it.
 *
 * The result is a remote check failing with hundreds of errors that name real modules which really
 * are missing — indistinguishable from a genuine failure, and reported as one, by two separate people.
 * So the predicate here is deliberately not "did the lockfile change" but "is the output actually
 * there", checked on the machine that will run the command.
 *
 * Declared per repo because bica has no way to guess. From `bica.yml`:
 *
 *     generated:
 *       paths:
 *         - ui/src/icons/essentials/Icon*.tsx
 *
 * A pattern matching nothing counts as missing, which is the point, and is why a glob is a better
 * declaration than a single representative filename.
 */

/**
 * Whether an entry re-includes rather than declares — `!IconSpinner*.tsx` alongside `Icon*.tsx`.
 *
 * Generated output rarely fills a whole directory. Here the repo's own `.gitignore` reads
 * `Icon*.tsx` then `!IconSpinner*`, because one icon is hand-written and committed. A declaration
 * that could not say the same thing would sweep that file into the sync exclusion and make it
 * permanently unreachable on the remote — which is what happened, and cost a real typecheck error
 * naming a module that was never generated in the first place.
 */
export function isNegatedGeneratedPath(p: string): boolean {
  return p.trim().startsWith('!');
}

/**
 * Reject anything that would let a declared path escape the workspace or the argument.
 * A leading `!` is stripped for validation and preserved in the result.
 */
export function validateGeneratedPath(p: string): string {
  const raw = p.trim();
  const negated = raw.startsWith('!');
  const t = raw.slice(negated ? 1 : 0).trim();
  if (t === '') {
    throw new Error('generated.paths entries must be non-empty');
  }
  if (t.startsWith('/') || t.startsWith('~')) {
    throw new Error(
      `generated.paths entries must be relative to the workspace (got ${JSON.stringify(p)})`,
    );
  }
  if (t.split('/').includes('..')) {
    throw new Error(
      `generated.paths entries must not contain ".." (got ${JSON.stringify(p)})`,
    );
  }
  // The pattern reaches the remote inside a single-quoted `find -path` argument, so a stray quote
  // would end that argument and everything after it would be shell. Refusing the characters outright
  // is a smaller thing to be sure of than escaping them correctly, and a generated path has no
  // legitimate use for any of them.
  if (/[\s'"`$;&|<>()\\]/.test(t)) {
    throw new Error(
      `generated.paths entries may contain only path characters and the globs * ? [ ] ` +
        `(got ${JSON.stringify(p)})`,
    );
  }
  return negated ? `!${t}` : t;
}

/**
 * The script that reports which declared paths are absent, one per line.
 *
 * Matching is done by `find`, not by the shell, and this is the whole reason the function looks the
 * way it does. The first version interpolated the pattern unquoted so the shell would expand it,
 * which works under `sh` — an unmatched glob is left as a literal — and fails under `zsh`, where an
 * unmatched glob is a *fatal error*. bica's remote login shell defaults to `zsh`, so the probe
 * aborted with `no matches found` and reported nothing missing, in exactly the case it exists to
 * detect. The unit tests ran `/bin/sh` and passed throughout.
 *
 * Handing the pattern to `find -path` as a single-quoted argument removes the shell from the
 * matching entirely, so the behaviour no longer depends on which shell the remote happens to use.
 * `-print -quit` stops at the first hit, so a directory of thousands is not walked to answer a
 * yes/no question.
 */
export function buildGeneratedProbeScript(
  workspacePath: string,
  paths: readonly string[],
): string {
  const negations = paths
    .filter((p) => isNegatedGeneratedPath(p))
    .map((p) => validateGeneratedPath(p).slice(1));
  // Applied to every positive check, not just skipped. A negation re-includes a file that the
  // positive pattern also matches -- `IconSpinner.tsx` against `Icon*.tsx` -- so without excluding it
  // here its mere presence makes the whole declaration look satisfied, and the generated files it was
  // standing in for are never noticed as missing. Observed: the committed spinner alone convinced the
  // probe that 346 absent icons were present.
  const excludeTerms = negations.map((n) => `! -path './${n}'`).join(' ');

  const lines = [`cd ${workspacePath} 2>/dev/null || exit 0`];
  for (const raw of paths) {
    if (isNegatedGeneratedPath(raw)) {
      continue;
    }
    const p = validateGeneratedPath(raw);
    const find = `find . -path './${p}'${excludeTerms === '' ? '' : ` ${excludeTerms}`} -print -quit 2>/dev/null`;
    lines.push(`if [ -z "$(${find})" ]; then printf '%s\n' '${p}'; fi`);
  }
  return `${lines.join('\n')}\nexit 0\n`;
}

/** Parse the probe's stdout into the list of missing declarations. */
export function parseMissing(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/**
 * Which declared paths the remote workspace is missing. Empty when there is nothing declared, so the
 * feature costs one ssh round trip only for repos that opt in.
 *
 * A probe that fails to run reports nothing missing rather than guessing. Forcing an install because
 * a connection blipped would be a worse failure than the one this prevents.
 */
export function remoteMissingGeneratedPaths(
  sshHost: string,
  workspacePath: string,
  paths: readonly string[],
): string[] {
  if (paths.length === 0) {
    return [];
  }
  const r = runRemoteScriptOverStdin(
    sshHost,
    buildGeneratedProbeScript(workspacePath, paths),
  );
  if (r.status !== 0) {
    return [];
  }
  return parseMissing(r.stdout);
}
