#!/usr/bin/env node
// Launch via Node so host.env and the configured Node binary use the normal host contract.
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {loadHostConfig} from './scripts/install-util.mjs';

try {
  const config = await loadHostConfig();
  if (!config.desktopEnabled) throw new Error('Desktop relay is disabled.');
  const child = spawn(config.desktopPython, [join(config.appDir, 'vnc_relay.py')], {
    stdio: 'inherit', env: {...process.env,
      NODE_BIN: process.env.NODE_BIN ?? process.execPath,
      SANDBOX_STATE_ROOT: config.stateRoot, SANDBOX_STATE_DIR: config.controlDir,
      SANDBOX_VM_STORAGE: config.storageRoot, SANDBOX_API: config.apiUrl},
  });
  child.once('error', () => {console.error('Desktop Python unavailable; install optional desktop dependencies.'); process.exitCode = 1;});
  child.once('exit', (code, signal) => {process.exitCode = code ?? (signal ? 1 : 0);});
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
} catch {console.error('Desktop relay unavailable; inspect host configuration and optional dependencies.'); process.exitCode = 1;}
