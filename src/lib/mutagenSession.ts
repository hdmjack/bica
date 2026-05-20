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

export interface SyncSessionSummary {
  name: string;
  identifier: string;
  alpha: string;
  beta: string;
}

const SYNC_LIST_TEMPLATE =
  '{{range .}}{{.Name}}|{{.Identifier}}|{{.Alpha.Path}}|{{.Beta.Host}}:{{.Beta.Path}}{{"\\n"}}{{end}}';

/**
 * Parse a single `Name|Identifier|alpha|host:beta-path` line into a summary. Returns null when the
 * line is malformed (e.g. an old `mutagen` build does not expose the field shape we expect).
 */
export function parseSyncListTemplateLine(
  line: string,
): SyncSessionSummary | null {
  const parts = line.split('|');
  if (parts.length !== 4) {
    return null;
  }
  const [name, identifier, alpha, beta] = parts.map((p) => p.trim());
  if (!name || !identifier) {
    return null;
  }
  return { name, identifier, alpha, beta };
}

/**
 * List every Mutagen sync session by name + endpoints. Returns [] if the templated CLI invocation
 * fails (older Mutagen lacking template support, etc.) — callers should treat the empty case as
 * "no detection possible" rather than "no conflicts".
 */
export function listAllSyncSessions(): SyncSessionSummary[] {
  const result = spawnSync(
    'mutagen',
    ['sync', 'list', '--template', SYNC_LIST_TEMPLATE],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    },
  );
  if (result.status !== 0) {
    return [];
  }
  const out = result.stdout ?? '';
  const sessions: SyncSessionSummary[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      continue;
    }
    const parsed = parseSyncListTemplateLine(line);
    if (parsed !== null) {
      sessions.push(parsed);
    }
  }
  return sessions;
}

/**
 * Sessions that bind the same alpha+beta as the project we are about to start, but with a name
 * other than the one bica's project file owns. These are leftovers from a prior bica.yml session
 * name — they fight the new session's ignore rules (e.g. snapshot return-flow gets clobbered).
 */
export function findConflictingSessions(options: {
  expectedSessionName: string;
  alphaPath: string;
  remoteSyncUrl: string;
}): SyncSessionSummary[] {
  const all = listAllSyncSessions();
  return all.filter(
    (s) =>
      s.alpha === options.alphaPath &&
      s.beta === options.remoteSyncUrl &&
      s.name !== options.expectedSessionName,
  );
}

export function mutagenSyncTerminate(sessionName: string): boolean {
  const result = spawnSync('mutagen', ['sync', 'terminate', sessionName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  if (result.status === 0) {
    return true;
  }
  const err = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
  process.stderr.write(
    `[bica] mutagen sync terminate ${sessionName}: ${err || `exit ${String(result.status)}`}\n`,
  );
  return false;
}

export function mutagenSyncMonitor(sessionName: string): void {
  spawnSync('mutagen', ['sync', 'monitor', sessionName], {
    stdio: 'inherit',
    shell: false,
  });
}

/**
 * Force a sync cycle so the **remote** catches up to **local** (best-effort before `bica run`).
 * Used when `BICA_SYNC_FLUSH=1`; see README. Requires an existing session.
 */
export function mutagenSyncFlush(repoRoot: string, sessionName: string): boolean {
  const result = spawnSync(
    'mutagen',
    ['sync', 'flush', sessionName],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.status === 0) {
    return true;
  }
  const err = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
  if (err) {
    process.stderr.write(`[bica] mutagen sync flush: ${err}\n`);
  } else {
    process.stderr.write(
      `[bica] mutagen sync flush exited ${String(result.status)}\n`,
    );
  }
  return false;
}
