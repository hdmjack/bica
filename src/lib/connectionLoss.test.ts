import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  CONNECTION_LOST_EXIT,
  classifySshFailure,
  describeConnectionLoss,
  openSshDiagnosticsLog,
  sshDiagnosticSummary,
} from './connectionLoss';

/** Exactly what ssh wrote when a two-command run lost its link mid-suite. */
const REPORTED_DROP =
  'Read from remote host 192.168.0.120: Connection reset by peer\n' +
  'client_loop: send disconnect: Broken pipe\n';

/**
 * Verbose logs copied from `mini`, line for line.
 *
 * Not paraphrased, and the distinction earned its place twice. The first version of this file
 * matched on ssh's error wording, which passed its tests and then met a real severed link whose
 * message -- `Connection closed by UNKNOWN port 65535` -- is also what a refused handshake prints.
 * The second version keyed on `debug1: Authenticated to`, a line that does not exist: ssh prints
 * that one without the `debug1:` prefix that nearly everything else carries. Both passed against
 * fixtures written from memory and both got the live case wrong.
 */
const VERBOSE_DROP =
  'debug1: Server accepts key: /Users/x/.ssh/id_ed25519 ED25519 SHA256:abc agent\n' +
  'Authenticated to 192.168.0.120 (via proxy) using "publickey".\n' +
  'debug1: Entering interactive session.\n' +
  'debug1: Sending command: zsh -lc echo started; sleep 120\n' +
  'debug1: pledge: fork\n' +
  'client_loop: send disconnect: Broken pipe\n';

const VERBOSE_COMMAND_FAILED =
  'Authenticated to 192.168.0.120 ([192.168.0.120]:22) using "publickey".\n' +
  'debug1: Entering interactive session.\n' +
  'debug1: Sending command: zsh -lc exit 255\n' +
  'debug1: Exit status 255\n';

const VERBOSE_NEVER_CONNECTED =
  'debug1: Connecting to 127.0.0.1 port 9.\n' +
  'debug1: connect to address 127.0.0.1 port 9: Connection refused\n' +
  'ssh: connect to host 127.0.0.1 port 9: Connection refused\n';

describe('classifySshFailure, reading a verbose log', () => {
  it('calls a session that was up and then died a lost connection', () => {
    expect(classifySshFailure({ status: 255, diagnostics: VERBOSE_DROP })).toBe(
      'connection-lost',
    );
  });

  it('believes the command when its own exit code came back', () => {
    // `Exit status 255` is the remote reporting; without it, 255 is ssh giving up.
    expect(
      classifySshFailure({ status: 255, diagnostics: VERBOSE_COMMAND_FAILED }),
    ).toBe('unknown');
  });

  it('calls a session that never existed unreachable', () => {
    expect(
      classifySshFailure({ status: 255, diagnostics: VERBOSE_NEVER_CONNECTED }),
    ).toBe('could-not-connect');
  });

  it('does not depend on the wording of the error at all', () => {
    // The live failure that broke the first version of this: a severed link whose message is also
    // what a refused handshake says. Authentication is what tells them apart.
    const sameWordsEitherWay = 'Connection closed by UNKNOWN port 65535\n';
    expect(
      classifySshFailure({
        status: 255,
        diagnostics:
          'debug1: Connecting to mini port 22.\n' +
          `Authenticated to mini using "publickey".\n${sameWordsEitherWay}`,
      }),
    ).toBe('connection-lost');
    expect(
      classifySshFailure({
        status: 255,
        diagnostics: `debug1: SSH2_MSG_KEXINIT sent\n${sameWordsEitherWay}`,
      }),
    ).toBe('could-not-connect');
  });
});

describe('classifySshFailure, with only ssh\'s wording to go on', () => {
  it('calls the reported drop a lost connection', () => {
    expect(
      classifySshFailure({ status: 255, diagnostics: REPORTED_DROP }),
    ).toBe('connection-lost');
  });

  it.each([
    ['a server that stopped answering', 'Timeout, server mini not responding.\n'],
    ['a remote that hung up', 'Connection to mini closed by remote host.\n'],
    ['a write that found nothing there', 'packet_write_wait: Connection to 10.0.0.2 port 22: Broken pipe\n'],
  ])('calls %s a lost connection', (_name, log) => {
    expect(classifySshFailure({ status: 255, diagnostics: log })).toBe(
      'connection-lost',
    );
  });

  it('calls a refused handshake unreachable, though it uses the same words as a drop', () => {
    // The distinction that matters: nothing ran, so the answer is "fix your ssh", not "re-run".
    expect(
      classifySshFailure({
        status: 255,
        diagnostics:
          'kex_exchange_identification: read: Connection reset by peer\n',
      }),
    ).toBe('could-not-connect');
  });

  it.each([
    'ssh: Could not resolve hostname mini: nodename nor servname provided\n',
    'ssh: connect to host mini port 22: Connection refused\n',
    'ssh: connect to host 10.0.0.2 port 22: Operation timed out\n',
    'mini: Permission denied (publickey).\n',
    'Host key verification failed.\n',
  ])('calls a connection that was never made unreachable: %s', (log) => {
    expect(classifySshFailure({ status: 255, diagnostics: log })).toBe(
      'could-not-connect',
    );
  });

  it('leaves a command that exited 255 on its own alone', () => {
    // ssh passes the remote status through, so 255 with nothing from ssh is the command's own word.
    expect(classifySshFailure({ status: 255, diagnostics: '' })).toBe('unknown');
  });

  it('never claims a drop for a status ssh does not use for one', () => {
    // A failing test suite exits 1 with ssh silent; a drop is always 255. Without this, any run
    // whose log happened to mention a broken pipe would be reported as a lost connection.
    expect(
      classifySshFailure({ status: 1, diagnostics: REPORTED_DROP }),
    ).toBe('unknown');
  });
});

describe('sshDiagnosticSummary', () => {
  it('leaves the verbose trace out of what it quotes back', () => {
    // A hundred lines about host key files have nothing to say to someone whose link just died.
    const said = sshDiagnosticSummary(
      'debug1: Connecting to mini port 22.\n' +
        'Authenticated to mini using "publickey".\n' +
        'client_loop: send disconnect: Broken pipe\n',
    );
    expect(said).toBe('client_loop: send disconnect: Broken pipe');
  });

  it('quotes the cause rather than the tidying-up that follows it', () => {
    expect(sshDiagnosticSummary(REPORTED_DROP)).toBe(
      'Read from remote host 192.168.0.120: Connection reset by peer',
    );
  });

  it('falls back to the last thing ssh said when nothing is recognised', () => {
    expect(sshDiagnosticSummary('something new\nand then this\n')).toBe(
      'and then this',
    );
  });

  it('says nothing about the statistics ssh prints on its way out', () => {
    // These followed every ordinary failure for one build: `[bica] ssh: Bytes per second: sent
    // 76718.9, received 60615.2` under a command that had simply exited 3.
    expect(
      sshDiagnosticSummary(
        'debug1: Exit status 3\n' +
          'Transferred: sent 4216, received 3304 bytes, in 0.1 seconds\n' +
          'Bytes per second: sent 76718.9, received 60615.2\n',
      ),
    ).toBeUndefined();
  });

  it('has nothing to say about an empty log', () => {
    expect(sshDiagnosticSummary('  \n\n')).toBeUndefined();
  });
});

describe('describeConnectionLoss', () => {
  it('says the result is unknown, not that the command failed', () => {
    const message = describeConnectionLoss({
      sshHost: 'mini',
      diagnostics: REPORTED_DROP,
    });
    expect(message).toContain('Connection reset by peer');
    expect(message).toContain('unknown');
    expect(message).toContain(String(CONNECTION_LOST_EXIT));
    expect(message).toContain('not a verdict');
  });

  it('names the command when there is more than one', () => {
    // The line it precedes is `exit codes: pnpm-test-run=95 pnpm-typecheck=0`, which on its own
    // leaves the reader to work out which of the two this is about.
    expect(
      describeConnectionLoss({
        sshHost: 'mini',
        label: 'pnpm-test-run',
        diagnostics: REPORTED_DROP,
      }),
    ).toContain('pnpm-test-run:');
  });
});

describe('openSshDiagnosticsLog', () => {
  it('reads back what ssh would have written, and cleans up after itself', () => {
    const log = openSshDiagnosticsLog();
    expect(log.read()).toBe('');
    fs.writeFileSync(log.path, REPORTED_DROP, 'utf8');
    expect(log.read()).toContain('Connection reset by peer');
    log.remove();
    expect(fs.existsSync(log.path)).toBe(false);
  });

  it('reads an empty string rather than throwing when the file never appeared', () => {
    // ssh that failed to start writes nothing; a diagnostics read must not be able to fail a run.
    const log = openSshDiagnosticsLog();
    log.remove();
    expect(log.read()).toBe('');
  });
});
