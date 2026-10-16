import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createMcpServer, loadTokens} from './mcp-http.mjs';
import {runClient} from './sandbox-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
function directory(t) {
  const root = fs.mkdtempSync(path.join(here, '.test-security-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}
function tokenFile(t) {
  const root = directory(t), file = path.join(root, 'tokens.json'), token = 'z'.repeat(43);
  fs.writeFileSync(file, JSON.stringify({tokens: [{name: 'operator', hash: createHash('sha256').update(token).digest('hex')}]}), {mode: 0o600});
  return {root, file, token};
}
async function listen(t, options) {
  const server = createMcpServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  return {server, endpoint: `http://127.0.0.1:${server.address().port}/mcp`};
}
const post = (endpoint, token, body) => fetch(endpoint, {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + token}, body: JSON.stringify(body)});

test('MCP audit contains only actor/tool/sandbox/outcome/duration, never command or tool output', async t => {
  const {file, token} = tokenFile(t), audit = [];
  const secret = 'synthetic-secret-not-a-real-credential';
  const request = async url => new Response(JSON.stringify(url.endsWith('/api/state') ? {csrfToken: secret} : {exitCode: 0, stdout: secret, stderr: secret, timedOut: false}));
  const {endpoint} = await listen(t, {tokensFile: file, request, log: line => audit.push(JSON.parse(line))});
  const response = await post(endpoint, token, {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'run_command', arguments: {name: 'space-a', command: 'echo ' + secret, password: secret, token}}});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.structuredContent.stdout, secret);
  assert.equal(audit.length, 1);
  assert.deepEqual(Object.keys(audit[0]).sort(), ['actor', 'tool', 'sandbox', 'outcome', 'duration'].sort());
  assert.equal(audit[0].actor, 'operator'); assert.equal(audit[0].tool, 'run_command');
  assert(!JSON.stringify(audit).includes(secret)); assert(!JSON.stringify(audit).includes(token));
  await post(endpoint, token, {id: 2, method: 'tools/call', params: {name: secret, arguments: {name: secret}}});
  assert.equal(audit[1].tool, 'unknown'); assert.equal(audit[1].sandbox, undefined);
  assert(!JSON.stringify(audit).includes(secret));
});

test('MCP authenticated concurrency is bounded and released after a request completes', async t => {
  const {file, token} = tokenFile(t);
  let release, started;
  const gate = new Promise(resolve => {release = resolve;});
  const entered = new Promise(resolve => {started = resolve;});
  const {endpoint} = await listen(t, {tokensFile: file, maxConcurrent: 1, request: async () => {started(); await gate; return new Response(JSON.stringify({host: {}, policy: {}, inventory: {}, sandboxes: [], jobs: []}));}});
  const first = post(endpoint, token, {id: 1, method: 'tools/call', params: {name: 'list_sandboxes'}});
  await entered;
  try {assert.equal((await post(endpoint, token, {id: 2, method: 'ping'})).status, 503);}
  finally {release();}
  assert.equal((await first).status, 200);
  assert.equal((await post(endpoint, token, {id: 3, method: 'ping'})).status, 200);
});

test('MCP body deadline releases admission and rejects unauthenticated streams without reading a body', async t => {
  const {file, token} = tokenFile(t);
  const {endpoint} = await listen(t, {tokensFile: file, maxConcurrent: 1, bodyTimeoutMs: 50});
  async function incomplete(authorization) {
    return new Promise((resolve, reject) => {
      const req = http.request(endpoint, {method: 'POST', headers: {'content-type': 'application/json', authorization}}, res => {res.resume(); resolve(res.statusCode);});
      req.on('error', reject); req.write('{');
    });
  }
  assert.equal(await incomplete('Bearer invalid'), 401);
  assert.equal(await incomplete('Bearer ' + token), 408);
  assert.equal((await post(endpoint, token, {id: 1, method: 'ping'})).status, 200);
});

test('malformed or unknown token stores fail closed and token manager never replaces them', t => {
  const {file} = tokenFile(t);
  for (const text of ['{broken', '{}', '{"tokens":[],"private":"unknown"}', '{"tokens":[{"name":"operator","hash":"bad"}]}']) {
    fs.writeFileSync(file, text, {mode: 0o600});
    assert.deepEqual(loadTokens(file), []);
    const result = spawnSync(process.execPath, [path.join(here, 'mcp-tokens.mjs'), 'add', 'new-operator'], {encoding: 'utf8', env: {...process.env, SANDBOX_MCP_TOKENS: file}});
    assert.equal(result.status, 1); assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert(!result.stderr.includes('at file:'));
  }
});

test('config defaults and overrides share state root, storage and module-relative helpers', t => {
  const root = directory(t);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SANDBOX_') && key !== 'LUME_BIN'));
  env.HOME = root;
  const read = extra => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import * as c from ${JSON.stringify(new URL('./config.mjs', import.meta.url).href)}; console.log(JSON.stringify(c));`], {encoding: 'utf8', cwd: root, env: {...env, ...extra}}));
  const defaults = read({});
  assert.equal(defaults.stateRoot, path.join(root, '.local/state/mac-sandboxes'));
  assert.equal(defaults.controlDir, path.join(defaults.stateRoot, 'control'));
  assert.equal(defaults.storageRoot, path.join(root, '.lume'));
  assert.equal(defaults.appDir, here);
  assert.equal(defaults.publicHost, 'mac-host.local'); assert.equal(defaults.mcpBind, '127.0.0.1');
  assert.equal(defaults.mcpPort, 8788); assert.equal(defaults.desktopEnabled, false);
  const custom = read({SANDBOX_STATE_ROOT: path.join(root, 'state'), SANDBOX_VM_STORAGE: path.join(root, 'vms'), LUME_BIN: '/example/lume', SANDBOX_DESKTOP_ENABLED: '1', SANDBOX_PUBLIC_HOST: 'host.example'});
  assert.equal(custom.controlDir, path.join(root, 'state/control')); assert.equal(custom.storageRoot, path.join(root, 'vms'));
  assert.equal(custom.lumeBin, '/example/lume'); assert.equal(custom.desktopEnabled, true); assert.equal(custom.publicHost, 'host.example');
});

test('client token defaults use its own config directory and loopback endpoint', async t => {
  const home = directory(t), config = path.join(home, '.config/mac-sandbox-control');
  fs.mkdirSync(config, {recursive: true}); fs.writeFileSync(path.join(config, 'token'), 'x'.repeat(43), {mode: 0o600});
  const urls = [];
  await runClient(['ls'], {home, env: {}, print: () => {}, request: async (url, options) => {
    urls.push(url); const body = JSON.parse(options.body);
    if (body.method === 'notifications/initialized') return new Response(null, {status: 202});
    const result = body.method === 'initialize' ? {} : {structuredContent: {sandboxes: [], jobs: [], inventory: {}, policy: {}}};
    return new Response(JSON.stringify({id: body.id, result}));
  }});
  assert(urls.every(url => url === 'http://127.0.0.1:8788/mcp'));
});

test('forward module is passive and exports only port metadata readers', async () => {
  const forward = await import('./forward.mjs');
  assert.deepEqual(Object.keys(forward).sort(), ['PORTS', 'readPorts']);
});

test('guest authentication fails closed when SSH fails without diagnostic output', async () => {
  const {Guest} = await import('./guest.mjs');
  const guest = new Guest({ip: '192.168.64.2', key: '/unused', hosts: '/unused', alias: 'sandbox-template'});
  guest.ssh = async () => {throw Object.assign(new Error('connection failed'), {output: ''});};
  assert.equal(await guest.authenticates('spaceuser', 'synthetic-password'), false);
});

test('unexpected provider errors never leak exception text or traces', async () => {
  const {handle} = await import('./mcp.mjs');
  const secret = 'synthetic-error-credential';
  const result = await handle({id: 1, method: 'tools/call', params: {name: 'list_sandboxes'}}, async () => {throw new Error(secret);});
  assert.equal(result.result.isError, true); assert(!JSON.stringify(result).includes(secret));
});
