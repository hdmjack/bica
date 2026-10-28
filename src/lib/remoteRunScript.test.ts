import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildRemoteRunScript,
  REMOTE_CD_FAILED_EXIT,
  wrapCommandToDieWithConnection,
} from './runRemote';

// `cdExpr` includes the `cd`, matching what the caller passes.
const BASE = {
  preamble: 'export PATH="/x:$PATH"\n',
  cdExpr: 'cd "$HOME/code/repo-lane-1"',
  command: "pnpm 'test:run'",
};

describe('buildRemoteRunScript — no lease', () => {
  const script = buildRemoteRunScript({
    ...BASE,
    runId: undefined,
    claimPathExpr: undefined,
  });

  it('runs the command and preserves its exit code', () => {
    expect(script).toContain("pnpm 'test:run'");
    expect(script).toContain('_bica_ec=$?');
    expect(script.trimEnd().endsWith('exit "$_bica_ec"')).toBe(true);
  });

  it('touches no claim, so the default workspace is unaffected', () => {
    expect(script).not.toContain('_bica_held');
  });

  it('fails with a distinct code when the workspace cannot be entered', () => {
    expect(script).toContain(`|| exit ${String(REMOTE_CD_FAILED_EXIT)}`);
  });

  it('keeps the preamble first, so tooling is on PATH before anything runs', () => {
    expect(script.startsWith(BASE.preamble)).toBe(true);
  });
});

describe('buildRemoteRunScript — holding a lease', () => {
  const CLAIM = '"$HOME/.bica/claims/code_repo-lane-1"';
  const script = buildRemoteRunScript({
    ...BASE,
    runId: 'abc123def456-999',
    claimPathExpr: CLAIM,
  });

  it('does not create the claim — that happens before the rsync, not here', () => {
    // The rsync is the destructive act, so the lease must already exist when it runs. A script that
    // claimed at this point would have overwritten another run's files before noticing the conflict.
    expect(script).not.toMatch(/printf '%s' '[^']*' > "\$HOME\/\.bica/);
  });

  it('checks the lease only after the command has run', () => {
    expect(script.indexOf('_bica_held')).toBeGreaterThan(
      script.indexOf("pnpm 'test:run'"),
    );
  });

  it('captures the exit code before the check, so the check cannot clobber it', () => {
    expect(script.indexOf('_bica_ec=$?')).toBeLessThan(
      script.indexOf('_bica_held'),
    );
  });

  it('compares only the run id field, not the whole claim line', () => {
    // The claim also carries host, pid and eventually the exit code; a whole-line match would break
    // as soon as any of those were appended.
    expect(script).toContain("cut -d' ' -f1");
  });

  it('exits 97 when the lease is no longer ours', () => {
    expect(script).toContain('exit 97');
  });

  it('records the exit code into the claim once it finishes', () => {
    expect(script).toContain(`> ${CLAIM}`);
  });
});

describe('the end-of-run lease check, executed', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-lease-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(
    runId: string,
    claimContents: string | null,
    command = 'true',
  ): number {
    const claimFile = path.join(dir, 'claim');
    if (claimContents === null) {
      fs.rmSync(claimFile, { force: true });
    } else {
      fs.writeFileSync(claimFile, claimContents, 'utf8');
    }
    const script = buildRemoteRunScript({
      preamble: '',
      cdExpr: `cd ${JSON.stringify(dir)}`,
      command,
      runId,
      claimPathExpr: JSON.stringify(claimFile),
    });
    return spawnSync('sh', ['-c', script], { cwd: dir }).status ?? -1;
  }

  it('passes the command exit code through when the lease is still ours', () => {
    expect(run('mine', 'mine thishost 123')).toBe(0);
    expect(run('mine', 'mine thishost 123', 'exit 4')).toBe(4);
  });

  it('discards the result when another run took the lease mid-command', () => {
    // The command still ran; what is thrown away is its verdict, because the files underneath it were
    // being replaced while it worked.
    expect(run('mine', 'someone-else otherhost 999')).toBe(97);
  });

  it('discards the result when the lease vanished entirely', () => {
    expect(run('mine', null)).toBe(97);
  });

  it('appends the exit code to the claim, for resolving ssh 255 later', () => {
    // `(exit 7)` in a subshell, because a bare `exit` would terminate the run script itself before it
    // could record anything — which is exactly what it should do, but is not what is under test here.
    run('mine', 'mine thishost 123', '(exit 7)');
    expect(fs.readFileSync(path.join(dir, 'claim'), 'utf8').trim()).toMatch(
      /^mine thishost 123 rpid=\d+ 7$/,
    );
  });

  it('publishes the shell\'s own pid into the claim before the command runs', () => {
    // The claim records the client's pid, which stops being an answer the moment the client dies with
    // the ssh still up. This is the pid that tracks what is actually touching the workspace.
    run('mine', 'mine thishost 123', 'true');
    const claim = fs.readFileSync(path.join(dir, 'claim'), 'utf8');
    const rpid = /rpid=(\d+)/.exec(claim)?.[1];
    expect(rpid).toBeDefined();
    expect(Number(rpid)).toBeGreaterThan(0);
  });

  it('records the pid early enough for a command that never finishes to be seen', () => {
    // Published before the command, not after it: a run that hangs is precisely the one whose claim
    // has to be judgeable.
    const claimFile = path.join(dir, 'claim');
    fs.writeFileSync(claimFile, 'mine thishost 123', 'utf8');
    const script = buildRemoteRunScript({
      preamble: '',
      cdExpr: `cd ${JSON.stringify(dir)}`,
      command: `cat ${JSON.stringify(claimFile)} > ${JSON.stringify(path.join(dir, 'seen'))}`,
      runId: 'mine',
      claimPathExpr: JSON.stringify(claimFile),
    });
    spawnSync('sh', ['-c', script], { cwd: dir });
    expect(fs.readFileSync(path.join(dir, 'seen'), 'utf8')).toMatch(/rpid=\d+/);
  });

  it('does not write its pid into a claim that is no longer ours', () => {
    // The lease may have been broken between acquiring it and this script starting. Appending here
    // would corrupt the new holder's claim; the end-of-run check is what discards our result.
    expect(run('mine', 'someone-else otherhost 999')).toBe(97);
    expect(fs.readFileSync(path.join(dir, 'claim'), 'utf8')).toBe(
      'someone-else otherhost 999',
    );
  });

  it('quotes the run id so a real shell treats it as data', () => {
    // Run ids are whitespace-free by contract (formatOwner enforces it, because the claim is
    // space-delimited), so the hostile case to defend against is quoting, not spaces.
    const nasty = "abc';touch(pwned);echo'";
    expect(run(nasty, `${nasty} thishost 1`, 'true')).toBe(0);
    expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
  });
});

describe('wrapCommandToDieWithConnection', () => {
  it('runs the command in the background with a watchdog on stdin', () => {
    const script = wrapCommandToDieWithConnection("'pnpm' 'serve'");
    expect(script).toContain("'pnpm' 'serve' < /dev/null &");
    expect(script).toContain('cat <&3 > /dev/null');
    expect(script).toContain('kill -TERM 0');
  });

  it("leaves $? as the command's own status for the enclosing script", () => {
    const script = wrapCommandToDieWithConnection('serve');
    expect(script.trimEnd().endsWith('(exit "$_bica_ec")')).toBe(true);
  });

  it('waits on the command, not on the watchdog', () => {
    const script = wrapCommandToDieWithConnection('serve');
    expect(script).toContain('wait "$_bica_cmd"');
    expect(script).not.toContain('wait "$_bica_watch"');
  });
});

/**
 * The watchdog run for real, in a process group of its own as sshd would give it, with the
 * connection played by a pipe on stdin. Closing the pipe is the connection dropping.
 */
// Every shell bica might run under: `sh` and `bash` redirect a background job's stdin, zsh does not,
// and the watchdog was only ever correct under the one that does not.
const shells = ['sh', 'bash', 'zsh'].filter(
  (shell) => spawnSync('sh', ['-c', `command -v ${shell}`]).status === 0,
);

describe.each(shells)('wrapCommandToDieWithConnection, run under %s', (shell) => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-watchdog-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const startWrapped = (command: string, before = '') => {
    const child = spawn(shell, ['-c', `${before}${wrapCommandToDieWithConnection(command)}`], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('close', (code) => {
        resolve(code);
      });
    });
    return { child, exited };
  };

  const waitFor = async (check: () => boolean, ms = 5000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return check();
  };

  it('ends the processes the command started when the connection goes, not only the command', async () => {
    // The shape of `pnpm test:run`: the pid the wrapper starts is a parent, and the work is done by a
    // grandchild that a `SIGTERM` to the parent alone did not reach.
    const pidFile = path.join(dir, 'grandchild');
    const { child, exited } = startWrapped(
      `sh -c 'sleep 60 & echo $! > ${pidFile}; wait'`,
    );
    try {
      expect(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '')).toBe(true);
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
      expect(isAlive(grandchild)).toBe(true);

      child.stdin.end();
      await exited;
      expect(await waitFor(() => !isAlive(grandchild))).toBe(true);
    } finally {
      try {
        process.kill(-(child.pid ?? 0), 'SIGKILL');
      } catch {
        // Already gone, which is the point.
      }
    }
  });

  // A Node process reading the connection's pipe, started before the wrapper so that the pipe is
  // already non-blocking when the watchdog's `cat` reaches its `read`: the order a loaded remote
  // produced, made certain rather than likely.
  // Through fd 4, because `sh` and `bash` would hand a plain background job `/dev/null` instead.
  const nonBlockingFirst =
    `exec 4<&0\n${JSON.stringify(process.execPath)} -e 'process.stdin.on("data", () => {})' <&4 & sleep 1\nexec 4<&-\n`;

  it('does not mistake a non-blocking pipe for the connection ending', async () => {
    const { child, exited } = startWrapped(`sh -c 'sleep 2; exit 3'`, nonBlockingFirst);
    try {
      expect(await exited).toBe(3);
    } finally {
      child.stdin.end();
    }
  });

  it('still ends the command when the connection closes, with the pipe non-blocking', async () => {
    const pidFile = path.join(dir, 'grandchild');
    const { child, exited } = startWrapped(
      `sh -c 'sleep 60 & echo $! > ${pidFile}; wait'`,
      nonBlockingFirst,
    );
    try {
      expect(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '')).toBe(true);
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
      // Past the moment the old watchdog would have fired on `EAGAIN`.
      await new Promise((r) => setTimeout(r, 1500));
      expect(isAlive(grandchild)).toBe(true);

      child.stdin.end();
      await exited;
      expect(await waitFor(() => !isAlive(grandchild))).toBe(true);
    } finally {
      try {
        process.kill(-(child.pid ?? 0), 'SIGKILL');
      } catch {
        // Already gone, which is the point.
      }
    }
  });

  it("gives the command its own stdin, so it cannot read or reconfigure the connection's", async () => {
    // `cat` as the command reads end-of-file from `/dev/null` and finishes; reading the connection
    // it would wait for as long as the connection lasted.
    const { child, exited } = startWrapped('cat');
    try {
      expect(await exited).toBe(0);
    } finally {
      child.stdin.end();
    }
  });

  it("leaves a command that finishes on its own alone, with its own exit code", async () => {
    const { child, exited } = startWrapped(`sh -c 'exit 3'`);
    try {
      expect(await exited).toBe(3);
    } finally {
      child.stdin.end();
    }
  });
});

/**
 * A command whose client has gone quiet is ended on the remote. Run for real under `sh`, with the
 * intervals shortened: the parts that matter are the shell's -- `-nt`, the process-group kill, and
 * stopping when the lease is no longer this run's.
 */
describe('buildRemoteRunScript — heartbeat', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-heartbeat-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const claim = (): string => path.join(dir, 'code_repo');

  /** Start the script in its own process group, as sshd starts a session. */
  const start = (runId = 'run-1'): { pid: number; done: Promise<number | null> } => {
    fs.writeFileSync(claim(), `${runId} laptop 1 t=0\n`);
    const script = buildRemoteRunScript({
      preamble: '',
      cdExpr: `cd '${dir}'`,
      command: 'sleep 30',
      runId,
      claimPathExpr: `'${claim()}'`,
      heartbeat: true,
      heartbeatTiming: { checkSeconds: 1, staleSeconds: 3 },
    });
    const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
    const done = new Promise<number | null>((resolve) => {
      child.on('exit', (code, signal) => resolve(signal === null ? code : -1));
    });
    return { pid: child.pid!, done };
  };

  const within = <T,>(p: Promise<T>, ms: number): Promise<T | 'timeout'> =>
    Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);

  const stop = (pid: number): void => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  };

  it('ends the command once the heartbeat goes quiet', async () => {
    const run = start();
    try {
      expect(await within(run.done, 8000)).not.toBe('timeout');
    } finally {
      stop(run.pid);
    }
  }, 15_000);

  it('leaves the command running while the heartbeat keeps coming', async () => {
    const run = start();
    const beat = setInterval(() => {
      const now = new Date();
      fs.utimesSync(`${claim()}.beat`, now, now);
    }, 700);
    try {
      expect(await within(run.done, 6000)).toBe('timeout');
    } finally {
      clearInterval(beat);
      stop(run.pid);
    }
  }, 15_000);

  it('stops watching once the lease is no longer this run\'s', async () => {
    const run = start();
    fs.writeFileSync(claim(), 'someone-else laptop 2 t=0\n');
    try {
      expect(await within(run.done, 6000)).toBe('timeout');
    } finally {
      stop(run.pid);
    }
  }, 15_000);
});
