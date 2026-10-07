import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Keeping one person's settings out of everyone's repository.
 *
 * `.bica/local.yml` holds an ssh host and a remote path, and `.bica/project.yml` an absolute
 * local path. Both are per person, and both were only ever ignored because the repository bica
 * grew up in happened to carry the rule already.
 */

/** Whether a repository already ignores `.bica/`, without changing anything. */
export function bicaIsGitignored(repoRoot: string): boolean {
  try {
    return fs
      .readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .some((line) => line === '.bica' || line === '.bica/' || line === '/.bica/');
  } catch {
    return false;
  }
}

/**
 * Make sure `.bica/` is ignored by the repository it was just written into.
 *
 * `.bica/local.yml` holds one person's ssh host and remote path, and `.bica/project.yml` holds their
 * absolute local path. Both are described everywhere as gitignored, which was true only because the
 * one repository bica grew up in happened to have the line already. In any other repository the
 * first `bica init` left them to be committed, and the next person to clone would inherit somebody
 * else's machine.
 *
 * Appended rather than rewritten, and only when no existing rule already covers it.
 */
export function ensureBicaIsGitignored(repoRoot: string): 'added' | 'present' | 'failed' {
  const gitignore = path.join(repoRoot, '.gitignore');
  try {
    let existing = '';
    try {
      existing = fs.readFileSync(gitignore, 'utf8');
    } catch {
      // No .gitignore yet; one with this single rule is still the right outcome.
    }
    const covered = existing
      .split('\n')
      .map((line) => line.trim())
      .some((line) => line === '.bica' || line === '.bica/' || line === '/.bica/');
    if (covered) {
      return 'present';
    }
    const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(
      gitignore,
      `${separator}\n# bica: your ssh host, remote path and generated sync project file\n.bica/\n`,
    );
    return 'added';
  } catch {
    return 'failed';
  }
}
