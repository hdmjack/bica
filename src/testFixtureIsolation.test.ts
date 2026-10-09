import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A guard on the tests themselves, rather than on bica.
 *
 * Much of this suite works by putting real files in a temp directory and pointing something at them.
 * A fixture path built by *naming* a directory under the system temp — rather than by asking for a
 * fresh one — is shared by every process that runs the suite, and several of these tests empty their
 * directory before each case. Two copies of the suite at once therefore delete each other's fixtures
 * mid-test, and the failures appear in whichever file lost the race, describing a fault in the code
 * under test that does not exist. That cost an afternoon's confusion once; this makes it a named
 * failure on the line responsible.
 *
 * `fs.mkdtempSync` is the fix in every case: it asks the operating system for a name nobody else has.
 */

const TEST_DIR = import.meta.dirname;

function testFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return testFiles(full);
      }
      // Not itself: the matcher below necessarily contains the pattern it looks for.
      if (entry.name === path.basename(import.meta.filename)) {
        return [];
      }
      return entry.isFile() && entry.name.endsWith('.test.ts') ? [full] : [];
    });
}

/**
 * Lines that build a path under the system temp directory without asking for a fresh one.
 *
 * Deliberately crude: it looks for `os.tmpdir()` reached by any means other than `mkdtemp`, on the
 * same line. A fixture assembled across several lines escapes it, which is accepted — the point is to
 * catch the shape that has actually gone wrong, not to be a type system.
 */
function fixedTempPaths(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line, i) => ({ line: line.trim(), number: i + 1 }))
    .filter(
      ({ line }) =>
        line.includes('tmpdir()') &&
        !line.includes('mkdtemp') &&
        !line.startsWith('//') &&
        !line.startsWith('*'),
    )
    .map(({ line, number }) => `${path.basename(file)}:${String(number)}: ${line}`);
}

describe('test fixtures are private to the process that made them', () => {
  it('finds the test files it is meant to be checking', () => {
    // A guard that silently checks nothing is worse than no guard.
    const files = testFiles(TEST_DIR);
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith('tunnelState.test.ts'))).toBe(true);
  });

  it('builds every temp fixture path with mkdtemp, never by naming one', () => {
    const offenders = testFiles(TEST_DIR).flatMap(fixedTempPaths);
    expect(
      offenders,
      `These lines name a directory under the system temp instead of asking for a fresh one, so two\n` +
        `copies of this suite running at once share it:\n  ${offenders.join('\n  ')}\n\n` +
        `Use fs.mkdtempSync(path.join(os.tmpdir(), 'bica-<what>-')) instead.`,
    ).toEqual([]);
  });
});
