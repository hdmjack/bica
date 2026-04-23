#!/usr/bin/env node
/* eslint-disable no-undef -- CommonJS bin: Node provides require, __dirname, process, console. */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const pkgRoot = path.join(__dirname, '..');
const cliTs = path.join(pkgRoot, 'src', 'cli.ts');
const tsxCli = require.resolve('tsx/cli', { paths: [pkgRoot] });

const forwardedArgv = process.argv.slice(2);
const tsxArgv = [tsxCli, cliTs, ...forwardedArgv];

const result = spawnSync(process.execPath, tsxArgv, {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
