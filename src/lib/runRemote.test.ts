import { describe, expect, it } from 'vitest';

import {
  pickRemoteHomeFromSshStdout,
  remotePathExprForCd,
  sanitizeRemotePosixAbsolutePath,
  shellSingleQuoteRemotePathForSh,
} from './runRemote';

describe('remotePathExprForCd', () => {
  it('trims whitespace so cd/mkdir paths are not broken', () => {
    expect(remotePathExprForCd('  ~/code/foo  ')).toBe('"$HOME/code/foo"');
    expect(remotePathExprForCd('  /abs/path  ')).toBe('"/abs/path"');
  });
});

describe('sanitizeRemotePosixAbsolutePath', () => {
  it('removes CR/LF so ssh pwd output cannot poison mkdir', () => {
    expect(sanitizeRemotePosixAbsolutePath('/Users/x/code/foo\n')).toBe(
      '/Users/x/code/foo',
    );
  });
});

describe('shellSingleQuoteRemotePathForSh', () => {
  it('escapes embedded single quotes for POSIX sh', () => {
    expect(shellSingleQuoteRemotePathForSh("/Users/x/a'b")).toBe(
      `'/Users/x/a'\\''b'`,
    );
  });
});

describe('pickRemoteHomeFromSshStdout', () => {
  it('takes the last absolute path line when MOTD precedes HOME', () => {
    expect(
      pickRemoteHomeFromSshStdout(
        'Welcome to macOS\n\nLast login: …\n/Users/jack',
      ),
    ).toBe('/Users/jack');
  });

  it('returns null when there is no absolute path', () => {
    expect(pickRemoteHomeFromSshStdout('hello')).toBeNull();
  });

  it('rejects bare / as HOME', () => {
    expect(pickRemoteHomeFromSshStdout('hello\n/')).toBeNull();
  });
});
