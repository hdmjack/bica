/**
 * Wraps a string for safe use inside a POSIX `sh` single-quoted string.
 */
export function shellSingleQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
