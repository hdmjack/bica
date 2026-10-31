#!/usr/bin/env node
/* eslint-disable no-undef -- CommonJS bin: Node provides require, __dirname, process, console. */
'use strict';

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const pkgRoot = path.join(__dirname, '..');
const cliTs = path.join(pkgRoot, 'src', 'cli.ts');
const tsxCli = require.resolve('tsx/cli', { paths: [pkgRoot] });

const forwardedArgv = process.argv.slice(2);
const tsxArgv = [tsxCli, cliTs, ...forwardedArgv];

// Not spawnSync: that blocks the event loop, so a signal sent to this process is never seen, and the
// default action ends the launcher while the CLI it started carries on. A run told to stop by SIGTERM
// -- `timeout 900 bica run ...`, an agent's tool cleanup, `kill` -- then ended nothing: the remote
// command kept going and the workspace stayed leased. The signals a caller sends to "bica" are passed
// to the CLI, which has handlers that end the remote command and release the lease.
const child = spawn(process.execPath, tsxArgv, {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal !== null) {
    // The CLI died of a signal: report it the way a shell does.
    process.exit(128 + (os.constants.signals[signal] ?? 0));
  }
  process.exit(code === null ? 1 : code);
});
