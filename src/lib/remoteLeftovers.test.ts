import { describe, expect, it } from 'vitest';

import {
  buildLeftoversScript,
  buildLoadScript,
  describeRemoteState,
  loadIsWorthMentioning,
  parseLeftovers,
  parseLoad,
} from './remoteLeftovers';

describe('what a run left running', () => {
  it('asks about the process groups the lease recorded', () => {
    const script = buildLeftoversScript('~/.bica/claims/code_repo');
    expect(script).toContain("grep '^rpid='");
    // Every group, not the first: a concurrent run has one per command.
    expect(script).toContain('for _one in $_g');
  });

  it('says nothing when the lease recorded no group', () => {
    expect(buildLeftoversScript('~/.bica/claims/x')).toContain(
      '[ -n "$_g" ] || exit 0',
    );
  });

  it('reads pid and command out of ps output', () => {
    const found = parseLeftovers('  68622 sleep 300\n 68700 python server.py --socket /tmp/a\n');
    expect(found).toEqual([
      { pid: 68622, command: 'sleep 300' },
      { pid: 68700, command: 'python server.py --socket /tmp/a' },
    ]);
  });

  it('ignores anything that is not a process line', () => {
    expect(parseLeftovers('\n  \nnot a pid line\n')).toEqual([]);
  });
});

describe('how hard the remote is working', () => {
  it('reads the one-minute average and the core count', () => {
    expect(parseLoad('LOAD 6.29\nCORES 10\n')).toEqual({ load: 6.29, cores: 10 });
  });

  it('returns nothing rather than a guess when the output is unexpected', () => {
    expect(parseLoad('something else entirely')).toBeNull();
    expect(parseLoad('LOAD x\nCORES 10')).toBeNull();
    expect(parseLoad('LOAD 1.0\nCORES 0')).toBeNull();
  });

  it('asks in a way that works on both ends it runs against', () => {
    // macOS has sysctl, Linux has nproc, and the remote may be either.
    expect(buildLoadScript()).toContain('sysctl -n hw.ncpu');
    expect(buildLoadScript()).toContain('nproc');
  });

  it('treats a core of load per core as ordinary, and more as worth saying', () => {
    expect(loadIsWorthMentioning({ load: 6.0, cores: 10 })).toBe(false);
    expect(loadIsWorthMentioning({ load: 10.0, cores: 10 })).toBe(false);
    expect(loadIsWorthMentioning({ load: 12.5, cores: 10 })).toBe(true);
  });
});

describe('what gets said', () => {
  it('says nothing when there is nothing to say', () => {
    expect(
      describeRemoteState({
        sshHost: 'mini',
        leftovers: [],
        load: { load: 2, cores: 10 },
      }),
    ).toBeUndefined();
  });

  it('names what was left behind', () => {
    const message = describeRemoteState({
      sshHost: 'mini',
      leftovers: [{ pid: 1, command: 'sleep 300' }],
      load: { load: 1, cores: 10 },
    });
    expect(message).toContain('left 1 process');
    expect(message).toContain('sleep 300');
  });

  it('caps the list rather than printing a wall of processes', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      pid: i,
      command: `thing-${String(i)}`,
    }));
    const message = describeRemoteState({
      sshHost: 'mini',
      leftovers: many,
      load: null,
    });
    expect(message).toContain('left 9 processes');
    expect(message).toContain('and 6 more');
  });

  it('mentions a labouring remote even with nothing left behind', () => {
    const message = describeRemoteState({
      sshHost: 'mini',
      leftovers: [],
      load: { load: 30, cores: 10 },
    });
    expect(message).toContain('load 30');
    expect(message).toContain('10 cores');
  });
});
