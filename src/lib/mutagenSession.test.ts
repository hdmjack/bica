import { describe, expect, it } from 'vitest';

import { parseSyncListTemplateLine, waitForSyncReady } from './mutagenSession';

describe('parseSyncListTemplateLine', () => {
  it('parses a 4-field session line', () => {
    const summary = parseSyncListTemplateLine(
      'web-app|sync_lJvWnsi5|/Users/me/code/web-app|mini:~/code/web-app',
    );
    expect(summary).toEqual({
      name: 'web-app',
      identifier: 'sync_lJvWnsi5',
      alpha: '/Users/me/code/web-app',
      beta: 'mini:~/code/web-app',
    });
  });

  it('returns null for malformed lines', () => {
    expect(parseSyncListTemplateLine('')).toBeNull();
    expect(parseSyncListTemplateLine('name|id|alpha')).toBeNull();
    expect(parseSyncListTemplateLine('|id|alpha|beta')).toBeNull();
    expect(parseSyncListTemplateLine('name||alpha|beta')).toBeNull();
  });
});

describe('a scan is not a stall', () => {
  // The reported failure: `bica run true` on an llvm-project checkout (181,755 files) at local
  // load 20 sat in "Scanning files" and was declared stalled after 60s, three times in a row,
  // while the remote was idle and reachable. Scanning publishes no number that moves, so the
  // fingerprint is byte-identical from one poll to the next however hard Mutagen is working.
  const scanning = {
    status: 'scanning',
    alphaFiles: 181755,
    betaFiles: 181755,
  };

  function clock(stepMs: number) {
    let t = 0;
    return () => (t += stepMs);
  }

  it('waits far longer than 60s while the status is one that publishes nothing', () => {
    let polls = 0;
    const out = waitForSyncReady('s', {
      stallSeconds: 60,
      quietStallSeconds: 600,
      now: clock(10_000),
      sleep: () => undefined,
      readProgress: () => scanning,
      readStatus: () => {
        polls += 1;
        return { exists: true, status: 'Scanning files' };
      },
    });
    expect(out.ready).toBe(false);
    expect(out.stalledSeconds).toBe(600);
    // 60s would have ended it after a handful of polls; it kept going for the larger budget.
    expect(polls).toBeGreaterThan(30);
  });

  it('becomes ready when the scan finishes, rather than being killed part-way', () => {
    let polls = 0;
    const out = waitForSyncReady('s', {
      stallSeconds: 60,
      quietStallSeconds: 600,
      now: clock(10_000),
      sleep: () => undefined,
      readProgress: () => scanning,
      readStatus: () => {
        polls += 1;
        return polls > 20
          ? { exists: true, status: 'Watching for changes' }
          : { exists: true, status: 'Scanning files' };
      },
    });
    // 20 polls at 10s of simulated time each is well past the 60s that used to end it.
    expect(out.ready).toBe(true);
  });

  it('still calls a stalled transfer stalled on the shorter budget', () => {
    // Staging publishes files and bytes that climb while it works, so stillness there is real
    // evidence and must not inherit the scan's patience.
    const out = waitForSyncReady('s', {
      stallSeconds: 60,
      quietStallSeconds: 600,
      now: clock(10_000),
      sleep: () => undefined,
      readProgress: () => ({
        status: 'staging-beta',
        receivedFiles: 10,
        expectedFiles: 1000,
        totalReceivedSize: 1024,
      }),
      readStatus: () => ({ exists: true, status: 'Staging files on beta' }),
    });
    expect(out.ready).toBe(false);
    expect(out.stalledSeconds).toBe(60);
  });
});
