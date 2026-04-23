#!/usr/bin/env node
/* eslint-disable no-undef -- Node CJS maintainer dev: typecheck, link, tsx watch */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const pkgRoot = path.join(__dirname, '..');
const cliTs = path.join(pkgRoot, 'src', 'cli.ts');

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: pkgRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  const code = result.status === null ? 1 : result.status;
  if (code !== 0) {
    process.exit(code);
  }
}

process.stderr.write('[bica dev] Typechecking…\n');
run('pnpm', ['exec', 'tsc', '--noEmit', '-p', 'tsconfig.json']);

process.stderr.write('[bica dev] Linking globally (pnpm link --global)…\n');
run('pnpm', ['link', '--global']);

const binDirResult = spawnSync('pnpm', ['bin', '-g'], {
  cwd: pkgRoot,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
let globalBinDir =
  typeof binDirResult.stdout === 'string' ? binDirResult.stdout.trim() : '';
if (globalBinDir === '' || globalBinDir === 'undefined') {
  globalBinDir = '';
}

process.stderr.write(
  '\n[bica dev] Global `bica` is linked. If the command is not found, add pnpm’s bin dir to PATH:\n',
);
if (globalBinDir !== '') {
  process.stderr.write(
    `  export PATH="${globalBinDir}:$PATH"\n  # zsh/bash; adjust for your shell\n\n`,
  );
}

const initCwd = process.env.INIT_CWD || process.cwd();
const forwarded = process.argv.slice(2);
// Default reload for tsx watch: no-op (see cli.ts `watch-idle`). Use `pnpm dev -- help` for help.
const cliArgs = forwarded.length > 0 ? forwarded : ['watch-idle'];

const tsxCli = require.resolve('tsx/cli', { paths: [pkgRoot] });

process.stderr.write(
  '[bica dev] Starting tsx watch (save sources to re-run the CLI; Ctrl+C to exit)…\n',
);

const watchResult = spawnSync(
  process.execPath,
  [tsxCli, 'watch', '--clear-screen=false', '--no-cache', cliTs, ...cliArgs],
  {
    stdio: 'inherit',
    cwd: initCwd,
    env: process.env,
  },
);

if (watchResult.error) {
  console.error(watchResult.error);
  process.exit(1);
}

process.exit(watchResult.status === null ? 1 : watchResult.status);
