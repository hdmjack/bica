import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ForwardStderr,
  checkLocalSocket,
  describeBindFailure,
  inodeAt,
  pathIsServed,
} from './tunnelSocketWatch';

/**
 * Both halves of the report, each tested against the thing it was wrong about.
 *
 * The message half is what the report asked for directly: "the failure message must quote the ssh
 * error and not suggest an OpenSSH version problem unless ssh actually reported missing stream-local
 * support". Its fixtures are the two lines the tunnel's own log showed, verbatim.
 *
 * The recovery half is the report's first expectation, after the diagnosis moved. The tunnel did not
 * fail to retry: it was never asked, because the socket it listens on had been unlinked and replaced
 * by something that then went away, so every client got `ECONNREFUSED` three milliseconds in. These
 * run on real sockets, since the whole question is what the filesystem and the kernel say.
 */

let dir = '';
let servers: net.Server[] = [];

beforeEach(() => {
  // Short, because a unix socket path is capped near 104 characters and the obvious temp paths are
  // longer than that -- a bind that fails with EADDRINUSE on a path with no file at it.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-'));
  servers = [];
});

afterEach(() => {
  for (const s of servers) {
    s.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

async function serve(socketPath: string): Promise<net.Server> {
  const server = net.createServer(() => {});
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(socketPath, resolve);
  });
  return server;
}

describe('describeBindFailure', () => {
  // Exactly what the tunnel's log held, one line above the message that contradicted it.
  const TIMED_OUT =
    'ssh: connect to host 192.168.0.120 port 22: Operation timed out\n';

  it('says the host was unreachable when that is what ssh said', () => {
    const said = describeBindFailure({
      forwardPath: '/x/t.fwd',
      sshHost: 'mini',
      stderr: TIMED_OUT,
    });
    expect(said).toContain('could not reach mini');
    expect(said).toContain('Operation timed out');
  });

  it('does not blame the OpenSSH version for a connect timeout', () => {
    // The sentence that sent a reader looking at ssh versions on two machines that had been
    // forwarding this socket for two days.
    expect(
      describeBindFailure({
        forwardPath: '/x/t.fwd',
        sshHost: 'mini',
        stderr: TIMED_OUT,
      }),
    ).not.toContain('6.7');
  });

  it.each([
    'ssh: connect to host mini port 22: Connection refused\n',
    'ssh: Could not resolve hostname mini: nodename nor servname provided\n',
    'ssh: connect to host 10.0.0.2 port 22: No route to host\n',
  ])('keeps the version theory out of %s', (stderr) => {
    expect(
      describeBindFailure({ forwardPath: '/x/t.fwd', sshHost: 'mini', stderr }),
    ).not.toContain('6.7');
  });

  it('still names the version when ssh really did refuse the forward kind', () => {
    const said = describeBindFailure({
      forwardPath: '/x/t.fwd',
      sshHost: 'old-box',
      stderr: 'unix domain socket forwarding is not supported\n',
    });
    expect(said).toContain('6.7');
    expect(said).toContain('not supported');
  });

  it('offers the version as a guess only when ssh said nothing at all', () => {
    const said = describeBindFailure({
      forwardPath: '/x/t.fwd',
      sshHost: 'mini',
      stderr: '',
    });
    expect(said).toContain('said nothing about why');
    expect(said).toContain('6.7');
  });

  it('quotes an unfamiliar error without inventing a cause for it', () => {
    const said = describeBindFailure({
      forwardPath: '/x/t.fwd',
      sshHost: 'mini',
      stderr: 'ssh: something nobody has seen before\n',
    });
    expect(said).toContain('something nobody has seen before');
    expect(said).not.toContain('6.7');
    expect(said).not.toContain('could not reach');
  });
});

describe('ForwardStderr', () => {
  it('keeps the most recent words, which are the ones worth quoting', () => {
    const buffer = new ForwardStderr();
    buffer.add('first\n');
    buffer.add('second\n');
    expect(buffer.last).toContain('second');
  });

  it('forgets a previous attempt when a new forward starts', () => {
    // Otherwise a fresh failure is explained by the last one's error, which is how a wrong line
    // outlives the thing that caused it.
    const buffer = new ForwardStderr();
    buffer.add('Operation timed out\n');
    buffer.clear();
    expect(buffer.last).toBe('');
  });

  it('does not grow without limit on a forward that complains every few seconds', () => {
    const buffer = new ForwardStderr();
    for (let i = 0; i < 2_000; i += 1) {
      buffer.add('connect to host mini port 22: Operation timed out\n');
    }
    expect(buffer.last.length).toBeLessThanOrEqual(4_000);
  });
});

describe('checkLocalSocket', () => {
  it('is content while the path still leads to this listener', async () => {
    const socketPath = path.join(dir, 'a.sock');
    await serve(socketPath);
    expect(await checkLocalSocket(socketPath, inodeAt(socketPath))).toBe('ours');
  });

  it('calls a replaced path that nothing serves abandoned', async () => {
    // The state the reported tunnel was in for two days: a socket file at the path, its listener
    // gone, and the tunnel still holding the socket the path used to name.
    const socketPath = path.join(dir, 'b.sock');
    const server = await serve(socketPath);
    const ours = inodeAt(socketPath);
    // Something else takes the name and then goes away, which is what leaves the file behind.
    fs.unlinkSync(socketPath);
    const usurper = await serve(socketPath);
    await new Promise<void>((resolve) => {
      usurper.close(() => {
        resolve();
      });
    });
    fs.writeFileSync(socketPath, '');
    expect(await checkLocalSocket(socketPath, ours)).toBe('abandoned');
    server.close();
  });

  it('calls a path somebody else is serving taken, which is not ours to reclaim', async () => {
    const socketPath = path.join(dir, 'c.sock');
    await serve(socketPath);
    const ours = inodeAt(socketPath);
    fs.unlinkSync(socketPath);
    await serve(socketPath);
    expect(await checkLocalSocket(socketPath, ours)).toBe('taken');
  });

  it('calls a path that has been deleted outright abandoned', async () => {
    const socketPath = path.join(dir, 'd.sock');
    await serve(socketPath);
    const ours = inodeAt(socketPath);
    fs.unlinkSync(socketPath);
    expect(await checkLocalSocket(socketPath, ours)).toBe('abandoned');
  });
});

describe('pathIsServed', () => {
  it('is true for a listener and false for a leftover file', async () => {
    const live = path.join(dir, 'live.sock');
    await serve(live);
    expect(await pathIsServed(live)).toBe(true);

    const dead = path.join(dir, 'dead.sock');
    fs.writeFileSync(dead, '');
    expect(await pathIsServed(dead)).toBe(false);
  });

  it('is false rather than throwing for a path with nothing at it', async () => {
    expect(await pathIsServed(path.join(dir, 'missing.sock'))).toBe(false);
  });
});

describe('inodeAt', () => {
  it('has nothing to report for a path that does not exist', () => {
    expect(inodeAt(path.join(dir, 'nope.sock'))).toBeUndefined();
  });

  it('changes when the path is replaced, which is the whole signal', async () => {
    const socketPath = path.join(dir, 'e.sock');
    await serve(socketPath);
    const before = inodeAt(socketPath);
    fs.unlinkSync(socketPath);
    await serve(socketPath);
    expect(inodeAt(socketPath)).not.toBe(before);
  });
});
