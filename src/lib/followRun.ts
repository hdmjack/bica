import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { remoteLogPathFor } from './detachedRun';
import { claimPathExpr } from './remoteClaim';
import { shellSingleQuoteRemotePathForSh } from './runRemote';
import { dim, warn } from '../terminalStyle';

/**
 * Watching a run on the remote in a way that a dropped connection cannot end.
 *
 * An ordinary run ties the command to its ssh session: when the link goes, the command is ended, which
 * is what stops orphaned builds holding the workspace and is right for most runs. For a long build
 * under a loaded host it costs the whole build when the link blips at minute seven. `bica run
 * --reconnect` starts the command detached, as `--detach` does, and then does what `bica logs
 * --follow` does -- except that it knows how far it has read, so when the connection drops it opens a
 * new one and carries on from that byte. The command was never attached to the connection, so nothing
 * is lost and nothing is repeated.
 *
 * The remote half is a small `sh` loop rather than `tail -F`, for one reason: it knows when to stop.
 * It reads the run's claim, the file the command appends its exit code to, and finishes once that is
 * there and the log has been read to its end, so "the run is over" and "the connection broke" are
 * different exit statuses of the same ssh.
 */

/** The script's exit status when the run finished and every byte of its output was sent. */
export const FOLLOW_FINISHED = 0;
/** The script's exit status when the claim no longer names this run: something else holds the workspace. */
export const FOLLOW_CLAIM_GONE = 3;

/**
 * The `sh` that sends a run's output from byte `offset` onwards, then stops when the run is over.
 *
 * Order matters: the claim is read *before* the log's size, so a command that wrote its last line and
 * then recorded its exit cannot be reported finished with that line still unsent. Output is sent in
 * bounded pieces (`head -c`) so a log that is still growing under the read cannot be sent twice.
 */
export function buildFollowScript(options: {
  runId: string;
  remoteWorkspacePath: string;
  offset: number;
}): string {
  const log = remoteLogPathFor(options.runId);
  const claim = claimPathExpr(options.remoteWorkspacePath);
  const run = shellSingleQuoteRemotePathForSh(options.runId);
  return [
    `_bica_log=${log}`,
    `_bica_claim=${claim}`,
    `_bica_run=${run}`,
    `_bica_off=${String(Math.max(0, Math.floor(options.offset)))}`,
    'while :; do',
    // `other` when the claim names another run or is gone, `done` once an exit code trails the three
    // mandatory fields (the rule `parseClaimRead` applies on this side), `running` otherwise.
    "  _bica_state=$(awk -v r=\"$_bica_run\" '{ if ($1 != r) { print \"other\"; exit } last = \"\"; for (i = 4; i <= NF; i++) if ($i !~ /^[a-z]+=/) last = $i; print (last ~ /^[0-9]+$/ ? \"done\" : \"running\"); exit }' \"$_bica_claim\" 2>/dev/null)",
    '  [ -f "$_bica_claim" ] || _bica_state=other',
    '  _bica_size=$(wc -c < "$_bica_log" 2>/dev/null | tr -d \' \')',
    '  _bica_size=${_bica_size:-0}',
    '  if [ "$_bica_size" -gt "$_bica_off" ]; then',
    '    tail -c +$((_bica_off + 1)) "$_bica_log" | head -c $((_bica_size - _bica_off))',
    '    _bica_off=$_bica_size',
    '    continue',
    '  fi',
    `  [ "$_bica_state" = other ] && exit ${String(FOLLOW_CLAIM_GONE)}`,
    `  [ "$_bica_state" = done ] && exit ${String(FOLLOW_FINISHED)}`,
    '  sleep 1',
    'done',
    '',
  ].join('\n');
}

export type FollowOutcome =
  /** The run is over and all of its output was shown. */
  | 'finished'
  /** The workspace was taken by something else; there is no exit code to be had. */
  | 'claim-gone'
  /** The host stayed unreachable for the grace period. The run is, in all likelihood, still going. */
  | 'gave-up';

/** How long a host may stay unreachable before the follower stops trying. Under the remote's own patience. */
export const RECONNECT_GRACE_MS = 5 * 60_000;

/** A connection that stayed up this long was working, however it ended. */
const HEALTHY_AFTER_MS = 20_000;
/** How long a new connection must last before it is announced as having worked. */
const ANNOUNCE_AFTER_MS = 3_000;

type Spawn = (
  command: string,
  args: string[],
  options: { stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcess;

export interface FollowOptions {
  sshHost: string;
  remoteWorkspacePath: string;
  runId: string;
  /** How long to keep trying an unreachable host. */
  graceMs?: number;
  /** Where the run's output goes. */
  out?: (chunk: Buffer) => void;
  /** Where bica's own notices go. */
  say?: (line: string) => void;
  /** Pause between attempts, in ms; grows to a ceiling. Overridden in tests. */
  backoffMs?: (attempt: number) => number;
  now?: () => number;
  spawnSsh?: Spawn;
  /** Extra ssh options, one token each, after bica's own. */
  sshOpts?: readonly string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function defaultBackoff(attempt: number): number {
  return Math.min(10_000, 1_000 * 2 ** Math.min(attempt, 4));
}

/**
 * Show a run's output as it is written, across as many connections as it takes.
 *
 * Counts the bytes it has handed on, not the ones it asked for, so a connection that dies mid-chunk
 * costs nothing: the next one starts exactly where the last write ended.
 */
export async function followRun(options: FollowOptions): Promise<FollowOutcome> {
  const out = options.out ?? ((c: Buffer) => process.stdout.write(c));
  const say =
    options.say ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });
  const now = options.now ?? (() => Date.now());
  const graceMs = options.graceMs ?? RECONNECT_GRACE_MS;
  const backoff = options.backoffMs ?? defaultBackoff;
  const spawnSsh: Spawn = options.spawnSsh ?? ((c, a, o) => spawn(c, a, o));

  let offset = 0;
  let lostSince: number | undefined;
  let announcedLoss = false;
  let failures = 0;

  for (;;) {
    const startedAt = now();
    let received = 0;
    let announceTimer: NodeJS.Timeout | undefined;
    const wasLost = announcedLoss;
    const announceReconnected = (): void => {
      if (announcedLoss) {
        announcedLoss = false;
        say(dim(`[bica] Reconnected to ${options.sshHost}; carrying on from where the output stopped.`));
      }
    };
    const child = spawnSsh(
      'ssh',
      [
        '-T',
        // Sooner than a run's own settings: this connection holds nothing but a view, and noticing a
        // dead link in a minute is worth more than riding out a ten-minute silence.
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=4',
        '-o', 'ConnectTimeout=20',
        ...(options.sshOpts ?? []),
        options.sshHost,
        'sh',
        '-s',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      received += chunk.length;
      offset += chunk.length;
      out(chunk);
      announceReconnected();
    });
    // ssh's own complaints are not the run's output and would be noise on every retry.
    child.stderr?.on('data', () => undefined);
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(
      buildFollowScript({
        runId: options.runId,
        remoteWorkspacePath: options.remoteWorkspacePath,
        offset,
      }),
    );
    if (wasLost) {
      announceTimer = setTimeout(announceReconnected, ANNOUNCE_AFTER_MS);
    }
    const status = await new Promise<number>((resolve) => {
      child.on('error', () => {
        resolve(255);
      });
      child.on('close', (code) => {
        resolve(code ?? 255);
      });
    });
    if (announceTimer !== undefined) {
      clearTimeout(announceTimer);
    }
    if (status === FOLLOW_FINISHED) {
      announceReconnected();
      return 'finished';
    }
    if (status === FOLLOW_CLAIM_GONE) {
      announceReconnected();
      return 'claim-gone';
    }

    // The connection ended some other way: a drop, a host that would not answer, an ssh that could
    // not start. The command is not attached to it, so all of these mean "try again".
    const at = now();
    const wasWorking = received > 0 || at - startedAt >= HEALTHY_AFTER_MS;
    if (lostSince === undefined || wasWorking) {
      lostSince = at;
      failures = 0;
    }
    failures += 1;
    if (!announcedLoss) {
      announcedLoss = true;
      say(
        `${warn('[bica]')} Lost the connection to ${options.sshHost}. The command is still running there; ` +
          'reconnecting.',
      );
    }
    if (at - lostSince >= graceMs) {
      return 'gave-up';
    }
    await sleep(backoff(failures));
  }
}
