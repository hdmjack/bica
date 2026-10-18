import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { pushPinnedWorkingTree } from './pinnedSync';
import { describeSpawnFailure, quoteSubprocessOutput } from './subprocessOutput';

/**
 * Output bigger than Node will hold.
 *
 * Node caps a captured stdout at 1 MiB, then kills the child with SIGTERM and sets ENOBUFS. rsync
 * handles the signal and exits 20, so a caller reading only the status reports a transfer failure
 * that never happened -- and quotes a megabyte of ordinary itemised output as the evidence. An
 * llvm-project worktree is 180,677 files, and a mirror whose timestamps differ lists every one of
 * them, so every pinned run there failed before the command started.
 */

const made: string[] = [];

/** A stub `rsync` first on PATH, writing `lines` itemised lines and exiting `code`. */
function stubRsync(lines: number, code: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-stub-bin-'));
  made.push(dir);
  const script = `#!/bin/sh
i=0
while [ $i -lt ${String(lines)} ]; do
  printf '<f..t.... some/quite/long/path/to/a/file/number-%s.cpp\\n' "$i"
  i=$((i + 1))
done
exit ${String(code)}
`;
  fs.writeFileSync(path.join(dir, 'rsync'), script, { mode: 0o755 });
  return dir;
}

function repoWithNoGit(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-pinned-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  while (made.length > 0) {
    fs.rmSync(made.pop() as string, { recursive: true, force: true });
  }
});

describe('pushPinnedWorkingTree with more output than Node holds by default', () => {
  it('succeeds where the default 1 MiB buffer would have killed the transfer', () => {
    // ~25,000 lines of ~55 characters is comfortably past 1 MiB, and well short of what a real
    // llvm-project mirror lists.
    const bin = stubRsync(25_000, 0);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${String(previousPath)}`;
    try {
      const result = pushPinnedWorkingTree({
        repoRoot: repoWithNoGit(),
        remoteSyncUrl: 'mini:~/code/x',
        syncIgnorePaths: [],
        returnFlowPaths: [],
      });
      expect(result.ok).toBe(true);
    } finally {
      process.env.PATH = previousPath;
    }
  });
});

describe('describeSpawnFailure', () => {
  it('names the buffer, not the child, when Node did the killing', () => {
    // The exit status describes the consequence; `error` describes the cause.
    const said = describeSpawnFailure(
      {
        error: Object.assign(new Error('spawnSync maxBuffer exceeded'), {
          code: 'ENOBUFS',
        }),
        status: 20,
        stdout: 'x'.repeat(5_000),
        stderr: '',
      },
      'The pinned sync',
    );
    expect(said).toContain('more output than bica could hold');
    expect(said).toContain('bug in bica');
    expect(said).not.toContain('exited 20');
  });

  it('reports an ordinary non-zero exit with its output', () => {
    expect(
      describeSpawnFailure(
        { error: undefined, status: 23, stdout: '', stderr: 'permission denied' },
        'The pinned sync',
      ),
    ).toBe('The pinned sync exited 23: permission denied');
  });

  it('says plainly when the command could not be run at all', () => {
    expect(
      describeSpawnFailure(
        {
          error: Object.assign(new Error('spawnSync rsync ENOENT'), { code: 'ENOENT' }),
          status: null,
          stdout: '',
          stderr: '',
        },
        'The pinned sync',
      ),
    ).toContain('could not be run');
  });
});

describe('quoteSubprocessOutput', () => {
  it('leaves a short message alone', () => {
    expect(quoteSubprocessOutput('  rsync: link_stat failed\n')).toBe(
      'rsync: link_stat failed',
    );
  });

  it('keeps the tail of a long one, where the explanation is', () => {
    // A failure message carrying 15,000 itemised lines buries the one line that explains it.
    const text = `${'noise\n'.repeat(5_000)}rsync: the actual error`;
    const quoted = quoteSubprocessOutput(text);
    expect(quoted).toContain('rsync: the actual error');
    expect(quoted).toContain('earlier characters omitted');
    expect(quoted.length).toBeLessThan(2_200);
  });
});
