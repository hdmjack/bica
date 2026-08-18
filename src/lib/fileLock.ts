import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Advisory inter-process locks.
 *
 * Exclusivity comes from one primitive: a lock is published by `link()`ing a fully-written staging
 * file onto the lock path. `link` fails if the path exists, so exactly one process can claim it, and
 * because the content is already in the file, there is never an instant where a lock is visible
 * without its holder recorded. Nothing here depends on elapsed time.
 *
 * Two things need locking once runs can overlap:
 *
 * - **A lane.** Two runs on one lane would sync different working trees into the same remote
 *   directory and each would see the other's files. Holding the lane's lock for the whole run turns
 *   that silent corruption into an upfront error naming the process that holds it.
 * - **The local repo, briefly.** Return-flow rsyncs remote files into the local tree with
 *   `--delete`; two of those at once in the same tree fight. The pull takes the repo lock so the
 *   pulls queue instead.
 *
 * A holder that died without releasing leaves its file behind. Acquisition decides what to do with
 * such a file *structurally* rather than by age: a parseable pid is authoritative and only liveness
 * matters, while unparseable content cannot be one of ours (we never publish an incomplete lock) and is
 * therefore debris to be cleared immediately. See {@link reclaimLockFile} for the one race this cannot
 * fully close in pure POSIX.
 */

export interface LockHolder {
  pid: number;
  /** ISO timestamp of acquisition, for the "held by" message. */
  acquiredAt: string;
  /** Command line that took the lock, for the "held by" message. */
  command: string;
}

export interface HeldLock {
  filePath: string;
  release(): void;
}

function describeSelf(): LockHolder {
  return {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    command: process.argv.slice(1).join(' '),
  };
}

export function readLockHolder(filePath: string): LockHolder | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { pid?: unknown }).pid === 'number'
    ) {
      const holder = parsed as LockHolder;
      return {
        pid: holder.pid,
        acquiredAt:
          typeof holder.acquiredAt === 'string' ? holder.acquiredAt : 'unknown',
        command: typeof holder.command === 'string' ? holder.command : 'unknown',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether `pid` is still running. `kill(pid, 0)` performs the permission/existence check without
 * delivering a signal; EPERM means the process exists but belongs to another user, which still
 * counts as alive.
 *
 * Pid reuse is the one thing this cannot rule out: a lock left by a dead process whose pid has since
 * been recycled reads as alive. That errs in the safe direction — the lane is treated as taken rather
 * than handed to a second run — and `--lane auto` simply moves to the next lane. `bica lanes list`
 * names the holder so a wedged lane can be cleared deliberately.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as { code?: string } | null)?.code === 'EPERM';
  }
}

/** Distinguishes concurrent staging files within one process, so they cannot collide either. */
let stagingCounter = 0;

/**
 * Claim `filePath` atomically, with the holder's identity already in it.
 *
 * The obvious implementation — `open(…, 'wx')` then write the pid — is wrong, and wrong in a way that
 * defeats the whole lock. Between the create and the write, the file exists but is *empty*; a second
 * process arriving in that window reads no pid, concludes the lock is abandoned, deletes it and takes
 * it. Both then believe they hold the same lane. Simultaneous starts land in that window nearly every
 * time, so this failed reproducibly rather than rarely.
 *
 * Writing the content to a staging file first and then `link()`ing it into place closes the window:
 * `link` fails with EEXIST if the target exists, so the claim is still exclusive, but the file is
 * fully populated the instant it becomes visible. There is no moment at which a lock exists without
 * its holder.
 */
function writeLockFileExclusive(filePath: string): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  stagingCounter += 1;
  const staging = `${filePath}.${String(process.pid)}.${String(stagingCounter)}.staging`;
  fs.writeFileSync(staging, `${JSON.stringify(describeSelf())}\n`, 'utf8');
  try {
    fs.linkSync(staging, filePath);
    return true;
  } catch (e: unknown) {
    if ((e as { code?: string } | null)?.code === 'EEXIST') {
      return false;
    }
    throw e;
  } finally {
    try {
      fs.unlinkSync(staging);
    } catch {
      // The link (when it succeeded) keeps the inode alive; losing the staging name is harmless.
    }
  }
}

/**
 * Remove a lock file we have judged dead or foreign, but only if it is still the *same file* we
 * judged.
 *
 * What exclusivity actually rests on is the atomic `link` in {@link writeLockFileExclusive}: whoever
 * wins the link holds the lock, no matter who removed the previous file. So reclaiming does not need
 * to elect a single remover, and `rename` here is not what makes concurrency safe — an earlier comment
 * claimed it was, and that was wrong.
 *
 * What reclaiming *does* need is not to delete a lock that became valid while we were deciding:
 *
 *   A reads the file, sees a dead pid
 *   B reclaims it and links its own live lock
 *   A removes the file — now B's live lock is gone — and links its own
 *   A and B both believe they hold the lane
 *
 * The `expectedIno` guard closes almost all of that: A only removes the file if it is still the inode
 * A inspected, and B's lock is a different inode. POSIX has no compare-and-delete, so a window remains
 * between the stat and the rename. It is orders of magnitude tighter than read-then-delete, and it
 * needs a dead-pid lock plus two simultaneous reclaimers to matter. Closing it completely means kernel
 * advisory locks (`flock`), where death releases the lock and stale files stop existing — that needs a
 * native binding, so it is a deliberate not-yet rather than an oversight.
 *
 * A plain `unlink` is used rather than a rename into quarantine. The rename bought nothing: it is no
 * more atomic with respect to the check above, and the extra file kind was one more thing to explain.
 */
function reclaimLockFile(filePath: string, expectedIno: number): boolean {
  try {
    if (fs.statSync(filePath).ino !== expectedIno) {
      // Replaced since we looked: whatever is there now is not ours to judge. Retry from the top.
      return false;
    }
    fs.unlinkSync(filePath);
    return true;
  } catch {
    // Already gone, or removed by another process between the stat and the unlink. Either way the path
    // is clear and the caller's retry settles who claims it.
    return false;
  }
}

/** Inode of `filePath`, or null when it does not exist. */
function inodeOf(filePath: string): number | null {
  try {
    return fs.statSync(filePath).ino;
  } catch {
    return null;
  }
}

function releaseIfOurs(filePath: string): void {
  const holder = readLockHolder(filePath);
  // A lock we already lost to a stale-takeover belongs to someone else now; leave it alone.
  if (holder !== null && holder.pid !== process.pid) {
    return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Already gone (stale takeover, manual cleanup) — nothing to undo.
  }
}

/**
 * Take `filePath` if it is free, or if the recorded holder is no longer running. Returns null when
 * a live process holds it — callers decide whether that is an error (explicit lane) or a signal to
 * try the next candidate (`--lane auto`).
 */
export function tryAcquireLock(filePath: string): HeldLock | null {
  // Bounded so a pathological churn of reclaim-and-reacquire cannot spin forever. Each iteration
  // either wins, loses to a live holder, or removes exactly one dead/foreign file, so two rounds is
  // already generous.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (writeLockFileExclusive(filePath)) {
      return { filePath, release: () => releaseIfOurs(filePath) };
    }

    // Read the inode *before* the content, so the guard covers everything we base the decision on.
    const ino = inodeOf(filePath);
    if (ino === null) {
      continue;
    }
    const holder = readLockHolder(filePath);
    if (holder !== null) {
      // Parseable with a pid: authoritative, whatever wrote it. Liveness alone decides.
      if (isProcessAlive(holder.pid)) {
        return null;
      }
      // The owner is gone. Clear it and race for the vacancy.
      reclaimLockFile(filePath, ino);
      continue;
    }

    // Unparseable. bica publishes a lock complete — content and all — in a single atomic `link`, so
    // there is no instant at which one of ours is visible without its pid. Unparseable therefore means
    // this file is not one of our locks: debris from a process killed mid-write by an older build, or
    // something another tool left here. Neither is a claim on the lane, and no amount of waiting will
    // turn it into one, so reclaim it now rather than guessing at an age that makes it safe.
    reclaimLockFile(filePath, ino);
  }
  return null;
}

/**
 * Take `filePath`, waiting up to `timeoutMs` for a live holder to finish. Used for the short
 * repo-wide return-flow lock, where queueing is the desired behaviour rather than an error.
 */
export async function acquireLockWithWait(
  filePath: string,
  options: { timeoutMs: number; pollMs?: number },
): Promise<HeldLock | null> {
  const pollMs = options.pollMs ?? 200;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const lock = tryAcquireLock(filePath);
    if (lock !== null) {
      return lock;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }
}

export function describeLockHolder(filePath: string): string {
  const holder = readLockHolder(filePath);
  if (holder === null) {
    return 'an unidentified process';
  }
  return `pid ${String(holder.pid)} (since ${holder.acquiredAt}): ${holder.command}`;
}
