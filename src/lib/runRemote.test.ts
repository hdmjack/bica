import { describe, expect, it } from 'vitest';

import {
  buildRunRemoteSshArgs,
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

describe('buildRunRemoteSshArgs', () => {
  const base = {
    sshHost: 'mini',
    shell: 'zsh',
    flags: ['-lc'],
    remoteScript: 'cd "$HOME/code/foo" && pnpm typecheck',
  };

  it('forces a PTY (-t) for an interactive terminal', () => {
    const argv = buildRunRemoteSshArgs({ ...base, interactive: true });
    expect(argv).toContain('-t');
    expect(argv).not.toContain('-T');
  });

  it('disables the PTY (-T) when output is captured', () => {
    const argv = buildRunRemoteSshArgs({ ...base, interactive: false });
    expect(argv).toContain('-T');
    expect(argv).not.toContain('-t');
  });

  it('sends ssh\'s own diagnostics to a file, keeping them out of the command\'s stream', () => {
    // What makes a lost connection recognisable: the log holds ssh speaking and nothing else, so
    // `Connection reset by peer` found there is a fact about the link rather than a line of output.
    const argv = buildRunRemoteSshArgs({
      ...base,
      interactive: false,
      diagnosticsLogPath: '/tmp/bica-ssh-x/ssh.log',
    });
    expect(argv.slice(argv.indexOf('-E'), argv.indexOf('-E') + 2)).toEqual([
      '-E',
      '/tmp/bica-ssh-x/ssh.log',
    ]);
    // Verbose, because the wording of ssh's errors turned out not to separate a drop from a refused
    // handshake and `debug1: Authenticated to …` does. Only ever alongside the log file.
    expect(argv).toContain('-v');
    // Before the host, or ssh reads it as part of the remote command.
    expect(argv.indexOf('-E')).toBeLessThan(argv.indexOf('mini'));
  });

  it('asks for neither a log file nor verbosity when none is wanted', () => {
    // Verbosity without the log file would put the whole handshake on the user's terminal.
    const argv = buildRunRemoteSshArgs({ ...base, interactive: false });
    expect(argv).not.toContain('-E');
    expect(argv).not.toContain('-v');
  });

  it('preserves host, shell, flags, and remote script order after the PTY flag', () => {
    const argv = buildRunRemoteSshArgs({ ...base, interactive: false });
    const ptyIdx = argv.indexOf('-T');
    expect(argv.slice(ptyIdx)).toEqual([
      '-T',
      'mini',
      'zsh',
      '-lc',
      `'cd "$HOME/code/foo" && pnpm typecheck'`,
    ]);
  });

  it('passes the script as one quoted word, so the shell asked for is the shell that runs it', () => {
    // ssh joins its arguments with spaces and the remote's own login shell parses the result. An
    // unquoted multi-line script therefore became `zsh -lc <first word>` plus every remaining line
    // executed by the outer shell -- which is how a bare `export` came to run, printing the wall of
    // KEY=value that every run used to start with.
    const argv = buildRunRemoteSshArgs({
      ...base,
      interactive: false,
      remoteScript: "echo one\necho 'two'\n",
    });
    const script = argv[argv.length - 1];
    expect(script.startsWith("'")).toBe(true);
    expect(script.endsWith("'")).toBe(true);
    // The script's own quotes survive, escaped the POSIX way rather than ending the word early.
    expect(script).toContain(`'\\''two'\\''`);
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
