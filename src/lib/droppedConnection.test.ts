import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONNECTION_LOST_EXIT } from './connectionLoss';
import { REMOTE_CD_FAILED_EXIT, runRemoteCommand } from './runRemote';

/**
 * The report's own suggested test, as close as it can be run without a second machine: "start a run,
 * kill the ssh connection, and assert the exit summary names a connection-loss code and message, not
 * `sleep=255`".
 *
 * A real drop needs a real link to break, so what stands in for ssh here is a script that behaves the
 * way ssh does when one breaks: it writes its complaint to the file given by `-E` and exits 255. That
 * is the whole of the contract bica now depends on, and it is the part that was wrong before --
 * everything upstream of it is ssh's business.
 */

let bin = '';
let repoRoot = '';
let originalPath = '';

/** A fake `ssh` that answers bica's probes and then fails the way `how` says. */
function installFakeSsh(how: { log: string; status: number }): void {
  fs.writeFileSync(
    path.join(bin, 'ssh'),
    [
      '#!/bin/sh',
      '# The login-shell probe runs as `ssh -T host sh -s` with the script on stdin. It has to',
      '# succeed, or bica stops before it ever opens the connection this test is about.',
      'for a in "$@"; do',
      '  if [ "$a" = "-s" ]; then cat >/dev/null; exit 0; fi',
      'done',
      '# The run itself: find -E, write what ssh would have written, and fail as ssh would.',
      'logfile=',
      'prev=',
      'for a in "$@"; do',
      '  if [ "$prev" = "-E" ]; then logfile="$a"; fi',
      '  prev="$a"',
      'done',
      `[ -n "$logfile" ] && printf '%s' ${JSON.stringify(how.log)} > "$logfile"`,
      `exit ${String(how.status)}`,
    ].join('\n'),
    { mode: 0o755 },
  );
}

beforeEach(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-fakessh-'));
  // A repo of its own, because the run reads the workspace spec for the remote shell preamble.
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-fakerepo-'));
  fs.writeFileSync(
    path.join(repoRoot, 'bica.yml'),
    'sync:\n  mode: one-way-replica\n  ignore:\n    paths: []\n',
  );
  originalPath = process.env.PATH ?? '';
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Each test gets its own host name: the login-shell probe is cached per host for the process. */
let hostCounter = 0;
function freshHost(): string {
  hostCounter += 1;
  return `fake-host-${String(hostCounter)}`;
}

async function runAgainstFakeSsh(): Promise<{ code: number; said: string }> {
  let said = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    said += String(chunk);
    return true;
  });
  const code = await runRemoteCommand(
    freshHost(),
    '~/code/repo',
    'pnpm test:run',
    repoRoot,
    { label: 'pnpm-test-run' },
  );
  return { code, said };
}

describe('a connection that drops part-way through a run', () => {
  it('is reported as 95 and named, not as the command exiting 255', async () => {
    installFakeSsh({
      status: 255,
      log:
        'Read from remote host 192.168.0.120: Connection reset by peer\n' +
        'client_loop: send disconnect: Broken pipe\n',
    });
    const { code, said } = await runAgainstFakeSsh();
    expect(code).toBe(CONNECTION_LOST_EXIT);
    expect(said).toContain('dropped part-way through');
    expect(said).toContain('Connection reset by peer');
    expect(said).toContain('pnpm-test-run');
    expect(said).toContain('unknown');
  });

  it('leaves a command that genuinely exited 255 as 255', async () => {
    // ssh says nothing of its own, so the status came back from the remote and is a real verdict.
    installFakeSsh({ status: 255, log: '' });
    const { code, said } = await runAgainstFakeSsh();
    expect(code).toBe(255);
    expect(said).not.toContain('dropped');
  });

  it('calls a connection that was never made unreachable, which is a different instruction', async () => {
    installFakeSsh({
      status: 255,
      log: 'ssh: connect to host mini port 22: Connection refused\n',
    });
    const { code, said } = await runAgainstFakeSsh();
    expect(code).toBe(REMOTE_CD_FAILED_EXIT);
    expect(said).toContain('nothing ran');
  });

  it('still shows what ssh said when it cannot classify it', async () => {
    // `-E` takes ssh's messages off the terminal. A warning that used to be visible must not become
    // invisible in exchange for the ones bica now understands.
    installFakeSsh({
      status: 1,
      log: 'Warning: the ECDSA host key for mini has changed\n',
    });
    const { code, said } = await runAgainstFakeSsh();
    expect(code).toBe(1);
    expect(said).toContain('host key for mini has changed');
  });

  it('stays quiet when the command answered for itself', async () => {
    // A failing command needs no commentary from ssh, and `-v` has plenty to offer.
    installFakeSsh({
      status: 3,
      log:
        'debug1: Exit status 3\n' +
        'Bytes per second: sent 76718.9, received 60615.2\n',
    });
    const { code, said } = await runAgainstFakeSsh();
    expect(code).toBe(3);
    expect(said).not.toContain('Bytes per second');
  });

  it('says nothing extra when the run succeeded', async () => {
    installFakeSsh({
      status: 0,
      log: 'Warning: Permanently added mini to the list of known hosts.\n',
    });
    const { code, said } = await runAgainstFakeSsh();
    expect(code).toBe(0);
    expect(said).not.toContain('known hosts');
  });
});
