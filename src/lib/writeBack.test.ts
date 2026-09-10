import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { workingTreeOid } from './contentIdentity';
import {
  buildPruneTerms,
  buildWriteBackProbeScript,
  buildWriteBackPullArgs,
  collectWriteBack,
  describePaths,
  dropIgnoredPaths,
  parseChangedPaths,
  parseLsTreeZ,
  partitionByLocalEdits,
  validateProbePattern,
  writeBackMarkerPath,
} from './writeBack';

let repoRoot = '';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function write(rel: string, contents: string): void {
  const abs = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, 'utf8');
}

beforeEach(() => {
  repoRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bica-write-back-')),
  );
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  write('.gitignore', 'node_modules/\ndist/\n*.log\n');
  write('src/a.ts', 'export const a = 1;\n');
  write('src/b.ts', 'export const b = 2;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('validateProbePattern', () => {
  it('normalises a usable pattern', () => {
    expect(validateProbePattern('  dist/  ')).toBe('dist');
    expect(validateProbePattern('./build/generated')).toBe('build/generated');
  });

  it('drops negations, which re-include in the forward sync and say nothing here', () => {
    expect(validateProbePattern('!keep.ts')).toBeNull();
  });

  it('refuses anything that could end the quoted find argument it lands in', () => {
    for (const bad of ["a'b", 'a b', 'a$b', 'a;rm -rf /', 'a`b`', 'a|b']) {
      expect(validateProbePattern(bad)).toBeNull();
    }
  });
});

describe('buildPruneTerms', () => {
  it('always prunes .git and .bica, whatever the config says', () => {
    expect(buildPruneTerms([])).toEqual(["-name '.git'", "-name '.bica'"]);
  });

  it('matches a bare name at any depth and a slashed pattern from the root', () => {
    expect(buildPruneTerms(['node_modules', 'apps/web/dist'])).toEqual([
      "-name '.git'",
      "-name '.bica'",
      "-name 'node_modules'",
      "-path './apps/web/dist'",
    ]);
  });

  it('emits each tree once even when several sources name it', () => {
    expect(buildPruneTerms(['dist', 'dist/', './dist'])).toEqual([
      "-name '.git'",
      "-name '.bica'",
      "-name 'dist'",
    ]);
  });
});

describe('buildWriteBackProbeScript', () => {
  it('prunes before testing, and removes the marker on the way out', () => {
    const script = buildWriteBackProbeScript({
      remoteWorkspacePath: '~/work/repo',
      markerPath: '/tmp/bica-write-back-42',
      ignorePaths: ['node_modules'],
    });
    expect(script).toContain('cd "$HOME/work/repo"');
    expect(script).toContain(
      "find . \\( -name '.git' -o -name '.bica' -o -name 'node_modules' \\) -prune -o -type f -newer '/tmp/bica-write-back-42' -print",
    );
    expect(script).toContain("rm -f '/tmp/bica-write-back-42'");
  });

  it('reports nothing when the marker is gone, rather than every file in the tree', () => {
    const script = buildWriteBackProbeScript({
      remoteWorkspacePath: '/w',
      markerPath: '/tmp/m',
      ignorePaths: [],
    });
    expect(script).toContain("[ -e '/tmp/m' ] || exit 0");
  });
});

describe('parseChangedPaths', () => {
  it('strips find\u2019s leading ./ and drops blank lines', () => {
    expect(parseChangedPaths('./src/a.ts\n\n./src/b.ts\n')).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });
});

describe('dropIgnoredPaths', () => {
  it('keeps tracked files and drops the ones git ignores', () => {
    expect(
      dropIgnoredPaths(repoRoot, [
        'src/a.ts',
        'node_modules/x/index.js',
        'dist/out.js',
        'debug.log',
        'src/new.ts',
      ]),
    ).toEqual(['src/a.ts', 'src/new.ts']);
  });

  it('is a no-op on an empty list, without shelling out', () => {
    expect(dropIgnoredPaths(repoRoot, [])).toEqual([]);
  });
});

describe('parseLsTreeZ', () => {
  it('reads NUL-separated records and ignores non-blob entries', () => {
    const stdout =
      '100644 blob aaa\tsrc/a.ts\0' +
      '160000 commit ccc\tvendor/sub\0' +
      '100644 blob bbb\tsrc/with space.ts\0';
    expect(parseLsTreeZ(stdout)).toEqual(
      new Map([
        ['src/a.ts', 'aaa'],
        ['src/with space.ts', 'bbb'],
      ]),
    );
  });
});

describe('partitionByLocalEdits', () => {
  it('treats a file still exactly as bica shipped it as safe to overwrite', () => {
    const treeOid = workingTreeOid(repoRoot) ?? undefined;
    expect(
      partitionByLocalEdits({ repoRoot, treeOid, paths: ['src/a.ts'] }),
    ).toEqual({ safe: ['src/a.ts'], conflicted: [] });
  });

  it('refuses a file edited locally while the run was out', () => {
    const treeOid = workingTreeOid(repoRoot) ?? undefined;
    write('src/a.ts', 'export const a = 999; // typed during the run\n');
    expect(
      partitionByLocalEdits({
        repoRoot,
        treeOid,
        paths: ['src/a.ts', 'src/b.ts'],
      }),
    ).toEqual({ safe: ['src/b.ts'], conflicted: ['src/a.ts'] });
  });

  it('treats a file the run created as safe when nothing of that name exists locally', () => {
    const treeOid = workingTreeOid(repoRoot) ?? undefined;
    expect(
      partitionByLocalEdits({ repoRoot, treeOid, paths: ['src/created.ts'] }),
    ).toEqual({ safe: ['src/created.ts'], conflicted: [] });
  });

  it('refuses a file the run created that the user also created locally', () => {
    const treeOid = workingTreeOid(repoRoot) ?? undefined;
    write('src/created.ts', 'mine\n');
    expect(
      partitionByLocalEdits({ repoRoot, treeOid, paths: ['src/created.ts'] }),
    ).toEqual({ safe: [], conflicted: ['src/created.ts'] });
  });

  it('refuses everything when there is no baseline to compare against', () => {
    expect(
      partitionByLocalEdits({
        repoRoot,
        treeOid: undefined,
        paths: ['src/a.ts'],
      }),
    ).toEqual({ safe: [], conflicted: ['src/a.ts'] });
  });

  it('refuses everything when the named tree is not one git can read', () => {
    expect(
      partitionByLocalEdits({
        repoRoot,
        treeOid: '0'.repeat(40),
        paths: ['src/a.ts'],
      }),
    ).toEqual({ safe: [], conflicted: ['src/a.ts'] });
  });
});

describe('buildWriteBackPullArgs', () => {
  it('enumerates the transfer instead of matching it, and never deletes', () => {
    const args = buildWriteBackPullArgs({
      remoteSyncUrl: 'host:/home/me/work',
      repoRoot: '/Users/me/repo',
    });
    expect(args).toEqual([
      '-a',
      '--files-from=-',
      '--from0',
      'host:/home/me/work/',
      '/Users/me/repo/',
    ]);
    expect(args).not.toContain('--delete');
  });
});

describe('collectWriteBack', () => {
  const remote = {
    sshHost: 'h',
    remoteWorkspacePath: '/w',
    remoteSyncUrl: 'h:/w',
    markerPath: '/tmp/m',
    ignorePaths: ['node_modules'],
  };

  it('reports what the run wrote without touching the local tree when pull is off', () => {
    const outcome = collectWriteBack({
      ...remote,
      repoRoot,
      pushedTreeOid: workingTreeOid(repoRoot) ?? undefined,
      pull: false,
      run: () => ({
        status: 0,
        stdout: './src/a.ts\n./node_modules/x.js\n./dist/o.js\n',
        stderr: '',
      }),
    });
    expect(outcome).toEqual({
      changed: ['src/a.ts'],
      pulled: [],
      conflicted: [],
    });
    expect(fs.readFileSync(path.join(repoRoot, 'src/a.ts'), 'utf8')).toBe(
      'export const a = 1;\n',
    );
  });

  it('reports nothing when the probe could not run, rather than guessing', () => {
    expect(
      collectWriteBack({
        ...remote,
        repoRoot,
        pushedTreeOid: undefined,
        pull: true,
        run: () => ({ status: 255, stdout: '', stderr: 'ssh: no route' }),
      }),
    ).toEqual({ changed: [], pulled: [], conflicted: [] });
  });

  it('skips the transfer entirely when every changed file was edited locally', () => {
    const treeOid = workingTreeOid(repoRoot) ?? undefined;
    write('src/a.ts', 'edited while the run was out\n');
    const outcome = collectWriteBack({
      ...remote,
      repoRoot,
      pushedTreeOid: treeOid,
      pull: true,
      run: () => ({ status: 0, stdout: './src/a.ts\n', stderr: '' }),
    });
    expect(outcome).toEqual({
      changed: ['src/a.ts'],
      pulled: [],
      conflicted: ['src/a.ts'],
    });
    expect(fs.readFileSync(path.join(repoRoot, 'src/a.ts'), 'utf8')).toBe(
      'edited while the run was out\n',
    );
  });
});

describe('describePaths', () => {
  it('caps the list so a thousand-file codemod does not fill the terminal', () => {
    const many = Array.from({ length: 25 }, (_, i) => `src/f${String(i)}.ts`);
    const text = describePaths(many);
    expect(text.split('\n')).toHaveLength(11);
    expect(text).toContain('…and 15 more');
  });
});

describe('writeBackMarkerPath', () => {
  it('lives outside the workspace, so it is neither its own probe hit nor push fodder', () => {
    expect(writeBackMarkerPath('4213')).toBe('/tmp/bica-write-back-4213');
  });

  it('strips anything from the run id that is not path-safe', () => {
    expect(writeBackMarkerPath('42; rm -rf /')).toBe('/tmp/bica-write-back-42rm-rf');
  });
});
