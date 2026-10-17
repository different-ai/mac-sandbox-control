import fs from 'node:fs/promises';
import {stateRoot as state, lumeBin as lume, storageRoot as storage} from './config.mjs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {parseLumeJSON} from './lume-json.mjs';
process.umask(0o077);
async function main() {
const name = process.argv[2];
if (!/^space-[a-z0-9][a-z0-9-]{0,30}$/.test(name || '')) throw new Error('Invalid sandbox name.');
function run(file, args, input = '', timeout = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {stdio: ['pipe', 'pipe', 'pipe']});
    let output = ''; const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.on('data', data => {output += data; if (output.length > 1e6) child.kill('SIGTERM');});
    child.stderr.on('data', () => {});
    child.once('error', () => {clearTimeout(timer); reject(new Error('Could not execute power command.'));});
    child.once('close', code => {clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error('Power command failed.'));});
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
async function info() {const result = parseLumeJSON(await run(lume, ['get', name, '--format', 'json', '--storage', storage])); return Array.isArray(result) ? result[0] : result;}
const vm = await info();
if (vm.status !== 'running') {console.log('Sandbox is already stopped.'); process.exit(0);}
if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(vm.ipAddress || '')) throw new Error('Guest IP unavailable.');
const credential = JSON.parse(await fs.readFile(path.join(state, 'credentials', name + '.json'), 'utf8'));
if (!credential.verified || !/^[a-z_][a-z0-9_-]{0,31}$/.test(credential.username || '') || typeof credential.password !== 'string') throw new Error('Verified management credentials unavailable.');
const args = ['-T', '-i', path.join(state, 'keys', name), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${path.join(state, name + '.known_hosts')}`, '-o', `HostKeyAlias=${name}`, `${credential.username}@${vm.ipAddress}`, 'sudo -k -S /bin/sh -c \'nohup /bin/sh -c "sleep 1; /sbin/shutdown -h now" >/dev/null 2>&1 &\''];
// Password travels only over the encrypted SSH connection's stdin.
await run('/usr/bin/ssh', args, credential.password + '\n');
for (let attempt = 0; attempt < 60; attempt++) {
  if ((await info()).status !== 'running') {console.log('Sandbox stopped gracefully.'); process.exit(0);}
  await delay(2000);
}
throw new Error('Guest did not stop within two minutes. Use force kill only after inspecting its state.');

}
try {await main();} catch {console.error('Operation failed; inspect private state before retrying.'); process.exitCode = 1;}
