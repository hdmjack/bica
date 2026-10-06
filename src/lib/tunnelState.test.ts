import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claimLocalSocket,
  cleanUpAfterDeadTunnel,
  describeTunnel,
  forwardSocketPathFor,
  listTunnelRecords,
  readTunnelRecord,
  recordPathFor,
  removeTunnelRecord,
  tunnelLogPathFor,
  writeTunnelRecord,
} from './tunnelState';

const HOME = path.join(os.tmpdir(), 'bica-tunnel-state-tests');

const record = (over: Partial<Parameters<typeof writeTunnelRecord>[0]> = {}) => ({
  localSocket: '/tmp/parser.sock',
  remoteSocket: '/tmp/parser.sock',
  sshHost: 'mini',
  remoteArgv: ['serve'],
  pid: process.pid,
  startedAt: new Date().toISOString(),
  restart: 'on-demand' as const,
  ...over,
});

describe('the tunnel registry', () => {
  // `os.homedir()` reads $HOME on POSIX, and cannot be spied on in ESM -- so the environment is the
  // seam, which is also closer to what the production path actually depends on.
  const realHome = process.env.HOME;

  beforeEach(() => {
    fs.rmSync(HOME, { force: true, recursive: true });
    fs.mkdirSync(HOME, { recursive: true });
    process.env.HOME = HOME;
  });

  afterEach(() => {
    if (realHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = realHome;
    }
    fs.rmSync(HOME, { force: true, recursive: true });
  });

  it('round-trips a record, keyed by the socket path', () => {
    writeTunnelRecord(record());
    expect(readTunnelRecord('/tmp/parser.sock')?.sshHost).toBe('mini');
    expect(readTunnelRecord('/tmp/other.sock')).toBeNull();
  });

  it('keys on the resolved path, so two spellings are one tunnel', () => {
    expect(recordPathFor('/tmp/parser.sock')).toBe(
      recordPathFor('/tmp/./parser.sock'),
    );
  });

  it('keeps the forward socket and the log beside the record, not at the client path', () => {
    const fwd = forwardSocketPathFor('/tmp/parser.sock');
    expect(fwd).not.toBe('/tmp/parser.sock');
    expect(path.dirname(fwd)).toBe(path.dirname(recordPathFor('/tmp/parser.sock')));
    expect(tunnelLogPathFor('/tmp/parser.sock').endsWith('.log')).toBe(true);
  });

  it('reports a live owner as taken', () => {
    writeTunnelRecord(record());
    const outcome = claimLocalSocket('/tmp/parser.sock');
    expect(outcome.kind).toBe('taken');
  });

  it('treats a record whose process is gone as litter, not as a conflict', () => {
    // A pid that cannot be running: the kernel has no process 0 to signal.
    writeTunnelRecord(record({ pid: 2 ** 30 }));
    const outcome = claimLocalSocket('/tmp/parser.sock');
    expect(outcome.kind).toBe('stale');
  });

  it('is free once a record is removed', () => {
    writeTunnelRecord(record());
    removeTunnelRecord('/tmp/parser.sock');
    expect(claimLocalSocket('/tmp/parser.sock').kind).toBe('free');
  });

  it('survives a corrupt record rather than failing the listing', () => {
    writeTunnelRecord(record());
    fs.writeFileSync(path.join(HOME, '.bica', 'tunnels', 'junk.json'), '{oops');
    expect(listTunnelRecords()).toHaveLength(1);
  });

  it('lists live tunnels before dead ones', () => {
    writeTunnelRecord(record({ localSocket: '/tmp/a.sock', pid: 2 ** 30 }));
    writeTunnelRecord(record({ localSocket: '/tmp/b.sock' }));
    const listed = listTunnelRecords();
    expect(listed.map((e) => e.record.localSocket)).toEqual([
      '/tmp/b.sock',
      '/tmp/a.sock',
    ]);
    expect(listed[0].alive).toBe(true);
    expect(listed[1].alive).toBe(false);
  });

  it('says plainly when a listed tunnel is not running', () => {
    expect(describeTunnel(record({ pid: 2 ** 30 }), false)).toContain(
      'not running',
    );
    expect(describeTunnel(record(), true)).toContain(`pid ${String(process.pid)}`);
  });

  it('returns nothing at all when no tunnel has ever run', () => {
    expect(listTunnelRecords()).toEqual([]);
  });
});

describe('cleaning up after a tunnel that was killed', () => {
  const realHome = process.env.HOME;

  beforeEach(() => {
    fs.rmSync(HOME, { force: true, recursive: true });
    fs.mkdirSync(HOME, { recursive: true });
    process.env.HOME = HOME;
  });

  afterEach(() => {
    if (realHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = realHome;
    }
    fs.rmSync(HOME, { force: true, recursive: true });
  });

  it('removes the socket a dead tunnel left bound to nothing', async () => {
    const localSocket = path.join(HOME, 'left-behind.sock');
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(localSocket, r));
    await new Promise<void>((r) => server.close(() => r()));
    // A socket file with no listener is what a killed tunnel leaves: present, and refusing.
    fs.writeFileSync(localSocket, '');
    fs.rmSync(localSocket);
    const server2 = net.createServer();
    await new Promise<void>((r) => server2.listen(localSocket, r));

    const rec = record({ localSocket, pid: 2 ** 30 });
    writeTunnelRecord(rec);
    const removed = cleanUpAfterDeadTunnel(rec);
    await new Promise<void>((r) => server2.close(() => r()));

    expect(removed).toContain(localSocket);
    expect(fs.existsSync(localSocket)).toBe(false);
  });

  it('leaves a path alone when there is no socket at it', () => {
    const rec = record({ localSocket: path.join(HOME, 'never-existed.sock') });
    expect(cleanUpAfterDeadTunnel(rec)).toEqual([]);
  });

  it('does not delete a regular file that happens to share the path', () => {
    const localSocket = path.join(HOME, 'notes.txt');
    fs.writeFileSync(localSocket, 'something of the user’s');
    const rec = record({ localSocket });
    expect(cleanUpAfterDeadTunnel(rec)).toEqual([]);
    expect(fs.existsSync(localSocket)).toBe(true);
  });
});

describe('what the orphan sweep is allowed to kill', () => {
  const realHome = process.env.HOME;

  beforeEach(() => {
    fs.rmSync(HOME, { force: true, recursive: true });
    fs.mkdirSync(HOME, { recursive: true });
    process.env.HOME = HOME;
  });

  afterEach(() => {
    if (realHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = realHome;
    }
    fs.rmSync(HOME, { force: true, recursive: true });
  });

  it('spares a process that merely has the remote socket path in its arguments', async () => {
    // The remote socket is an ordinary name the user chose -- /tmp/parser.sock and the like -- and
    // `pgrep -f` is a substring match over every command line on the machine. Searching for it meant
    // `bica tunnel --list` could SIGTERM a local server of the same name, a tail on its log, or
    // someone else's live tunnel to the same remote socket.
    const remoteSocket = '/tmp/bica-decoy-sweep-test.sock';
    // The loop matters: `sh -c 'sleep 30' <arg>` execs straight into sleep, which drops the argument
    // from the command line and so would not be found by the very search being tested.
    const decoy = spawn(
      'sh',
      ['-c', 'while :; do sleep 1; done', remoteSocket],
      { stdio: 'ignore' },
    );
    // Watch for the exit rather than reading `exitCode`: a child killed by a signal keeps a null
    // exit code and reports the signal separately, so the obvious assertion holds either way.
    let exited = false;
    decoy.on('exit', () => {
      exited = true;
    });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      expect(decoy.pid).toBeDefined();
      expect(exited).toBe(false);

      cleanUpAfterDeadTunnel(
        record({
          localSocket: path.join(HOME, 'gone.sock'),
          remoteSocket,
          pid: 2 ** 30,
        }),
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      expect(exited).toBe(false);
    } finally {
      decoy.kill('SIGKILL');
    }
  });
});
