import { describe, expect, it } from 'vitest';

import { parseSyncListTemplateLine } from './mutagenSession';

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
