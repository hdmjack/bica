import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dim, warn } from '../terminalStyle';
import { remotePathExprForCd } from './runRemote';

/**
 * Noticing when a run wrote files, and bringing those files home.
 *
 * `bica run` copies the tree out, runs the command there and streams back stdout. A command that
 * *reads* is served perfectly by that; a command that *writes* has its edits applied to the remote
 * copy and nothing comes back. The command exits 0, the local files are untouched, and the two are
 * indistinguishable — which is how a `pnpm format` gets believed and the Prettier violations it did
 * not fix reach CI.
 *
 * The rule the team carried instead ("never run a formatter through bica") is a documented footgun,
 * and a documented footgun is weakest for exactly the people who have not read it: new joiners, and
 * agents that reach for `bica run <anything>` by default.
 *
 * ## Why this is not a return-flow pattern list
 *
 * Return-flow answers "which paths does the remote own" with a whitelist, and the obvious extension is
 * to invert it into a denylist and mirror everything else back. That is the wrong axis, for three
 * reasons that are all properties of the whitelist rather than of the patterns in it:
 *
 * - The whitelist is what makes `--delete` safe. Return-flow's trailing `- *` protects every
 *   non-matching local file from deletion, which is how obsolete snapshots can be pruned without
 *   endangering anything else. A denylist plus `--delete` means "remove any local file the remote does
 *   not have" — and the remote deliberately does not have plenty: gitignored files, `.env`, everything
 *   in `sync.ignore.paths`.
 * - They fail in opposite directions. A missing whitelist entry means a snapshot does not come back,
 *   which shows up as a test diff you notice. A missing denylist entry means the remote's
 *   `node_modules`, `.next` or `target` crosses the wire into the local tree — unbounded, and growing
 *   with every ecosystem bica supports.
 * - A whitelisted path is also removed from the forward sync, which is how "the remote owns this file"
 *   is expressed. A denylist names everything, so it cannot make that claim about anything.
 *
 * So this decides by *what the run changed*, not by pattern: fingerprint the remote tree either side
 * of the command and take the difference. It is bounded by what actually happened, it makes
 * `bica run --write-back pnpm format` do the obvious thing, and detecting the change is the same work
 * as reporting it — which is why reporting is on by default and the copy home is opt-in.
 *
 * Scoping to files git does not ignore is the denylist we do not have to maintain: build output and
 * dependency trees are ignored already, for the repo's own reasons.
 */

/** How many changed paths to name before summarising the rest. */
const MAX_LISTED = 10;

/**
 * Whether write-back is switched off for this run. Detection costs a `touch` and a pruned `find`, and
 * a caller that knows its command only reads should be able to decline both.
 */
export function writeBackDisabled(): boolean {
  return process.env.BICA_WRITE_BACK?.trim() === '0';
}

/**
 * Marker file whose mtime the post-run `find` compares against.
 *
 * Outside the workspace, deliberately. Inside it, the marker is itself a file created after the push,
 * so it matches its own probe, and the next pinned push would delete it as remote-only content.
 */
export function writeBackMarkerPath(runId: string): string {
  return `/tmp/bica-write-back-${runId.replaceAll(/[^A-Za-z0-9_.-]/g, '')}`;
}

/**
 * Reject anything that would let a configured ignore path escape the single-quoted `find` argument it
 * is interpolated into. Same reasoning as `generated.paths`: refusing these characters is a smaller
 * thing to be sure of than escaping them correctly, and an ignore path has no use for any of them.
 */
export function validateProbePattern(p: string): string | null {
  const t = p.trim();
  if (t === '' || t.startsWith('!')) {
    return null;
  }
  if (/[\s'"`$;&|<>()\\]/.test(t)) {
    return null;
  }
  return t.replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * `find` prune terms for the trees neither side should be comparing.
 *
 * `.git` and `.bica` are always pruned — the first is mirrored by its own rsync, the second is
 * local-only state. Everything else comes from the paths the user already told bica each side owns
 * independently, plus the return-flow patterns, which have their own transport and must not be
 * reported twice.
 *
 * A bare name (`node_modules`) is matched at any depth, the way Mutagen ignore syntax means it; a
 * pattern with a slash is matched as a path from the workspace root, where `find`'s `*` applies.
 */
export function buildPruneTerms(ignorePaths: readonly string[]): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const raw of ['.git', '.bica', ...ignorePaths]) {
    const p = validateProbePattern(raw);
    if (p === null || p === '' || seen.has(p)) {
      continue;
    }
    seen.add(p);
    terms.push(p.includes('/') ? `-path './${p}'` : `-name '${p}'`);
  }
  return terms;
}

/**
 * The script that lists every file written since the marker, one per line, and then removes the
 * marker so a killed run leaves nothing behind.
 *
 * Matching is `find`'s, not the shell's, for the reason the generated-paths probe learned the hard
 * way: bica's remote login shell defaults to `zsh`, where an unmatched glob is a fatal error rather
 * than a literal, so a shell-expanded pattern aborts the probe in exactly the case it exists to catch.
 */
export function buildWriteBackProbeScript(options: {
  remoteWorkspacePath: string;
  markerPath: string;
  ignorePaths: readonly string[];
}): string {
  const prune = buildPruneTerms(options.ignorePaths);
  const pruneExpr =
    prune.length === 0 ? '' : `\\( ${prune.join(' -o ')} \\) -prune -o `;
  const marker = `'${options.markerPath}'`;
  return [
    `cd ${remotePathExprForCd(options.remoteWorkspacePath)} 2>/dev/null || exit 0`,
    `[ -e ${marker} ] || exit 0`,
    `find . ${pruneExpr}-type f -newer ${marker} -print 2>/dev/null`,
    `rm -f ${marker}`,
    'exit 0',
  ].join('\n');
}

/** Create the marker. Returns false when the remote could not be reached; the caller then skips detection. */
export function placeWriteBackMarker(
  sshHost: string,
  markerPath: string,
  run: RemoteScriptRunner,
): boolean {
  return run(sshHost, `: > '${markerPath}'\nexit 0\n`).status === 0;
}

/** Signature of {@link runRemoteScriptOverStdin}, injected so the probe is testable without a host. */
export type RemoteScriptRunner = (
  sshHost: string,
  script: string,
) => { status: number; stdout: string; stderr: string };

/**
 * Parse the probe's stdout into workspace-relative paths, sorted.
 *
 * `find` emits in traversal order, which puts a directory's files next to each other but is otherwise
 * arbitrary — and the report caps the list, so traversal order decides which paths a reader is shown.
 * Sorting makes that a stable, guessable set rather than a different ten each run.
 */
export function parseChangedPaths(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => l.replace(/^\.\//, ''))
    .filter((l) => l !== '')
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Drop the paths git ignores.
 *
 * This is the bound on everything downstream. `node_modules`, `dist` and friends are ignored for the
 * repo's own reasons, so using that answer means the list of things that must never cross the wire is
 * maintained by the repo rather than by bica — and it is the same rule `contentIdentity` already uses
 * to decide what a run's tree OID names, so the two agree about which files a run is *about*.
 *
 * A git that cannot answer yields the input unchanged rather than a guess; the conflict guard
 * downstream is what actually protects the local tree.
 */
export function dropIgnoredPaths(
  repoRoot: string,
  paths: readonly string[],
): string[] {
  if (paths.length === 0) {
    return [];
  }
  const check = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: repoRoot,
    input: paths.join('\n'),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  // 0 = some paths are ignored, 1 = none are, anything else = git could not answer.
  if (check.status !== 0 && check.status !== 1) {
    return [...paths];
  }
  const ignored = new Set(
    (check.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean),
  );
  return paths.filter((p) => !ignored.has(p));
}

/** Blob OIDs of every file in a tree, keyed by path. Null when git cannot read the tree. */
export function readTreeBlobs(
  repoRoot: string,
  treeOid: string,
): Map<string, string> | null {
  const out = spawnSync('git', ['ls-tree', '-r', '-z', treeOid], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (out.status !== 0) {
    return null;
  }
  return parseLsTreeZ(out.stdout ?? '');
}

/** Parse `git ls-tree -r -z` output: `<mode> <type> <oid>\t<path>\0`. */
export function parseLsTreeZ(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of stdout.split('\0')) {
    if (record === '') {
      continue;
    }
    const tab = record.indexOf('\t');
    if (tab === -1) {
      continue;
    }
    const fields = record.slice(0, tab).split(' ');
    if (fields.length < 3 || fields[1] !== 'blob') {
      continue;
    }
    map.set(record.slice(tab + 1), fields[2]);
  }
  return map;
}

/** Git object ids for local files, in the order given. Missing/unreadable files map to null. */
export function hashLocalFiles(
  repoRoot: string,
  paths: readonly string[],
): (string | null)[] {
  const existing: string[] = [];
  const present = paths.map((p) => {
    const abs = path.join(repoRoot, p);
    let isFile = false;
    try {
      isFile = fs.statSync(abs).isFile();
    } catch {
      isFile = false;
    }
    if (isFile) {
      existing.push(p);
    }
    return isFile;
  });
  if (existing.length === 0) {
    return paths.map(() => null);
  }
  const out = spawnSync('git', ['hash-object', '--stdin-paths'], {
    cwd: repoRoot,
    input: `${existing.join('\n')}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const oids =
    out.status === 0
      ? (out.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
      : [];
  // A short or failed answer must not be read as "these files are unchanged": every path whose OID
  // we did not get is treated as locally modified, so the guard below refuses it rather than
  // overwriting it.
  const byPath = new Map<string, string>();
  existing.forEach((p, i) => {
    const oid = oids[i];
    if (oid !== undefined) {
      byPath.set(p, oid);
    }
  });
  return paths.map((p, i) => (present[i] ? (byPath.get(p) ?? 'unknown') : null));
}

export interface WriteBackPartition {
  /** Files the run changed that are still exactly as bica shipped them, so overwriting loses nothing. */
  safe: string[];
  /** Files the run changed that were *also* edited locally while it was out. Never overwritten. */
  conflicted: string[];
}

/**
 * Split the run's changes by whether the local copy has moved since the push.
 *
 * This is the guard that makes a background run safe to leave running while you keep working. The
 * push already names the exact content it shipped — a git tree OID, computed either side of the
 * transfer to prove the tree did not move during it — so "is this file still how bica left it" is a
 * blob comparison against that tree, not a timestamp heuristic.
 *
 * Equal means nobody touched it and the remote's version can land. Different means you edited it
 * while the run was out, and copying the remote's version over the top would silently eat your work;
 * that file is skipped and named instead. A file the pushed tree did not contain is new, and is safe
 * exactly when nothing of that name exists locally.
 *
 * A tree git cannot read yields everything as conflicted: with no baseline there is no way to tell
 * an untouched file from an edited one, and the only honest move is to overwrite nothing.
 */
export function partitionByLocalEdits(options: {
  repoRoot: string;
  treeOid: string | undefined;
  paths: readonly string[];
}): WriteBackPartition {
  const { repoRoot, treeOid, paths } = options;
  if (paths.length === 0) {
    return { safe: [], conflicted: [] };
  }
  const pushed = treeOid === undefined ? null : readTreeBlobs(repoRoot, treeOid);
  if (pushed === null) {
    return { safe: [], conflicted: [...paths] };
  }
  const local = hashLocalFiles(repoRoot, paths);
  const safe: string[] = [];
  const conflicted: string[] = [];
  paths.forEach((p, i) => {
    const before = pushed.get(p) ?? null;
    (local[i] === before ? safe : conflicted).push(p);
  });
  return { safe, conflicted };
}

/**
 * rsync argv to copy exactly the named files back, and nothing else.
 *
 * `--files-from` is the whole reason this is safe next to return-flow: the transfer is enumerated
 * rather than pattern-matched, so there is no rule that could match more than was asked for. There is
 * deliberately no `--delete` — an enumerated pull has nothing to prune, and a mirror is precisely the
 * thing this design is avoiding.
 */
export function buildWriteBackPullArgs(options: {
  remoteSyncUrl: string;
  repoRoot: string;
}): string[] {
  const source = options.remoteSyncUrl.endsWith('/')
    ? options.remoteSyncUrl
    : `${options.remoteSyncUrl}/`;
  const dest = options.repoRoot.endsWith('/')
    ? options.repoRoot
    : `${options.repoRoot}/`;
  return ['-a', '--files-from=-', '--from0', source, dest];
}

/** Human list of paths, capped so a thousand-file codemod does not fill the terminal. */
export function describePaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED).map((p) => `    ${p}`).join('\n');
  const more =
    paths.length > MAX_LISTED
      ? `\n    …and ${String(paths.length - MAX_LISTED)} more`
      : '';
  return `${shown}${more}`;
}

export interface WriteBackOutcome {
  /** Files the command wrote, after ignored paths are dropped. */
  changed: string[];
  /** Files copied back into the local tree. Empty unless the caller opted in. */
  pulled: string[];
  /** Files left alone because the local copy had moved on. */
  conflicted: string[];
}

/**
 * Ask the remote what the command wrote, and copy back the part that is safe to copy.
 *
 * Best-effort throughout: a probe that cannot run reports nothing rather than guessing, and nothing
 * here throws, so the remote command's exit code is never masked by a failure to look at its
 * side-effects.
 */
export function collectWriteBack(options: {
  sshHost: string;
  remoteWorkspacePath: string;
  remoteSyncUrl: string;
  repoRoot: string;
  markerPath: string;
  ignorePaths: readonly string[];
  /** Content name of the tree that was pushed, for the local-edit guard. */
  pushedTreeOid: string | undefined;
  /** Whether to copy the safe files back, as opposed to only naming them. */
  pull: boolean;
  run: RemoteScriptRunner;
}): WriteBackOutcome {
  const probe = options.run(
    options.sshHost,
    buildWriteBackProbeScript({
      remoteWorkspacePath: options.remoteWorkspacePath,
      markerPath: options.markerPath,
      ignorePaths: options.ignorePaths,
    }),
  );
  if (probe.status !== 0) {
    return { changed: [], pulled: [], conflicted: [] };
  }
  const changed = dropIgnoredPaths(
    options.repoRoot,
    parseChangedPaths(probe.stdout),
  );
  if (changed.length === 0 || !options.pull) {
    return { changed, pulled: [], conflicted: [] };
  }

  const { safe, conflicted } = partitionByLocalEdits({
    repoRoot: options.repoRoot,
    treeOid: options.pushedTreeOid,
    paths: changed,
  });
  if (safe.length === 0) {
    return { changed, pulled: [], conflicted };
  }

  const result = spawnSync(
    'rsync',
    buildWriteBackPullArgs({
      remoteSyncUrl: options.remoteSyncUrl,
      repoRoot: options.repoRoot,
    }),
    {
      // NUL-separated, so a path containing whitespace or a quote is carried literally.
      input: `${safe.join('\0')}\0`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    },
  );
  if ((result.status ?? 1) !== 0) {
    const err = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    process.stderr.write(
      `${warn('[bica]')} ${dim(`write-back rsync exited ${String(result.status ?? 1)}${err ? `: ${err}` : ''}`)}\n`,
    );
    return { changed, pulled: [], conflicted };
  }
  return { changed, pulled: safe, conflicted };
}

/**
 * Say what the run did to the files, on stderr.
 *
 * Printed unconditionally rather than through `chrome`, which hides itself when stdout is piped. The
 * audience that most needs this — CI, an agent's shell tool — is exactly the audience running with a
 * pipe, and a warning only a human at a TTY can see would repeat the fault this feature exists to fix.
 */
export function reportWriteBack(outcome: WriteBackOutcome, pulled: boolean): void {
  const n = outcome.changed.length;
  if (n === 0) {
    return;
  }
  const count = `${String(n)} file${n === 1 ? '' : 's'}`;
  if (!pulled) {
    process.stderr.write(
      `${warn('[bica]')} This command wrote ${count} on the remote. They stay there — your local tree is unchanged:\n` +
        `${describePaths(outcome.changed)}\n` +
        `${dim('    Re-run with --write-back to copy them home, or run the command locally.')}\n`,
    );
    return;
  }
  if (outcome.pulled.length > 0) {
    process.stderr.write(
      `${dim('[bica]')} Copied back ${String(outcome.pulled.length)} file(s) the command wrote:\n${describePaths(outcome.pulled)}\n`,
    );
  }
  if (outcome.conflicted.length > 0) {
    process.stderr.write(
      `${warn('[bica]')} Left ${String(outcome.conflicted.length)} file(s) alone: you changed them locally while the run was out, ` +
        'so the remote version would overwrite your edits:\n' +
        `${describePaths(outcome.conflicted)}\n` +
        `${dim('    Re-run the command once your tree has settled, or apply those changes yourself.')}\n`,
    );
  }
}
