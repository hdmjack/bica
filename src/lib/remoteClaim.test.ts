import * as os from 'node:os';
import { describe, expect, it } from 'vitest';

import {
  claimFileName,
  claimIsStale,
  describeClaim,
  describeSelfAsOwner,
  formatOwner,
  parseOwner,
} from './remoteClaim';

const alive = (): boolean => true;
const dead = (): boolean => false;

describe('claimFileName', () => {
  it('gives one claim per remote directory', () => {
    expect(claimFileName('~/code/repo-lane-1')).not.toBe(
      claimFileName('~/code/repo-lane-2'),
    );
  });

  it('is stable regardless of a trailing slash', () => {
    expect(claimFileName('~/code/repo-lane-1/')).toBe(
      claimFileName('~/code/repo-lane-1'),
    );
  });

  it('produces a flat, safe filename', () => {
    // It is used unquoted inside a remote shell path, so nothing exotic may survive.
    expect(claimFileName('~/code/re po/../lane-1')).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('distinguishes clones that differ only deep in the path', () => {
    expect(claimFileName('~/code/float-javascript-lane-1')).not.toBe(
      claimFileName('~/code/float-javascript-5-lane-1'),
    );
  });
});

describe('formatOwner', () => {
  it('writes run id, host and pid in that order', () => {
    expect(formatOwner({ runId: 'r1', host: 'h1', pid: 42 })).toBe('r1 h1 42');
  });

  it('rejects a run id containing whitespace', () => {
    // The remote reads field 1 with `cut -d' '`, so a spaced id would compare against a fragment of
    // itself and every check would fail — silently, and in the direction of refusing everything.
    expect(() => formatOwner({ runId: 'a b', host: 'h', pid: 1 })).toThrow(
      /whitespace/,
    );
    expect(() => formatOwner({ runId: '', host: 'h', pid: 1 })).toThrow();
  });

  it('round-trips through parseOwner', () => {
    const owner = describeSelfAsOwner('run-7');
    expect(parseOwner(formatOwner(owner))).toEqual(owner);
  });
});

describe('parseOwner', () => {
  it('ignores a trailing exit code, which the run appends when it finishes', () => {
    expect(parseOwner('r1 h1 42 0')).toEqual({ runId: 'r1', host: 'h1', pid: 42 });
  });

  it('returns null for content that is not a claim', () => {
    expect(parseOwner('')).toBeNull();
    expect(parseOwner('garbage')).toBeNull();
    expect(parseOwner('r1 h1 not-a-pid')).toBeNull();
  });
});

describe('claimIsStale', () => {
  const here = os.hostname();

  it('treats a claim from this machine with a dead pid as stale', () => {
    // This is what unwedges a workspace after a run is killed — no clock involved.
    expect(claimIsStale({ runId: 'r', host: here, pid: 999 }, dead)).toBe(true);
  });

  it('honours a claim from this machine whose owner is alive', () => {
    expect(claimIsStale({ runId: 'r', host: here, pid: 999 }, alive)).toBe(false);
  });

  it('honours a claim from another machine, which it cannot interrogate', () => {
    // Refusing costs a re-run; guessing costs a wrong answer.
    expect(claimIsStale({ runId: 'r', host: 'other-host', pid: 999 }, dead)).toBe(
      false,
    );
  });

  it('treats unreadable content as stale, since a claim is published complete', () => {
    expect(claimIsStale(null, alive)).toBe(true);
  });
});

describe('describeClaim', () => {
  it('names the holder so the refusal is actionable', () => {
    const msg = describeClaim({
      ok: false,
      heldBy: { runId: 'r9', host: 'box', pid: 12 },
      raw: 'r9 box 12',
    });
    expect(msg).toContain('r9');
    expect(msg).toContain('box');
    expect(msg).toContain('12');
  });

  it('degrades to the raw text when the claim cannot be parsed', () => {
    expect(describeClaim({ ok: false, heldBy: null, raw: 'junk' })).toBe('junk');
  });
});
