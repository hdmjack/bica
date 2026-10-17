import { describe, expect, it } from 'vitest';

import {
  buildDetachStartScript,
  buildLogsScript,
  describeDetachedRun,
  parseDetachStart,
  remoteLogPathFor,
} from './detachedRun';

/**
 * The request's test: "`run --detach` followed by killing the caller: the remote command keeps going,
 * `bica wait` returns its exit code, and a concurrent `bica run` gets 98."
 *
 * The first and third of those are properties of the script below rather than of any TypeScript, and
 * the one that nearly sank it is the third. The lease's liveness oracle asks whether the recorded pid
 * is a *process group*, which is right for an attached run because ssh makes the remote shell a group
 * leader. A backgrounded job in a non-interactive shell does not get its own group, macOS has no
 * `setsid` to give it one, and so the detached shell sat in the launching ssh's group -- which dies
 * with the launcher. The next run read the lease as stale, broke it, and rsynced over a build that
 * was still compiling. Measured on `mini`: pgid 96707 for a job whose own pid was 96708, against
 * pgid 96712 == pid 96712 once job control was on.
 */

describe('buildDetachStartScript', () => {
  const base = {
    remoteWorkspacePath: '~/code/llvm',
    innerScript: 'echo hi\n',
    runId: '4242',
    loginShell: 'zsh',
  };

  it('turns job control on, so the command gets its own process group', () => {
    // Load-bearing: without it the lease looks stale the moment the launcher exits, and the next run
    // syncs over a live build.
    expect(buildDetachStartScript(base)).toContain('set -m');
  });

  it('survives the connection that started it', () => {
    const script = buildDetachStartScript(base);
    expect(script).toContain('nohup');
    expect(script).toContain('setsid');
  });

  it('gives the command a stdin that is not already closed', () => {
    // A backgrounded command in a non-interactive shell inherits a closed stdin, and a build tool
    // that reads it sees an immediate EOF that looks like a mysterious early exit.
    expect(buildDetachStartScript(base)).toContain('< /dev/null');
  });

  it('sends the output to the run\'s own log', () => {
    expect(buildDetachStartScript(base)).toContain(remoteLogPathFor('4242'));
  });

  it('waits a moment and reports whether it is still alive', () => {
    // "Started" has to mean something. A command that cannot start at all is better reported now
    // than left for `bica wait` to discover in an hour.
    const script = buildDetachStartScript(base);
    expect(script).toContain('kill -0');
    expect(script).toContain('started=');
    expect(script).toContain('exited-early=');
  });
});

describe('parseDetachStart', () => {
  it('reads a started pid', () => {
    expect(parseDetachStart('started=96528\n')).toEqual({
      started: true,
      exitedEarly: false,
      pid: 96528,
    });
  });

  it('tells an early exit apart from a launch that never happened', () => {
    // Different advice: one has output to read, the other has a remote to look at.
    expect(parseDetachStart('exited-early=96528\n').exitedEarly).toBe(true);
    expect(parseDetachStart('').exitedEarly).toBe(false);
    expect(parseDetachStart('').started).toBe(false);
  });
});

describe('buildLogsScript', () => {
  it('reads the log from the beginning when not following', () => {
    expect(buildLogsScript({ runId: '1', follow: false })).toContain('cat ');
  });

  it('follows by name, since a watcher can arrive before the file exists', () => {
    const script = buildLogsScript({ runId: '1', follow: true });
    expect(script).toContain('-F');
    expect(script).toContain('-n +1');
  });
});

describe('describeDetachedRun', () => {
  const record = {
    runId: '4242',
    sshHost: 'mini',
    remoteWorkspacePath: '~/code/llvm',
    repoRoot: '/l',
    command: ['ninja', '-C', 'build'],
    startedAt: new Date(Date.now() - 125_000).toISOString(),
    remoteLogPath: '~/.bica/runs/4242.log',
  };

  it('says how long a running build has been going', () => {
    const said = describeDetachedRun(record, 'running', null);
    expect(said).toContain('ninja -C build');
    expect(said).toContain('running for 2m');
  });

  it('gives the exit code of a finished one', () => {
    expect(describeDetachedRun(record, 'finished', 7)).toContain('exit 7');
  });

  it('says plainly when the workspace was taken by something else', () => {
    // Its result is genuinely unrecoverable at that point; reporting a stranger's exit code would be
    // worse than saying so.
    expect(describeDetachedRun(record, 'gone', null)).toContain('gone');
  });
});
