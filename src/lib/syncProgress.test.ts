import { describe, expect, it } from 'vitest';

import {
  SYNC_NOT_READY_EXIT,
  describeSyncProgress,
  describeSyncStall,
  parseSyncProgress,
  progressFingerprint,
} from './syncProgress';

/**
 * Fixtures captured from `mutagen sync list <name> --template '{{json .}}'` against `mini`, during a
 * real staging run rather than written from memory. The field that matters -- `beta.stagingProgress`
 * -- appears only while staging is in flight and is absent from every other sample, which is exactly
 * the kind of thing a remembered fixture gets wrong.
 */
const STAGING = JSON.stringify([
  {
    identifier: 'sync_KWHhqU8MbX0Q9Im7G64mY3DfGNkl7WX0tg9Ypxk83xb',
    alpha: { protocol: 'local', connected: true, scanned: true, files: 40 },
    beta: {
      protocol: 'ssh',
      host: 'mini',
      connected: true,
      scanned: true,
      stagingProgress: {
        path: 'blob40.bin',
        receivedSize: 10223616,
        expectedSize: 15728640,
        receivedFiles: 14,
        expectedFiles: 40,
        totalReceivedSize: 230424576,
      },
    },
    status: 'staging-beta',
  },
]);

const WATCHING = JSON.stringify([
  {
    alpha: { files: 8000, totalFileSize: 32768000 },
    beta: { files: 8000, totalFileSize: 32768000 },
    status: 'watching',
    successfulCycles: 3,
  },
]);

const SCANNING = JSON.stringify([
  { alpha: { files: 0 }, beta: { files: 0 }, status: 'scanning' },
]);

describe('parseSyncProgress', () => {
  it('reads how far staging has got', () => {
    const progress = parseSyncProgress(STAGING);
    expect(progress?.status).toBe('staging-beta');
    expect(progress?.receivedFiles).toBe(14);
    expect(progress?.expectedFiles).toBe(40);
    expect(progress?.totalReceivedSize).toBe(230424576);
  });

  it('reads a session that is not staging without inventing numbers for it', () => {
    const progress = parseSyncProgress(WATCHING);
    expect(progress?.status).toBe('watching');
    expect(progress?.receivedFiles).toBeUndefined();
    expect(progress?.betaFiles).toBe(8000);
  });

  it('is null rather than throwing on output that is not JSON', () => {
    // Mutagen prints `Error: unable to locate requested sessions` on stdout for a name it has never
    // heard of, which is what a session that has not appeared yet looks like.
    expect(parseSyncProgress('Error: unable to locate requested sessions')).toBeNull();
  });

  it('is null for an empty list, which is a session that does not exist', () => {
    expect(parseSyncProgress('[]')).toBeNull();
  });
});

describe('progressFingerprint', () => {
  it('changes while staging advances', () => {
    const before = progressFingerprint(parseSyncProgress(STAGING));
    const later = progressFingerprint({
      status: 'staging-beta',
      receivedFiles: 15,
      expectedFiles: 40,
      totalReceivedSize: 240424576,
    });
    expect(later).not.toBe(before);
  });

  it('is the same for two readings of a sync that has not moved', () => {
    expect(progressFingerprint(parseSyncProgress(STAGING))).toBe(
      progressFingerprint(parseSyncProgress(STAGING)),
    );
  });

  it('changes when only the status moves, so scanning is not mistaken for a stall', () => {
    // Scanning a very large tree publishes no counts at all and can take minutes. Without this the
    // stall detector would fire on exactly the repositories this whole change is for.
    expect(progressFingerprint(parseSyncProgress(SCANNING))).not.toBe(
      progressFingerprint(parseSyncProgress(STAGING)),
    );
  });

  it('has a value for a session that cannot be read yet', () => {
    expect(progressFingerprint(null)).toBe('none');
  });
});

describe('describeSyncProgress', () => {
  it('says how many files of how many, and how much', () => {
    const said = describeSyncProgress(parseSyncProgress(STAGING));
    expect(said).toContain('14/40 files');
    expect(said).toContain('230MB');
  });

  it('says scanning is happening, since it sends nothing and looks like a hang', () => {
    expect(describeSyncProgress(parseSyncProgress(SCANNING))).toContain(
      'Scanning',
    );
  });

  it('says nothing when there is nothing to report', () => {
    expect(describeSyncProgress(parseSyncProgress(WATCHING))).toBeUndefined();
    expect(describeSyncProgress(null)).toBeUndefined();
  });
});

describe('describeSyncStall', () => {
  it('says nothing ran, which is what the old message left to be inferred', () => {
    // The report: `ls` exited 1 and a script exited 127, and both read as the command failing when
    // in fact the remote workspace held zero files.
    const said = describeSyncStall({
      lastStatus: 'Staging files on beta',
      progress: parseSyncProgress(STAGING),
      stallSeconds: 60,
    });
    expect(said).toContain('Nothing ran');
    expect(said).toContain(String(SYNC_NOT_READY_EXIT));
    expect(said).toContain('not a verdict');
    expect(said).toContain('partial tree');
  });

  it('quotes the status and how far it got', () => {
    const said = describeSyncStall({
      lastStatus: 'Staging files on beta',
      progress: parseSyncProgress(STAGING),
      stallSeconds: 60,
    });
    expect(said).toContain('Staging files on beta');
    expect(said).toContain('14/40 files');
  });

  it('says a second attempt sends only what is missing', () => {
    // The repro's worst property was that no run could ever succeed: each failure discarded the
    // transfer and the next one met the same wall. What survives is worth saying.
    expect(
      describeSyncStall({ lastStatus: null, progress: null, stallSeconds: 60 }),
    ).toContain('only what is missing');
  });
});
