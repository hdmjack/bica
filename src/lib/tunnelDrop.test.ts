import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { endRequestsInFlight } from './tunnel';
import type { ProxiedRequest } from './tunnel';

/**
 * The report's own test, as far as it can be run without severing a real link: "assert that bica
 * logs the drop and closes the local client's connection".
 *
 * The logging half is a line of output. This is the half that was the actual complaint -- a client
 * that asked a question and got neither an answer nor an error for ten and a half minutes -- and it
 * is tested on real sockets rather than doubles, because what is being asserted is precisely what a
 * waiting `node:net` client observes.
 */

let dir = '';
let servers: net.Server[] = [];
let sockets: net.Socket[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-drop-'));
  servers = [];
  sockets = [];
});

afterEach(() => {
  for (const s of sockets) {
    s.destroy();
  }
  for (const s of servers) {
    s.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A server that accepts and then says nothing at all, the way a dead link behaves. */
async function silentServer(): Promise<{ socketPath: string }> {
  const socketPath = path.join(dir, 'silent.sock');
  const server = net.createServer((connection) => {
    sockets.push(connection);
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(socketPath, resolve);
  });
  return { socketPath };
}

async function connect(socketPath: string): Promise<net.Socket> {
  const socket = net.connect(socketPath);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('error', reject);
  });
  return socket;
}

describe('a forward that dies with requests in flight', () => {
  it('ends the waiting client rather than leaving it in silence', async () => {
    const { socketPath } = await silentServer();
    const client = await connect(socketPath);
    const upstream = await connect(socketPath);

    const clientClosed = new Promise<void>((resolve) => {
      client.on('close', () => {
        resolve();
      });
    });
    client.write('a question nobody will answer');

    const inFlight = new Set<ProxiedRequest>([{ client, upstream }]);
    endRequestsInFlight(inFlight);

    await clientClosed;
    expect(client.destroyed).toBe(true);
    expect(upstream.destroyed).toBe(true);
    expect(inFlight.size).toBe(0);
  });

  it('ends every request, not only the first', async () => {
    const { socketPath } = await silentServer();
    const pairs: ProxiedRequest[] = [];
    for (let i = 0; i < 3; i += 1) {
      pairs.push({
        client: await connect(socketPath),
        upstream: await connect(socketPath),
      });
    }
    endRequestsInFlight(new Set(pairs));
    for (const pair of pairs) {
      expect(pair.client.destroyed).toBe(true);
      expect(pair.upstream.destroyed).toBe(true);
    }
  });

  it('is safe to call when nothing was in flight', () => {
    const empty = new Set<ProxiedRequest>();
    expect(() => {
      endRequestsInFlight(empty);
    }).not.toThrow();
  });
});
