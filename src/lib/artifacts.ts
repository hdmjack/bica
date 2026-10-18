import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { SUBPROCESS_MAX_BUFFER } from './subprocessOutput';

/**
 * Named outputs copied home from a tree the remote owns.
 *
 * Return-flow cannot do this, by construction. It folds `sync.ignore.paths` into its own excludes,
 * because those paths name trees each side owns independently and mirroring artifacts across them is
 * exactly what it must not do. But a build directory *has* to be ignored -- it is 8-20GB, it must
 * survive every run, and leaving it mirrored means the local side, which has no `build/`, deletes it
 * -- and the binaries worth having are inside it. So the two requirements meet head on: the only
 * place the outputs can live is the one place return-flow is forbidden to look.
 *
 * `artifacts:` is the explicit exception. Each entry names something to copy remote to local after
 * the run, by name rather than by pattern, with no mirroring and no `--delete` in either direction.
 * Naming them one at a time is the safety: a whitelist of specific outputs cannot walk into a 20GB
 * build tree the way a glob can.
 *
 * The workaround this replaces was a script that `cp -L`'d binaries into a whitelisted directory so
 * return-flow would carry them -- which is the same copy, done twice, with a directory invented to
 * hold it.
 */

/** How an artifact pull is run. Injectable so the shape of the commands can be tested without ssh. */
export type RsyncRunner = (args: readonly string[]) => {
  status: number;
  stdout: string;
  stderr: string;
};

/**
 * rsync's way of saying the source is not there.
 *
 * Not an error worth reporting: an artifact names what a build *will* produce, and before it has --
 * or when the build failed before reaching it -- the honest report is that there is nothing to bring
 * home, not that the copy went wrong. openrsync words it differently from GNU rsync, so both.
 */
const SOURCE_NOT_THERE =
  /No such file or directory|empty file list|link_stat .* failed|change_dir .* failed/;

export interface ArtifactOutcome {
  /** The configured path, as written in `bica.yml`. */
  path: string;
  /** Files that actually changed. Empty when the remote's copy already matched. */
  changed: string[];
  /** The remote has not got it: a build that has not produced it yet, or did not get that far. */
  missing?: boolean;
  /** Set when rsync failed for some other reason; the run is not failed for it, but it is said. */
  error?: string;
}

/**
 * Where the artifact lands locally.
 *
 * A file goes into its own directory (`build/bin/llc` → `<repo>/build/bin/`), a trailing slash means
 * the artifact is a tree and its contents go into the matching tree. Spelled out rather than left to
 * `--relative`: macOS ships openrsync, which does not honour the `/./` marker that would otherwise
 * carry the path across, and silently recreated the remote's whole absolute path under the repo root
 * instead -- `./Users/haakonjack/code/bica-art-repro/build/bin/llc`, found only by running it.
 */
export function artifactDestination(
  repoRoot: string,
  artifactPath: string,
): string {
  const clean = artifactPath.replace(/^\.?\//, '');
  const root = repoRoot.replace(/\/+$/, '');
  if (clean.endsWith('/')) {
    return `${root}/${clean}`;
  }
  const lastSlash = clean.lastIndexOf('/');
  return lastSlash === -1 ? `${root}/` : `${root}/${clean.slice(0, lastSlash + 1)}`;
}

/**
 * `-L` follows symlinks and copies what they point at, because the thing wanted locally is the
 * binary: `build/bin/clang` is a link to `clang-23`, and a copied link points at a path that does
 * not exist on this machine.
 *
 * No `--info=`: openrsync rejects it and prints its usage, which is how the first version of the
 * workspace seed failed with "source ... directory" and nothing else.
 */
export function buildArtifactRsyncArgs(options: {
  remoteSyncUrl: string;
  repoRoot: string;
  artifactPath: string;
}): string[] {
  const clean = options.artifactPath.replace(/^\.?\//, '');
  return [
    '-az',
    '-L',
    '--itemize-changes',
    `${options.remoteSyncUrl}/${clean}`,
    artifactDestination(options.repoRoot, options.artifactPath),
  ];
}

/**
 * The files rsync says it actually transferred.
 *
 * `--itemize-changes` prints a line per item, of which the first character says what happened: `>`
 * for something received, `c` for something created. A directory line (`cd`) is structure rather
 * than content, and counting those would report "copied" for a run that brought back nothing.
 */
export function parseItemizedChanges(stdout: string): string[] {
  const changed: string[] = [];
  // Split on the gap rather than at a fixed column: GNU rsync writes eleven flag characters and
  // openrsync, which is what macOS has, writes nine. Slicing at twelve took three characters off the
  // front of every name openrsync reported.
  const itemized = /^([<>ch.*][fdLDS]\S*)\s+(.+)$/;
  for (const line of stdout.split('\n')) {
    const match = itemized.exec(line.trimEnd());
    if (match === null) {
      continue;
    }
    const [, code, name] = match;
    if (name === './' || code[1] === 'd') {
      // A directory line is structure rather than content; counting those would report "copied" for
      // a run that brought back nothing.
      continue;
    }
    if (code.startsWith('>') || code.startsWith('c')) {
      changed.push(name);
    }
  }
  return changed;
}

function defaultRunner(args: readonly string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('rsync', [...args], {
    encoding: 'utf8',
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    shell: false,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function pullArtifacts(options: {
  artifacts: readonly string[];
  remoteSyncUrl: string;
  repoRoot: string;
  run?: RsyncRunner;
}): ArtifactOutcome[] {
  const run = options.run ?? defaultRunner;
  return options.artifacts.map((artifactPath) => {
    // openrsync has no `--mkpath`, and a destination directory that does not exist is an error
    // rather than something it creates.
    try {
      fs.mkdirSync(artifactDestination(options.repoRoot, artifactPath), {
        recursive: true,
      });
    } catch {
      // Left to rsync to report: it says the same thing with the path in it.
    }
    const result = run(
      buildArtifactRsyncArgs({
        remoteSyncUrl: options.remoteSyncUrl,
        repoRoot: options.repoRoot,
        artifactPath,
      }),
    );
    if (result.status !== 0) {
      const said = result.stderr.trim();
      if (SOURCE_NOT_THERE.test(said)) {
        return { path: artifactPath, changed: [], missing: true };
      }
      // Not fatal. The command's own result is the run's result, and an artifact that could not be
      // fetched must not turn a reported failure into a different one.
      return {
        path: artifactPath,
        changed: [],
        error: said.split('\n').at(-1) ?? `rsync exited ${String(result.status)}`,
      };
    }
    return { path: artifactPath, changed: parseItemizedChanges(result.stdout) };
  });
}

/**
 * What to say about a pull, in the shape `--write-back` uses for what it wrote.
 *
 * A directory artifact can be thousands of files, so those are counted rather than listed; a single
 * binary is named, because that is the whole point of naming it in the first place.
 */
export function describeArtifactPull(
  outcomes: readonly ArtifactOutcome[],
): string | undefined {
  if (outcomes.length === 0) {
    return undefined;
  }
  const lines: string[] = [];
  const copied = outcomes.filter((o) => o.changed.length > 0);
  for (const outcome of copied) {
    lines.push(
      outcome.changed.length === 1
        ? `Brought home ${outcome.path}.`
        : `Brought home ${outcome.path} (${String(outcome.changed.length)} files).`,
    );
  }
  for (const outcome of outcomes) {
    if (outcome.error !== undefined) {
      lines.push(`Could not bring home ${outcome.path}: ${outcome.error}`);
    }
  }
  const missing = outcomes.filter((o) => o.missing === true);
  if (lines.length === 0 && missing.length === outcomes.length) {
    return `Nothing to bring home yet (${missing.map((o) => o.path).join(', ')} not on the remote).`;
  }
  if (lines.length === 0) {
    // Said rather than left silent: "nothing changed" and "the pull never ran" look identical
    // otherwise, and these are the outputs somebody is waiting for.
    return `Artifacts unchanged (${outcomes.map((o) => o.path).join(', ')}).`;
  }
  return lines.join('\n');
}

/**
 * Artifacts that the mirror will delete before anything can be copied home.
 *
 * An artifact only survives if the sync is leaving its tree alone. Listed under a path the mirror
 * owns, the file exists remotely and not locally, which is the exact predicate `--delete` acts on,
 * so it is removed during the run and the pull afterwards finds nothing. That is a silent empty
 * result, so it is worth saying up front.
 */
export function artifactsNotProtected(options: {
  artifacts: readonly string[];
  syncIgnorePaths: readonly string[];
  generatedPaths: readonly string[];
}): string[] {
  const guarded = [...options.syncIgnorePaths, ...options.generatedPaths].map(
    (p) => p.replace(/^\.?\//, '').replace(/\/+$/, ''),
  );
  return options.artifacts.filter((artifact) => {
    const clean = artifact.replace(/^\.?\//, '');
    return !guarded.some(
      (g) => g !== '' && (clean === g || clean.startsWith(`${g}/`)),
    );
  });
}
