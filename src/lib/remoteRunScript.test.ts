import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRemoteRunScript, REMOTE_CD_FAILED_EXIT } from './runRemote';

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
