import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resolveRunContent,
  shortOid,
  treeOidForCommittish,
  workingTreeOid,
} from './contentIdentity';

let repoRoot = '';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  repoRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bica-content-')),
  );
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'ignored/\n*.log\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'tracked.ts'), 'export const a = 1;\n', 'utf8');
  git('add', '-A');
  git('commit', '-qm', 'init');
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('workingTreeOid', () => {
  it('names a clean tree, matching the commit it was made from', () => {
    expect(workingTreeOid(repoRoot)).toBe(
      treeOidForCommittish(repoRoot, 'HEAD'),
    );
  });

  it('is stable across repeated calls', () => {
    expect(workingTreeOid(repoRoot)).toBe(
      workingTreeOid(repoRoot),
    );
  });

  it('changes when a tracked file is modified but not committed', () => {
    // The whole point: uncommitted work gets a name, so a run can say what it verified.
    const before = workingTreeOid(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'tracked.ts'), 'export const a = 2;\n', 'utf8');
    expect(workingTreeOid(repoRoot)).not.toBe(before);
  });

  it('includes untracked files that are not ignored', () => {
    const before = workingTreeOid(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'new.ts'), 'export const b = 1;\n', 'utf8');
    expect(workingTreeOid(repoRoot)).not.toBe(before);
  });

  it('ignores gitignored files — the documented limit of this name', () => {
    // rsync still ships these, so the OID is a strong claim about tracked content and not a total
    // claim about the bytes on the remote. Asserted so the limit stays deliberate.
    const before = workingTreeOid(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'ignored'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'ignored', 'x.ts'), 'nope\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'debug.log'), 'nope\n', 'utf8');
    expect(workingTreeOid(repoRoot)).toBe(before);
  });

  it('leaves the real index completely untouched', () => {
    // This has to be safe to run while the user is staging a commit in another terminal.
    fs.writeFileSync(path.join(repoRoot, 'staged.ts'), 'export const c = 1;\n', 'utf8');
    git('add', 'staged.ts');
    const stagedBefore = git('diff', '--cached', '--name-only');
    const statusBefore = git('status', '--porcelain');

    workingTreeOid(repoRoot);

    expect(git('diff', '--cached', '--name-only')).toBe(stagedBefore);
    expect(git('status', '--porcelain')).toBe(statusBefore);
  });

  it('keeps its throwaway index out of the repository entirely', () => {
    // If the index lives inside the tree, `git add -A` walks it and the content name ends up naming
    // bica's own scratch file — which varied by pid, so an unchanged tree got a different name each run.
    const before = git('status', '--porcelain', '--ignored');
    workingTreeOid(repoRoot);
    expect(git('status', '--porcelain', '--ignored')).toBe(before);
    expect(fs.existsSync(path.join(repoRoot, '.bica'))).toBe(false);
  });

  it('returns null outside a git repository, rather than inventing a name', () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-nogit-'));
    try {
      expect(workingTreeOid(notARepo)).toBeNull();
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe('treeOidForCommittish', () => {
  it('resolves a branch to its tree', () => {
    const head = git('rev-parse', 'HEAD');
    expect(treeOidForCommittish(repoRoot, head)).toBe(
      git('rev-parse', 'HEAD^{tree}'),
    );
  });

  it('returns null for something that is not a commit', () => {
    expect(treeOidForCommittish(repoRoot, 'no-such-ref')).toBeNull();
  });
});

describe('resolveRunContent', () => {
  it('names a ref by its committed tree', () => {
    const content = resolveRunContent({ repoRoot, ref: 'HEAD' });
    expect(content?.source).toBe('ref');
    expect(content?.label).toBe('HEAD');
    expect(content?.treeOid).toBe(git('rev-parse', 'HEAD^{tree}'));
  });

  it('names the working tree when no ref is given', () => {
    fs.writeFileSync(path.join(repoRoot, 'tracked.ts'), 'export const a = 9;\n', 'utf8');
    const content = resolveRunContent({ repoRoot, ref: undefined });
    expect(content?.source).toBe('working-tree');
    // Differs from HEAD precisely because the uncommitted edit is part of what would be verified.
    expect(content?.treeOid).not.toBe(git('rev-parse', 'HEAD^{tree}'));
  });

  it('returns null for an unresolvable ref', () => {
    expect(
      resolveRunContent({ repoRoot, ref: 'no-such-ref' }),
    ).toBeNull();
  });
});

describe('shortOid', () => {
  it('trims to a readable prefix', () => {
    expect(shortOid('0123456789abcdef0123456789abcdef01234567')).toBe(
      '0123456789ab',
    );
  });
});
