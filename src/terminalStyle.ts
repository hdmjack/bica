import chalk from 'chalk';

/**
 * CLI styling via [chalk](https://github.com/chalk/chalk) — respects NO_COLOR, FORCE_COLOR, and TTY.
 * Thin named exports keep call sites (`heading`, `ok`, …) stable across the bica package.
 */

/** Section title (bold + cyan). */
export function heading(text: string): string {
  return chalk.bold.cyan(text);
}

/** Success / confirmation line. */
export function ok(text: string): string {
  return chalk.green(text);
}

/** Secondary / hint text. */
export function dim(text: string): string {
  return chalk.dim(text);
}

/** Emphasis without changing hue. */
export function bold(text: string): string {
  return chalk.bold(text);
}

/** Attention (e.g. already exists, skipped). */
export function warn(text: string): string {
  return chalk.yellow(text);
}

/** Mutagen sync target shown as `host:path` in prompts (e.g. `mini:~/code/repo`). */
export function syncRemoteTarget(text: string): string {
  return chalk.cyan(text);
}
