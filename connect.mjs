import fs from 'node:fs';
import {home as defaultHome, stateRoot, lumeBin, storageRoot} from './config.mjs';
import path from 'node:path';
import {isIP} from 'node:net';
import {pathToFileURL} from 'node:url';
import {execFileSync, spawn} from 'node:child_process';

export class ConnectError extends Error {}
export function connectionArgs(name, {home = defaultHome, stateDir = home === defaultHome ? stateRoot : path.join(home, '.local/state/mac-sandboxes'), getVM} = {}) {
  if (!/^space-[a-z0-9][a-z0-9-]{0,30}$/.test(name || '')) throw new ConnectError('Usage: sandbox-connect space-NAME');
  const state = stateDir;
  let credential;
  try {credential = JSON.parse(fs.readFileSync(path.join(state, 'credentials', name + '.json'), 'utf8'));}
  catch (error) {
    if (error.code === 'ENOENT') throw new ConnectError(`${name} has no provisioned access. Create it in the control plane first.`);
    throw new ConnectError(`${name}: stored access information could not be read. Inspect the private host diagnostics.`);
  }
  if (credential?.verified !== true) throw new ConnectError(`${name} is not ready: credential setup is incomplete. Check its failed create job in the control plane; it must be provisioned successfully before you can connect.`);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(credential.username || '')) throw new ConnectError(`${name}: guest account information needs operator inspection.`);
  let vm;
  try {
    const raw = getVM ? getVM(name) : JSON.parse(execFileSync(lumeBin, ['get', name, '--format', 'json', '--storage', storageRoot], {encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore']}));
    vm = Array.isArray(raw) ? raw[0] : raw;
  } catch {throw new ConnectError(`${name}: could not verify VM state. Check the host diagnostics before connecting.`);}
  if (vm?.name !== name) throw new ConnectError(`${name}: VM identity could not be verified.`);
  if (vm.status === 'stopped') throw new ConnectError(`${name} is stopped. Start it in the control plane, then connect again.`);
  if (vm.status !== 'running') throw new ConnectError(`${name} is not running yet. Check its status in the control plane.`);
  if (isIP(vm.ipAddress || '') !== 4) throw new ConnectError(`${name} has no verified network address yet. Wait for startup to finish.`);
  const key = path.join(state, 'keys', name);
  const hosts = path.join(state, name + '.known_hosts');
  for (const file of [key, hosts]) {
    try {if (!fs.lstatSync(file).isFile()) throw new Error('Not a file.');}
    catch {throw new ConnectError(`${name}: verified SSH access files are missing. Inspect the host diagnostics; do not bypass host-key checking.`);}
  }
  return ['-t', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${hosts}`, '-o', `HostKeyAlias=${name}`, `${credential.username}@${vm.ipAddress}`];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const child = spawn('/usr/bin/ssh', connectionArgs(process.argv[2]), {stdio: 'inherit'});
    child.once('error', () => {console.error('Could not start SSH. Check the host diagnostics.'); process.exitCode = 1;});
    child.once('exit', code => {process.exitCode = code ?? 1;});
  } catch (error) {
    console.error(error instanceof ConnectError ? error.message : 'Could not prepare SSH access. Check the host diagnostics.');
    process.exitCode = 1;
  }
}
