import { shellSingleQuote } from './shellQuote';

/**
 * Builds a POSIX `sh`-safe command string from argv (no shell interpolation).
 */
export function argvToPosixShCommand(argv: string[]): string {
  return argv.map(shellSingleQuote).join(' ');
}
