import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {SessionVault, VaultError, parseArgs, runVaultCLI, requestGuest} from './session-vault.mjs';
import {captureSession, restoreSession, handleBrowserSession, normalizeOrigins, validateSession, connectCDP} from './browser-session.mjs';
const ORIGIN = 'https://fixture.example:8791';
const NOW = 1800000000000;
function session() {return {schema: 1, origins: [ORIGIN], browser: {product: 'Chrome/140.0', protocol: '1.3'}, cookies: [{name: 'session', value: 'TOP_SECRET_COOKIE', url: ORIGIN, path: '/', secure: true, httpOnly: true, sameSite: 'Lax'}], localStorage: [{origin: ORIGIN, items: [['auth', 'TOP_SECRET_STORAGE']]}]};}
async function root(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-vault-test-'));
  // macOS /var is a symlink; production correctly refuses symlinked paths.
  const real = await fs.realpath(dir);
  t.after(() => fs.rm(real, {recursive: true, force: true})); return real;
}
function fakeCDP(cookies = [{name: 'session', value: 'SECRET', domain: 'fixture.example', path: '/', expires: -1, session: true, secure: true, httpOnly: true, sameSite: 'Lax', size: 13, priority: 'Medium', sourceScheme: 'Secure', sourcePort: 8791}]) {
  const calls = [];
  return {calls, async send(method, params, sid) {
    calls.push({method, params, sid});
    if (method === 'Browser.getVersion') return {product: 'Chrome/140.0', protocolVersion: '1.3'};
    if (method === 'Storage.getCookies') return {cookies};
    if (method === 'Target.createTarget') return {targetId: 'target'};
    if (method === 'Target.attachToTarget') return {sessionId: 'attached'};
    if (method === 'Runtime.evaluate') return {result: {value: true}};
    if (method === 'DOMStorage.getDOMStorageItems') return {entries: [['key', 'value']]};
    return {};
  }};
}
test('vault encrypts in separate private directories and authenticates a round trip', async t => {
  const dir = await root(t), vault = new SessionVault(dir, {now: () => NOW});
  const meta = await vault.save(session(), {origins: [ORIGIN]});
  assert.equal(meta.expiresAt, NOW + 3600000);
  const text = await fs.readFile(path.join(dir, 'session-vault', meta.snapshotId + '.json'), 'utf8');
  assert.ok(!text.includes('TOP_SECRET')); assert.ok(!text.includes('session\"'));
  assert.equal((await fs.stat(path.join(dir, 'session-vault-keys/master.key'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(dir, 'session-vault'))).mode & 0o777, 0o700);
  assert.deepEqual((await vault.read(meta.snapshotId, [ORIGIN])).session, session());
  assert.deepEqual(await vault.list(), [meta]);
  await vault.delete(meta.snapshotId); assert.deepEqual(await vault.list(), []);
});
test('fresh nonces and opaque IDs for identical captures', async t => {
  const dir = await root(t), vault = new SessionVault(dir, {now: () => NOW});
  const a = await vault.save(session(), {origins: [ORIGIN]}), b = await vault.save(session(), {origins: [ORIGIN]});
  const read = async id => JSON.parse(await fs.readFile(path.join(dir, 'session-vault', id + '.json'), 'utf8'));
  assert.notEqual(a.snapshotId, b.snapshotId); assert.notEqual((await read(a.snapshotId)).nonce, (await read(b.snapshotId)).nonce);
});
test('expired, wrong-origin, tampered, and truncated snapshots fail closed', async t => {
  const dir = await root(t); let clock = NOW;
  const vault = new SessionVault(dir, {now: () => clock});
  const meta = await vault.save(session(), {origins: [ORIGIN], ttlSeconds: 1});
  await assert.rejects(vault.read(meta.snapshotId, ['https://other.example']), VaultError);
  clock += 1000; await assert.rejects(vault.read(meta.snapshotId, [ORIGIN]), VaultError);
  assert.equal((await vault.list()).length, 1); clock = NOW;
  const file = path.join(dir, 'session-vault', meta.snapshotId + '.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.metadata.expiresAt += 1000; await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(vault.read(meta.snapshotId, [ORIGIN]), VaultError);
  await fs.writeFile(file, '{'); await assert.rejects(vault.read(meta.snapshotId, [ORIGIN]), VaultError);
});
test('key permissions, symlinked key/blob, and missing key are rejected', async t => {
  const dir = await root(t), vault = new SessionVault(dir, {now: () => NOW});
  const meta = await vault.save(session(), {origins: [ORIGIN]});
  const key = path.join(dir, 'session-vault-keys/master.key');
  await fs.chmod(key, 0o644); await assert.rejects(vault.read(meta.snapshotId, [ORIGIN]), VaultError);
  await fs.chmod(key, 0o600); await fs.rename(key, key + '.backup'); await fs.symlink(key + '.backup', key);
  await assert.rejects(vault.read(meta.snapshotId, [ORIGIN]), VaultError);
  await fs.unlink(key); await assert.rejects(vault.read(meta.snapshotId, [ORIGIN]), VaultError);
  await fs.rename(key + '.backup', key);
  const blob = path.join(dir, 'session-vault', meta.snapshotId + '.json');
  await fs.rename(blob, blob + '.backup'); await fs.symlink(blob + '.backup', blob);
  await assert.rejects(vault.read(meta.snapshotId, [ORIGIN]), VaultError);
  await assert.rejects(vault.delete(meta.snapshotId), VaultError);
});
test('root symlinks, unsafe directory permissions, traversal, invalid TTL, and oversized payload rejected', async t => {
  const dir = await root(t), vault = new SessionVault(dir, {now: () => NOW});
  await fs.symlink(dir, path.join(dir, 'alias'));
  await assert.rejects(new SessionVault(path.join(dir, 'alias')).init());
  await fs.chmod(dir, 0o755); await assert.rejects(vault.save(session(), {origins: [ORIGIN]}), VaultError); await fs.chmod(dir, 0o700);
  await assert.rejects(vault.read('../master.key', [ORIGIN]), VaultError);
  for (const ttlSeconds of [0, 86401, 1.5]) await assert.rejects(vault.save(session(), {origins: [ORIGIN], ttlSeconds}), VaultError);
  const huge = session(); huge.cookies[0].value = 'x'.repeat(8 * 1024 * 1024);
  await assert.rejects(vault.save(huge, {origins: [ORIGIN]}), VaultError);
});
test('strict operator CLI requires explicit consent, sandbox, origins, and expected snapshot', () => {
  const base = ['capture','--sandbox','space-a','--origin',ORIGIN];
  assert.throws(() => parseArgs(base));
  assert.equal(parseArgs([...base, '--ack-sensitive']).ttlSeconds, undefined);
  for (const args of [[], ['list','--ack-sensitive'], ['delete','--snapshot','../x'], [...base,'--ack-sensitive','--wat'], [...base,'--ack-sensitive','--sandbox','space-b'], ['restore', ...base.slice(1), '--ack-sensitive'], ['capture','--sandbox','not-managed','--origin',ORIGIN,'--ack-sensitive']]) assert.throws(() => parseArgs(args));
});
test('origin allowlist rejects paths, insecure schemes, credentials, queries, fragments, and duplicates', () => {
  for (const origin of ['http://localhost','https://fixture.example/path','https://user:pass@fixture.example','https://fixture.example?x=1','https://fixture.example#x','file:///foo']) assert.throws(() => normalizeOrigins([origin]));
  assert.throws(() => normalizeOrigins([ORIGIN, ORIGIN + '/']));
  assert.deepEqual(normalizeOrigins([ORIGIN + '/']), [ORIGIN]);
});
test('CDP capture includes HttpOnly and localStorage, session expiry omitted, target always closes', async () => {
  const client = fakeCDP(); const data = await captureSession(client, [ORIGIN]);
  assert.equal(data.cookies[0].httpOnly, true); assert.equal(data.cookies[0].expires, undefined); assert.equal(data.cookies[0].url, ORIGIN);
  assert.deepEqual(data.localStorage[0].items, [['key','value']]);
  assert.equal(client.calls.at(-1).method, 'Target.closeTarget');
  assert.equal(client.calls.find(c => c.method === 'DOMStorage.getDOMStorageItems').sid, 'attached');
});
test('CDP ignores unrelated domains but refuses relevant broad and partitioned cookies', async () => {
  const unrelated = {domain: '.other.example', partitionKeyOpaque: true};
  const empty = await captureSession(fakeCDP([unrelated]), [ORIGIN]); assert.equal(empty.cookies.length, 0);
  for (const update of [{domain: '.fixture.example'}, {domain: '.example'}, {partitionKey: {topLevelSite: ORIGIN}}, {partitionKeyOpaque: true}, {unexpectedFutureAttribute: true}, {sameParty: true}]) {
    const client = fakeCDP(); const base = (await client.send('Storage.getCookies')).cookies[0];
    await assert.rejects(captureSession(fakeCDP([{...base,...update}]), [ORIGIN]));
  }
});
test('persistent expiry preserved, expired cookies refused, and restore never clears cookies/storage', async () => {
  const client = fakeCDP(); const base = (await client.send('Storage.getCookies')).cookies[0];
  const expiry = Date.now() / 1000 + 3600;
  const data = await captureSession(fakeCDP([{...base, session: false, expires: expiry}]), [ORIGIN]);
  assert.equal(data.cookies[0].expires, expiry);
  await assert.rejects(captureSession(fakeCDP([{...base, session: false, expires: 1}]), [ORIGIN]));
  const restore = fakeCDP(); const counts = await restoreSession(restore, data, [ORIGIN]);
  assert.equal(counts.cookieCount, 1); assert.equal(counts.localStorageCount, 1);
  assert.equal(restore.calls[0].method, 'Storage.setCookies');
  assert.ok(!restore.calls.some(c => /clear|delete/i.test(c.method)));
  assert.equal(restore.calls.find(c => c.method === 'DOMStorage.setDOMStorageItem').sid, 'attached');
});
test('restore rejects extra origins, broad domains, expired cookies and malformed localStorage before mutations', async () => {
  for (const mutate of [s => s.cookies[0].url = 'https://evil.example', s => s.cookies[0].domain = '.example', s => s.cookies[0].expires = 1, s => s.localStorage.push({origin: 'https://evil.example',items: []}), s => s.localStorage[0].items.push(['auth','duplicate'])]) {
    const data = session(); mutate(data); const client = fakeCDP();
    await assert.rejects(restoreSession(client, data, [ORIGIN])); assert.equal(client.calls.length, 0);
  }
  assert.throws(() => validateSession(session(), ['https://evil.example']));
});
test('target cleanup on storage failure and empty/logged-out inspect returns only counts', async () => {
  const client = fakeCDP(); const send = client.send;
  client.send = async (...args) => {if (args[0] === 'DOMStorage.getDOMStorageItems') throw Error('SECRET FAILURE'); return send(...args);};
  await assert.rejects(handleBrowserSession({operation: 'capture', origins: [ORIGIN]}, {client}), error => !error.message.includes('SECRET'));
  assert.equal(client.calls.at(-1).method, 'Target.closeTarget');
  const empty = fakeCDP([]); const original = empty.send;
  empty.send = async (...args) => args[0] === 'DOMStorage.getDOMStorageItems' ? {entries: []} : original(...args);
  const result = await handleBrowserSession({operation: 'inspect', origins: [ORIGIN]}, {client: empty});
  assert.equal(result.cookieCount, 0); assert.equal(result.localStorageCount, 0); assert.equal(result.cookies, undefined);
});
test('CDP discovery rejects remote, mismatched, credentialed, and malformed WebSockets', async () => {
  let opened = false;
  for (const url of ['ws://evil.example:9222/devtools/browser/a','ws://127.0.0.1:9333/devtools/browser/a','ws://user@127.0.0.1:9222/devtools/browser/a','ws://127.0.0.1:9222/devtools/page/a','wss://127.0.0.1:9222/devtools/browser/a']) {
    await assert.rejects(connectCDP(9222, {fetchImpl: async () => ({ok: true, text: async () => JSON.stringify({webSocketDebuggerUrl: url})}), WebSocketImpl: class {constructor() {opened = true;}}}));
  }
  assert.equal(opened, false);
  await assert.rejects(connectCDP(80));
});
test('CLI transports raw payload only in memory and stdout is allowlisted metadata', async t => {
  const dir = await root(t), env = {SANDBOX_STATE_ROOT: dir}; const output = [], calls = [];
  const guest = async (name, req) => {calls.push({name,req}); return req.operation === 'capture' ? session() : {origins: [ORIGIN], cookieCount: 1, localStorageCount: 1, malicious: 'TOP_SECRET'};};
  const common = ['--sandbox','space-a','--origin',ORIGIN,'--ack-sensitive'];
  await runVaultCLI(['capture',...common], {env, now: () => NOW, guest, print: s => output.push(s)});
  const {snapshotId} = JSON.parse(output[0]);
  await runVaultCLI(['restore','--snapshot',snapshotId,...common], {env, now: () => NOW, guest, print: s => output.push(s)});
  assert.equal(calls[1].req.session.cookies[0].value, 'TOP_SECRET_COOKIE');
  assert.ok(!output.join('').includes('TOP_SECRET'));
  let dispatched = false;
  await assert.rejects(runVaultCLI(['capture',...common.slice(0,-1)], {env, guest: async () => {dispatched = true;}})); assert.equal(dispatched, false);
});
test('guest SSH uses pinned identity, constant helper code, stdin secrets, and exact managed running VM', async t => {
  const dir = await root(t);
  await fs.mkdir(path.join(dir,'credentials'), {mode: 0o700}); await fs.mkdir(path.join(dir,'keys'), {mode: 0o700});
  await fs.writeFile(path.join(dir,'credentials/space-a.json'), JSON.stringify({username: 'spaceuser', verified: true}), {mode: 0o600});
  await fs.writeFile(path.join(dir,'keys/space-a'), 'FAKE TEST KEY', {mode: 0o600});
  await fs.writeFile(path.join(dir,'space-a.known_hosts'), 'FAKE TEST PUBLIC HOST KEY', {mode: 0o644});
  const state = {inventory: {error: null}, jobs: [], sandboxes: [{name: 'space-a', securityReady: true, status: 'running', starting: false, ipAddress: '192.0.2.10'}]};
  let calls = 0;
  const deps = {root: dir, fetchImpl: async () => ({ok: true, text: async () => JSON.stringify(state)}), sshRunner: async (file,args,opts) => {
    calls++; assert.equal(file, '/usr/bin/ssh'); assert.ok(args.includes('StrictHostKeyChecking=yes')); assert.ok(args.includes('HostKeyAlias=space-a')); assert.ok(args.includes('IdentitiesOnly=yes'));
    assert.ok(!args.join('').includes('TOP_SECRET_COOKIE')); assert.ok(opts.input.includes('TOP_SECRET_COOKIE'));
    assert.ok(args.at(-1).includes('$HOME/.local/share/browser-session-runtime/bin/node'));
    return JSON.stringify({origins: [ORIGIN], cookieCount: 1, localStorageCount: 1});
  }};
  await requestGuest('space-a', {operation: 'restore',origins: [ORIGIN],session: session()}, deps); assert.equal(calls, 1);
  state.jobs.push({name: 'space-a', status: 'queued'}); await assert.rejects(requestGuest('space-a', {}, deps));
  state.jobs = []; state.sandboxes[0].starting = true; await assert.rejects(requestGuest('space-a', {}, deps));
  state.sandboxes[0].starting = false; state.sandboxes[0].securityReady = false; await assert.rejects(requestGuest('space-a', {}, deps));
  await assert.rejects(requestGuest('space-a', {}, {...deps,api: 'http://remote.example'}));
  assert.equal(calls, 1);
});
