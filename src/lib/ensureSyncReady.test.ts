import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  endLeftoverRunSyncs,
  settleOtherCheckoutsSyncs,
} from './ensureSyncReady';
import type { SyncSessionSummary } from './mutagenSession';
import {
  LEGACY_LIVE_RUN_MARKER_RELATIVE,
  liveRunMarkerRelative,
  workspaceKey,
} from './workspaceKey';

/** The marker a run into `beta` leaves, relative to its checkout. */
const marker = (beta: string): string => liveRunMarkerRelative(workspaceKey(beta));

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
      fs.writeFileSync(path.join(alpha, marker('mini:~/code/shared')), `${String(pid)}\n`);
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

/**
 * The net under each run's watchdog: any bica run ends syncs whose run is over, from any checkout and
 * into any workspace -- not only the ones it is about to share a workspace with.
 */
describe('endLeftoverRunSyncs', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-leftover-'));
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const checkout = (name: string, marked?: { beta: string; pid: number }): string => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, '.bica'), { recursive: true });
    if (marked !== undefined) {
      fs.writeFileSync(path.join(dir, marker(marked.beta)), `${String(marked.pid)}\n`);
    }
    return dir;
  };
  const session = (name: string, alpha: string, beta: string): SyncSessionSummary => ({
    name,
    identifier: `sync_${name}`,
    alpha,
    beta,
  });

  it('ends only sessions whose run is dead, whatever workspace they sync into', () => {
    // As reported: a killed run's session into a per-worktree folder nobody else used kept writing
    // there for twenty minutes.
    const wiles = 'mini:~/code/objective-wiles';
    const dead = checkout('dead', { beta: wiles, pid: 111 });
    const live = checkout('live', { beta: 'mini:~/code/x', pid: 222 });
    const started = checkout('started');
    const ended: string[] = [];
    const result = endLeftoverRunSyncs({
      list: () => [
        session('a', dead, wiles),
        session('b', live, 'mini:~/code/x'),
        session('c', started, 'mini:~/code/y'),
      ],
      alive: (pid) => pid === 222,
      terminate: (name) => ended.push(name),
    });
    expect(ended).toEqual(['a']);
    expect(result).toEqual(['a']);
    expect(fs.existsSync(path.join(dead, marker(wiles)))).toBe(false);
    expect(fs.existsSync(path.join(live, marker('mini:~/code/x')))).toBe(true);
  });

  it('keeps one checkout\'s two runs apart: a dead run does not end the live one beside it', () => {
    // Two runs from one checkout into different workspaces. The one into `a` died; the one into `b`
    // is going. With one marker per checkout the second run's pid decided the fate of both.
    const a = 'mini:~/code/a';
    const b = 'mini:~/code/b';
    const dir = checkout('both', { beta: a, pid: 111 });
    fs.writeFileSync(path.join(dir, marker(b)), '222\n');
    const ended: string[] = [];
    endLeftoverRunSyncs({
      list: () => [session(`both-${workspaceKey(a)}`, dir, a), session(`both-${workspaceKey(b)}`, dir, b)],
      alive: (pid) => pid === 222,
      terminate: (name) => ended.push(name),
    });
    expect(ended).toEqual([`both-${workspaceKey(a)}`]);
    expect(fs.existsSync(path.join(dir, marker(a)))).toBe(false);
    expect(fs.existsSync(path.join(dir, marker(b)))).toBe(true);
  });

  it('reads the checkout-wide marker of an older bica, but only for a session with no key in its name', () => {
    const beta = 'mini:~/code/old';
    const dir = checkout('old');
    fs.writeFileSync(path.join(dir, LEGACY_LIVE_RUN_MARKER_RELATIVE), '333\n');
    const ended: string[] = [];
    endLeftoverRunSyncs({
      list: () => [session('old', dir, beta), session(`old-${workspaceKey(beta)}`, dir, beta)],
      alive: () => false,
      terminate: (name) => ended.push(name),
    });
    expect(ended).toEqual(['old']);
    expect(fs.existsSync(path.join(dir, LEGACY_LIVE_RUN_MARKER_RELATIVE))).toBe(false);
  });
});
