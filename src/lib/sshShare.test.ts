import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { removeRemoteSessionCaches } from './mutagenCaches';
import { buildRemoteProbeSshArgv, buildRunRemoteSshArgs, runRemoteScriptOverStdin } from './runRemote';
import {
  idleLimitHint,
  sharedSshOptions,
  shareSshWithRsync,
  sshIdleLimitOptions,
  sshIdleSeconds,
  sshShareDisabled,
} from './sshShare';

const POSIX = process.platform !== 'win32';

describe('sharedSshOptions', () => {
  it.runIf(POSIX)('multiplexes into a private folder, with a socket path far under the 104-byte limit', () => {
    const options = sharedSshOptions({});
    expect(options).toContain('ControlMaster=auto');
    expect(options).toContain('ControlPersist=60');
    const controlPath = options.find((o) => o.startsWith('ControlPath='))?.slice('ControlPath='.length);
    expect(controlPath).toBeDefined();
    // `%C` expands to a 40-character hash, so that is what the limit has to hold with.
    expect(controlPath!.replace('%C', 'x'.repeat(40)).length).toBeLessThan(104);
    const dir = path.dirname(controlPath!);
    const stat = fs.lstatSync(dir);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o077).toBe(0);
    expect(stat.uid).toBe(process.getuid?.());
  });

  it('is empty when BICA_SSH_SHARE=0, for a host that refuses multiplexing', () => {
    expect(sshShareDisabled({ BICA_SSH_SHARE: '0' })).toBe(true);
    expect(sharedSshOptions({ BICA_SSH_SHARE: '0' })).toEqual([]);
    expect(sshShareDisabled({})).toBe(false);
  });
});

describe('the idle limit', () => {
  // Raised against 0.10.10: seven runs sat for two hours in their `.git` rsync. The remote halves had
  // exited, the remote sshd never closed their sessions, and the shared connection went on answering
  // keepalives, so neither rsync nor ssh nor bica had any reason to stop waiting.
  const yes = (): boolean => true;
  const no = (): boolean => false;

  it('ends a session that has been silent for two minutes, by default', () => {
    expect(sshIdleSeconds({})).toBe(120);
    expect(sshIdleLimitOptions({}, yes)).toEqual(['-o', 'ChannelTimeout=session=120']);
  });

  it('takes its length from BICA_SSH_IDLE_SECONDS, and 0 turns it off', () => {
    expect(sshIdleLimitOptions({ BICA_SSH_IDLE_SECONDS: '600' }, yes)).toEqual([
      '-o',
      'ChannelTimeout=session=600',
    ]);
    expect(sshIdleLimitOptions({ BICA_SSH_IDLE_SECONDS: '0' }, yes)).toEqual([]);
    // A value that is not a whole number of seconds is not a reason to wait for ever.
    expect(sshIdleSeconds({ BICA_SSH_IDLE_SECONDS: 'soon' })).toBe(120);
    expect(sshIdleSeconds({ BICA_SSH_IDLE_SECONDS: '-5' })).toBe(120);
  });

  it('is left out for an ssh that would stop at an option it does not know', () => {
    expect(sshIdleLimitOptions({}, no)).toEqual([]);
  });

  it.runIf(POSIX)('reaches the short calls and rsync alike, when this ssh has it', () => {
    const limit = sshIdleLimitOptions({});
    const shared = sharedSshOptions({});
    const env: NodeJS.ProcessEnv = {};
    shareSshWithRsync(env);
    if (limit.length === 0) {
      expect(shared.join(' ')).not.toContain('ChannelTimeout');
      return;
    }
    expect(shared).toContain('ChannelTimeout=session=120');
    expect(env.RSYNC_RSH).toContain('-o ChannelTimeout=session=120');
  });

  it('explains exit 255, which is all ssh says when it closes a silent session', () => {
    expect(idleLimitHint(255, {})).toContain('120s of nothing');
    expect(idleLimitHint(255, {})).toContain('BICA_SSH_IDLE_SECONDS');
    expect(idleLimitHint(255, { BICA_SSH_IDLE_SECONDS: '30' })).toContain('30s of nothing');
  });

  it('says nothing about a failure the limit cannot have caused', () => {
    expect(idleLimitHint(23, {})).toBe('');
    expect(idleLimitHint(0, {})).toBe('');
    expect(idleLimitHint(255, { BICA_SSH_IDLE_SECONDS: '0' })).toBe('');
    expect(idleLimitHint(255, { BICA_SSH_SHARE: '0' })).toBe('');
  });
});

describe('shareSshWithRsync', () => {
  it.runIf(POSIX)('gives rsync the same options through RSYNC_RSH, so no rsync call site changes', () => {
    const env: NodeJS.ProcessEnv = {};
    shareSshWithRsync(env);
    expect(env.RSYNC_RSH).toMatch(/^ssh -o ControlMaster=auto -o ControlPath=\/tmp\/bica-ssh-\d+\/%C-i /);
    expect(env.RSYNC_RSH).not.toMatch(/\s{2,}/);
  });

  it('leaves a remote shell the caller chose alone, and does nothing when sharing is off', () => {
    const chosen: NodeJS.ProcessEnv = { RSYNC_RSH: 'ssh -i /my/key' };
    shareSshWithRsync(chosen);
    expect(chosen.RSYNC_RSH).toBe('ssh -i /my/key');
    const off: NodeJS.ProcessEnv = { BICA_SSH_SHARE: '0' };
    shareSshWithRsync(off);
    expect(off.RSYNC_RSH).toBeUndefined();
  });
});

describe('which connections share', () => {
  // Real functions against a stand-in `ssh` that records its arguments. What is pinned is the split:
  // everything short shares, and the command's own connection does not, because bica reads a dropped
  // link out of that ssh's own debug output and a client on a shared connection prints none of it.
  function withRecordingSsh<T>(body: () => T): { result: T; calls: string[] } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica ssh shim '));
    const log = path.join(dir, 'calls');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncat >/dev/null\nexit 0\n`, {
      mode: 0o755,
    });
    const before = process.env.PATH;
    process.env.PATH = `${bin}:${before ?? ''}`;
    try {
      const result = body();
      const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
      return { result, calls };
    } finally {
      process.env.PATH = before;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it.runIf(POSIX)('shares the probes, the cache cleanup and the probe argv', () => {
    const { calls } = withRecordingSsh(() => {
      runRemoteScriptOverStdin('mini', 'true\n');
      removeRemoteSessionCaches('mini', ['sync_abc']);
      spawnSync('true');
    });
    // The one-off question of whether this ssh has an idle limit is not a call to the remote.
    const remote = calls.filter((call) => !call.startsWith('-G '));
    expect(remote).toHaveLength(2);
    for (const call of remote) {
      expect(call).toContain('ControlMaster=auto');
      expect(call).toContain('ControlPath=/tmp/bica-ssh-');
    }
    expect(buildRemoteProbeSshArgv('mini', 'true').join(' ')).toContain('ControlMaster=auto');
  });

  it('does not share the connection the command runs on', () => {
    const args = buildRunRemoteSshArgs({
      interactive: false,
      sshHost: 'mini',
      shell: 'zsh',
      flags: ['-lc'],
      remoteScript: 'true',
      diagnosticsLogPath: '/tmp/diag.log',
    });
    expect(args.join(' ')).not.toContain('Control');
  });
});
