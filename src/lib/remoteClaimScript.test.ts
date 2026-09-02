import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildClaimAcquireScript,
  buildClaimCancelScript,
  buildClaimReleaseScript,
  claimPathExpr,
  formatOwner,
} from './remoteClaim';

/**
 * The lease is enforced by a few lines of POSIX `sh` that used to be reachable only over ssh, so the
 * part doing the actual work — `ln` failing when the target exists — was never exercised by a test.
 * Three bugs shipped in this area (a claim inside the workspace that `rsync --delete` erased, a
 * whole-line release comparison that stopped matching once the exit code was appended, and an
 * empty-then-filled publish that let two runs both believe they held it), and none of them would have
 * survived running the script.
 *
 * These run the real generated script under `/bin/sh` against a temp directory. Nothing is mocked:
 * what is executed here is byte-for-byte what is sent to the remote.
 */

let dir: string;

function runScript(script: string): { status: number; stdout: string } {
  const r = spawnSync('/bin/sh', ['-s'], {
    input: script,
    encoding: 'utf8',
    shell: false,
  });
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim() };
}

/** The claim path a test uses: same shape as production, rooted in a temp dir. */
function claimIn(workspacePath: string): { expr: string; file: string } {
  // claimPathExpr yields `~/.bica/claims/<name>`; swap the tilde root for the temp dir so the shell
  // resolves it locally while the rest of the expression stays exactly as production builds it.
  const expr = claimPathExpr(workspacePath).replace('~/.bica/claims', dir);
  return { expr, file: expr };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-claim-script-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the lease script, executed', () => {
  it('takes a free claim and records the owner in one step', () => {
    const { expr, file } = claimIn('~/code/repo');
    const owner = formatOwner({ runId: 'run-a', host: 'mac', pid: 4242 });

    const r = runScript(buildClaimAcquireScript(expr, owner, dir));

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('OK');
    // The decisive property: the file is complete the instant it exists. An empty claim is the bug
    // that let two runs share a workspace. The start stamp is added by the same `printf`, so it
    // arrives with the rest rather than being appended after publication.
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^run-a mac 4242 t=\d+$/);
  });

  it('stamps the start from the remote clock, and records the command beside it', () => {
    // Age is reported as the difference of two readings of *this* clock. Stamping locally and
    // subtracting remotely would fold clock skew between two machines into a number presented as
    // elapsed time.
    const { expr, file } = claimIn('~/code/repo');
    const before = Math.floor(Date.now() / 1000);
    runScript(
      buildClaimAcquireScript(
        expr,
        formatOwner({ runId: 'run-a', host: 'mac', pid: 4242 }),
        dir,
        'pnpm test:run common/src',
      ),
    );
    const stamp = Number(
      /t=(\d+)/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '0',
    );
    expect(stamp).toBeGreaterThanOrEqual(before);
    // The command lives in a sidecar because the claim is one space-delimited line read with `cut`.
    expect(fs.readFileSync(`${file}.cmd`, 'utf8')).toBe('pnpm test:run common/src');
  });

  it('reports the holder, its command and the remote clock when refusing', () => {
    // All three come back in one round-trip: a refusal that has to make a second call to say what it
    // is waiting on would not bother, which is how "wait for it to finish" stayed open-ended.
    const { expr } = claimIn('~/code/repo');
    runScript(
      buildClaimAcquireScript(
        expr,
        formatOwner({ runId: 'run-a', host: 'mac', pid: 1 }),
        dir,
        'pnpm lint:fast',
      ),
    );
    const second = runScript(
      buildClaimAcquireScript(
        expr,
        formatOwner({ runId: 'run-b', host: 'mac', pid: 2 }),
        dir,
        'pnpm typecheck',
      ),
    );
    expect(second.stdout).toMatch(/HELD run-a mac 1 t=\d+/);
    expect(second.stdout).toMatch(/NOW \d+/);
    expect(second.stdout).toContain('CMD pnpm lint:fast');
  });

  it('does not overwrite the holder\'s command with the refused run\'s', () => {
    const { expr, file } = claimIn('~/code/repo');
    runScript(
      buildClaimAcquireScript(
        expr,
        formatOwner({ runId: 'run-a', host: 'mac', pid: 1 }),
        dir,
        'pnpm lint:fast',
      ),
    );
    runScript(
      buildClaimAcquireScript(
        expr,
        formatOwner({ runId: 'run-b', host: 'mac', pid: 2 }),
        dir,
        'pnpm typecheck',
      ),
    );
    expect(fs.readFileSync(`${file}.cmd`, 'utf8')).toBe('pnpm lint:fast');
  });

  it('refuses a claim another run holds, and says who holds it', () => {
    const { expr } = claimIn('~/code/repo');
    runScript(
      buildClaimAcquireScript(
        expr,
        formatOwner({ runId: 'run-a', host: 'mac', pid: 1 }),
        dir,
      ),
    );

    const second = runScript(
      buildClaimAcquireScript(
        expr,
        formatOwner({ runId: 'run-b', host: 'mac', pid: 2 }),
        dir,
      ),
    );

    expect(second.stdout).toMatch(/^HELD run-a mac 1 t=\d+/);
  });

  it('leaves no temp file behind on either path', () => {
    const { expr } = claimIn('~/code/repo');
    const owner = formatOwner({ runId: 'run-a', host: 'mac', pid: 1 });
    runScript(buildClaimAcquireScript(expr, owner, dir));
    runScript(buildClaimAcquireScript(expr, owner, dir)); // the HELD path

    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });

  it('gives the claim to exactly one of eight simultaneous contenders', () => {
    const { expr, file } = claimIn('~/code/repo');
    // Eight separate `sh` *processes*, started together -- which is what production does, one ssh
    // session each. Subshells of a single shell would not do: `$$` is per-process, so they would
    // share a temp file name and clobber each other. That is a property of the harness, not of the
    // lease, but getting it wrong makes the test lie in both directions.
    const procs = Array.from({ length: 8 }, () =>
      spawn('/bin/sh', ['-s'], { stdio: ['pipe', 'pipe', 'ignore'] }),
    );
    const outputs = procs.map((child, i) => {
      const script = buildClaimAcquireScript(
        expr,
        formatOwner({ runId: `run-${String(i)}`, host: 'mac', pid: i + 1 }),
        dir,
      );
      child.stdin.end(script);
      return new Promise<string>((resolve) => {
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', () => resolve(out.trim()));
      });
    });

    return Promise.all(outputs).then((results) => {
      expect(results.filter((r) => r === 'OK')).toHaveLength(1);
      expect(results.filter((r) => r.startsWith('HELD'))).toHaveLength(7);
      // The survivor's line is one contender's, not a mixture of two.
      expect(fs.readFileSync(file, 'utf8')).toMatch(/^run-[0-7] mac [1-8] t=\d+$/);
    });
  });
});

describe('the release script, executed', () => {
  it('drops a claim this run owns', () => {
    const { expr, file } = claimIn('~/code/repo');
    runScript(
      buildClaimAcquireScript(
        expr,
        formatOwner({ runId: 'run-a', host: 'mac', pid: 1 }),
        dir,
      ),
    );

    runScript(buildClaimReleaseScript(expr, 'run-a'));

    expect(fs.existsSync(file)).toBe(false);
  });

  it('still matches after the run appends its exit code', () => {
    // The regression that wedged every workspace: release compared the whole line, and the run script
    // appends its exit code as a fourth field when it finishes, so nothing matched at the exact moment
    // release was called.
    const { expr, file } = claimIn('~/code/repo');
    fs.writeFileSync(file, 'run-a mac 1 0');

    runScript(buildClaimReleaseScript(expr, 'run-a'));

    expect(fs.existsSync(file)).toBe(false);
  });

  it('leaves a claim belonging to another run alone', () => {
    const { expr, file } = claimIn('~/code/repo');
    fs.writeFileSync(file, 'run-other mac 9');

    runScript(buildClaimReleaseScript(expr, 'run-a'));

    expect(fs.readFileSync(file, 'utf8')).toBe('run-other mac 9');
  });

  it('exits 0 when there is no claim at all', () => {
    const { expr } = claimIn('~/code/repo');
    // Release runs in teardown; a non-zero exit here would surface as a spurious failure.
    expect(runScript(buildClaimReleaseScript(expr, 'run-a')).status).toBe(0);
  });

  it('is not fooled by a run id that prefixes the holder', () => {
    const { expr, file } = claimIn('~/code/repo');
    fs.writeFileSync(file, 'run-abc mac 9');

    runScript(buildClaimReleaseScript(expr, 'run-a'));

    expect(fs.readFileSync(file, 'utf8')).toBe('run-abc mac 9');
  });
});

describe('the cancel script, executed', () => {
  /**
   * Starts a real process in its own process group and returns its pid, which is what a run records
   * as `rpid`. `detached` is what makes it a group leader — the same shape sshd gives a remote
   * command, and the reason a negative pid reaches the whole job.
   */
  function groupLeader(): { pid: number; alive: () => boolean } {
    const child = spawn('sh', ['-c', 'sleep 30'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const pid = child.pid ?? -1;
    return {
      pid,
      alive: () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 250));
  }

  it('kills the whole remote process group, not just the recorded pid', async () => {
    // The claim records the remote *shell*, and signalling only that leaves its children running in
    // the workspace — observed with a `sleep` that outlived its shell. `kill -TERM -<pgid>` is what
    // actually ends the job.
    const leader = groupLeader();
    const { expr, file } = claimIn('~/code/repo');
    fs.writeFileSync(file, `r1 ${os.hostname()} 4242 rpid=${String(leader.pid)}`, 'utf8');

    const r = runScript(buildClaimCancelScript(expr, 'r1'));
    expect(r.stdout).toContain('BICA_SIGNALLED');
    expect(r.stdout).toContain('BICA_CLEARED');

    await settle();
    expect(leader.alive()).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('leaves a claim belonging to another run completely alone', async () => {
    // Scoping to the run id is what stops a cancel racing a run that arrived legitimately in between.
    const leader = groupLeader();
    const { expr, file } = claimIn('~/code/repo');
    const contents = `someone-else ${os.hostname()} 4242 rpid=${String(leader.pid)}`;
    fs.writeFileSync(file, contents, 'utf8');

    const r = runScript(buildClaimCancelScript(expr, 'r1'));
    expect(r.stdout).toContain('BICA_NOT_MINE');
    expect(fs.readFileSync(file, 'utf8')).toBe(contents);

    await settle();
    expect(leader.alive()).toBe(true);
    process.kill(-leader.pid, 'SIGKILL');
  });

  it('cancels whatever holds the claim when no run id is given', async () => {
    const leader = groupLeader();
    const { expr, file } = claimIn('~/code/repo');
    fs.writeFileSync(file, `orphan ${os.hostname()} 4242 rpid=${String(leader.pid)}`, 'utf8');

    expect(runScript(buildClaimCancelScript(expr, null)).stdout).toContain('BICA_SIGNALLED');
    await settle();
    expect(leader.alive()).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('clears a claim from a run that never reached the remote', () => {
    // No `rpid` means the client died between taking the lease and the command starting. There is
    // nothing to signal, and the claim still has to go — otherwise cancel cannot unwedge it.
    const { expr, file } = claimIn('~/code/repo');
    fs.writeFileSync(file, `r1 ${os.hostname()} 4242`, 'utf8');

    const r = runScript(buildClaimCancelScript(expr, 'r1'));
    expect(r.stdout).toContain('BICA_NEVER_RAN');
    expect(r.stdout).toContain('BICA_CLEARED');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('says so rather than failing when there is nothing to cancel', () => {
    const { expr } = claimIn('~/code/repo');
    const r = runScript(buildClaimCancelScript(expr, 'r1'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('BICA_NO_CLAIM');
  });

  it('reports a group that has already gone, without inventing a signal', () => {
    // A finished run leaves its `rpid` in the claim. Saying "signalled" there would be a lie, and the
    // caller uses the difference to describe what it did.
    const { expr, file } = claimIn('~/code/repo');
    fs.writeFileSync(file, `r1 ${os.hostname()} 4242 rpid=2147483646 0`, 'utf8');
    const r = runScript(buildClaimCancelScript(expr, 'r1'));
    expect(r.stdout).toContain('BICA_GROUP_GONE');
    expect(r.stdout).toContain('BICA_CLEARED');
  });
});

describe('claim paths', () => {
  it('gives two workspaces distinct claim files', () => {
    expect(claimPathExpr('~/code/repo-1')).not.toBe(
      claimPathExpr('~/code/repo-2'),
    );
  });

  it('resolves the same claim for equivalent spellings of one workspace', () => {
    // Two checkouts pointing at one remote directory must contend, which is the case the lease exists
    // for. A trailing slash must not create a second, non-contending lease.
    expect(claimPathExpr('~/code/repo/')).toBe(claimPathExpr('~/code/repo'));
  });

  it('produces a path with no shell metacharacters left in the filename', () => {
    const expr = claimPathExpr('~/code/we ird$(x)/repo');
    const name = expr.slice(expr.lastIndexOf('/') + 1);
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('survives a workspace path that would otherwise inject shell', () => {
    // Executed, not just pattern-matched: if the sanitiser ever regressed, this would run the
    // injected command instead of creating a file.
    const marker = path.join(dir, 'PWNED');
    const { expr } = claimIn(`~/code/x;touch ${marker};echo `);
    runScript(
      buildClaimAcquireScript(
        expr,
        formatOwner({ runId: 'run-a', host: 'mac', pid: 1 }),
        dir,
      ),
    );
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('owner formatting guards the release comparison', () => {
  it('refuses a run id containing whitespace', () => {
    // `cut -d' ' -f1` would compare against a fragment, so every release would silently no-op.
    expect(() =>
      formatOwner({ runId: 'run a', host: 'mac', pid: 1 }),
    ).toThrow(/whitespace/);
  });

  it('refuses an empty run id', () => {
    expect(() => formatOwner({ runId: '', host: 'mac', pid: 1 })).toThrow();
  });
});

describe('sanity', () => {
  it('runs the shell these tests depend on', () => {
    expect(execFileSync('/bin/sh', ['-c', 'echo ok'], { encoding: 'utf8' }).trim()).toBe('ok');
  });
});
