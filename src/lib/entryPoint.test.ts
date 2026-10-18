import { describe, expect, it } from 'vitest';

import { describeEntryPoint, isScriptEntryPoint } from './entryPoint';

describe('isScriptEntryPoint', () => {
  it.each(['./x', './scripts/build.sh', '/usr/local/bin/thing', 'tools/build'])(
    'treats %s as a script in the tree',
    (argv0) => {
      expect(isScriptEntryPoint(argv0)).toBe(true);
    },
  );

  it.each(['pnpm', 'cargo', 'ninja', 'cmake'])(
    'treats %s as a tool on PATH',
    (argv0) => {
      expect(isScriptEntryPoint(argv0)).toBe(false);
    },
  );
});

describe('describeEntryPoint', () => {
  it('says plainly when nothing will install anything', () => {
    // The request: this "should simply not apply, and that should be said once in doctor, not
    // discovered".
    const { detail, note } = describeEntryPoint({ activePluginIds: [] });
    expect(detail).toContain('no install preflight');
    expect(note).toContain('cmake');
  });

  it('names the package manager, and the case it does not cover', () => {
    const { detail, note } = describeEntryPoint({ activePluginIds: ['pnpm'] });
    expect(detail).toContain('pnpm');
    expect(note).toContain('./x build');
  });
});
