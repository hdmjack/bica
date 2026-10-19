import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildForwardSshArgs,
  forwardKeepaliveOptions,
  tunnelDeadAfterSeconds,
  sshRefusedTheRemoteSocket,
  buildSocketReadyScript,
  joinSockets,
  localSocketObstruction,
  parseTunnelArgs,
  classifyTunnelInvocation,
  tunnelNeedsWorkspace,
} from './tunnel';
import { parseArgs } from '../cliArgs';

describe('classifyTunnelInvocation', () => {
  it('reads --list, --stop and --restart <path> without a workspace', () => {
    expect(classifyTunnelInvocation(['--list'])).toEqual({ kind: 'list' });
    expect(classifyTunnelInvocation(['--stop', '/tmp/a.sock'])).toEqual({
      kind: 'stop',
      target: '/tmp/a.sock',
    });
    expect(classifyTunnelInvocation(['--stop=/tmp/a.sock'])).toEqual({
      kind: 'stop',
      target: '/tmp/a.sock',
    });
    expect(classifyTunnelInvocation(['--restart', '/tmp/a.sock'])).toEqual({
      kind: 'restart',
      target: '/tmp/a.sock',
    });
    for (const tail of [
      ['--list'],
      ['--stop', '/tmp/a.sock'],
      ['--stop=/tmp/a.sock'],
    ]) {
      expect(tunnelNeedsWorkspace(tail)).toBe(false);
    }
  });

  it('tells `--restart=<mode>` on a new tunnel from `--restart <path>` on a recorded one', () => {
    const starting = [
      '--local=/tmp/a.sock',
      '--remote=/srv/b.sock',
      '--restart=on-demand',
      '--',
      'serve',
    ];
    expect(classifyTunnelInvocation(starting)).toEqual({ kind: 'start' });
    expect(tunnelNeedsWorkspace(starting)).toBe(true);
  });

  it('wants a workspace to revive a recorded tunnel, which starts one', () => {
    // The revived tunnel is spawned into this directory, so refusing here is the earlier and
    // clearer of the two places it can fail.
    expect(tunnelNeedsWorkspace(['--restart', '/tmp/a.sock'])).toBe(true);
  });
});

describe('parseTunnelArgs and the global flag parser together', () => {
  // The regression this guards: `parseArgs` lifts `--detach` out of the whole command line for
  // `bica run --detach`, so the tunnel's own parser never saw the token and started a foreground
  // tunnel that could not return. Both halves are asserted here rather than in two files, because
  // each half was individually correct -- only the seam was wrong.
  const tunnelArgv = [
    'tunnel',
    '--local=/tmp/a.sock',
    '--remote=/srv/b.sock',
    '--restart=on-demand',
    '--detach',
    '--',
    'serve',
  ];

  it('loses --detach from the argv the tunnel command is handed', () => {
    const globals = parseArgs(tunnelArgv);
    expect(globals.detach).toBe(true);
    expect(globals.rest).not.toContain('--detach');
  });

  it('still detaches, because the global parser passes the flag on', () => {
    const globals = parseArgs(tunnelArgv);
    const args = parseTunnelArgs(globals.rest.slice(1), {
      detachedByGlobals: globals.detach,
    });
    expect(args.detach).toBe(true);
    // The command bound for the remote must not have grown a flag on the way through.
    expect(args.remoteArgv).toEqual(['serve']);
  });

  it('does not detach a tunnel nobody asked to detach', () => {
    const globals = parseArgs([
      'tunnel',
      '--local=/tmp/a.sock',
      '--remote=/srv/b.sock',
      '--',
      'serve',
    ]);
    expect(
      parseTunnelArgs(globals.rest.slice(1), {
        detachedByGlobals: globals.detach,
      }).detach,
    ).toBe(false);
  });
});

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

describe('how long a dead forward goes unnoticed', () => {
  it('gives up after about a minute, not ten', () => {
    // Ten minutes was the inherited setting, and it was not a figure anyone chose for a tunnel: a
    // link died with a request in flight and the client sat in silence for 10m32s, which is
    // `ServerAliveInterval=30` times `ServerAliveCountMax=20` to the second.
    const args = buildForwardSshArgs({
      sshHost: 'mini',
      localSocket: '/tmp/a.sock',
      remoteSocket: '/srv/b.sock',
    });
    const interval = Number(
      /ServerAliveInterval=(\d+)/.exec(args.join(' '))?.[1],
    );
    const count = Number(/ServerAliveCountMax=(\d+)/.exec(args.join(' '))?.[1]);
    expect(interval * count).toBeLessThanOrEqual(60);
    expect(interval * count).toBeGreaterThanOrEqual(30);
  });

  it('asks often enough that the wait is a wait and not a timeout', () => {
    // One probe inside the window would make the whole budget hang on a single lost packet.
    expect(forwardKeepaliveOptions(60)).toEqual([
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=4',
    ]);
  });

  it('lets a slower link ask for more rope', () => {
    expect(tunnelDeadAfterSeconds({ BICA_TUNNEL_DEAD_AFTER: '300' })).toBe(300);
    expect(forwardKeepaliveOptions(300)).toContain('ServerAliveCountMax=20');
  });

  it('never lets that setting mean "never give up"', () => {
    // A count of zero is ssh for "keep waiting forever", which is the opposite of what anyone
    // lowering this number is asking for.
    for (const value of ['0', '-5', 'soon', '', '1']) {
      const seconds = tunnelDeadAfterSeconds({ BICA_TUNNEL_DEAD_AFTER: value });
      expect(seconds).toBeGreaterThanOrEqual(15);
      expect(forwardKeepaliveOptions(seconds)).not.toContain(
        'ServerAliveCountMax=0',
      );
    }
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

describe('parseTunnelArgs: the restart flag has two jobs', () => {
  it('reads --restart=<mode> as a mode when a command follows', () => {
    const args = parseTunnelArgs([
      '--local=/tmp/a.sock',
      '--remote=/srv/b.sock',
      '--restart=on-demand',
      '--',
      'serve',
    ]);
    expect(args.restart).toBe('on-demand');
  });

  it('refuses a socket path where a mode belongs, rather than guessing', () => {
    expect(() =>
      parseTunnelArgs([
        '--local=/tmp/a.sock',
        '--remote=/srv/b.sock',
        '--restart=/tmp/a.sock',
        '--',
        'serve',
      ]),
    ).toThrow(/--restart must be one of/);
  });
});

describe('buildSocketReadyScript', () => {
  it('waits for a socket using POSIX test alone, with no interpreter', () => {
    const script = buildSocketReadyScript('/srv/b.sock', 30);
    expect(script).toContain("[ ! -S '/srv/b.sock' ]");
    // No python3, perl or netcat: the remote may have none of them, and a probe that silently
    // degrades to this same check is worse than doing this check openly.
    expect(script).not.toMatch(/python|perl|nc |socat/);
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

describe('reading ssh as the authority on whether anything is listening', () => {
  it('recognises the refusal ssh prints for a forward it cannot complete', () => {
    // The signal that distinguishes "the socket file exists" from "something is behind it". Without
    // it, bica announced `Tunnel up` over a path nothing was listening on, and every request after
    // that went unanswered while the log said the tunnel was fine.
    expect(
      sshRefusedTheRemoteSocket(
        'channel 1: open failed: connect failed: open failed\n',
      ),
    ).toBe(true);
    expect(
      sshRefusedTheRemoteSocket(
        'channel 3: open failed: connect failed: No such file or directory\n',
      ),
    ).toBe(true);
    expect(
      sshRefusedTheRemoteSocket(
        'channel 2: open failed: connect failed: Connection refused\n',
      ),
    ).toBe(true);
  });

  it('is not fooled by ordinary ssh chatter', () => {
    expect(sshRefusedTheRemoteSocket('Warning: Permanently added …\n')).toBe(false);
    expect(sshRefusedTheRemoteSocket('debug1: Authentication succeeded\n')).toBe(false);
    expect(sshRefusedTheRemoteSocket('')).toBe(false);
  });
});

describe('--ready-when, the only exact answer about readiness', () => {
  const base = ['--local=/tmp/a.sock', '--remote=/srv/b.sock', '--', 'serve'];

  it('is absent unless asked for', () => {
    expect(parseTunnelArgs(base).readyWhen).toBeUndefined();
  });

  it('takes a pattern the server prints when it is ready', () => {
    // No probe can distinguish a server that has bound from one that will answer: the kernel queues
    // connections either way. What the server says about itself is the one statement that settles it.
    const args = parseTunnelArgs(['--ready-when=ENTAILMENT READY', ...base]);
    expect(args.readyWhen?.test('… ENTAILMENT READY on /tmp/x\n')).toBe(true);
    expect(args.readyWhen?.test('loading model\n')).toBe(false);
  });

  it('accepts a real expression, not just a literal', () => {
    const args = parseTunnelArgs(['--ready-when=^(listening|ready) on ', ...base]);
    expect(args.readyWhen?.test('listening on /tmp/x')).toBe(true);
    expect(args.readyWhen?.test('not listening on /tmp/x')).toBe(false);
  });

  it('refuses a pattern that is not a valid expression', () => {
    expect(() => parseTunnelArgs(['--ready-when=[unclosed', ...base])).toThrow(
      /regular expression/,
    );
  });

  it("does not read the remote command's own --ready-when", () => {
    const args = parseTunnelArgs([...base, '--ready-when=theirs']);
    expect(args.readyWhen).toBeUndefined();
  });
});
