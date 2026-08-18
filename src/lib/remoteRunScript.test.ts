import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

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
