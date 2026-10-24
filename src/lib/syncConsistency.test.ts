import { describe, expect, it } from 'vitest';

import {
  COMPANION_RULES,
  findSyncInconsistencies,
  withCompanionRecordsIgnored,
} from './syncConsistency';

describe('one half of a matched pair', () => {
  it('flags build output withheld while its record is sent', () => {
    const found = findSyncInconsistencies(['node_modules', '.git', 'dist']);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('*.tsbuildinfo');
    expect(found[0].message).toContain('dist');
  });

  it('is satisfied when both are withheld', () => {
    expect(
      findSyncInconsistencies(['node_modules', 'dist', '*.tsbuildinfo']),
    ).toEqual([]);
  });

  it('accepts the quoted form YAML produces', () => {
    // `- "*.tsbuildinfo"` has to be quoted in YAML, and may arrive with the quotes attached.
    expect(findSyncInconsistencies(['dist', '"*.tsbuildinfo"'])).toEqual([]);
  });

  it('accepts a broader glob that already covers the record', () => {
    expect(findSyncInconsistencies(['dist', '**/*.tsbuildinfo'])).toEqual([]);
  });

  it('says nothing when the output is not ignored at all', () => {
    // Sending both halves is consistent, whatever else it is.
    expect(findSyncInconsistencies(['node_modules'])).toEqual([]);
  });

  it('says nothing about ignoring the record alone', () => {
    // The remote then rebuilds what it cannot prove is current: slower, and correct.
    expect(findSyncInconsistencies(['*.tsbuildinfo'])).toEqual([]);
  });

  it('explains the consequence, not just the rule', () => {
    for (const rule of COMPANION_RULES) {
      expect(rule.why.length).toBeGreaterThan(40);
    }
  });
});

describe('withCompanionRecordsIgnored', () => {
  it('ignores *.tsbuildinfo for a config that ignores dist and has not said', () => {
    expect(withCompanionRecordsIgnored(['node_modules', 'dist'])).toEqual({
      paths: ['node_modules', 'dist', '*.tsbuildinfo'],
      added: ['*.tsbuildinfo'],
    });
  });

  it('leaves a config that mentions the record exactly as written, either way', () => {
    for (const said of ['"*.tsbuildinfo"', '*.tsbuildinfo', 'common/tsconfig.tsbuildinfo', '!*.tsbuildinfo']) {
      expect(withCompanionRecordsIgnored(['dist', said])).toEqual({
        paths: ['dist', said],
        added: [],
      });
    }
  });

  it('adds nothing when dist travels, since both halves then come from one side', () => {
    expect(withCompanionRecordsIgnored(['node_modules']).added).toEqual([]);
  });
});

