import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const launcher = path.join(__dirname, '..', 'bin', 'bica.cjs');

/**
 * The launcher starts the CLI as a child process and has to stay transparent: its exit status is the
 * CLI's. (Passing signals on to the child is checked against a real run, since it needs a live remote
 * command to be meaningful; see the 0.9.3 changelog entry.)
 */
describe('bin/bica.cjs', () => {
  it('exits with the CLI\'s own status', () => {
    expect(spawnSync(process.execPath, [launcher, '--version'], { encoding: 'utf8' }).status).toBe(0);
    const unknown = spawnSync(process.execPath, [launcher, 'no-such-command'], { encoding: 'utf8' });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('Unknown command');
  });
});
