import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The two things a Rust checkout needs that bica's defaults get wrong.
 *
 * `target/` is the first. It is a build tree the remote owns -- gigabytes of it, and the only reason
 * a second build is faster than the first -- but it is gitignored, so a local checkout usually has
 * none. A mirror that deletes what the local side does not have therefore removes it between runs,
 * and every build is a clean build. Declaring it in `sync.ignore.paths` fixes that and nobody does,
 * because nothing says to; so for a repository that is evidently Rust, bica declares it.
 *
 * Submodules are the second. `.git` is ignored by the sync and copied by `git.sync` instead, and that
 * ignore matches at every level -- so a submodule's own `.git`, which is a one-line file naming a
 * path inside the parent's `.git/modules`, never reaches the remote. The parent's modules directory
 * does, since it lives inside `.git`. The result is a remote with all the submodule data present and
 * nothing pointing at it, where `git submodule status` reports every submodule as uninitialised.
 * rustc's bootstrap reads exactly that.
 */

/** Rust's build directory, owned by whichever machine built there. */
export const CARGO_TARGET_DIR = 'target';

export function looksLikeRustRepo(repoRoot: string): boolean {
  return (
    fs.existsSync(path.join(repoRoot, 'Cargo.toml')) ||
    fs.existsSync(path.join(repoRoot, 'Cargo.lock'))
  );
}

/**
 * `target` added to the ignore list for a Rust repo that has not spoken for itself.
 *
 * Never overrides a decision: a repository that already mentions `target` -- to ignore it, or by
 * listing something under it -- is left exactly as written. The point is a default for the people
 * who have not thought about it, not a rule for the people who have.
 */
export function withCargoTargetIgnored(
  repoRoot: string,
  ignorePaths: readonly string[],
): { paths: string[]; added: boolean } {
  const mentioned = ignorePaths.some(
    (p) =>
      p === CARGO_TARGET_DIR ||
      p.replace(/^\.?\//, '').split('/')[0] === CARGO_TARGET_DIR,
  );
  if (mentioned || !looksLikeRustRepo(repoRoot)) {
    return { paths: [...ignorePaths], added: false };
  }
  return { paths: [...ignorePaths, CARGO_TARGET_DIR], added: true };
}

export interface SubmodulePointer {
  /** Path of the submodule relative to the repository root. */
  path: string;
  /** The exact contents of its `.git` file. */
  contents: string;
}

/**
 * Every submodule `.git` file in the tree, with what it says.
 *
 * Read from the files themselves rather than from `git submodule status`, because what has to be
 * reproduced on the remote is the file, byte for byte: it names a path relative to the submodule,
 * and the parent's `.git/modules` is already there once `git.sync` has run.
 */
export function readSubmodulePointers(
  repoRoot: string,
  gitmodulesPaths?: readonly string[],
): SubmodulePointer[] {
  const paths = gitmodulesPaths ?? submodulePathsFromGitmodules(repoRoot);
  const pointers: SubmodulePointer[] = [];
  for (const rel of paths) {
    const dotGit = path.join(repoRoot, rel, '.git');
    try {
      const stat = fs.statSync(dotGit);
      if (!stat.isFile()) {
        // A submodule with a real `.git` directory predates git 1.7.8's layout. Nothing to point at.
        continue;
      }
      pointers.push({ path: rel, contents: fs.readFileSync(dotGit, 'utf8') });
    } catch {
      // Not checked out. `git submodule update` is the user's business, not bica's.
    }
  }
  return pointers;
}

/** Submodule paths as `.gitmodules` lists them. */
export function submodulePathsFromGitmodules(repoRoot: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(repoRoot, '.gitmodules'), 'utf8');
  } catch {
    return [];
  }
  return parseGitmodulesPaths(raw);
}

export function parseGitmodulesPaths(gitmodules: string): string[] {
  const paths: string[] = [];
  for (const line of gitmodules.split('\n')) {
    const match = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    if (match !== null && match[1] !== '') {
      paths.push(match[1]);
    }
  }
  return paths;
}

/**
 * A script that recreates those pointers on the remote.
 *
 * Written rather than rsynced: each is a few dozen bytes, there may be a dozen of them, and one
 * round trip that writes them all beats a dozen rsync invocations. Heredocs, so the contents go
 * across uninterpreted.
 */
export function buildSubmodulePointerScript(options: {
  remoteWorkspaceWord: string;
  pointers: readonly SubmodulePointer[];
}): string {
  if (options.pointers.length === 0) {
    return '';
  }
  const lines = [`cd ${options.remoteWorkspaceWord} || exit 1`];
  for (const pointer of options.pointers) {
    // The submodule's own directory is part of the synced tree, so it is already there; `-p` covers
    // the case where it is not, which is better than failing the whole batch for one of them.
    lines.push(`mkdir -p ${shQuote(pointer.path)} 2>/dev/null || true`);
    lines.push(`cat > ${shQuote(`${pointer.path}/.git`)} <<'BICA_SUBMODULE_EOF'`);
    lines.push(pointer.contents.replace(/\n$/, ''));
    lines.push('BICA_SUBMODULE_EOF');
  }
  lines.push('');
  return lines.join('\n');
}

function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** The toolchain a repository pins, from `rust-toolchain.toml`. */
export function pinnedToolchain(repoRoot: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(repoRoot, 'rust-toolchain.toml'), 'utf8');
  } catch {
    return null;
  }
  const match = /^\s*channel\s*=\s*["']([^"']+)["']/m.exec(raw);
  return match?.[1] ?? null;
}

/** Channels rustup installs on demand. Anything else has to have been put there. */
const RUSTUP_INSTALLS_THESE =
  /^(stable|beta|nightly)(-\d{4}-\d{2}-\d{2})?(-[\w.-]+)?$|^\d+\.\d+(\.\d+)?(-[\w.-]+)?$/;

/**
 * Whether rustup will fetch this toolchain by itself.
 *
 * The plugin's assumption is that it will, which holds for a channel or a version and breaks for a
 * locally linked one: `rustup toolchain link blackfin build/host/stage1` exists only on the machine
 * where it was run, and the remote has no way to obtain it.
 */
export function rustupCanInstall(channel: string): boolean {
  return RUSTUP_INSTALLS_THESE.test(channel);
}

export function describeMissingToolchain(options: {
  channel: string;
  sshHost: string;
}): string {
  return (
    `${options.sshHost} has no rustup toolchain called \`${options.channel}\`, and rustup cannot ` +
    'fetch it: a name that is not a channel or a version is a locally linked toolchain.\n' +
    `Link it there, pointing at wherever its sysroot was built, e.g. \`bica run rustup toolchain ` +
    `link ${options.channel} build/host/stage1\`.`
  );
}
