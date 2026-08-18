import { execFileSync, spawnSync } from 'node:child_process';
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

describe('buildRemoteRunScript — without a run id', () => {
  it('runs the command and preserves its exit code', () => {
    const script = buildRemoteRunScript({ ...BASE, runId: undefined });
    expect(script).toContain("pnpm 'test:run'");
    expect(script).toContain('_bica_ec=$?');
    expect(script).toContain('exit "$_bica_ec"');
  });

  it('writes no marker at all, so the default workspace is untouched', () => {
    const script = buildRemoteRunScript({ ...BASE, runId: undefined });
    expect(script).not.toContain('.bica-run');
  });

  it('fails with a distinct code when the workspace cannot be entered', () => {
    // Otherwise a missing workspace looks like a command failure.
    expect(buildRemoteRunScript({ ...BASE, runId: undefined })).toContain(
      `|| exit ${String(REMOTE_CD_FAILED_EXIT)}`,
    );
  });
});

describe('buildRemoteRunScript — with a run id', () => {
  const script = buildRemoteRunScript({ ...BASE, runId: 'abc123def456-999' });

  it('claims the workspace before running the command', () => {
    expect(script.indexOf("> .bica-run")).toBeLessThan(
      script.indexOf("pnpm 'test:run'"),
    );
  });

  it('re-checks the claim after the command, not before it', () => {
    // The post-command check is the load-bearing half: it catches a concurrent run that replaced this
    // workspace part-way through. A pre-command check would only confirm what the rsync just did.
    const commandAt = script.indexOf("pnpm 'test:run'");
    const checkAt = script.indexOf('!= ');
    expect(checkAt).toBeGreaterThan(commandAt);
  });

  it('captures the exit code before the check, so the check cannot clobber it', () => {
    expect(script.indexOf('_bica_ec=$?')).toBeLessThan(script.indexOf('!= '));
  });

  it('exits 97 on a mismatch rather than returning the command result', () => {
    expect(script).toContain('exit 97');
  });

  it('records the run id alongside the exit code once it finishes', () => {
    // This pairing is what lets a 255 be resolved to a fact: the id proves the record is ours.
    expect(script).toMatch(/printf '%s %s' '[^']+' "\$_bica_ec" > \.bica-run/);
  });

  it('still exits with the command exit code on the success path', () => {
    expect(script.trimEnd().endsWith('exit "$_bica_ec"')).toBe(true);
  });

  it('quotes the run id so a real shell treats it as data, not code', () => {
    // Asserted by execution rather than by pattern. A first attempt used a regex and failed on
    // correctly-escaped output — the only trustworthy check of shell quoting is to let a shell parse it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-quote-'));
    try {
      const nastyId = "abc'; touch pwned; echo '";
      const script = buildRemoteRunScript({
        preamble: '',
        cdExpr: `cd ${JSON.stringify(dir)}`,
        command: 'true',
        runId: nastyId,
      });
      execFileSync('sh', ['-c', script], { cwd: dir });

      // The injected command must not have run, and the id must have landed verbatim.
      expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
      expect(fs.readFileSync(path.join(dir, '.bica-run'), 'utf8')).toBe(
        `${nastyId} 0`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the preamble first, so tooling is on PATH before anything runs', () => {
    expect(script.startsWith(BASE.preamble)).toBe(true);
  });
});

describe('the workspace holds its own claim, across checkouts', () => {
  // The local lane lock is per-checkout, but the contended resource is a remote directory that
  // several clones can resolve to. These tests run the generated script with a real shell, because
  // the claim is shell logic and the only trustworthy check of shell logic is to execute it.
  function runIn(dir: string, runId: string, command = 'true'): number {
    const script = buildRemoteRunScript({
      preamble: '',
      cdExpr: `cd ${JSON.stringify(dir)}`,
      command,
      runId,
    });
    const r = spawnSync('sh', ['-c', script], { cwd: dir, encoding: 'utf8' });
    return r.status ?? -1;
  }

  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-claim-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('claims a free workspace', () => {
    expect(runIn(dir, 'run-a')).toBe(0);
    expect(fs.readFileSync(path.join(dir, '.bica-run'), 'utf8')).toBe('run-a 0');
  });

  it('refuses a workspace another run is still using', () => {
    // A single-field marker means a run in progress. This is the cross-checkout case: nothing local
    // could have told this run that another clone was already here.
    fs.writeFileSync(path.join(dir, '.bica-run'), 'other-run-in-progress', 'utf8');
    expect(runIn(dir, 'run-b')).toBe(97);
  });

  it('does not run the command when it refuses', () => {
    // The whole point: a run that did not execute its own command must not report a verdict.
    fs.writeFileSync(path.join(dir, '.bica-run'), 'other-run-in-progress', 'utf8');
    runIn(dir, 'run-b', `touch ${JSON.stringify(path.join(dir, 'ran'))}`);
    expect(fs.existsSync(path.join(dir, 'ran'))).toBe(false);
  });

  it('takes over a workspace whose previous run finished', () => {
    // Two fields is a completed run's record, not a live claim; refusing it would wedge the lane.
    fs.writeFileSync(path.join(dir, '.bica-run'), 'earlier-run 0', 'utf8');
    expect(runIn(dir, 'run-c')).toBe(0);
  });

  it('is re-entrant for the same run id', () => {
    // The install step and the user command are separate ssh invocations of the same run.
    fs.writeFileSync(path.join(dir, '.bica-run'), 'run-d', 'utf8');
    expect(runIn(dir, 'run-d')).toBe(0);
  });

  it('still surfaces the command exit code once it holds the claim', () => {
    expect(runIn(dir, 'run-e', 'exit 3')).toBe(3);
  });
});
