import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildRemoteCommandScript,
  remoteWorkspaceWordForSh,
  runRemoteScriptOverStdin,
  shellSingleQuoteRemotePathForSh,
} from './runRemote';

/**
 * Runs that outlive the thing that started them.
 *
 * An agent's tool call times out after ten minutes and a CI step often sooner, while the builds bica
 * is most useful for -- 40 minutes of `ninja`, one to two hours of `./x build` -- run far longer than
 * that. bica ends the remote command when its connection goes, which is right for an ordinary run
 * and makes a long one impossible to start from such a caller at all: the command dies with the tool
 * call that launched it.
 *
 * So a detached run inverts that. The command is started on the remote under `nohup` with its output
 * going to a file there, and the launching ssh exits as soon as it has confirmed the command is
 * running. Nothing local is holding it up -- which also means a dropped link, the normal state of
 * affairs on a wifi remote, no longer costs an hour of compilation. The alternative, a detached local
 * supervisor holding the ssh open the way `bica tunnel --detach` does, would have kept that exposure
 * for the whole build.
 *
 * What makes this safe is that the lease is not released when the launcher exits. The claim already
 * carries the remote shell's pid (`rpid=`), the liveness oracle already reads it, and `bica run`
 * already refuses a workspace somebody else holds -- so a second run meets 98 while the build is
 * going, exactly as it would for an attached one. The detached shell appends its exit code to the
 * claim when it finishes, which is what `bica wait` reads.
 */

/** Where the remote keeps a detached run's output. One directory, beside the claims. */
const REMOTE_RUN_DIR = '~/.bica/runs';

export interface DetachedRunRecord {
  runId: string;
  sshHost: string;
  remoteWorkspacePath: string;
  /** The local checkout this was started from, so `wait` can pull artifacts back into it. */
  repoRoot: string;
  /** What was asked for, for `bica runs` to show. */
  command: string[];
  startedAt: string;
  /** Path on the remote holding the command's combined output. */
  remoteLogPath: string;
  /**
   * When this run was last seen to be over. Its presence is what makes the record history.
   *
   * The record used to be deleted at that point, which also deleted the only thing that knows which
   * host holds the log -- so `bica wait` would report an exit code and the `bica logs` it had just
   * recommended would answer "no detached run called that". The log itself was never the problem; it
   * is still on the remote. Kept and marked instead, and pruned by age.
   */
  finishedAt?: string;
  /** Its exit code, where one was recovered. `null` when the workspace changed hands first. */
  exitCode?: number | null;
}

/** How long a finished run's record is kept, so its output stays reachable afterwards. */
export const FINISHED_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function runsDir(): string {
  return path.join(os.homedir(), '.bica', 'runs');
}

export function recordPathFor(runId: string): string {
  return path.join(runsDir(), `${runId}.json`);
}

export function remoteLogPathFor(runId: string): string {
  return `${REMOTE_RUN_DIR}/${runId}.log`;
}

export function writeDetachedRunRecord(record: DetachedRunRecord): void {
  fs.mkdirSync(runsDir(), { recursive: true });
  fs.writeFileSync(
    recordPathFor(record.runId),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
}

export function readDetachedRunRecord(runId: string): DetachedRunRecord | null {
  try {
    const raw = fs.readFileSync(recordPathFor(runId), 'utf8');
    return JSON.parse(raw) as DetachedRunRecord;
  } catch {
    return null;
  }
}

export function removeDetachedRunRecord(runId: string): void {
  try {
    fs.rmSync(recordPathFor(runId), { force: true });
  } catch {
    // A record that will not go is not worth failing a wait over.
  }
}

/**
 * Records old enough to drop, so finished ones do not pile up forever.
 *
 * Pure, and takes `now`, because the alternative is a test that waits a week.
 */
export function expiredRunRecords(
  records: readonly DetachedRunRecord[],
  now: number,
  retentionMs: number = FINISHED_RECORD_RETENTION_MS,
): DetachedRunRecord[] {
  return records.filter((r) => {
    if (r.finishedAt === undefined) {
      // Still going, or last seen going. Age says nothing about it: a build can take hours and an
      // unreachable host can keep one unresolved for longer.
      return false;
    }
    const at = Date.parse(r.finishedAt);
    return !Number.isNaN(at) && now - at > retentionMs;
  });
}

/** Drop the records of runs that finished long enough ago to be of no further use. */
export function pruneFinishedRunRecords(now: number = Date.now()): void {
  for (const record of expiredRunRecords(listDetachedRunRecords(), now)) {
    removeDetachedRunRecord(record.runId);
  }
}

export function listDetachedRunRecords(): DetachedRunRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(runsDir());
  } catch {
    return [];
  }
  const records: DetachedRunRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const record = readDetachedRunRecord(name.slice(0, -'.json'.length));
    if (record !== null) {
      records.push(record);
    }
  }
  return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * The script that starts the command and lets go of it.
 *
 * `setsid` where there is one, `nohup` otherwise: the command must survive both the ssh connection
 * closing and the session leader going with it. Both are tried because macOS has no `setsid` and
 * Linux hosts generally do, and bica runs against either.
 *
 * stdin is `/dev/null` deliberately. A backgrounded command in a non-interactive shell inherits a
 * stdin that is already closed, and a build tool that reads it sees an immediate EOF part-way through
 * -- which looks like a mysterious early exit rather than anything to do with detaching.
 *
 * The started pid is printed and nothing else is, so the launcher can tell "running" from "the shell
 * came back having done nothing", which is the one thing it has to establish before it exits.
 */
export function buildDetachStartScript(options: {
  remoteWorkspacePath: string;
  /** Already-built remote run script: preamble, cd, the command, the claim bookkeeping. */
  innerScript: string;
  runId: string;
  loginShell: string;
}): string {
  const logPath = remoteLogPathFor(options.runId);
  const inner = shellSingleQuoteRemotePathForSh(options.innerScript);
  const shell = shellSingleQuoteRemotePathForSh(options.loginShell);
  return [
    `mkdir -p ${REMOTE_RUN_DIR} || exit 1`,
    // Job control, so the backgrounded shell becomes its own process-group leader.
    //
    // This is load-bearing, not hygiene. The lease's liveness oracle asks whether the recorded pid is
    // a *process group* -- right for an attached run, where ssh makes the remote shell a group leader
    // -- and macOS has no `setsid`, so without this the detached shell stays in the launching ssh's
    // group. That group dies the moment the launcher disconnects, the next run reads the lease as
    // stale, breaks it, and rsyncs over a build that is still compiling. Measured: pgid 96707 for a
    // job whose own pid was 96708, against pgid 96712 == pid 96712 with `set -m`.
    'set -m',
    `_bica_runner=${shell}`,
    'if command -v setsid >/dev/null 2>&1; then',
    `  setsid nohup "$_bica_runner" -lc ${inner} > ${logPath} 2>&1 < /dev/null &`,
    'else',
    `  nohup "$_bica_runner" -lc ${inner} > ${logPath} 2>&1 < /dev/null &`,
    'fi',
    '_bica_started=$!',
    // Give it a moment to fall over, so "started" means something. A command that cannot start at
    // all -- a missing binary, a workspace that is not there -- is better reported now than left for
    // `bica wait` to discover in an hour.
    'sleep 1',
    'if kill -0 "$_bica_started" 2>/dev/null; then',
    '  printf \'started=%s\\n\' "$_bica_started"',
    'else',
    // Its status, not just the fact that it is over. A command can finish inside the second for the
    // happiest of reasons -- `ninja: no work to do` on an up-to-date tree -- and reporting that as a
    // failure to start told people their build had broken when it had simply been quick.
    '  wait "$_bica_started"',
    '  _bica_ec=$?',
    "  printf 'exited-early=%s %s\\n' \"$_bica_started\" \"$_bica_ec\"",
    'fi',
    '',
  ].join('\n');
}

export interface DetachStartOutcome {
  started: boolean;
  /**
   * Set when the command was already over a second after starting.
   *
   * Not a failure. `true`, and `ninja` on a tree with nothing to do, both land here, and reporting
   * them as a run that would not start was the bug this field's name used to encode.
   */
  exitedEarly: boolean;
  /** The command's exit status, when the remote was able to report it. */
  exitCode?: number;
  pid?: number;
}

export function parseDetachStart(stdout: string): DetachStartOutcome {
  const started = /^started=(\d+)$/m.exec(stdout);
  if (started !== null) {
    return { started: true, exitedEarly: false, pid: Number(started[1]) };
  }
  // The exit status is optional in the pattern because a remote running an older start script does
  // not send one. Its absence means "finished, code unknown", which is still not "failed to start".
  const early = /^exited-early=(\d+)(?: (\d+))?$/m.exec(stdout);
  if (early !== null) {
    return {
      started: false,
      exitedEarly: true,
      pid: Number(early[1]),
      exitCode: early[2] === undefined ? undefined : Number(early[2]),
    };
  }
  return { started: false, exitedEarly: false };
}

/** `cat` the log, or follow it. Follows by pid so it stops when the run does. */
export function buildLogsScript(options: {
  runId: string;
  follow: boolean;
}): string {
  const logPath = remoteLogPathFor(options.runId);
  if (!options.follow) {
    return `cat ${logPath} 2>/dev/null || { echo "[bica] no log for ${options.runId}" >&2; exit 1; }\n`;
  }
  // `-F` rather than `-f`: the file is created by the launcher and a follower may arrive first.
  return `tail -n +1 -F ${logPath} 2>/dev/null\n`;
}

/** Whether the remote workspace still exists, for a record whose run has gone. */
export function buildRunStillThereScript(remoteWorkspacePath: string): string {
  const w = remoteWorkspaceWordForSh(remoteWorkspacePath);
  return `if [ -d ${w} ]; then printf 'yes\\n'; else printf 'no\\n'; fi\n`;
}

export type RemoteRunner = (
  sshHost: string,
  script: string,
) => { status: number; stdout: string; stderr: string };

export function startDetachedRun(options: {
  sshHost: string;
  remoteWorkspacePath: string;
  innerScript: string;
  runId: string;
  loginShell: string;
  run?: RemoteRunner;
}): DetachStartOutcome {
  const run = options.run ?? runRemoteScriptOverStdin;
  const result = run(
    options.sshHost,
    buildDetachStartScript({
      remoteWorkspacePath: options.remoteWorkspacePath,
      innerScript: options.innerScript,
      runId: options.runId,
      loginShell: options.loginShell,
    }),
  );
  if (result.status !== 0) {
    return { started: false, exitedEarly: false };
  }
  return parseDetachStart(result.stdout);
}

/** One line per detached run, for `bica runs`. */
export function describeDetachedRun(
  record: DetachedRunRecord,
  state: 'running' | 'finished' | 'gone' | 'unreachable',
  exitCode: number | null,
): string {
  const age = Math.round(
    (Date.now() - new Date(record.startedAt).getTime()) / 1000,
  );
  const minutes = age < 60 ? `${String(age)}s` : `${String(Math.round(age / 60))}m`;
  const what =
    state === 'running'
      ? `running for ${minutes}`
      : state === 'unreachable'
        ? // Not a statement about the run: the host did not answer, so its state is simply unknown.
          `unknown — ${record.sshHost} is not answering; started ${minutes} ago`
        : state === 'gone'
          ? 'gone (no claim on the remote; it may have been cleared)'
          : `finished (exit ${exitCode === null ? '?' : String(exitCode)}) after ${minutes}`;
  return `${record.runId}  ${record.command.join(' ')}  [${what}]`;
}

/**
 * Start a command on the remote and come back as soon as it is running.
 *
 * The inner script is built by the same function an attached run uses, so a detached build gets the
 * same tooling preamble, the same `cd`, and the same lease bookkeeping -- including appending its
 * exit code to the claim when it finishes, which is the whole mechanism `bica wait` reads.
 */
export function launchDetachedRun(options: {
  sshHost: string;
  remoteWorkspacePath: string;
  repoRoot: string;
  /** POSIX-quoted command, as `runRemoteCommand` takes it. */
  command: string;
  /** Shell lines exporting forwarded environment; see envPassthrough.ts. */
  envScript?: string;
  /** The user's argv, recorded so `bica runs` can show what is going. */
  argv: string[];
  runId: string;
  claimPathExpr: string;
  loginShell: string;
  run?: RemoteRunner;
}): DetachStartOutcome {
  const innerScript = buildRemoteCommandScript({
    remoteWorkspacePath: options.remoteWorkspacePath,
    command: options.command,
    repoRoot: options.repoRoot,
    envScript: options.envScript,
    // Never: the command must outlive the connection that started it. That watchdog is the exact
    // thing that makes a 50-minute build impossible to launch from a caller that times out at ten.
    dieWithConnection: false,
    assertRunId: options.runId,
    claimPathExpr: options.claimPathExpr,
    recordExitCode: true,
  });
  const outcome = startDetachedRun({
    sshHost: options.sshHost,
    remoteWorkspacePath: options.remoteWorkspacePath,
    innerScript,
    runId: options.runId,
    loginShell: options.loginShell,
    run: options.run,
  });
  // Written for a run that was already over within the second as well as for one still going. Both
  // have a log on the remote, and the record is the only thing that names the host it is on.
  //
  // Deliberately *not* marked finished. A finished record is history, which `bica wait` answers from
  // without touching the remote -- so marking it here would skip the release of the lease and the
  // artifact pull that a run, however short, still needs. It is `wait` that ends a detached run; the
  // launcher's job is only to make sure it can be found.
  if (outcome.started || outcome.exitedEarly) {
    writeDetachedRunRecord({
      runId: options.runId,
      sshHost: options.sshHost,
      remoteWorkspacePath: options.remoteWorkspacePath,
      repoRoot: options.repoRoot,
      command: options.argv,
      startedAt: new Date().toISOString(),
      remoteLogPath: remoteLogPathFor(options.runId),
    });
  }
  return outcome;
}
