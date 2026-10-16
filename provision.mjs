// Per-sandbox provisioning from the Golden Gate template. Called by the
// controller with a stopped clone; leaves it stopped and verified.
import fs from 'node:fs/promises';
import path from 'node:path';
import {desktopEnabled} from './config.mjs';
import {randomBytes} from 'node:crypto';
import {USER, state, lume, storage, bootstrapKey, bootstrapHosts, templatePasswordFile, b64, secret, run, Guest, waitForSSH, shutdown, desktopScript, sudoersScript, GuestError} from './guest.mjs';
process.umask(0o077);
async function main() {
const [mode, name] = process.argv.slice(2);
if (mode !== 'provision' || !/^space-[a-z0-9][a-z0-9-]{0,30}$/.test(name || '')) throw new GuestError('Usage: provision.mjs provision space-NAME');

const templatePassword = secret(await fs.readFile(templatePasswordFile, 'utf8'));
if (!templatePassword || /[\r\n\0]/.test(templatePassword)) throw new GuestError('Verified template password is unavailable.');
const keys = path.join(state, 'keys'); const credentials = path.join(state, 'credentials');
await fs.mkdir(keys, {recursive: true, mode: 0o700}); await fs.mkdir(credentials, {recursive: true, mode: 0o700});
const key = path.join(keys, name); const credentialFile = path.join(credentials, name + '.json'); const hosts = path.join(state, name + '.known_hosts');
const password = secret(randomBytes(24).toString('base64url'));
const credential = {username: USER, password, name, createdAt: new Date().toISOString(), verified: false};
await fs.writeFile(credentialFile, JSON.stringify(credential) + '\n', {mode: 0o600, flag: 'wx'});
await run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key, '-C', name]);
const managerPub = (await fs.readFile(key + '.pub', 'utf8')).trim();
const clientPub = await fs.readFile(path.join(state, 'client.pub'), 'utf8').then(s => s.trim()).catch(error => { if (error.code === 'ENOENT') return ''; throw new GuestError('Client public key could not be read.'); });
if (clientPub && !/^ssh-(rsa|ed25519) [A-Za-z0-9+/=]+(?:\s|$)/.test(clientPub)) throw new GuestError('Client public key is missing or invalid.');

await run(lume, ['run', name, '--storage', storage, '--display', 'none', '--vnc', 'disabled', '--detach']);
const ip = await waitForSSH(name, bootstrapKey, bootstrapHosts, 'sandbox-template');
const guest = new Guest({ip, key: bootstrapKey, hosts: bootstrapHosts, alias: 'sandbox-template'});

// Apple's supported current-user change on an Apple-created account (verified to work on macOS 27).
await guest.tty('/usr/sbin/sysadminctl -newPassword - -oldPassword -', templatePassword, [templatePassword, password]);
if (!(await guest.authenticates(USER, password))) throw new GuestError('New guest password did not authenticate.');
if (await guest.authenticates(USER, templatePassword)) throw new GuestError('Template password still authenticates; provisioning blocked.');
if (!(await guest.isAdmin(password))) throw new GuestError('New guest password does not grant administrator rights.');

const output = await guest.root([
  'set -eu', 'umask 077',
  `scutil --set ComputerName '${name}'`, `scutil --set HostName '${name}'`, `scutil --set LocalHostName '${name}'`,
  `printf %s '${b64(managerPub + '\n' + clientPub + '\n')}' | base64 -D > /Users/${USER}/.ssh/authorized_keys`,
  `chmod 600 /Users/${USER}/.ssh/authorized_keys`, `chown ${USER}:staff /Users/${USER}/.ssh/authorized_keys`,
  'rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub', '/usr/bin/ssh-keygen -A >/dev/null', '/usr/sbin/sshd -t',
  "/usr/sbin/sshd -T | grep -q '^passwordauthentication no$'", "/usr/sbin/sshd -T | grep -q '^kbdinteractiveauthentication no$'",
  'cat /etc/ssh/ssh_host_ed25519_key.pub',
].join('\n') + '\n', password);
const hostKey = output.split('\n').map(line => line.trim()).find(line => /^ssh-ed25519 [A-Za-z0-9+/=]+/.test(line));
if (!hostKey) throw new GuestError('Guest host key not returned.');
await fs.writeFile(hosts, `${name} ${hostKey.split(/\s+/).slice(0, 2).join(' ')}\n`, {mode: 0o600});
const own = new Guest({ip, key, hosts, alias: name});
if ((await own.ssh('printf SANDBOX_SSH_VERIFIED')).trim() !== 'SANDBOX_SSH_VERIFIED') throw new GuestError('Per-sandbox SSH was not verified.');

// Opt-in autologin for Lume's viewer; no in-guest Screen Sharing listener.
// (sysadminctl -autologin reported success without writing kcpassword in the prototype.)
await own.root((desktopEnabled ? desktopScript(USER, password) : '') + sudoersScript(USER), password);
if ((await own.ssh('sudo -n /usr/bin/id -u')).trim() !== '0') throw new GuestError('Passwordless sudo was not verified.');
if (desktopEnabled) {
const check = await own.root('test -s /etc/kcpassword && echo kc-ok; defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser', password);
if (!/kc-ok/.test(check) || !check.split(/\r?\n/).includes(USER)) throw new GuestError('Autologin configuration was not verified.');
}
credential.verified = true;
await fs.writeFile(credentialFile, JSON.stringify(credential) + '\n', {mode: 0o600});
await shutdown(name, own, password);
console.log('Unique credentials (old rejected), pinned per-sandbox SSH verified; guest stopped.');

}
try {await main();} catch {console.error('Operation failed; inspect private state before retrying.'); process.exitCode = 1;}
