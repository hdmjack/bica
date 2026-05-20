import { describe, expect, it } from 'vitest';

import { parseSyncListTemplateLine } from './mutagenSession';

describe('parseSyncListTemplateLine', () => {
  it('parses a 4-field session line', () => {
    const summary = parseSyncListTemplateLine(
      'float-javascript|sync_lJvWnsi5|/Users/me/code/float-javascript|mini:~/code/float-javascript',
    );
    expect(summary).toEqual({
      name: 'float-javascript',
      identifier: 'sync_lJvWnsi5',
      alpha: '/Users/me/code/float-javascript',
      beta: 'mini:~/code/float-javascript',
    });
  });

  it('returns null for malformed lines', () => {
    expect(parseSyncListTemplateLine('')).toBeNull();
    expect(parseSyncListTemplateLine('name|id|alpha')).toBeNull();
    expect(parseSyncListTemplateLine('|id|alpha|beta')).toBeNull();
    expect(parseSyncListTemplateLine('name||alpha|beta')).toBeNull();
  });
});
