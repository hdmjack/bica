import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { bicaIsGitignored, ensureBicaIsGitignored } from './gitignore';

/**
 * "Is `.bica/` ignored" is a question only git can answer.
 *
 * Reading `.gitignore` gets it wrong exactly where it matters most. A clone of somebody else's
 * project -- llvm-project, in the report this came from -- is where a person puts their own rules in
 * `.git/info/exclude` rather than editing a tracked file they do not own. bica warned that their ssh
 * host could be committed when git had already been told otherwise, and advised them to edit that
 * tracked file.
 */

const made: string[] = [];

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-gitignore-'));
  made.push(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

afterEach(() => {
  while (made.length > 0) {
    fs.rmSync(made.pop() as string, { recursive: true, force: true });
  }
});

describe('bicaIsGitignored', () => {
  it('sees a rule in .git/info/exclude', () => {
    const repo = tempRepo();
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.bica/\n');
    expect(bicaIsGitignored(repo)).toBe(true);
  });

  it('sees a rule in .gitignore', () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, '.gitignore'), '.bica/\n');
    expect(bicaIsGitignored(repo)).toBe(true);
  });

  it('warns when nothing ignores it', () => {
    expect(bicaIsGitignored(tempRepo())).toBe(false);
  });

  it('does not mistake a longer rule for this one', () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, '.gitignore'), '.bicanonsense/\n');
    expect(bicaIsGitignored(repo)).toBe(false);
  });

  it('falls back to the literal rule where there is no repository', () => {
    // `git check-ignore` fails outside a repo; that is not evidence either way, so the old scan
    // still gets its say rather than the answer defaulting to "exposed".
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'bica-norepo-'));
    made.push(bare);
    fs.writeFileSync(path.join(bare, '.gitignore'), '.bica/\n');
    expect(bicaIsGitignored(bare)).toBe(true);
  });
});

describe('ensureBicaIsGitignored', () => {
  it('leaves a tracked .gitignore alone when info/exclude already covers it', () => {
    // The whole point of putting the rule there is to not touch a file you do not own.
    const repo = tempRepo();
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.bica/\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'build/\n');
    expect(ensureBicaIsGitignored(repo)).toBe('present');
    expect(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')).toBe('build/\n');
  });

  it('adds the rule when nothing covers it', () => {
    const repo = tempRepo();
    expect(ensureBicaIsGitignored(repo)).toBe('added');
    expect(bicaIsGitignored(repo)).toBe(true);
  });
});
