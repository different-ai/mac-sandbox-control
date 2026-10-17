// Explicit, one-shot template factory. Never run automatically at service startup.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {parseLumeJSON} from '../lume-json.mjs';

const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));
if (args.includes('--help')) {
  console.log('Usage: node scripts/init-template.mjs [--ipsw PATH|latest] [--client-key PATH.pub]\nRun on a trusted Apple-silicon host with Lume 0.6.1. Refuses an existing template or bootstrap state.');
  process.exit(0);
}
let ipsw = 'latest', clientKey;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ipsw' && args[i + 1]) ipsw = args[++i];
  else if (args[i] === '--client-key' && args[i + 1]) clientKey = args[++i];
  else throw new Error('Unknown or incomplete option. Use --help.');
}
process.umask(0o077);
async function exists(p) {try {await fs.lstat(p); return true;} catch (e) {if (e.code === 'ENOENT') return false; throw e;}}
async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Template creation requires an Apple-silicon Mac.');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required.');
  const hostEnv = path.join(os.homedir(), '.config/mac-sandbox-control/host.env');
  if (await exists(hostEnv)) process.loadEnvFile(hostEnv);
  const c = await import('../config.mjs');
  const {run, vmInfo, waitForSSH, b64, sshdConfig} = await import('../guest.mjs');
  const vm = 'macos-template';
  const version = await run(c.lumeBin, ['--version']);
  if (!/(^|\n)0\.6\.1(\s|$)/.test(version.trim())) throw new Error('This factory is based on Lume 0.6.1. Revalidate other versions before adapting the check.');
  if (os.totalmem() < 20 * 2 ** 30 || os.cpus().length < 8) throw new Error('The default factory requires 8 CPU cores and at least 20 GiB RAM (14 guest + 6 host reserve).');
  const inventory = parseLumeJSON(await run(c.lumeBin, ['ls', '--format', 'json']));
  if (inventory.some(v => v.name === vm)) throw new Error('macos-template already exists. Inspect it; this command will not overwrite or delete it.');
  if (inventory.some(v => v.status !== 'stopped')) throw new Error('Stop other VMs deliberately before running the factory. It will not stop them for you.');
  await fs.mkdir(c.stateRoot, {recursive: true, mode: 0o700});
  await fs.mkdir(c.storageRoot, {recursive: true, mode: 0o700});
  const bootstrapKey = path.join(c.stateRoot, 'bootstrap_key');
  const hosts = path.join(c.stateRoot, 'bootstrap_known_hosts');
  for (const name of ['bootstrap_key', 'bootstrap_known_hosts', 'template-ready', 'template-password', 'template-password.new']) {
    if (await exists(path.join(c.stateRoot, name))) throw new Error('Previous bootstrap state exists. Inspect it before creating or resuming a template.');
  }
  const disk = await fs.statfs(c.storageRoot);
  if (disk.bavail * disk.bsize < 100 * 2 ** 30) throw new Error('At least 100 GiB free space is required for this initial template build.');
  let publicKey;
  if (clientKey) {
    if (!clientKey.endsWith('.pub')) throw new Error('--client-key must refer to a public .pub file, never a private key.');
    publicKey = (await fs.readFile(path.resolve(clientKey), 'utf8')).trim();
    if (publicKey.length > 16384 || !/^ssh-(rsa|ed25519) [A-Za-z0-9+/=]+(?:\s|$)/.test(publicKey)) throw new Error('Unsupported public key format.');
    if (await exists(path.join(c.stateRoot, 'client.pub'))) throw new Error('client.pub already exists; inspect before replacing it.');
  }
  console.log('Installing Apple restore image. This may take several minutes and upstream unattended setup may briefly expose its own VNC listener.');
  await run(c.lumeBin, ['create', vm, '--storage', c.storageRoot, '--ipsw', ipsw, '--unattended', 'tahoe', '--cpu', '8', '--memory', '14GB', '--disk-size', '150GB', '--display', '1920x1080', '--network', 'nat'], '', 45 * 60_000);
  if ((await vmInfo(vm)).status !== 'stopped') throw new Error('Lume did not leave the new template stopped. Inspect its state before continuing.');
  await run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', bootstrapKey, '-C', 'template-bootstrap']);
  if (publicKey) await fs.writeFile(path.join(c.stateRoot, 'client.pub'), publicKey + '\n', {mode: 0o600, flag: 'wx'});
  await run(c.lumeBin, ['run', vm, '--storage', c.storageRoot, '--display', 'none', '--vnc', 'disabled', '--detach']);
  let ip, pinned;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      ip = (await vmInfo(vm)).ipAddress;
      if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        const scan = await run('/usr/bin/ssh-keyscan', ['-T', '4', '-t', 'ed25519', ip], '', 6000);
        const fields = scan.split('\n').map(s => s.trim().split(/\s+/)).find(s => s[1] === 'ssh-ed25519' && /^[A-Za-z0-9+/=]+$/.test(s[2]));
        if (fields) {pinned = fields.slice(1, 3).join(' '); break;}
      }
    } catch {}
    await delay(3000);
  }
  if (!pinned) throw new Error('The new template did not expose its SSH host key. Do not blindly repeat installation.');
  // First trust applies only to this newly created guest on the already trusted host.
  await fs.writeFile(hosts, 'sandbox-template ' + pinned + '\n', {mode: 0o600, flag: 'wx'});
  const key = (await fs.readFile(bootstrapKey + '.pub', 'utf8')).trim();
  const rootScript = ['set -eu', 'umask 077', 'mkdir -p /Users/lume/.ssh /etc/ssh/sshd_config.d',
    `printf %s '${b64(key + '\n')}' | base64 -D > /Users/lume/.ssh/authorized_keys`,
    'chmod 700 /Users/lume/.ssh', 'chmod 600 /Users/lume/.ssh/authorized_keys', 'chown -R lume:staff /Users/lume/.ssh',
    `printf %s '${b64(sshdConfig('lume'))}' | base64 -D > /etc/ssh/sshd_config.d/000-sandbox.conf`, '/usr/sbin/sshd -t'].join('\n') + '\n';
  const command = `sudo -k -p __BOOTSTRAP_SUDO__ /bin/sh -c 'printf %s ${b64(rootScript)} | base64 -D | /bin/bash'`;
  await run('/usr/bin/expect', [path.join(c.appDir, 'scripts/bootstrap-key.exp'), ip, hosts, 'sandbox-template', command], '', 120000);
  await waitForSSH(vm, bootstrapKey, hosts, 'sandbox-template', 'lume');
  console.log('Bootstrap key pinned and verified. Creating the managed account and applying Golden Gate first-login fixes.');
  const result = await run(process.execPath, [path.join(c.appDir, 'build-template.mjs'), vm], '', 20 * 60_000);
  console.log(result.trim());
}
try {await main();}
catch (error) {
  // Child output can contain an upstream temporary VNC URL; do not print it.
  console.error(error.message || 'Template factory failed.');
  console.error('Inspect private state and VM inventory before retrying. Nothing will be automatically deleted or replayed.');
  process.exitCode = 1;
}
