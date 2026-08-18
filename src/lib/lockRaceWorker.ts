/**
 * Test fixture, not part of the CLI. Spawned as a separate process by `fileLockRace.test.ts` to
 * contend for a lock for real.
 *
 * It has to be a committed file inside the project rather than something the test writes to a temp
 * directory: tsx only applies its TypeScript transform within the project, so a worker written
 * elsewhere cannot import `fileLock.ts` at all.
 *
 * The protocol is a handshake, deliberately with no sleeps or deadlines in it. An earlier version
 * used "wait two seconds for everyone to start, hold the lock for 1.5 seconds" and that made the test
 * a timing guess: if eight `node --import tsx` startups overran the wait, a late worker attempted
 * acquisition after the winner had already released and legitimately won, failing the test for a
 * reason that was not a bug. Waiting on files instead makes the ordering exact:
 *
 *   1. announce readiness      (touch <ready>)
 *   2. block until released    (wait for <barrier>)   <- every worker attempts at the same instant
 *   3. attempt, print verdict
 *   4. block until dismissed   (wait for <done>)      <- no lock is freed before all verdicts exist
 *   5. release and exit
 *
 * Usage: `node --import tsx src/lib/lockRaceWorker.ts <lockPath> <ready> <barrier> <done>`
 */

import * as fs from 'node:fs';

/** Upper bound only, to stop a broken run hanging forever. Never part of the expected path. */
const RUNAWAY_LIMIT_MS = 120_000;

import { tryAcquireLock } from './fileLock';

function waitForFile(filePath: string, what: string): void {
  const deadline = Date.now() + RUNAWAY_LIMIT_MS;
  while (!fs.existsSync(filePath)) {
    if (Date.now() > deadline) {
      process.stderr.write(`${what} never appeared at ${filePath}\n`);
      process.exit(3);
    }
  }
}

function main(): void {
  const [lockPath, readyPath, barrierPath, donePath] = process.argv.slice(2);
  if (
    lockPath === undefined ||
    readyPath === undefined ||
    barrierPath === undefined ||
    donePath === undefined
  ) {
    process.stderr.write(
      'usage: lockRaceWorker <lockPath> <ready> <barrier> <done>\n',
    );
    process.exit(2);
  }

  fs.writeFileSync(readyPath, '', 'utf8');
  waitForFile(barrierPath, 'barrier');

  const lock = tryAcquireLock(lockPath);
  process.stdout.write(lock === null ? 'LOST\n' : 'WON\n');

  waitForFile(donePath, 'done signal');
  lock?.release();
}

main();
