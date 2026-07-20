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

/** **Remote** sync target shown as `host:path` in prompts (e.g. `mini:~/code/repo`). */
export function syncRemoteTarget(text: string): string {
  return chalk.cyan(text);
}

/**
 * One-line remote-command result, printed unconditionally after `bica run` so a silent-success
 * command (e.g. `tsgo --build`) is unambiguous in captured output. Dim on success, warn otherwise.
 */
export function remoteExitStatusLine(code: number): string {
  const msg = `[bica] remote command exited ${code}`;
  return code === 0 ? dim(msg) : warn(msg);
}
