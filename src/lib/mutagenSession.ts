import * as fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

import {
  SYNC_QUIET_PHASE_STALL_SECONDS,
  SYNC_STALL_SECONDS,
  stallBudgetSeconds,
  describeSyncProgress,
  progressFingerprint,
  readSyncProgress,
} from './syncProgress';
import type { ReadProgress, SyncProgress } from './syncProgress';

/** How often to say where a long first sync has got to. */
const PROGRESS_EVERY_MS = 10_000;

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

/**
 * Block until the session is ready, or until it stops getting anywhere.
 *
 * This waited a fixed sixty seconds and then let the caller run the command regardless. On a tree
 * whose first transfer takes longer than that the command ran against an empty directory and its
 * exit code was reported as if it had seen the files -- see the note in `syncProgress.ts`. There is
 * no fixed number that is right here, because the budget scales with the tree and the link, so what
 * is measured instead is whether Mutagen is still making progress. Staged files and bytes climb
 * continuously while it works; a sync that has not moved at all for `stallSeconds` has stopped.
 */
export function waitForSyncReady(
  sessionName: string,
  options: {
    /** Seconds with no change of any kind before the sync is called stalled. */
    stallSeconds?: number;
    /**
     * Seconds to allow a phase that publishes no number at all, such as scanning.
     *
     * Separate because stillness there is not evidence of anything: there was nothing to watch.
     */
    quietStallSeconds?: number;
    /** Said every so often while waiting, so a long first sync does not look like a hang. */
    onProgress?: (line: string) => void;
    /** Injectable for tests. */
    readProgress?: ReadProgress;
    /** Injectable for tests; the real one shells out to Mutagen once per poll. */
    readStatus?: (sessionName: string) => SessionListParse;
    /** Injectable for tests; returns milliseconds. */
    now?: () => number;
    /** Injectable for tests; the real one blocks. */
    sleep?: () => void;
  } = {},
): {
  ready: boolean;
  lastStatus: string | null;
  progress: SyncProgress | null;
  /** The budget that was exceeded, so the message quotes the number that was actually used. */
  stalledSeconds?: number;
} {
  const stallSeconds = options.stallSeconds ?? SYNC_STALL_SECONDS;
  const quietStallSeconds =
    options.quietStallSeconds ?? SYNC_QUIET_PHASE_STALL_SECONDS;
  const readProgress = options.readProgress ?? readSyncProgress;
  const readStatus = options.readStatus ?? getSessionListParse;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((): void => {
      spawnSync('sleep', ['0.5']);
    });

  let lastStatus: string | null = null;
  let progress: SyncProgress | null = null;
  let fingerprint = '';
  let movedAt = now();
  let saidAt = 0;

  for (;;) {
    const info = readStatus(sessionName);
    lastStatus = info.status;
    if (info.exists && isLikelySyncReady(info.status)) {
      return { ready: true, lastStatus, progress };
    }
    progress = readProgress(sessionName);
    const current = progressFingerprint(progress);
    if (current !== fingerprint) {
      fingerprint = current;
      movedAt = now();
    }
    const stalledFor = now() - movedAt;
    // The budget depends on what the sync is doing. Scanning a large tree publishes no number that
    // moves, so a single budget made "working hard on 181,755 files" indistinguishable from
    // "wedged", and the large tree lost.
    const budget = stallBudgetSeconds(progress?.status ?? lastStatus, {
      moving: stallSeconds,
      quiet: quietStallSeconds,
    });
    if (stalledFor >= budget * 1_000) {
      return { ready: false, lastStatus, progress, stalledSeconds: budget };
    }
    if (options.onProgress !== undefined && now() - saidAt >= PROGRESS_EVERY_MS) {
      saidAt = now();
      const line = describeSyncProgress(progress, {
        elapsedSeconds: stalledFor / 1_000,
      });
      if (line !== undefined) {
        options.onProgress(line);
      }
    }
    sleep();
  }
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

/**
 * Forward Mutagen's own output, both streams to stderr.
 *
 * Mutagen narrates on stdout -- `Creating session...`, `Connecting to agent (POSIX)...`, without a
 * newline -- and bica used to pass that through to its own stdout, where the remote command's output
 * goes. So `$(bica run git rev-parse HEAD)` captured `Creating session...   Connecting to agent
 * (POSIX)...   e354057…` and any caller reading a value got the narration with it. stdout belongs to
 * the command and to the one summary line callers are told to read; everything bica says about its
 * own progress goes to stderr.
 */
function writeMutagenStreams(
  stdout: string | null | undefined,
  stderr: string | null | undefined,
): void {
  if (stdout) {
    process.stderr.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
}

/**
 * The project identifier Mutagen recorded when it last started this project file, or null when the
 * project is not marked as running.
 *
 * `mutagen project start` writes the identifier into `<project file>.lock` and `project terminate`
 * removes the file. "project already running" means only that the file is non-empty: Mutagen does
 * not look for the sessions, so the file outlives them whenever they end some other way.
 */
export function readProjectLockId(projectFileAbsolutePath: string): string | null {
  try {
    const id = fs.readFileSync(`${projectFileAbsolutePath}.lock`, 'utf8').trim();
    return id === '' ? null : id;
  } catch {
    return null;
  }
}

/**
 * Sessions Mutagen started for project `projectId`, found by the label it puts on each of them.
 * Returns null when the listing fails, which is "cannot tell", not "there are none".
 */
function listProjectSessions(projectId: string): SyncSessionSummary[] | null {
  const result = spawnSync(
    'mutagen',
    [
      'sync',
      'list',
      '--label-selector',
      `io.mutagen.project=${projectId}`,
      '--template',
      SYNC_LIST_TEMPLATE,
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return (result.stdout ?? '')
    .split('\n')
    .map((line) => parseSyncListTemplateLine(line.trim()))
    .filter((s): s is SyncSessionSummary => s !== null);
}

function spawnProjectStart(repoRoot: string, projectFileAbsolutePath: string) {
  // Prefer `-f/--project-file` so Mutagen does not default to `./mutagen.yml`
  // (some versions ignore or mishandle MUTAGEN_PROJECT_FILE alone).
  return spawnSync(
    'mutagen',
    ['project', 'start', '-f', projectFileAbsolutePath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

export function mutagenProjectStart(
  repoRoot: string,
  projectFileAbsolutePath: string,
): boolean {
  let result = spawnProjectStart(repoRoot, projectFileAbsolutePath);

  // "Already running" was taken at its word, and it is only a statement about the lock file. A run
  // that died without its exit hook, or a teardown that failed, leaves the file naming sessions that
  // no longer exist, and `bica run` itself ends this checkout's leftover sessions with `sync
  // terminate` before it gets here, which never touches the file. Every later run then started
  // nothing, waited sixty seconds for a session that was not there, and stopped with 94 and advice to
  // check the network and the disk. When the project's sessions are gone the lock is stale: clear it
  // the way Mutagen does and start once more.
  if (/already\s+running/i.test(`${result.stdout ?? ''}${result.stderr ?? ''}`)) {
    const projectId = readProjectLockId(projectFileAbsolutePath);
    const sessions =
      projectId === null ? null : listProjectSessions(projectId);
    if (sessions !== null && sessions.length === 0) {
      process.stderr.write(
        '[bica] The last sync from this checkout was not shut down cleanly; clearing it and starting a new one.\n',
      );
      mutagenProjectTerminate(repoRoot, projectFileAbsolutePath, true);
      result = spawnProjectStart(repoRoot, projectFileAbsolutePath);
    }
  }

  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (result.status === 0) {
    writeMutagenStreams(result.stdout, result.stderr);
    return true;
  }

  // Idempotent start: backend exits non-zero when the project session already exists.
  if (/already\s+running/i.test(combined)) {
    process.stderr.write(
      'Remote sync is already running (nothing to start).\n',
    );
    return true;
  }

  writeMutagenStreams(result.stdout, result.stderr);
  return false;
}

/** Single-quoted for `sh`, so a path with a space or a quote in it stays one word. */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The script that ends a run's sync once the run's process is gone.
 *
 * The exit hook is the normal way a run's session ends, and `kill -9`, an OOM kill or a closed
 * terminal skip it. The session then went on mirroring that checkout into the remote for as long as
 * nobody ran bica from it again: one watched for twenty minutes after its run died, recreating a
 * workspace folder while somebody deleted it. This waits on the pid instead, so nothing the run
 * failed to do depends on anybody coming back.
 *
 * Keyed on the project identifier, which Mutagen makes afresh on every start, so a later run from the
 * same checkout -- a new project id -- is never touched. The lock file and the live-run marker are
 * removed only while they still name this run, for the same reason.
 */
export function buildSyncWatchdogScript(options: {
  pid: number;
  projectId: string;
  lockPath: string;
  markerPath: string;
}): string {
  const { pid, projectId } = options;
  const id = shQuote(projectId);
  return [
    `while kill -0 ${String(pid)} 2>/dev/null; do sleep 2; done`,
    `mutagen sync terminate --label-selector io.mutagen.project=${id} >/dev/null 2>&1`,
    `[ "$(cat ${shQuote(options.lockPath)} 2>/dev/null)" = ${id} ] && rm -f ${shQuote(options.lockPath)}`,
    `[ "$(cat ${shQuote(options.markerPath)} 2>/dev/null)" = '${String(pid)}' ] && rm -f ${shQuote(options.markerPath)}`,
    'exit 0',
  ].join('\n');
}

/**
 * Start the watcher for this process's sync, detached so it survives whatever ends this process.
 * Best effort: without a project id there is nothing safe to key it on, and the sweep in
 * `endLeftoverRunSyncs` still ends the session the next time anyone runs bica.
 */
export function startSyncWatchdog(options: {
  projectFileAbsolutePath: string;
  markerPath: string;
  pid?: number;
}): boolean {
  const projectId = readProjectLockId(options.projectFileAbsolutePath);
  if (projectId === null) {
    return false;
  }
  try {
    const child = spawn(
      'sh',
      [
        '-c',
        buildSyncWatchdogScript({
          pid: options.pid ?? process.pid,
          projectId,
          lockPath: `${options.projectFileAbsolutePath}.lock`,
          markerPath: options.markerPath,
        }),
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function mutagenProjectTerminate(
  repoRoot: string,
  projectFileAbsolutePath: string,
  quiet = false,
): boolean {
  // Quiet mode (captured / non-TTY): pipe instead of inherit so Mutagen's `\r`-based
  // "Terminating session …" progress line cannot clobber the last real output line.
  const result = spawnSync(
    'mutagen',
    ['project', 'terminate', '-f', projectFileAbsolutePath],
    {
      cwd: repoRoot,
      encoding: quiet ? 'utf8' : undefined,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
    },
  );
  const ok = result.status === 0;
  // Surface stderr only on failure so quiet teardown stays silent on the happy path.
  if (quiet && !ok && typeof result.stderr === 'string' && result.stderr.trim().length > 0) {
    process.stderr.write(result.stderr);
  }
  return ok;
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

/**
 * Sessions the ephemeral-session mode (`bica run`) must clear before starting a fresh one: alpha is
 * exactly `repoRoot`, so any name and any ignore config counts.
 *
 * `remoteSyncUrl` narrows that to sessions pointed at *this run's* remote workspace. Concurrent workspace
 * runs share the alpha but each owns a different remote path, so matching on alpha alone would have
 * every `bica run` terminate its siblings' sessions — the original hard blocker on running two at
 * once. Omitting the argument keeps the old repo-wide sweep for callers that want it.
 */
export function findAllSessionsForRepo(
  repoRoot: string,
  remoteSyncUrl?: string,
): SyncSessionSummary[] {
  return listAllSyncSessions().filter(
    (s) =>
      s.alpha === repoRoot &&
      (remoteSyncUrl === undefined || s.beta === remoteSyncUrl),
  );
}

/**
 * Sessions from *other* checkouts on this machine that sync into the remote workspace `remoteSyncUrl`.
 *
 * Checkouts may share a remote workspace on purpose, and the lease keeps their runs apart. But a
 * session outlives its run whenever the run dies without its exit hook, and a one-way-replica session
 * goes on making the remote an exact copy of *its* checkout, under whichever run holds the lease
 * next. A run that holds the lease is the only one entitled to that workspace, so anything found here
 * is a leftover.
 */
export function findSessionsFromOtherCheckouts(
  repoRoot: string,
  remoteSyncUrl: string,
): SyncSessionSummary[] {
  return listAllSyncSessions().filter(
    (s) => s.alpha !== repoRoot && s.beta === remoteSyncUrl,
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
