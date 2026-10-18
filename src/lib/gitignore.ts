import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Keeping one person's settings out of everyone's repository.
 *
 * `.bica/local.yml` holds an ssh host and a remote path, and `.bica/project.yml` an absolute
 * local path. Both are per person, and both were only ever ignored because the repository bica
 * grew up in happened to carry the rule already.
 */

/** The file whose fate the question is really about. */
const WITNESS = '.bica/local.yml';

/** A literal rule for `.bica/`, in the spellings a person writes it. */
function lineCoversBica(line: string): boolean {
  return line === '.bica' || line === '.bica/' || line === '/.bica/';
}

/**
 * Whether `.bica/` is ignored, as git itself would answer.
 *
 * Reading `.gitignore` is the wrong question in the repositories that need this most. git ignores a
 * path through any `.gitignore` at any level, through `.git/info/exclude`, and through
 * `core.excludesFile` -- and a clone of somebody else's project, llvm-project being the case this
 * was reported from, is exactly where a person puts their own rules in `info/exclude` rather than
 * editing a tracked file they do not own. bica then warned that their settings could be committed
 * when git had already been told otherwise, and advised them to edit that tracked file.
 *
 * `git check-ignore -q` is git's own answer: 0 ignored, 1 not ignored, anything else an error such
 * as "not a repository", which falls back to the literal scan rather than guessing.
 */
export function bicaIsGitignored(repoRoot: string): boolean {
  const asked = spawnSync('git', ['check-ignore', '-q', '--', WITNESS], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: false,
  });
  if (asked.error === undefined && (asked.status === 0 || asked.status === 1)) {
    return asked.status === 0;
  }
  // No git to ask, or nowhere to ask it. The literal rule is all that is left.
  try {
    return fs
      .readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .some(lineCoversBica);
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
 * Appended rather than rewritten, and only when nothing already covers it -- which includes a rule
 * in `.git/info/exclude`. Someone working in a clone of a project they do not own puts their rules
 * there precisely so the tracked `.gitignore` stays untouched, and `bica init` editing it anyway
 * would undo that choice on their behalf.
 */
export function ensureBicaIsGitignored(repoRoot: string): 'added' | 'present' | 'failed' {
  const gitignore = path.join(repoRoot, '.gitignore');
  try {
    if (bicaIsGitignored(repoRoot)) {
      return 'present';
    }
    let existing = '';
    try {
      existing = fs.readFileSync(gitignore, 'utf8');
    } catch {
      // No .gitignore yet; one with this single rule is still the right outcome.
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
