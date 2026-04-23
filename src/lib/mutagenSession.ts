import { spawnSync } from 'node:child_process';

/**
 * Throws a clear error with install instructions if `mutagen` is not on PATH.
 * Call this before any mutagen operation so the user sees a useful message instead
 * of a confusing ENOENT / "command not found" from spawnSync.
 */
export function assertMutagenInstalled(): void {
  const result = spawnSync('mutagen', ['version'], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.error != null) {
    throw new Error(
      'File sync is not available: the sync CLI was not found on PATH.\n\n' +
        'Install it (macOS + Homebrew example):\n' +
        '  brew install mutagen-io/mutagen/mutagen\n\n' +
        'Installation guide: https://mutagen.io/documentation/introduction/installation',
    );
  }
}

export interface SessionListParse {
  /** Session exists (sync backend) */
  exists: boolean;
  /** Raw Status: line value, if present */
  status: string | null;
}

/**
 * Runs `mutagen sync list <name>` and parses status (best-effort for default CLI output).
 */
export function getSessionListParse(sessionName: string): SessionListParse {
  const result = spawnSync('mutagen', ['sync', 'list', sessionName], {
    encoding: 'utf8',
    shell: false,
  });

  if (result.status !== 0) {
    return { exists: false, status: null };
  }

  const output = result.stdout ?? '';
  const statusMatch = /^Status:\s*(.+)$/m.exec(output);
  return {
    exists: true,
    status: statusMatch?.[1]?.trim() ?? null,
  };
}

export function isLikelySyncReady(status: string | null): boolean {
  if (!status) {
    return false;
  }
  const s = status.toLowerCase();
  if (s.includes('error') || s.includes('halted') || s.includes('failed')) {
    return false;
  }
  return s.includes('synchronized') || s.includes('watching for changes');
}

function writeMutagenStreams(
  stdout: string | null | undefined,
  stderr: string | null | undefined,
): void {
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
}

export function mutagenProjectStart(
  repoRoot: string,
  projectFileAbsolutePath: string,
): boolean {
  // Prefer `-f/--project-file` so Mutagen does not default to `./mutagen.yml`
  // (some versions ignore or mishandle MUTAGEN_PROJECT_FILE alone).
  const result = spawnSync(
    'mutagen',
    ['project', 'start', '-f', projectFileAbsolutePath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (result.status === 0) {
    writeMutagenStreams(result.stdout, result.stderr);
    return true;
  }

  // Idempotent start: backend exits non-zero when the project session already exists.
  if (/already\s+running/i.test(combined)) {
    process.stdout.write(
      'Remote sync is already running (nothing to start).\n',
    );
    return true;
  }

  writeMutagenStreams(result.stdout, result.stderr);
  return false;
}

export function mutagenProjectTerminate(
  repoRoot: string,
  projectFileAbsolutePath: string,
): boolean {
  const result = spawnSync(
    'mutagen',
    ['project', 'terminate', '-f', projectFileAbsolutePath],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false,
    },
  );
  return result.status === 0;
}

export function mutagenSyncList(): void {
  spawnSync('mutagen', ['sync', 'list'], { stdio: 'inherit', shell: false });
}

export function mutagenSyncMonitor(sessionName: string): void {
  spawnSync('mutagen', ['sync', 'monitor', sessionName], {
    stdio: 'inherit',
    shell: false,
  });
}
