import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Telling a lost connection apart from a failed command.
 *
 * ssh exits 255 both when the remote command exits 255 and when ssh itself gives up on the
 * connection, and it writes its explanation to the same stderr the command has been writing to all
 * along. From the outside those are the same event: a two-command run whose link died part-way
 * through reported `pnpm-test-run=255` beside `pnpm-typecheck=0`, which reads as a test suite that
 * failed in an unusual way. The only clue was ssh's own `Connection reset by peer` sitting in the
 * middle of the test output, under the same label as the tests.
 *
 * The separation comes from `ssh -E`, which sends ssh's own diagnostics to a file instead of mixing
 * them into the stream. What lands there is ssh speaking, never the command, so a message found in
 * it can be trusted to be about the connection. bica reads it when a run fails, and says what it
 * found rather than leaving it on the terminal, which is where it was being overlooked.
 *
 * Since the file is private, bica also asks for `-v`, and that is what the answer actually rests on.
 * Matching ssh's error wording was the first attempt and it was wrong within the hour: a deliberately
 * severed link reported `Connection closed by UNKNOWN port 65535`, which is also what a refused
 * handshake says. Verbose output answers the two questions directly instead. `Authenticated to …`
 * means a session existed, so a failure after it is a failure of the link. `debug1: Exit status N`
 * means the remote command's own code came back, so 255 is the command's word and not ssh's. A drop
 * is the case where the first appears and the second never does.
 */

/**
 * Exit code for a run whose connection dropped part-way through.
 *
 * In the family with 96, 97 and 98: none of them is a verdict on the code. This one is the weakest
 * claim of the four -- the command may have passed, failed, or still be running on the remote. The
 * only honest thing to report is that nobody knows.
 */
export const CONNECTION_LOST_EXIT = 95;

export type SshFailure =
  /** The session was established and then died. The command's result is unknown. */
  | 'connection-lost'
  /** The session was never established. Nothing ran. */
  | 'could-not-connect'
  /** ssh said nothing about the connection, so 255 is the command's own exit code. */
  | 'unknown';

/**
 * ssh's verbose lines for a session that reached the far end.
 *
 * `Authenticated to` carries no `debug1:` prefix, unlike almost everything else `-v` prints -- which
 * cost a live run to discover, because a fixture written from memory had the prefix and passed.
 * `Entering interactive session` is the second witness, and `mux_client_request_session` is the
 * first one's stand-in on a multiplexed connection, where the master authenticated and this client
 * did not.
 */
const SESSION_ESTABLISHED: readonly RegExp[] = [
  /^(?:debug1: )?Authenticated to /m,
  /^debug1: Entering interactive session/m,
  /^debug1: mux_client_request_session/m,
];

/** ssh's verbose line for the remote command's own exit code coming back. */
const REMOTE_REPORTED_ITS_EXIT = /^debug1: Exit status /m;

/**
 * Whether the remote command's own exit code came back.
 *
 * When it did, ssh has nothing to add: the status is the command's verdict, and anything ssh wrote
 * is the bookkeeping `-v` always prints.
 */
export function remoteReportedItsExit(diagnostics: string): boolean {
  return REMOTE_REPORTED_ITS_EXIT.test(diagnostics);
}

/**
 * Lines `-v` prints on its way out, which are not about anything going wrong.
 *
 * Unfiltered, the transfer statistics are the last line of a verbose log, so a command that merely
 * exited 3 was followed by `[bica] ssh: Bytes per second: sent 76718.9, received 60615.2`.
 */
const VERBOSE_EPILOGUE =
  /^(?:Transferred: |Bytes per second: |Authenticated to |Connection to .* closed\.$)/;

/** Whether this log was written with `-v`, and so can be read the firm way. */
function isVerbose(diagnostics: string): boolean {
  return /^debug1: /m.test(diagnostics);
}

/**
 * Checked first, because some of these contain the mid-session wording.
 *
 * `kex_exchange_identification: read: Connection reset by peer` is a refused or dropped *handshake*:
 * same words, opposite meaning, and nothing ran. Matching the drop patterns first would report an
 * unreachable host as a lost run and send the user away to re-run instead of to fix their ssh.
 */
const COULD_NOT_CONNECT: readonly RegExp[] = [
  /kex_exchange_identification/,
  /Could not resolve hostname/,
  /Connection refused/,
  /No route to host/,
  /Network is unreachable/,
  /Host key verification failed/,
  /Permission denied \(/,
  /connect to host .* port .*: (Operation|Connection) timed out/,
];

/** ssh's vocabulary for a session that was up and is not any more. Deliberately not exhaustive. */
const DROPPED_MID_SESSION: readonly RegExp[] = [
  /Connection reset by peer/,
  /Broken pipe/,
  /client_loop: send disconnect/,
  /Timeout, server .* not responding/,
  /Connection to .* closed by remote host/,
  /Connection closed by remote host/,
  /packet_write_wait/,
];

/**
 * What ssh's exit status and its own diagnostics together say about a failed run.
 *
 * Only 255 is ssh's to claim. Every other status came back from the remote command, and a drop that
 * produced one of those would be a bug in ssh rather than something to guess at here.
 */
export function classifySshFailure(options: {
  status: number;
  diagnostics: string;
}): SshFailure {
  const { status, diagnostics } = options;
  if (status !== 255) {
    return 'unknown';
  }
  if (isVerbose(diagnostics)) {
    if (REMOTE_REPORTED_ITS_EXIT.test(diagnostics)) {
      return 'unknown';
    }
    return SESSION_ESTABLISHED.some((p) => p.test(diagnostics))
      ? 'connection-lost'
      : 'could-not-connect';
  }
  // No verbose log to read: an ssh too old for `-E`, or a log that could not be written. Reading the
  // wording is weaker -- it is what missed the drop above -- but it is better than saying nothing.
  if (COULD_NOT_CONNECT.some((p) => p.test(diagnostics))) {
    return 'could-not-connect';
  }
  if (DROPPED_MID_SESSION.some((p) => p.test(diagnostics))) {
    return 'connection-lost';
  }
  return 'unknown';
}

/**
 * The one line worth quoting back, out of however many ssh wrote.
 *
 * A drop usually produces two or three lines, of which the first names the cause and the rest are
 * ssh tidying up. Preferring a line that matched is what keeps `Connection reset by peer` from being
 * reported as `client_loop: send disconnect: Broken pipe`, which is true but downstream of it.
 */
export function sshDiagnosticSummary(diagnostics: string): string | undefined {
  const lines = diagnostics
    .split('\n')
    .map((line) => line.trim())
    // The verbose trace is for the classifier, not for the reader: a hundred `debug1:` lines about
    // host keys have nothing to say to someone whose connection just died.
    .filter(
      (line) =>
        line.length > 0 &&
        !/^debug[123]: /.test(line) &&
        !VERBOSE_EPILOGUE.test(line),
    );
  const interesting = lines.find((line) =>
    [...COULD_NOT_CONNECT, ...DROPPED_MID_SESSION].some((p) => p.test(line)),
  );
  return interesting ?? lines.at(-1);
}

export interface SshDiagnosticsLog {
  /** Pass to `ssh -E`. */
  path: string;
  read: () => string;
  remove: () => void;
}

/**
 * A private file for one ssh to log into.
 *
 * Its own directory, because a run opens one connection per command and each needs its own file;
 * under `mkdtemp` so that two runs on one machine cannot collide. Every operation on it is
 * best-effort: a diagnostics file that cannot be read must not be able to fail a run that worked.
 */
export function openSshDiagnosticsLog(): SshDiagnosticsLog {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-ssh-'));
  const file = path.join(dir, 'ssh.log');
  return {
    path: file,
    read: () => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return '';
      }
    },
    remove: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Nothing to do about a temp directory that will not go.
      }
    },
  };
}

/**
 * What to tell someone whose connection dropped.
 *
 * Says the result is unknown rather than implying the command failed, and names the command when
 * there is more than one, because the summary line it precedes is a row of numbers.
 */
export function describeConnectionLoss(options: {
  sshHost: string;
  label?: string;
  diagnostics: string;
}): string {
  const who = options.label === undefined ? '' : `${options.label}: `;
  const said = sshDiagnosticSummary(options.diagnostics);
  const quoted = said === undefined ? '' : ` ssh said: ${said}`;
  return (
    `${who}the connection to ${options.sshHost} dropped part-way through.${quoted}\n` +
    `Whether the command passed, failed, or is still running on ${options.sshHost} is unknown, ` +
    `so exit ${String(CONNECTION_LOST_EXIT)} is not a verdict on your code. Re-run it.`
  );
}
