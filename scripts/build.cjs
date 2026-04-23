#!/usr/bin/env node
/* eslint-disable no-undef -- Node CJS: typecheck only (no link, no watch) */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const pkgRoot = path.join(__dirname, '..');

process.stderr.write('[bica build] Typechecking…\n');
const result = spawnSync(
  'pnpm',
  ['exec', 'tsc', '--noEmit', '-p', 'tsconfig.json'],
  {
    cwd: pkgRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

const code = result.status === null ? 1 : result.status;
if (code !== 0) {
  process.exit(code);
}

process.stderr.write('[bica build] OK.\n');
