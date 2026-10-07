import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * bica's own version, read from the package it ships in.
 *
 * Worth having because bica keeps state on the remote that several people and several versions can
 * reach — the workspace lease, the install record — so "which bica is this?" is a question with
 * consequences.
 */
export function ownVersion(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.join(dir, '..', '..', 'package.json'),
    path.join(dir, '..', 'package.json'),
  ]) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'version' in parsed &&
        typeof (parsed as { version?: unknown }).version === 'string'
      ) {
        return (parsed as { version: string }).version;
      }
    } catch {
      // Try the next location; a version we cannot read is worth saying so about, not failing over.
    }
  }
  return 'unknown';
}
