import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assignLabels,
  buildParallelScript,
  labelForArgv,
} from './parallelCommands';

describe('labelForArgv', () => {
  it('names a command by its first two words', () => {
    expect(labelForArgv(['pnpm', 'lint'])).toBe('pnpm-lint');
  });

  it('drops path arguments, which do not belong in a filename', () => {
    expect(labelForArgv(['pnpm', 'test:run', 'libs/src/acl'])).toBe(
      'pnpm-test-run',
    );
  });

  it('names the tool, not the runner that launched it', () => {
    // `pnpm-exec` tells a reader nothing, and two `pnpm exec` commands would collide on it.
    expect(labelForArgv(['pnpm', 'exec', 'eslint', 'libs/src'])).toBe('pnpm-eslint');
    expect(labelForArgv(['pnpm', 'run', 'lint'])).toBe('pnpm-lint');
  });

  it('produces something filename-safe from anything', () => {
    expect(labelForArgv(['sh', '-c', 'a | b > c'])).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(labelForArgv([])).toBe('cmd');
  });
});

describe('assignLabels', () => {
  it('keeps distinct commands distinct', () => {
    const out = assignLabels([['pnpm', 'lint'], ['pnpm', 'typecheck']]);
    expect(out.map((c) => c.label)).toEqual(['pnpm-lint', 'pnpm-typecheck']);
  });

  it('gives two pnpm exec commands distinct, meaningful labels', () => {
    const out = assignLabels([
      ['pnpm', 'exec', 'eslint', 'a'],
      ['pnpm', 'exec', 'tsc', '-p', 'b'],
    ]);
    expect(out.map((c) => c.label)).toEqual(['pnpm-eslint', 'pnpm-tsc']);
  });

  it('still disambiguates genuinely identical commands', () => {
    const out = assignLabels([['pnpm', 'lint'], ['pnpm', 'lint']]);
    expect(new Set(out.map((c) => c.label)).size).toBe(2);
  });
});

describe('buildParallelScript, executed', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-par-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(argvs: string[][]): { status: number; out: string } {
    const script = buildParallelScript(assignLabels(argvs));
    const r = spawnSync('sh', ['-c', script], { cwd: dir, encoding: 'utf8' });
    return { status: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') };
  }

  it('runs every command and exits 0 when all succeed', () => {
    const { status, out } = run([
      ['echo', 'alpha'],
      ['echo', 'beta'],
    ]);
    expect(status).toBe(0);
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
  });

  it('exits non-zero when any command fails', () => {
    // The point of the feature: a caller branches on one exit code rather than parsing output.
    expect(run([['true'], ['false'], ['true']]).status).toBe(1);
  });

  it('reports each command exit code, not just the last', () => {
    const { out } = run([['true'], ['sh', '-c', 'exit 3']]);
    expect(out).toMatch(/exit codes:.*=0/);
    expect(out).toMatch(/=3/);
  });

  it('keeps each command output in its own block rather than interleaving', () => {
    // Concurrent writers to one stream produce an unreadable braid; the whole reason to capture.
    const { out } = run([
      ['sh', '-c', 'for i in 1 2 3; do echo A$i; done'],
      ['sh', '-c', 'for i in 1 2 3; do echo B$i; done'],
    ]);
    const a = out.indexOf('A3');
    const b = out.indexOf('B1');
    expect(a).toBeLessThan(b);
  });

  // Two process startups plus a handshake; vitest's 5s default is not enough on a loaded machine, and
  // a timeout there would look like a concurrency failure.
  it('actually runs commands concurrently', { timeout: 30_000 }, () => {
    // Proven by overlap, not by a stopwatch. Each command announces itself, waits for the other to
    // announce, and fails if it never does. Run serially the first would wait forever and time out;
    // run concurrently both see each other immediately. A wall-clock bound would instead measure how
    // busy the machine is, which is how this test flaked the first time it was written.
    // `if`, not `[ … ] && exit`: the latter leaves the loop body's status at 1 whenever the guard is
    // false, so the command exits 1 on the happy path. That made this test pass only when the other
    // flag already existed and the loop never ran — intermittent for a reason unrelated to concurrency.
    const waitFor = (mine: string, theirs: string) => [
      'sh',
      '-c',
      `: > ${mine}
n=0
while [ ! -e ${theirs} ]; do
  sleep 0.05
  n=$((n + 1))
  if [ "$n" -gt 200 ]; then exit 9; fi
done
exit 0`,
    ];
    const { status } = run([waitFor('a.flag', 'b.flag'), waitFor('b.flag', 'a.flag')]);
    expect(status).toBe(0);
  });

  it('leaves no log files behind in the workspace', () => {
    run([['echo', 'x']]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('passes arguments through without shell interpretation', () => {
    const { out } = run([['echo', 'a b; touch pwned']]);
    expect(out).toContain('a b; touch pwned');
    expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
  });

  it('refuses an empty command list rather than emitting a script that does nothing', () => {
    expect(() => buildParallelScript([])).toThrow(/at least one/);
  });
});
