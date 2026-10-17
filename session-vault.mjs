#!/usr/bin/env node
// Operator-only, host-local session vault. Does not instantiate the controller or expose MCP tools.
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createCipheriv, createDecipheriv, randomBytes, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {isIP} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {MAX_BYTES, normalizeOrigins, validateSession} from './browser-session.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME = /^space-[a-z0-9][a-z0-9-]{0,30}$/;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DISK_LIMIT = 12 * 1024 * 1024;
export class VaultError extends Error { constructor() {super('Session vault operation failed. Check consent, scope, expiry, file permissions, and sandbox/browser readiness.');} }
const fail = () => {throw new VaultError();};
function sameOrigins(a, b) {return JSON.stringify(normalizeOrigins(a)) === JSON.stringify(normalizeOrigins(b));}
async function noSymlinks(file) {
  let current = path.resolve(file);
  while (true) {
    try {if ((await fs.lstat(current)).isSymbolicLink()) fail();} catch (error) {if (error.code !== 'ENOENT') throw error;}
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
async function checked(file, {directory = false, publicFile = false} = {}) {
  await noSymlinks(file);
  const st = await fs.lstat(file);
  if ((directory ? !st.isDirectory() : !st.isFile()) || st.uid !== process.getuid() || (st.mode & (publicFile ? 0o022 : 0o077)) || (!directory && st.nlink !== 1)) fail();
  return st;
}
async function readSafe(file, limit, options) {
  const before = await checked(file, options);
  if (before.size > limit) fail();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (before.ino !== after.ino || before.dev !== after.dev || after.size > limit) fail();
    const data = await handle.readFile(); if (data.length > limit) fail(); return data;
  } finally {await handle.close();}
}
async function privateDirectory(dir) {
  await noSymlinks(dir);
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
  await checked(dir, {directory: true});
}
async function atomicCreate(file, bytes, {snapshot = false} = {}) {
  // Snapshot temp data is already encrypted; rename publishes only a complete, fsynced blob.
  // Keys use an atomic no-clobber link so concurrent first captures share the winning key.
  const temp = path.join(path.dirname(file), '.' + randomUUID() + '.tmp');
  let handle;
  try {
    handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    if (snapshot) {
      try {await fs.lstat(file); fail();} catch (error) {if (error.code !== 'ENOENT') throw error;}
      await fs.rename(temp, file);
    } else {await fs.link(temp, file); await fs.unlink(temp);}
    const dir = await fs.open(path.dirname(file), constants.O_RDONLY);
    try {await dir.sync();} finally {await dir.close();}
  } finally {await handle?.close(); await fs.unlink(temp).catch(() => {});}
}
function metadata(meta) {
  if (!meta || Object.keys(meta).sort().join(',') !== 'createdAt,expiresAt,origins,schema,snapshotId' || meta.schema !== 1 || !UUID.test(meta.snapshotId)) fail();
  if (!Number.isSafeInteger(meta.createdAt) || !Number.isSafeInteger(meta.expiresAt) || meta.expiresAt <= meta.createdAt || meta.expiresAt - meta.createdAt > 86400000) fail();
  const origins = normalizeOrigins(meta.origins);
  if (JSON.stringify(origins) !== JSON.stringify(meta.origins)) fail();
  return {schema: 1, snapshotId: meta.snapshotId, createdAt: meta.createdAt, expiresAt: meta.expiresAt, origins};
}
export class SessionVault {
  constructor(root, {now = Date.now} = {}) {
    this.root = path.resolve(root); this.now = now;
    const relative = path.relative(MODULE_DIR, this.root);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) fail();
    this.blobs = path.join(this.root, 'session-vault'); this.keys = path.join(this.root, 'session-vault-keys');
  }
  async init() {await privateDirectory(this.root); await privateDirectory(this.blobs); await privateDirectory(this.keys);}
  async key(create = false) {
    const file = path.join(this.keys, 'master.key');
    if (create) {
      try {await fs.lstat(file);} catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // Never silently replace a lost key while encrypted snapshots still exist.
        if ((await fs.readdir(this.blobs)).length) fail();
        const bytes = randomBytes(32);
        try {await atomicCreate(file, bytes);} catch (failure) {if (failure.code !== 'EEXIST') throw failure;} finally {bytes.fill(0);}
      }
    }
    if (((await checked(file)).mode & 0o777) !== 0o600) fail();
    const key = await readSafe(file, 32); if (key.length !== 32) {key.fill(0); fail();} return key;
  }
  file(id) {if (!UUID.test(id)) fail(); return path.join(this.blobs, id + '.json');}
  async save(data, {origins, ttlSeconds = 3600} = {}) {
    let key, plain;
    try {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400) fail();
      const now = this.now(); const session = validateSession(data, origins, now);
      const meta = metadata({schema: 1, snapshotId: randomUUID(), createdAt: now, expiresAt: now + ttlSeconds * 1000, origins: session.origins});
      await this.init(); key = await this.key(true);
      plain = Buffer.from(JSON.stringify(session)); if (plain.length > MAX_BYTES) fail();
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(JSON.stringify(meta)));
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      await atomicCreate(this.file(meta.snapshotId), JSON.stringify({metadata: meta, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64')}), {snapshot: true});
      return meta;
    } catch {fail();} finally {key?.fill(0); plain?.fill(0);}
  }
  async decrypt(id, {origins, allowExpired = false} = {}) {
    let key, plain;
    try {
      await this.init();
      const raw = JSON.parse((await readSafe(this.file(id), DISK_LIMIT)).toString('utf8'));
      if (!raw || Object.keys(raw).sort().join(',') !== 'ciphertext,metadata,nonce,tag') fail();
      const meta = metadata(raw.metadata);
      if (meta.snapshotId !== id || meta.createdAt > this.now() || (!allowExpired && meta.expiresAt <= this.now()) || (origins && !sameOrigins(origins, meta.origins))) fail();
      function decode(text, length) {
        if (typeof text !== 'string') fail();
        const data = Buffer.from(text, 'base64'); if (data.toString('base64') !== text || (length && data.length !== length)) fail(); return data;
      }
      key = await this.key();
      const decipher = createDecipheriv('aes-256-gcm', key, decode(raw.nonce, 12));
      decipher.setAAD(Buffer.from(JSON.stringify(meta))); decipher.setAuthTag(decode(raw.tag, 16));
      const ciphertext = decode(raw.ciphertext); if (ciphertext.length > MAX_BYTES) fail();
      plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const session = JSON.parse(plain.toString('utf8'));
      // Listing authenticates even expired blobs, without rendering payload or requiring cookie freshness.
      if (!allowExpired) validateSession(session, meta.origins, this.now());
      return {metadata: meta, session};
    } catch {fail();} finally {key?.fill(0); plain?.fill(0);}
  }
  async read(id, origins) {if (!origins) fail(); return this.decrypt(id, {origins});}
  async list() {
    try {
      await this.init(); const result = [];
      for (const name of await fs.readdir(this.blobs)) {
        if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) fail();
        result.push((await this.decrypt(name.slice(0, -5), {allowExpired: true})).metadata);
      }
      return result.sort((a, b) => a.createdAt - b.createdAt);
    } catch {fail();}
  }
  async delete(id) {
    try {
      await this.init(); const file = this.file(id); await checked(file); await fs.unlink(file);
      const dir = await fs.open(this.blobs, constants.O_RDONLY); try {await dir.sync();} finally {await dir.close();}
      return {snapshotId: id, deleted: true};
    } catch {fail();}
  }
}
const shellQuote = text => "'" + text.replaceAll("'", "'\\''") + "'";
export function runSSH(file, args, {input, timeout = 120000} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {stdio: ['pipe','pipe','pipe'], env: {...process.env, SSH_ASKPASS_REQUIRE: 'never'}});
    let count = 0, done = false; const output = [];
    const timer = setTimeout(() => finish(false), timeout);
    function finish(ok) {
      if (done) return; done = true; clearTimeout(timer);
      if (!ok) {child.kill('SIGKILL'); reject(new VaultError());} else resolve(Buffer.concat(output).toString('utf8'));
    }
    child.on('error', () => finish(false)); child.stdin.on('error', () => finish(false));
    child.stdout.on('data', chunk => {count += chunk.length; if (count > MAX_BYTES) finish(false); else output.push(chunk);});
    child.stderr.on('data', chunk => {count += chunk.length; if (count > MAX_BYTES) finish(false);});
    child.on('close', code => finish(code === 0)); child.stdin.end(input);
  });
}
export async function requestGuest(name, request, {root, api = 'http://127.0.0.1:8787', fetchImpl = fetch, sshRunner = runSSH} = {}) {
  try {
    if (!NAME.test(name)) fail();
    const endpoint = new URL(api);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) fail();
    const response = await fetchImpl(endpoint.origin + '/api/state', {redirect: 'error', signal: AbortSignal.timeout(15000)});
    if (!response.ok) fail();
    const text = await response.text(); if (Buffer.byteLength(text) > MAX_BYTES) fail();
    const state = JSON.parse(text);
    const matches = state.sandboxes?.filter(vm => vm.name === name);
    if (!state.inventory || state.inventory.error !== null || !Array.isArray(matches) || matches.length !== 1 || !Array.isArray(state.jobs)) fail();
    const vm = matches[0];
    if (vm.securityReady !== true || vm.status !== 'running' || vm.starting !== false || !isIP(vm.ipAddress) || state.jobs.some(j => j.name === name && !['succeeded','failed'].includes(j.status))) fail();
    root = path.resolve(root);
    await checked(root, {directory: true});
    await checked(path.join(root, 'credentials'), {directory: true}); await checked(path.join(root, 'keys'), {directory: true});
    const credentials = JSON.parse((await readSafe(path.join(root, 'credentials', name + '.json'), 65536)).toString('utf8'));
    if (!credentials.verified || typeof credentials.username !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(credentials.username)) fail();
    const identity = path.join(root, 'keys', name), known = path.join(root, name + '.known_hosts');
    await checked(identity); await checked(known, {publicFile: true});
    const source = await fs.readFile(path.join(MODULE_DIR, 'browser-session.mjs'), 'utf8');
    const command = '"$HOME/.local/share/browser-session-runtime/bin/node" --input-type=module -e ' + shellQuote(source);
    const args = ['-F', '/dev/null', '-T', '-i', identity, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${known}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', `HostKeyAlias=${name}`, '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', `${credentials.username}@${vm.ipAddress}`, command];
    const input = JSON.stringify(request); if (Buffer.byteLength(input) > MAX_BYTES) fail();
    const output = await sshRunner('/usr/bin/ssh', args, {input, timeout: 120000});
    if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_BYTES) fail();
    return JSON.parse(output);
  } catch {fail();}
}
export function parseArgs(args) {
  const [command, ...rest] = args;
  if (!['capture','restore','inspect','list','delete'].includes(command)) fail();
  const options = {command, origins: []}; const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--ack-sensitive') {if (seen.has(flag)) fail(); options.ack = true; seen.add(flag); continue;}
    if (!['--origin','--sandbox','--snapshot','--ttl-seconds'].includes(flag) || !rest[i + 1] || rest[i + 1].startsWith('--') || (flag !== '--origin' && seen.has(flag))) fail();
    seen.add(flag); const value = rest[++i];
    if (flag === '--origin') options.origins.push(value);
    else if (flag === '--sandbox') options.sandbox = value;
    else if (flag === '--snapshot') options.snapshotId = value;
    else {if (!/^[1-9][0-9]{0,4}$/.test(value) || +value > 86400) fail(); options.ttlSeconds = +value;}
  }
  if (['capture','restore','inspect'].includes(command)) {
    if (!options.ack || !NAME.test(options.sandbox ?? '')) fail();
    options.origins = normalizeOrigins(options.origins);
  } else if (options.ack || options.sandbox || options.origins.length || options.ttlSeconds !== undefined) fail();
  if (['restore','delete'].includes(command) ? !UUID.test(options.snapshotId ?? '') : options.snapshotId !== undefined) fail();
  if (command !== 'capture' && options.ttlSeconds !== undefined) fail();
  return options;
}
export async function runVaultCLI(args, {env = process.env, now = Date.now, guest = requestGuest, print = console.log} = {}) {
  try {
    const options = parseArgs(args);
    const root = env.SANDBOX_STATE_ROOT ?? path.join(os.homedir(), '.local/state/mac-sandboxes');
    const vault = new SessionVault(root, {now}); let result;
    if (options.command === 'list') result = await vault.list();
    else if (options.command === 'delete') result = await vault.delete(options.snapshotId);
    else {
      const call = request => guest(options.sandbox, request, {root, api: env.SANDBOX_API ?? 'http://127.0.0.1:8787'});
      if (options.command === 'capture') {
        const data = await call({operation: 'capture', origins: options.origins});
        result = await vault.save(data, options);
      } else if (options.command === 'restore') {
        const {session} = await vault.read(options.snapshotId, options.origins);
        const restored = await call({operation: 'restore', origins: options.origins, session});
        if (!sameOrigins(restored.origins, options.origins) || !Number.isInteger(restored.cookieCount) || !Number.isInteger(restored.localStorageCount)) fail();
        result = {snapshotId: options.snapshotId, origins: options.origins, cookieCount: restored.cookieCount, localStorageCount: restored.localStorageCount};
      } else {
        const inspected = await call({operation: 'inspect', origins: options.origins});
        if (!sameOrigins(inspected.origins, options.origins) || !Number.isInteger(inspected.cookieCount) || !Number.isInteger(inspected.localStorageCount)) fail();
        result = {origins: options.origins, cookieCount: inspected.cookieCount, localStorageCount: inspected.localStorageCount};
      }
    }
    print(JSON.stringify(result)); return 0;
  } catch {fail();}
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.umask(0o077);
  try {process.exitCode = await runVaultCLI(process.argv.slice(2));}
  catch {process.stderr.write('Session vault operation failed. Check consent, scope, expiry, file permissions, and sandbox/browser readiness.\n'); process.exitCode = 1;}
}
