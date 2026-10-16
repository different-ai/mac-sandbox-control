// Shared guest helpers. Secrets travel only over stdin or private 0600 files,
// never argv, and command output is redacted before it can reach a log.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

export const USER = 'spaceuser';
import {home, stateRoot as state, appDir as app, lumeBin as lume, storageRoot as storage} from './config.mjs';
export {home, state, app, lume, storage};
export const bootstrapKey = path.join(state, 'bootstrap_key');
export const bootstrapHosts = path.join(state, 'bootstrap_known_hosts');
export const templatePasswordFile = path.join(state, 'template-password');
export const b64 = value => Buffer.from(value).toString('base64');

const secrets = new Set();
export function secret(value) { if (value) secrets.add(value); return value; }
export function redact(text) { let out = String(text); for (const value of secrets) out = out.split(value).join('[REDACTED]'); return out; }

export class GuestError extends Error {}
export function run(file, args, input = '', timeout = 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {stdio: ['pipe', 'pipe', 'pipe']});
    let output = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    child.stdout.on('data', data => { output += data; if (output.length > 2e6) child.kill('SIGTERM'); });
    child.stderr.on('data', data => { output += data; if (output.length > 2e6) child.kill('SIGTERM'); });
    child.once('error', () => { clearTimeout(timer); reject(new GuestError('Could not execute a provisioning command.')); });
    child.once('close', code => {
      clearTimeout(timer);
      const text = redact(output);
      if (code === 0 && !timedOut) resolve(text);
      else { const error = new GuestError(`Provisioning command failed (exit ${code ?? 'unknown'}${timedOut ? ', timeout' : ''}).`); error.output = text.slice(-2000); reject(error); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
export async function vmInfo(vm) {
  const data = JSON.parse(await run(lume, ['get', vm, '--format', 'json', '--storage', storage]));
  return Array.isArray(data) ? data[0] : data;
}
export function sshArgs(ip, key, hosts, alias, command, user = USER) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip || '')) throw new GuestError('Guest has no valid IPv4 address.');
  return ['-T', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${hosts}`, '-o', `HostKeyAlias=${alias}`, `${user}@${ip}`, command];
}
export class Guest {
  constructor({ip, key, hosts, alias, user = USER}) { Object.assign(this, {ip, key, hosts, alias, user}); }
  ssh(command, input = '', timeout = 90000) { return run('/usr/bin/ssh', sshArgs(this.ip, this.key, this.hosts, this.alias, command, this.user), input, timeout); }
  // Root shell script over stdin; sudo password is the first stdin line.
  root(script, password, timeout = 120000) { return this.ssh('sudo -k -S -p "" /bin/bash', password + '\n' + script, timeout); }
  // Hidden TTY prompts (sysadminctl). Answers are written to a private temp file.
  async tty(command, sudoPassword, answers, timeout = 120000) {
    const dir = await fs.mkdtemp(path.join(state, '.tty-'));
    try {
      const sudoFile = path.join(dir, 'sudo'); const answerFile = path.join(dir, 'answers');
      await fs.writeFile(sudoFile, sudoPassword + '\n', {mode: 0o600});
      await fs.writeFile(answerFile, answers.join('\n') + '\n', {mode: 0o600});
      return await run('/usr/bin/expect', [path.join(app, 'guest-tty.exp'), this.user, this.ip, this.key, this.hosts, this.alias, sudoFile, answerFile, command], '', timeout);
    } finally { await fs.rm(dir, {recursive: true, force: true}); }
  }
  // True only when OpenDirectory accepts the password.
  async authenticates(user, password) {
    const out = await this.ssh('/usr/bin/dscl .', `authonly ${user} ${password}\nquit\n`, 20000).catch(() => 'Error');
    return !/Error|eDS|failed/i.test(out);
  }
  async isAdmin(password) {
    const out = await this.ssh('sudo -k -S -p "" /usr/bin/id -u', password + '\n', 20000).catch(() => '');
    return out.trim() === '0';
  }
}
export async function waitForSSH(vm, key, hosts, alias, user = USER) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const info = await vmInfo(vm);
      if (info.ipAddress) { await run('/usr/bin/ssh', sshArgs(info.ipAddress, key, hosts, alias, 'true', user), '', 10000); return info.ipAddress; }
    } catch {}
    await delay(3000);
  }
  throw new GuestError('Guest SSH did not become ready within the provisioning deadline.');
}
export async function waitStopped(vm) {
  for (let attempt = 0; attempt < 60; attempt++) { if ((await vmInfo(vm)).status === 'stopped') return; await delay(2000); }
  throw new GuestError('Guest shutdown was not confirmed. Inspect state before retrying.');
}
export async function shutdown(vm, guest, password) {
  await guest.ssh('sudo -k -S -p "" /bin/sh -c \'nohup /bin/sh -c "sleep 1; /sbin/shutdown -h now" >/dev/null 2>&1 &\'', password + '\n', 30000);
  await waitStopped(vm);
}
// loginwindow stamps from trycua/cua PR #4027 (verified there against a 27.0 guest):
// build: major<<21 | (train-'A')<<16 | daily<<5 ; product: major<<24 | minor<<16 | patch<<8
export function buildStamp(build) {
  const match = /^(\d+)([A-Z])(\d+)$/.exec(build); if (!match) return null;
  const [major, train, daily] = [Number(match[1]), match[2].charCodeAt(0) - 65, Number(match[3])];
  return major < 2048 && train < 32 && daily < 2048 ? (major << 21 | train << 16 | daily << 5) : null;
}
export function systemStamp(product) {
  const parts = product.split('.').map(Number);
  if (parts.length < 1 || parts.length > 3 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  while (parts.length < 3) parts.push(0);
  return parts[0] * 2 ** 24 + (parts[1] << 16) + (parts[2] << 8);
}
// Golden Gate (macOS 27) first-login fixes for an Apple-created account: Setup
// Assistant flags (system and user) plus the per-user last-login release record,
// so the first graphical login is not treated as a brand-new account (MiniBuddy).
export function goldenGateScript(user, build, product) {
  const flags = ['DidSeeAccessibility', 'DidSeeActivationLock', 'DidSeeAppStore', 'DidSeeAppearance', 'DidSeeAppearanceSetup', 'DidSeeApplePaySetup',
    'DidSeeAutoUpdatePrompt', 'DidSeeCloudSetup', 'DidSeeLockdownMode', 'DidSeePrivacy', 'DidSeeScreenTime', 'DidSeeSiriSetup', 'DidSeeSyncSetup',
    'DidSeeSyncSetup2', 'DidSeeTermsOfAddress', 'DidSeeTouchIDSetup', 'DidSeeTrueToneSetup', 'DidSeeiCloudLoginForStorageServices'];
  const b = buildStamp(build); const s = systemStamp(product);
  if (b === null || s === null) throw new GuestError('Guest release format not recognised; refusing to guess loginwindow stamps.');
  const prefs = `/Users/${user}/Library/Preferences`;
  const lines = ['set -eu', 'touch /var/db/.AppleSetupDone', 'chown root:wheel /var/db/.AppleSetupDone', 'chmod 644 /var/db/.AppleSetupDone', `mkdir -p ${prefs}`];
  for (const domain of ['/Library/Preferences/com.apple.SetupAssistant', `${prefs}/com.apple.SetupAssistant`]) {
    for (const flag of flags) lines.push(`defaults write ${domain} ${flag} -bool true`);
    lines.push(`defaults write ${domain} GestureMovieSeen none`, `defaults write ${domain} MiniBuddyShouldLaunchToResumeSetup -bool false`,
      `defaults write ${domain} LastSeenBuddyBuildVersion ${build}`, `defaults write ${domain} LastSeenCloudProductVersion ${product}`);
  }
  lines.push(`defaults write ${prefs}/loginwindow BuildVersionStampAsNumber -int ${b}`, `defaults write ${prefs}/loginwindow BuildVersionStampAsString ${build}`,
    `defaults write ${prefs}/loginwindow SystemVersionStampAsNumber -int ${s}`, `defaults write ${prefs}/loginwindow SystemVersionStampAsString ${product}`,
    `defaults delete ${prefs}/com.apple.loginwindow MiniBuddyLaunch >/dev/null 2>&1 || true`,
    `defaults write ${prefs}/com.apple.screensaver askForPassword -int 0`, `defaults write ${prefs}/com.apple.screensaver idleTime -int 0`,
    `chown -R ${user}:staff ${prefs}`, 'pmset -a sleep 0 displaysleep 0 disksleep 0 >/dev/null');
  return lines.join('\n') + '\n';
}
// /etc/kcpassword (autologin): plaintext padded with NULs to a multiple of 12 —
// always at least one NUL terminator — then XORed with Apple's fixed key.
export function kcpassword(password) {
  const key = [0x7d, 0x89, 0x52, 0x23, 0xd2, 0xbc, 0xdd, 0xea, 0xa3, 0xb9, 0x1f];
  const bytes = [...Buffer.from(password, 'utf8')];
  bytes.push(...Array(12 - (bytes.length % 12)).fill(0));
  return Buffer.from(bytes.map((byte, index) => byte ^ key[index % key.length]));
}
// Opt-in automatic GUI login for Lume's host-side viewer. Do not also enable
// Apple's in-guest Screen Sharing: that is an unnecessary separate listener.
export function desktopScript(user, password) {
  return ['set -eu', 'umask 077',
    `printf %s '${kcpassword(password).toString('base64')}' | base64 -D > /etc/kcpassword`,
    'chown root:wheel /etc/kcpassword', 'chmod 600 /etc/kcpassword',
    `defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser -string ${user}`,
  ].join('\n') + '\n';
}
// Passwordless sudo for the sandbox account (agents run installs). Guest-only; validated before install.
export const sudoersScript = user => ['set -eu',
  `printf '%s ALL=(ALL) NOPASSWD: ALL\\n' ${user} > /tmp/sandbox-sudoers`,
  'visudo -cf /tmp/sandbox-sudoers >/dev/null',
  `install -m 0440 -o root -g wheel /tmp/sandbox-sudoers /etc/sudoers.d/${user}`, 'rm -f /tmp/sandbox-sudoers'].join('\n') + '\n';
export const sshdConfig = user => `PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers ${user}\nAllowAgentForwarding no\nAllowTcpForwarding no\nX11Forwarding no\n`;
