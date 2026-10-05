import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildForwardSshArgs,
  joinSockets,
  buildSocketReadyScript,
  localSocketObstruction,
  parseTunnelArgs,
} from './tunnel';

describe('parseTunnelArgs', () => {
  it('splits its own flags from the remote argv at `--`', () => {
    const args = parseTunnelArgs([
      '--local=/tmp/a.sock',
      '--remote=/srv/b.sock',
      '--',
      'uv',
      'run',
      '--with',
      'spacy',
      'clauses.py',
    ]);
    expect(args.localSocket).toBe('/tmp/a.sock');
    expect(args.remoteSocket).toBe('/srv/b.sock');
    expect(args.remoteArgv).toEqual([
      'uv',
      'run',
      '--with',
      'spacy',
      'clauses.py',
    ]);
  });

  it("leaves the remote command's own flags alone", () => {
    const args = parseTunnelArgs([
      '--local=/tmp/a.sock',
      '--remote=/srv/b.sock',
      '--',
      'serve',
      '--local=something-of-its-own',
    ]);
    expect(args.remoteArgv).toEqual(['serve', '--local=something-of-its-own']);
  });

  it('defaults the ready timeout and accepts an override', () => {
    const base = ['--local=/tmp/a.sock', '--remote=/srv/b.sock', '--', 'serve'];
    expect(parseTunnelArgs(base).readyTimeoutSeconds).toBe(60);
    expect(
      parseTunnelArgs(['--ready-timeout=5', ...base]).readyTimeoutSeconds,
    ).toBe(5);
  });

  it('refuses a command with no `--` rather than guessing where it starts', () => {
    expect(() =>
      parseTunnelArgs(['--local=/tmp/a.sock', '--remote=/srv/b.sock', 'serve']),
    ).toThrow(/needs `--`/);
  });

  it('refuses an empty command, a missing socket, and a nonsense timeout', () => {
    expect(() =>
      parseTunnelArgs(['--local=/tmp/a.sock', '--remote=/srv/b.sock', '--']),
    ).toThrow(/No command/);
    expect(() => parseTunnelArgs(['--local=/tmp/a.sock', '--', 'serve'])).toThrow(
      /both required/,
    );
    expect(() =>
      parseTunnelArgs([
        '--local=/tmp/a.sock',
        '--remote=/srv/b.sock',
        '--ready-timeout=soon',
        '--',
        'serve',
      ]),
    ).toThrow(/positive number/);
  });

  it('refuses a relative local path, which ssh would not resolve as the caller expects', () => {
    expect(() =>
      parseTunnelArgs(['--local=a.sock', '--remote=/srv/b.sock', '--', 'serve']),
    ).toThrow(/absolute path/);
  });

  it('rejects an unknown flag before `--`', () => {
    expect(() =>
      parseTunnelArgs([
        '--local=/tmp/a.sock',
        '--remote=/srv/b.sock',
        '--port=1',
        '--',
        'serve',
      ]),
    ).toThrow(/Unknown option/);
  });
});

describe('buildForwardSshArgs', () => {
  it('forwards local→remote and makes a failed forward a failed ssh', () => {
    const args = buildForwardSshArgs({
      sshHost: 'mini',
      localSocket: '/tmp/a.sock',
      remoteSocket: '/srv/b.sock',
    });
    expect(args).toContain('-N');
    expect(args).toContain('-o');
    expect(args).toContain('ExitOnForwardFailure=yes');
    expect(args).toContain('StreamLocalBindUnlink=yes');
    expect(args.slice(-3)).toEqual(['-L', '/tmp/a.sock:/srv/b.sock', 'mini']);
  });
});

describe('buildSocketReadyScript', () => {
  it('waits for an answer, not merely for a file at the path', () => {
    const script = buildSocketReadyScript('/srv/b.sock', 30);
    expect(script).toContain("[ -S '/srv/b.sock' ] || return 1");
    expect(script).toContain('s.connect(sys.argv[1])');
    expect(script).toContain("python3 -c '");
  });

  it('falls back to the file check where no interpreter can connect', () => {
    expect(buildSocketReadyScript('/srv/b.sock', 30)).toContain(
      'command -v python3 >/dev/null 2>&1 || return 0',
    );
  });

  it('keeps the connect program free of single quotes, which would end its argument', () => {
    const script = buildSocketReadyScript('/srv/b.sock', 30);
    const program = script.slice(
      script.indexOf("python3 -c '") + "python3 -c '".length,
    );
    expect(program.slice(0, program.indexOf("'"))).toContain('sys.exit(1)');
  });

  it('quotes the path and gives the loop a deadline', () => {
    const script = buildSocketReadyScript("/srv/it's here.sock", 7);
    expect(script).toContain(`'/srv/it'\\''s here.sock'`);
    expect(script).toContain('+ 7 ))');
  });

  it('rounds a fractional timeout up, since shell arithmetic is integer', () => {
    expect(buildSocketReadyScript('/srv/b.sock', 1.2)).toContain('+ 2 ))');
  });
});

describe('localSocketObstruction', () => {
  const made: string[] = [];
  const tmp = (name: string): string => {
    const p = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'bica-tunnel-')),
      name,
    );
    made.push(p);
    return p;
  };

  afterEach(() => {
    for (const p of made.splice(0)) {
      fs.rmSync(p, { force: true, recursive: true });
    }
  });

  it('allows a path with nothing at it', () => {
    expect(localSocketObstruction(tmp('absent.sock'))).toBeUndefined();
  });

  it('allows a stale socket, which ssh replaces itself', async () => {
    const p = tmp('stale.sock');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(p, resolve));
    try {
      expect(localSocketObstruction(p)).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refuses a regular file or a directory rather than deleting it', () => {
    const file = tmp('notes.txt');
    fs.writeFileSync(file, 'something of the user’s');
    expect(localSocketObstruction(file)).toMatch(/regular file/);

    const dir = tmp('a-dir');
    fs.mkdirSync(dir);
    expect(localSocketObstruction(dir)).toMatch(/directory/);
  });
});

describe('parseTunnelArgs: restart and detach', () => {
  const base = ['--local=/tmp/a.sock', '--remote=/srv/b.sock', '--', 'serve'];

  it('defaults to not restarting and not detaching', () => {
    const args = parseTunnelArgs(base);
    expect(args.restart).toBe('never');
    expect(args.detach).toBe(false);
  });

  it('accepts the three restart modes', () => {
    for (const mode of ['never', 'on-exit', 'on-demand'] as const) {
      expect(parseTunnelArgs([`--restart=${mode}`, ...base]).restart).toBe(mode);
    }
  });

  it('refuses an unknown restart mode, and a bare --restart', () => {
    expect(() => parseTunnelArgs(['--restart=maybe', ...base])).toThrow(
      /--restart must be one of/,
    );
    expect(() => parseTunnelArgs(['--restart', ...base])).toThrow(
      /--restart needs a value/,
    );
  });

  it('takes --detach as a bare flag', () => {
    expect(parseTunnelArgs(['--detach', ...base]).detach).toBe(true);
  });

  it("does not read the remote command's own --restart or --detach", () => {
    const args = parseTunnelArgs([
      '--local=/tmp/a.sock',
      '--remote=/srv/b.sock',
      '--',
      'serve',
      '--restart=on-exit',
      '--detach',
    ]);
    expect(args.restart).toBe('never');
    expect(args.detach).toBe(false);
    expect(args.remoteArgv).toEqual(['serve', '--restart=on-exit', '--detach']);
  });
});

describe('joinSockets', () => {
  const made: { close: () => void }[] = [];

  afterEach(() => {
    for (const m of made.splice(0)) {
      m.close();
    }
  });

  /**
   * A server that answers with `size` bytes and closes, a proxy in front of it joined the way the
   * tunnel joins its own sockets, and a client that reads to the end through the proxy.
   */
  const replyThroughProxy = async (size: number): Promise<number> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-join-'));
    const upstreamPath = path.join(dir, 'upstream.sock');
    const proxyPath = path.join(dir, 'proxy.sock');

    const origin = net.createServer((conn) => {
      conn.on('data', () => {
        conn.end(Buffer.alloc(size, 0x61));
      });
    });
    const proxy = net.createServer((client) => {
      const upstream = net.connect(upstreamPath);
      upstream.on('connect', () => {
        joinSockets(client, upstream);
      });
    });
    made.push(
      { close: () => origin.close() },
      { close: () => proxy.close() },
      { close: () => fs.rmSync(dir, { force: true, recursive: true }) },
    );
    await new Promise<void>((r) => origin.listen(upstreamPath, r));
    await new Promise<void>((r) => proxy.listen(proxyPath, r));

    return await new Promise<number>((resolve, reject) => {
      const client = net.connect(proxyPath, () => {
        client.write('ask');
      });
      let received = 0;
      // Deliberately slow to start reading. A client that drains as fast as the proxy writes never
      // builds the queue that the truncation discarded, which is why the first version of this test
      // passed against the very bug it was written for.
      client.pause();
      setTimeout(() => {
        client.resume();
      }, 250);
      client.on('data', (chunk: Buffer) => {
        received += chunk.length;
      });
      client.on('end', () => {
        resolve(received);
      });
      client.on('close', () => {
        resolve(received);
      });
      client.on('error', reject);
    });
  };

  it('delivers a reply that fits in one socket buffer', async () => {
    expect(await replyThroughProxy(1_024)).toBe(1_024);
  });

  it('delivers a reply larger than the 16 KiB high-water mark, whole', async () => {
    // The regression: the queued remainder used to be destroyed with the socket when the upstream
    // closed, so this arrived as exactly 16384 bytes.
    expect(await replyThroughProxy(22 * 1024)).toBe(22 * 1024);
  });

  it('delivers a reply far larger than any single buffer', async () => {
    expect(await replyThroughProxy(2 * 1024 * 1024)).toBe(2 * 1024 * 1024);
  });
});
