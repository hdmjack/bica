import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tryAcquireLock } from './fileLock';

/**
 * Cross-process contention tests.
 *
 * These exist because a single-process test cannot catch the bug they were written for. Acquiring
 * locks one after another in one process never exposes the window between "lock file created" and
 * "holder written" — only genuinely simultaneous processes do, and when they did, several runs each
 * concluded lane 1 was free and all took it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');
const WORKER = path.join(HERE, 'lockRaceWorker.ts');
const RACERS = 8;

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-lock-race-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Launch `RACERS` workers genuinely in parallel against one lock and collect their verdicts.
 * Sequential spawning would let each see the previous holder's release and prove nothing.
 */
function raceForLock(lockPath: string, tag: string): string[] {
  const script = path.join(dir, `race-${tag}.sh`);
  const barrier = path.join(dir, `barrier-${tag}`);
  const done = path.join(dir, `done-${tag}`);
  // No sleeps: the barrier drops only once every worker has announced readiness, and no lock is
  // released until every verdict has been written. A fixed wait here would be a guess about node
  // startup time, and a wrong guess produces a second "winner" that is not a bug.
  fs.writeFileSync(
    script,
    `#!/usr/bin/env bash
set -u
D=${JSON.stringify(dir)}
for i in $(seq 1 ${String(RACERS)}); do
  ${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(WORKER)} \
    ${JSON.stringify(lockPath)} "$D/ready-${tag}.$i" ${JSON.stringify(barrier)} ${JSON.stringify(done)} \
    > "$D/out-${tag}.$i" 2> "$D/err-${tag}.$i" &
done

wait_for_count() {
  local pattern=$1 want=$2 label=$3 waited=0
  while [ "$(ls $pattern 2>/dev/null | wc -l | tr -d ' ')" -lt "$want" ]; do
    sleep 0.05
    waited=$((waited + 1))
    # Bound only so a broken run fails instead of hanging; not a timing assumption.
    if [ "$waited" -gt 2400 ]; then echo "timeout waiting for $label" >&2; exit 1; fi
  done
}

wait_for_count "$D/ready-${tag}.*" ${String(RACERS)} "workers to start"
touch ${JSON.stringify(barrier)}
# A verdict file is non-empty only after that worker has attempted acquisition.
while [ "$(grep -l . $D/out-${tag}.* 2>/dev/null | wc -l | tr -d ' ')" -lt ${String(RACERS)} ]; do
  sleep 0.05
done
touch ${JSON.stringify(done)}
wait
`,
    'utf8',
  );
  execFileSync('bash', [script], { cwd: REPO_ROOT, timeout: 180_000 });

  return Array.from({ length: RACERS }, (_, i) => {
    const out = fs
      .readFileSync(path.join(dir, `out-${tag}.${String(i + 1)}`), 'utf8')
      .trim();
    if (out === '') {
      // An empty verdict means the worker never ran; surfacing its stderr keeps a broken harness from
      // masquerading as a passing race.
      const err = fs
        .readFileSync(path.join(dir, `err-${tag}.${String(i + 1)}`), 'utf8')
        .trim();
      throw new Error(`worker ${String(i + 1)} produced no verdict: ${err.slice(0, 400)}`);
    }
    return out;
  });
}

describe('tryAcquireLock under real concurrency', () => {
  // Each round pays a barrier wait plus eight node+tsx startups, so these need far more than
  // vitest's 5s default. They are slow by construction: the concurrency is the point.
  it('lets exactly one of many simultaneous processes hold a lock', { timeout: 120_000 }, () => {
    const verdicts = raceForLock(path.join(dir, 'locks', 'contended.lock'), 'a');
    const winners = verdicts.filter((v) => v === 'WON').length;
    // The assertion the original implementation failed: with a create-then-write window, several
    // racers each found an empty lock file, judged it abandoned, and all reported WON.
    expect(verdicts).toHaveLength(RACERS);
    expect(winners, `verdicts were ${verdicts.join(',')}`).toBe(1);
    expect(verdicts.filter((v) => v === 'LOST')).toHaveLength(RACERS - 1);
  });

  it('is repeatably exclusive, not exclusive by luck', { timeout: 180_000 }, () => {
    // A race that happens to serialise once is not evidence. Repeat it.
    for (let round = 0; round < 3; round++) {
      const verdicts = raceForLock(
        path.join(dir, 'locks', `round-${String(round)}.lock`),
        `r${String(round)}`,
      );
      expect(
        verdicts.filter((v) => v === 'WON').length,
        `round ${String(round)}: ${verdicts.join(',')}`,
      ).toBe(1);
    }
  });
});

describe('reclaiming a dead lock under real concurrency', () => {
  it('lets exactly one of many simultaneous processes reclaim it', () => {
    // The reason unlink-then-create needed a grace period: several processes could each remove the
    // dead file and each create their own. `rename` makes reclaiming atomic, so this needs no waiting.
    const lockPath = path.join(dir, 'locks', 'dead.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2147483647, acquiredAt: 'then', command: 'dead run' }),
      'utf8',
    );
    const verdicts = raceForLock(lockPath, 'dead');
    expect(
      verdicts.filter((v) => v === 'WON').length,
      `verdicts were ${verdicts.join(',')}`,
    ).toBe(1);
  });

  it('lets exactly one of many simultaneous processes reclaim foreign debris', () => {
    const lockPath = path.join(dir, 'locks', 'debris.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, 'not a lock at all', 'utf8');
    const verdicts = raceForLock(lockPath, 'debris');
    expect(
      verdicts.filter((v) => v === 'WON').length,
      `verdicts were ${verdicts.join(',')}`,
    ).toBe(1);
  });
});

describe('a lock file caught mid-write', () => {
  it('cannot be produced by bica, so is reclaimed on sight rather than waited out', () => {
    // The window that broke lane allocation was a lock file existing with no pid in it. It can no
    // longer occur, which is what lets this case be decided structurally instead of by elapsed time.
    const lockPath = path.join(dir, 'locks', 'midwrite.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, '', 'utf8');
    const lock = tryAcquireLock(lockPath);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  it('is reclaimed when its content is truncated JSON', () => {
    const lockPath = path.join(dir, 'locks', 'truncated.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, '{"pid":12', 'utf8');
    const lock = tryAcquireLock(lockPath);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  it('leaves no staging files behind', () => {
    // The staging file is an implementation detail; leaking it would confuse lock enumeration.
    const lockPath = path.join(dir, 'locks', 'clean.lock');
    const lock = tryAcquireLock(lockPath);
    expect(lock).not.toBeNull();
    expect(
      fs.readdirSync(path.dirname(lockPath)).filter((f) => f.includes('staging')),
    ).toEqual([]);
    lock?.release();
  });
});
