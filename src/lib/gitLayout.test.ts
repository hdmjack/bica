import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { dotGitIsAFile, resolveGitLayout, WORKTREE_PRIVATE_ENTRIES } from './gitLayout';

const made: string[] = [];

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync(
    'git',
    ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args],
    { cwd, encoding: 'utf8' },
  );
  if ((r.status ?? 1) !== 0) {
    throw new Error(`git ${args.join(' ')}: ${r.stderr ?? ''}`);
  }
}

/** A clone and a worktree of it, which is the shape the whole module exists for. */
function repoWithWorktree(): { clone: string; worktree: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-gitlayout-'));
  made.push(root);
  const clone = path.join(root, 'clone');
  const worktree = path.join(root, 'wt');
  fs.mkdirSync(clone);
  git(clone, 'init', '-q', '-b', 'main', '.');
  fs.writeFileSync(path.join(clone, 'a.txt'), 'one\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'first');
  git(clone, 'worktree', 'add', '-q', '-b', 'side', worktree);
  return { clone, worktree };
}

describe('where a checkout keeps its git data', () => {
  afterEach(() => {
    for (const dir of made.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('calls an ordinary clone plain, with .git as its git dir', () => {
    const { clone } = repoWithWorktree();
    const layout = resolveGitLayout(clone);
    expect(layout.kind).toBe('plain');
    expect(dotGitIsAFile(clone)).toBe(false);
  });

  it('splits a worktree into its own state and the shared repository', () => {
    const { clone, worktree } = repoWithWorktree();
    const layout = resolveGitLayout(worktree);
    if (layout.kind !== 'worktree') {
      throw new Error(`expected a worktree, got ${layout.kind}`);
    }
    // The two answers git itself uses: per-worktree state, and everything shared.
    expect(layout.gitDir).toContain(path.join('.git', 'worktrees'));
    expect(fs.realpathSync(layout.commonDir)).toBe(
      fs.realpathSync(path.join(clone, '.git')),
    );
    // And `.git` here is the one-line file whose absolute path means nothing on another machine.
    expect(dotGitIsAFile(worktree)).toBe(true);
    expect(fs.readFileSync(path.join(worktree, '.git'), 'utf8')).toContain('gitdir:');
  });

  it('reports no git data outside a repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-nogit-'));
    made.push(dir);
    expect(resolveGitLayout(dir).kind).toBe('none');
  });

  it('keeps the worktree files that name local paths out of what gets copied', () => {
    // `commondir` and `gitdir` point into the main clone, which the remote does not have.
    expect(WORKTREE_PRIVATE_ENTRIES).toContain('commondir');
    expect(WORKTREE_PRIVATE_ENTRIES).toContain('gitdir');
    expect(WORKTREE_PRIVATE_ENTRIES).toContain('worktrees');
  });

  it('asks git rather than guessing from the filesystem', () => {
    const calls: string[][] = [];
    resolveGitLayout('/anywhere', (_root, args) => {
      calls.push(args);
      return { ok: true, stdout: '/x/.git' };
    });
    expect(calls[0]).toEqual(['rev-parse', '--absolute-git-dir']);
    expect(calls[1]).toEqual(['rev-parse', '--git-common-dir']);
  });
});
