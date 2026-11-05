import { describe, expect, it } from 'vitest';

import { ancestorsOf, describeSignal, isOrphaned } from './signalOrigin';

/**
 * `ps -axo pid=,ppid=,command=` as macOS prints it, taken from a real process walked up from a node
 * started through tsx (the same layering `bin/bica.cjs` produces), with the home directory replaced
 * and the long commands cut. Linux prints the same three columns.
 */
const PS = `
78762 78761 /usr/local/bin/node --require /home/u/bica/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/preflight.cjs --import file:///x/loader.mjs /home/u/bica/src/cli.ts run pnpm test
78761 78760 /usr/local/bin/node /home/u/bica/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs /home/u/bica/src/cli.ts run pnpm test
78760 78374 node /home/u/bica/bin/bica.cjs run pnpm test
78374 78370 /bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot.sh && eval 'bica run pnpm test'
78370 31893 /bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot.sh && eval 'sleep 1'
31893 31789 claude
31789 31788 -/bin/zsh
31788 49969 /usr/bin/login -flp user /bin/bash --noprofile --norc -c exec -l /bin/zsh
49969     1 /Applications/Ghostty.app/Contents/MacOS/ghostty
    1     0 /sbin/launchd
`;

describe('ancestorsOf', () => {
  it('lists what started the run, nearest first, without bica\'s own launcher layers', () => {
    const chain = ancestorsOf(PS, 78762);
    expect(chain.map((a) => a.pid)).toEqual([78374, 78370, 31893, 31789, 31788, 49969]);
    expect(chain.some((a) => a.command.includes('bica.cjs'))).toBe(false);
    expect(chain.some((a) => a.command.includes('tsx'))).toBe(false);
  });

  it('is empty for a pid it cannot find, and stops at init', () => {
    expect(ancestorsOf(PS, 999)).toEqual([]);
    expect(ancestorsOf(PS, 49969)).toEqual([]);
  });

  it('terminates on a loop in the table', () => {
    expect(ancestorsOf('10 20 a\n20 10 b\n', 10).length).toBeLessThanOrEqual(2);
  });
});

describe('isOrphaned', () => {
  it('is false while the shell that started the run is alive', () => {
    expect(isOrphaned(PS, 78762)).toBe(false);
  });

  it('is true once the outermost bica layer has been handed to init', () => {
    const orphan = PS.replace('78760 78374 node', '78760     1 node');
    expect(isOrphaned(orphan, 78762)).toBe(true);
  });
});

describe('describeSignal', () => {
  const ancestors = ancestorsOf(PS, 78762);

  it('names the chain and the elapsed time, and never claims a sender', () => {
    const text = describeSignal({ signal: 'SIGTERM', ranForSeconds: 191.4, ancestors, orphaned: false });
    expect(text).toContain('SIGTERM arrived 191s into the run');
    expect(text).toContain('cannot either');
    expect(text).toContain('claude (pid 31893)');
    expect(text).not.toMatch(/sent by|came from/);
  });

  it('says so when the parent is already gone', () => {
    const text = describeSignal({ signal: 'SIGTERM', ranForSeconds: 5, ancestors: [], orphaned: true });
    expect(text).toContain('already gone');
  });

  it('says the exit code is a stop and not a test result', () => {
    const text = describeSignal({ signal: 'SIGHUP', ranForSeconds: 1, ancestors: [], orphaned: false });
    expect(text).toContain('not a test result');
    expect(text).toContain('143');
  });
});
