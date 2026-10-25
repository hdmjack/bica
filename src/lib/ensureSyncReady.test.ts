import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LIVE_RUN_MARKER_RELATIVE,
  settleOtherCheckoutsSyncs,
} from './ensureSyncReady';
import type { SyncSessionSummary } from './mutagenSession';

/**
 * Another checkout's sync into this run's workspace. The question is whose it is: a finished run's
 * leftover is ended, and one somebody started with `bica start` is refused around rather than taken.
 */
describe('settleOtherCheckoutsSyncs', () => {
  let root = '';
  let said = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-othersync-'));
    said = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      said += String(chunk);
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A checkout on disk, with the marker a `bica run` writes when `pid` is given. */
  const checkout = (name: string, pid?: number): SyncSessionSummary => {
    const alpha = path.join(root, name);
    fs.mkdirSync(path.join(alpha, '.bica'), { recursive: true });
    if (pid !== undefined) {
      fs.writeFileSync(path.join(alpha, LIVE_RUN_MARKER_RELATIVE), `${String(pid)}\n`);
    }
    return { name: `${name}-session`, alpha, beta: 'mini:~/code/shared' } as SyncSessionSummary;
  };

  const settle = (sessions: SyncSessionSummary[], alive: (pid: number) => boolean) => {
    const ended: string[] = [];
    const code = settleOtherCheckoutsSyncs({
      repoRoot: path.join(root, 'here'),
      remoteSyncUrl: 'mini:~/code/shared',
      alive,
      find: () => sessions,
      terminate: (name) => {
        ended.push(name);
      },
    });
    return { code, ended };
  };

  it('ends a session whose run has ended, says so, and goes ahead', () => {
    const { code, ended } = settle([checkout('other', 4242)], () => false);
    expect(code).toBeUndefined();
    expect(ended).toEqual(['other-session']);
    expect(said).toContain('the run that started it has ended');
  });

  it("refuses with 98 rather than end a sync started with `bica start`, and offers the ways out", () => {
    const deliberate = checkout('other');
    const { code, ended } = settle([deliberate], () => false);
    expect(code).toBe(98);
    expect(ended).toEqual([]);
    expect(said).toContain(`cd ${deliberate.alpha} && bica stop`);
    expect(said).toContain('remotePath: ~/code/here');
    expect(said).toContain('not a verdict on your code');
  });

  it("leaves alone a session whose run is still going, which is somebody's live sync too", () => {
    const { code, ended } = settle([checkout('other', 4242)], () => true);
    expect(code).toBe(98);
    expect(ended).toEqual([]);
  });

  it('has nothing to do when no other checkout syncs here', () => {
    expect(settle([], () => false)).toEqual({ code: undefined, ended: [] });
  });
});
