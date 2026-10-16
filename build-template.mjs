// Turn a running macOS build VM into the sandbox template using its actual release:
// Apple-created admin account (spaceuser) with a private template password,
// pinned key-only SSH, Golden Gate first-login fixes, and Lume's incomplete
// offline-created `lume` account disabled. Leaves the VM stopped.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {USER, state, bootstrapKey, bootstrapHosts, templatePasswordFile, b64, secret, vmInfo, Guest, waitForSSH, shutdown, goldenGateScript, sshdConfig, GuestError, redact} from './guest.mjs';
process.umask(0o077);
async function main() {
const vm = process.argv[2];
if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(vm || '')) throw new GuestError('Usage: build-template.mjs VM_NAME');
const ALIAS = 'sandbox-template';
const step = text => console.log(redact(`• ${text}`));

const resume = process.argv[3] === '--resume';
const pending = templatePasswordFile + '.new';
const readyFile = path.join(state, 'template-ready');
const progressFile = pending + '.json';
const existsFile = file => fs.lstat(file).then(() => true).catch(error => {if (error.code === 'ENOENT') return false; throw error;});
if (await existsFile(readyFile)) throw new GuestError('Template is already marked ready; refusing to rebuild it.');
if (!resume && ((await existsFile(pending)) || (await existsFile(templatePasswordFile)) || (await existsFile(progressFile)))) throw new GuestError('Template credential state exists; inspect it and use --resume only for a known interrupted build.');
const info = await vmInfo(vm);
if (info.status !== 'running' && !(resume && info.status === 'stopped')) throw new GuestError('Build VM must be running, or stopped after verified shutdown on resume.');
let password, product, build;
if (resume) {
  // The account phase already finished; continue from the lume lockdown step.
  password = secret(await fs.readFile(pending, 'utf8'));
  if (!/^[A-Za-z0-9_-]{32}$/.test(password)) throw new GuestError('Pending template password is invalid.');
  if (info.status === 'stopped') {
    const progress = JSON.parse(await fs.readFile(progressFile, 'utf8'));
    if (progress.vm !== vm || progress.stage !== 'verified') throw new GuestError('Stopped template was not verified before interruption.');
    await finish(password, progress.product, progress.build);
    return;
  }
  const g = new Guest({ip: info.ipAddress, key: bootstrapKey, hosts: bootstrapHosts, alias: ALIAS});
  [product, build] = (await g.ssh('sw_vers -productVersion; sw_vers -buildVersion')).trim().split('\n').map(s => s.trim());
  step(`Resuming template build on macOS ${product} (${build}).`);
} else {
const legacy = new Guest({ip: info.ipAddress, key: bootstrapKey, hosts: bootstrapHosts, alias: ALIAS, user: 'lume'});
const legacyPassword = 'lume'; // Lume's documented default for its offline-created account.
[product, build] = (await legacy.ssh('sw_vers -productVersion; sw_vers -buildVersion')).trim().split('\n').map(s => s.trim());
step(`Guest is macOS ${product} (${build}).`);

password = secret(randomBytes(24).toString('base64url'));
await fs.writeFile(pending, password, {mode: 0o600, flag: 'wx'});

const exists = (await legacy.ssh(`/usr/bin/id -u ${USER} >/dev/null 2>&1 && echo yes || echo no`)).trim() === 'yes';
if (exists) throw new GuestError('Guest account already exists; refusing to reset an unknown account. Inspect pending state before resuming.');
await legacy.tty(`sudo -k -p __SUDO__ /usr/sbin/sysadminctl -addUser ${USER} -fullName "Space User" -admin -password -`, legacyPassword, [password]);
if (!(await legacy.authenticates(USER, password))) throw new GuestError('Apple-created account password was not verified.');
step(`Admin account "${USER}" created using sysadminctl and verified.`);

const bootstrapPub = (await fs.readFile(bootstrapKey + '.pub', 'utf8')).trim();
await legacy.root([
  'set -eu', 'umask 077',
  `mkdir -p /Users/${USER}/.ssh /etc/ssh/sshd_config.d`,
  `printf %s '${b64(bootstrapPub + '\n')}' | base64 -D > /Users/${USER}/.ssh/authorized_keys`,
  `chmod 700 /Users/${USER}/.ssh`, `chmod 600 /Users/${USER}/.ssh/authorized_keys`, `chown -R ${USER}:staff /Users/${USER}/.ssh`,
  `dseditgroup -o edit -a ${USER} -t user com.apple.access_ssh >/dev/null 2>&1 || true`,
  `printf %s '${b64(sshdConfig(USER))}' | base64 -D > /etc/ssh/sshd_config.d/000-sandbox.conf`,
  '/usr/sbin/sshd -t',
  '/usr/bin/defaults delete /Library/Preferences/com.apple.loginwindow autoLoginUser >/dev/null 2>&1 || true',
  'rm -f /etc/kcpassword',
].join('\n') + '\n' + goldenGateScript(USER, build, product), legacyPassword);
step('Key-only SSH for the new account and Golden Gate first-login fixes applied; old autologin removed.');

const guest = new Guest({ip: info.ipAddress, key: bootstrapKey, hosts: bootstrapHosts, alias: ALIAS});
if (!(await guest.isAdmin(password))) throw new GuestError('New account cannot authenticate as administrator over key SSH.');
step('Verified pinned key SSH and administrator rights for the new account.');

// Reboot so no process belongs to the incomplete account before locking it down.
await guest.ssh('sudo -k -S -p "" /bin/sh -c \'nohup /bin/sh -c "sleep 1; /sbin/shutdown -r now" >/dev/null 2>&1 &\'', password + '\n', 30000);
await delay(15000);
}
const ip = await waitForSSH(vm, bootstrapKey, bootstrapHosts, ALIAS);
const rebooted = new Guest({ip, key: bootstrapKey, hosts: bootstrapHosts, alias: ALIAS});
if (!(await rebooted.authenticates(USER, password)) || !(await rebooted.isAdmin(password))) throw new GuestError('Pending account password and administrator rights must be verified before resume.');
// macOS made Lume's offline account the APFS volume owner, so it cannot be
// deleted. Neutralize it instead: no admin, no SSH, sign-in disabled, hidden.
await rebooted.root([
  'set -eu',
  'dseditgroup -o edit -d lume -t user admin >/dev/null 2>&1 || true',
  'dseditgroup -o edit -d lume -t user com.apple.access_ssh >/dev/null 2>&1 || true',
  'pwpolicy -u lume -disableuser >/dev/null 2>&1',
  'dscl . -create /Users/lume UserShell /usr/bin/false',
  'dscl . -create /Users/lume IsHidden 1',
  'rm -f /Users/lume/.ssh/authorized_keys',
].join('\n') + '\n', password);
const adminCheck = await rebooted.ssh('/usr/sbin/dseditgroup -o checkmember -m lume admin 2>&1 || true');
if (!/^no /m.test(adminCheck.trim())) throw new GuestError('Could not remove administrator rights from the lume account.');
if (await rebooted.authenticates('lume', 'lume')) throw new GuestError('The lume account still accepts its default password.');
const sshd = await rebooted.root('/usr/sbin/sshd -T | grep -E "^(passwordauthentication|kbdinteractiveauthentication|allowusers) "', password);
if (!/passwordauthentication no/.test(sshd) || !/kbdinteractiveauthentication no/.test(sshd) || !new RegExp(`allowusers ${USER}`).test(sshd)) throw new GuestError('SSH hardening was not verified.');
step('Disabled the incomplete lume account (no admin, no SSH, default password rejected); verified only the new account can use SSH.');

await fs.writeFile(progressFile, JSON.stringify({vm, stage: 'verified', product, build}) + '\n', {mode: 0o600});
await shutdown(vm, rebooted, password);
await finish(password, product, build);

async function finish(password, product, build) {
  if ((await vmInfo(vm)).status !== 'stopped') throw new GuestError('Refusing readiness until the template is stopped.');
  if (await existsFile(templatePasswordFile)) {
    if (await fs.readFile(templatePasswordFile, 'utf8') !== password) throw new GuestError('Existing template password differs; operator inspection required.');
  } else await fs.writeFile(templatePasswordFile, password, {mode: 0o600, flag: 'wx'});
  const tmp = readyFile + '.' + randomBytes(8).toString('hex') + '.tmp';
  await fs.writeFile(tmp, JSON.stringify({vm, product, build, accountSource: 'sysadminctl', username: USER, legacyAccount: 'disabled-not-deleted', verifiedAt: new Date().toISOString()}) + '\n', {mode: 0o600, flag: 'wx'});
  await fs.rename(tmp, readyFile);
  await fs.rm(pending);
  await fs.rm(progressFile, {force: true});
  console.log(redact(`Template build complete: macOS ${product} (${build}), account ${USER}, VM stopped.`));
}
}
try {await main();}
catch (error) {
  console.error(error instanceof GuestError ? redact(error.message) : 'Template build failed; inspect private state before resuming.');
  if (error instanceof GuestError && error.output) console.error(redact(error.output));
  process.exitCode = 1;
}
