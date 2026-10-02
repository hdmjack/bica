import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildForwardSshArgs,
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
