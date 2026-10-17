import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, lstatSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { Controller, GiB, parseInventory } from './controller.mjs';
import { createServer } from './server.mjs';
import { runCli } from './cli.mjs';
import { handle as mcpHandle, tools as mcpTools } from './mcp.mjs';
import { describeSandboxes, filterSandboxes } from './sandbox-status.mjs';

const here = dirname(fileURLToPath(import.meta.url));
function vm(name, status = 'stopped', memory = 14) {
  return { name, os: 'macOS', cpuCount: 8, memorySize: memory * GiB,
    diskSize: { allocated: 30 * GiB, total: 150 * GiB }, display: '1024x768', status,
    locationName: 'default', vncUrl: 'vnc://SECRET_PASSWORD@127.0.0.1:5900', ipAddress: '192.168.64.2',
    machineIdentifier: 'SECRET_MACHINE_ID' };
}
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(here, '.test-state-'));
  const rows = [vm('macos-template')];
  const calls = [];
  const options = { stateDir: join(root, 'control'), storage: root, lume: join(root, 'fake-lume'),
    provisioner: join(root, 'fake-provision'), powerHelper: join(root, 'fake-power'),
    desktopEnabled: true, guestProbe: async () => true,
    consoleCheck: () => ({ready: true, connected: true, reason: 'ready'}), resources: () => ({ cpuTotal: 18, memoryGiB: 36, diskGiB: 100, diskTotalGiB: 500 }),
    // Lifecycle fixtures model runtime independently of macOS process tools.
    runtimeInspector: async row => ({ status: row.status, processState: row.status === 'running' ? 'running' : 'stopped' }),
    bootTimeoutMs: 5, pollMs: 1, ...overrides };
  const fake = { rows, calls, failure: null, delayed: new Set(), peak: 0, active: 0, serialPeak: 0 };
  fake.runner = async (file, args, config) => {
    calls.push({ file, args: [...args], config });
    if (fake.failure?.(file, args)) throw Object.assign(new Error('SECRET_PASSWORD in stderr and argv'), { code: 42, stderr: 'SECRET_PASSWORD', stdout: 'SECRET_MACHINE_ID' });
    if (args[0] === 'ls') return { stdout: JSON.stringify(rows) };
    fake.active++; fake.serialPeak = Math.max(fake.serialPeak, fake.active);
    try {
      await Promise.resolve();
      if (file === options.provisioner) {
        assert.equal(c.owned(args[0]).reserved, 1, 'provisioning boot must hold a durable reservation');
        assert.equal(args.length, 1);
        const guest = rows.find(vm => vm.name === args[0]); guest.status = 'running';
        fake.peak = Math.max(fake.peak, rows.filter(vm => vm.status !== 'stopped').length);
        guest.status = 'stopped';
      } else if (file === options.powerHelper) rows.find(vm => vm.name === args[0]).status = 'stopped';
      else if (args[0] === 'clone') rows.push({ ...structuredClone(rows.find(vm => vm.name === args[1])), name: args[2] });
      else if (args[0] === 'set') { const guest = rows.find(vm => vm.name === args[1]); guest.cpuCount = 8; guest.memorySize = 14 * GiB; }
      else if (args[0] === 'run') {
        assert.equal(c.owned(args[1]).reserved, 1, 'detached boot must hold a durable reservation');
        if (!fake.delayed.has(args[1])) rows.find(vm => vm.name === args[1]).status = 'running';
        fake.peak = Math.max(fake.peak, rows.filter(vm => vm.status !== 'stopped').length);
      } else if (args[0] === 'stop') { assert(args.includes('--force')); rows.find(vm => vm.name === args[1]).status = 'stopped'; }
      else if (args[0] === 'delete') {
        assert.equal(rows.find(vm => vm.name === args[1]).status, 'stopped');
        rows.splice(rows.findIndex(vm => vm.name === args[1]), 1);
      } else assert.fail('Unexpected fake command');
      return { stdout: 'SECRET_PASSWORD generic success output must never be exposed' };
    } finally { fake.active--; }
  };
  options.runner = fake.runner;
  writeFileSync(join(root, 'template-ready'), 'ready', { mode: 0o600 });
  let c = new Controller(options);
  t.after(async () => { await c.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, fake, options, get c() { return c; }, async reopen() { await c.close(); c = new Controller(options); return c; } };
}
const job = (c, queued) => c.db.prepare('SELECT * FROM jobs WHERE id=?').get(queued.id);
async function action(c, name, action, confirmation) {
  const queued = c.enqueue(name, action, confirmation); await c.idle(); return job(c, queued);
}
function seed(c, name, { security = 1, reserved = 0, claimed = 1 } = {}) {
  c.db.prepare("INSERT INTO sandboxes(name,createdAt,securityReady,claimed,reserved,stage) VALUES (?,?,?,?,?,'ready')")
    .run(name, new Date().toISOString(), security, claimed, reserved);
}

test('tagged Lume JSON shape is strict and secrets are removed', () => {
  const parsed = parseInventory(JSON.stringify([vm('space-a')]));
  assert.equal(parsed[0].memoryGiB, 14); assert.equal(parsed[0].diskGiB, 150);
  assert.equal(parsed[0].ipAddress, '192.168.64.2'); assert(!JSON.stringify(parsed).includes('SECRET'));
  for (const bad of ['{}', 'junk', JSON.stringify([{ name: 'bad', status: 'running' }])]) assert.throws(() => parseInventory(bad), /inventory is invalid/);
  const badIP = vm('space-b'); badIP.ipAddress = 'vnc://secret'; badIP.status = 'unknown-secret-status';
  assert.equal(parseInventory(JSON.stringify([badIP]))[0].ipAddress, null);
  assert.equal(parseInventory(JSON.stringify([badIP]))[0].status, 'unknown');
});

test('concurrent creates serialize, never exceed two, and use exact safe Lume arguments', async t => {
  const { c, fake, options } = fixture(t);
  const queued = await Promise.all(['space-a', 'space-b', 'space-c'].map(async name => c.enqueue(name, 'create')));
  await c.idle();
  assert.deepEqual(queued.map(q => job(c, q).status), ['succeeded', 'succeeded', 'failed']);
  assert.match(job(c, queued[2]).error, /Maximum two/); assert.equal(fake.peak, 2); assert.equal(fake.serialPeak, 1);
  const commands = fake.calls.filter(call => call.file === options.lume).map(call => call.args);
  assert.deepEqual(commands.find(args => args[0] === 'clone'), ['clone', 'macos-template', 'space-a', '--source-storage', options.storage, '--dest-storage', options.storage]);
  assert.deepEqual(commands.find(args => args[0] === 'set'), ['set', 'space-a', '--storage', options.storage, '--cpu', '8', '--memory', '14GB', '--machine-identifier', 'random', '--mac-address', 'random']);
  const run = commands.find(args => args[0] === 'run');
  assert.deepEqual(run.slice(0, 8), ['run', 'space-a', '--storage', options.storage, '--display', 'none', '--vnc', 'enabled']);
  assert.equal(run[8], '--vnc-port'); assert.equal(run[9], '15901'); assert.equal(run[10], '--vnc-password'); assert.match(run[11], /^[A-Za-z0-9]{8}$/);
  assert.deepEqual(run.slice(12), ['--detach', '--log-file', '/dev/null']);
  const runB = commands.filter(args => args[0] === 'run')[1]; assert.equal(runB[9], '15902'); assert.notEqual(runB[11], run[11]);
  assert(commands.every(args => !args.includes('--disk-size')));
  const state = await c.state();
  assert.equal(state.policy.networkIsolationVerified, false); assert.equal(state.host.diskAvailableGiB, 100);
  assert(state.sandboxes.find(vm => vm.name === 'space-a').securityReady);
  assert(!state.sandboxes.some(vm => vm.name === 'macos-template')); assert(!JSON.stringify(state).includes('SECRET'));
});

test('capacity counts unmanaged guests and memory reservation', async t => {
  const { c, fake } = fixture(t);
  fake.rows.push(vm('unmanaged-one', 'running'), vm('unmanaged-two', 'running'));
  assert.match((await action(c, 'space-count', 'create')).error, /Maximum two/);
  fake.rows.pop(); fake.rows[1].memorySize = 20 * GiB;
  assert.match((await action(c, 'space-memory', 'create')).error, /6 GiB/);
  assert(!fake.calls.some(call => call.args[0] === 'clone'));
});

test('marker, disk floor, template size and inventory failures fail closed before clone', async t => {
  const f = fixture(t);
  rmSync(join(f.root, 'template-ready'));
  assert.match((await action(f.c, 'space-marker', 'create')).error, /marker/);
  writeFileSync(join(f.root, 'template-ready'), 'ready');
  f.c.resources = () => ({ memoryGiB: 36, diskGiB: 59 });
  assert.match((await action(f.c, 'space-disk', 'create')).error, /60 GiB/);
  f.c.resources = f.options.resources; f.fake.rows[0].diskSize.total = 149 * GiB;
  assert.match((await action(f.c, 'space-template', 'create')).error, /150 GiB/);
  f.fake.failure = (_, args) => args[0] === 'ls';
  assert.match((await action(f.c, 'space-inventory', 'create')).error, /Command failed \(exit code 42\)/);
  assert(!f.fake.calls.some(call => call.args[0] === 'clone'));
});

test('secure stage required; failed provisioning never becomes startable and retains reservation', async t => {
  const { c, fake, options } = fixture(t);
  fake.failure = file => file === options.provisioner;
  assert.equal((await action(c, 'space-failed', 'create')).status, 'failed');
  assert.equal(c.owned('space-failed').securityReady, 0); assert.equal(c.owned('space-failed').reserved, 1);
  assert.match((await action(c, 'space-failed', 'start')).error, /secure provisioning/);
  fake.failure = null; fake.rows.push(vm('outside', 'running'));
  assert.match((await action(c, 'space-next', 'create')).error, /Maximum two/);
  assert(!fake.calls.some(call => call.args[0] === 'run'));
  assert.equal((await action(c, 'space-failed', 'kill')).status, 'succeeded');
  assert.equal(c.owned('space-failed').reserved, 0);
});

test('delayed or failed detached boots reserve capacity, survive restart, and are never retried', async t => {
  const f = fixture(t);
  seed(f.c, 'space-delayed'); f.fake.rows.push(vm('space-delayed')); f.fake.delayed.add('space-delayed');
  assert.match((await action(f.c, 'space-delayed', 'start')).error, /did not reach running/);
  assert.equal(f.c.owned('space-delayed').reserved, 1);
  await f.reopen(); f.fake.rows.push(vm('outside', 'running'));
  assert.match((await action(f.c, 'space-blocked', 'create')).error, /Maximum two/);
  assert.match((await action(f.c, 'space-delayed', 'delete', 'space-delayed')).error, /unresolved/);
  assert.equal(f.fake.calls.filter(call => call.args[0] === 'run').length, 1);
  assert.equal((await action(f.c, 'space-delayed', 'kill')).status, 'succeeded');
});

test('failed run commands keep conservative reservations and sanitize errors', async t => {
  const { c, fake } = fixture(t);
  fake.failure = (_, args) => args[0] === 'run';
  const failed = await action(c, 'space-run-failed', 'create');
  assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'Command failed (exit code 42).');
  assert.equal(c.owned(failed.name).securityReady, 1); assert.equal(c.owned(failed.name).reserved, 1);
  assert.match((await action(c, failed.name, 'start')).error, /unresolved boot reservation/);
  assert(!JSON.stringify(await c.state()).includes('SECRET'));
});

test('delete requires exact confirmation, refuses running VMs, and never boots a guest', async t => {
  const { c, fake, options } = fixture(t);
  assert.equal((await action(c, 'space-delete', 'create')).status, 'succeeded');
  assert.throws(() => c.enqueue('space-delete', 'delete'), /exact sandbox name/);
  assert.throws(() => c.enqueue('space-delete', 'delete', 'space-other'), /exact sandbox name/);
  assert.equal((await action(c, 'space-delete', 'delete', 'space-delete')).status, 'failed');
  const runs = fake.calls.filter(call => call.args[0] === 'run').length;
  assert.equal((await action(c, 'space-delete', 'stop')).status, 'succeeded');
  assert(fake.calls.some(call => call.file === options.powerHelper && call.args[0] === 'space-delete'));
  assert(!fake.calls.some(call => call.args[0] === 'shutdown' || call.args[0] === 'stop'));
  assert.equal((await action(c, 'space-delete', 'delete', 'space-delete')).status, 'succeeded');
  assert.equal(fake.calls.filter(call => call.args[0] === 'run').length, runs);
  assert.throws(() => c.owned('space-delete'), /not managed/);
  assert.deepEqual(fake.calls.find(call => call.args[0] === 'delete').args, ['delete', 'space-delete', '--storage', options.storage, '--force']);
});

test('confirmed deletion removes owned credentials and permits safe name reuse', async t => {
  const { c, root } = fixture(t);
  assert.equal((await action(c, 'space-reuse', 'create')).status, 'succeeded');
  assert.equal((await action(c, 'space-reuse', 'stop')).status, 'succeeded');
  for (const folder of ['keys', 'credentials']) mkdirSync(join(root, folder), {recursive: true, mode: 0o700});
  const files = [join(root, 'keys/space-reuse'), join(root, 'keys/space-reuse.pub'),
    join(root, 'space-reuse.known_hosts'), join(root, 'credentials/space-reuse.json'), join(root, 'credentials/space-reuse.vnc'),
    join(root, 'credentials/space-reuse.vnc-upstream')];
  for (const file of files) writeFileSync(file, 'fixture-only', {mode: 0o600});
  assert.equal((await action(c, 'space-reuse', 'delete', 'space-reuse')).status, 'succeeded');
  for (const file of files) assert(!existsSync(file));
  assert.equal((await action(c, 'space-reuse', 'create')).status, 'succeeded');
});

test('graceful helper failures do not fall back to immediate stop; kill is explicitly forced', async t => {
  const { c, fake, options } = fixture(t);
  seed(c, 'space-power'); fake.rows.push(vm('space-power', 'running'));
  fake.failure = file => file === options.powerHelper;
  const failed = await action(c, 'space-power', 'stop');
  assert.equal(failed.error, 'Command failed (exit code 42).');
  assert(!fake.calls.some(call => call.args[0] === 'stop'));
  fake.failure = null;
  assert.equal((await action(c, 'space-power', 'kill')).status, 'succeeded');
  assert.deepEqual(fake.calls.find(call => call.args[0] === 'stop').args, ['stop', 'space-power', '--storage', options.storage, '--force']);
  assert(!JSON.stringify(await c.state()).includes('SECRET'));
});

test('unknown, protected, injected and collided names can never be acted upon', async t => {
  const { c, fake } = fixture(t);
  for (const name of ['macos-template', '../space-a', 'space-a;touch bad', 'space-A', 'space-', `space-${'a'.repeat(32)}`]) {
    assert.throws(() => c.enqueue(name, 'create'));
    assert.throws(() => c.enqueue(name, 'kill'));
  }
  assert.throws(() => c.enqueue('space-unknown', 'kill'), /not managed/);
  fake.rows.push(vm('space-outside'));
  assert.equal((await action(c, 'space-outside', 'create')).status, 'failed');
  assert.match((await action(c, 'space-outside', 'kill')).error, /did not create/);
  assert.equal((await action(c, 'space-outside', 'delete', 'space-outside')).status, 'succeeded');
  assert(fake.rows.some(vm => vm.name === 'space-outside'));
  assert(!fake.calls.some(call => ['run', 'stop', 'delete', 'clone'].includes(call.args[0])));
});

test('interrupted running jobs become failed without retry; pending jobs remain durable and resume', async t => {
  const f = fixture(t, { autoStart: false });
  const interrupted = f.c.enqueue('space-interrupted', 'create');
  f.c.db.prepare("UPDATE jobs SET status='running', startedAt=? WHERE id=?").run(new Date().toISOString(), interrupted.id);
  f.c.db.prepare("UPDATE sandboxes SET claimed=1, reserved=1, stage='provisioning' WHERE name=?").run(interrupted.name);
  const pending = f.c.enqueue('space-pending', 'create');
  await f.reopen();
  assert.equal(job(f.c, interrupted).status, 'failed'); assert.match(job(f.c, interrupted).error, /Interrupted; not retried/);
  assert.equal(job(f.c, pending).status, 'queued'); assert.equal(f.fake.calls.length, 0);
  f.fake.rows.push(vm('space-interrupted'));
  f.c.paused = false; f.c.wake(); await f.c.idle();
  assert.equal(job(f.c, pending).status, 'succeeded');
  assert(!f.fake.calls.some(call => call.args[0] === 'clone' && call.args[2] === interrupted.name));
});

test('configuration drift cannot bypass the fixed per-VM memory budget', async t => {
  const { c, fake } = fixture(t);
  seed(c, 'space-drift'); fake.rows.push(vm('space-drift', 'stopped', 24));
  assert.match((await action(c, 'space-drift', 'start')).error, /configuration changed/);
  assert(!fake.calls.some(call => call.args[0] === 'run'));
});

test('default resource provider reads available disk from the configured storage filesystem', async t => {
  const { c } = fixture(t, { resources: undefined });
  const state = await c.state();
  const os = await import('node:os');
  assert.equal(state.host.cpuTotal, os.cpus().length); assert.equal(state.host.memoryGiB, os.totalmem() / GiB);
  assert(Number.isFinite(state.host.diskAvailableGiB) && state.host.diskAvailableGiB > 0);
  assert(state.host.diskTotalGiB >= state.host.diskAvailableGiB);
});

test('state refreshes coalesce for three seconds while job data stays live', async t => {
  const { c, fake } = fixture(t, { autoStart: false });
  await Promise.all([c.state(), c.state(), c.state()]);
  assert.equal(fake.calls.length, 1);
  const queued = c.enqueue('space-live', 'create');
  const state = await c.state();
  assert.equal(fake.calls.length, 1); assert.equal(state.jobs[0].id, queued.id); assert.equal(state.jobs[0].status, 'queued');
  c.snapshot.at -= 3001;
  await c.state(); assert.equal(fake.calls.length, 2);
  fake.failure = () => true; c.snapshot.at -= 3001;
  const failed = await c.state(); assert(failed.inventory.error); assert.equal(failed.inventory.activeCount, null);
});

test('private permissions, exclusive instance lock, safe stale PID recovery and uncertain refusal', async t => {
  const f = fixture(t, { autoStart: false });
  assert.equal(lstatSync(f.options.stateDir).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(f.options.stateDir, 'control.sqlite')).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(f.options.stateDir, 'controller.lock/owner.json')).mode & 0o777, 0o600);
  assert.throws(() => new Controller(f.options), /Another controller/);
  await f.c.close();
  const lock = join(f.options.stateDir, 'controller.lock');
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'stale-owner' }), { mode: 0o600 });
  await f.reopen(); assert(existsSync(lock)); await f.c.close();
  mkdirSync(lock, { mode: 0o700 }); writeFileSync(join(lock, 'owner.json'), '{}', { mode: 0o600 });
  assert.throws(() => new Controller(f.options), /uncertain/);
});

test('symlinked private database is refused without overwriting target', async t => {
  const f = fixture(t, { autoStart: false }); await f.c.close();
  rmSync(join(f.options.stateDir, 'control.sqlite'));
  const target = join(f.root, 'must-not-touch'); writeFileSync(target, 'private', { mode: 0o600 }); chmodSync(target, 0o644);
  symlinkSync(target, join(f.options.stateDir, 'control.sqlite'));
  assert.throws(() => new Controller(f.options), /Unsafe private state path/);
  assert.equal(lstatSync(target).mode & 0o777, 0o644);
});

test('dangling symlinked database is refused before SQLite can create its target', async t => {
  const f = fixture(t, { autoStart: false }); await f.c.close();
  rmSync(join(f.options.stateDir, 'control.sqlite'));
  const target = join(f.root, 'must-not-create');
  symlinkSync(target, join(f.options.stateDir, 'control.sqlite'));
  assert.throws(() => new Controller(f.options), /Unsafe private state path/);
  assert(!existsSync(target));
});

async function httpFixture(t) {
  const f = fixture(t, { autoStart: false });
  const publicDir = join(f.root, 'public'); mkdirSync(publicDir);
  for (const name of ['index.html', 'app.js', 'style.css']) writeFileSync(join(publicDir, name), `safe ${name}`);
  const server = createServer(f.c, { publicDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = (path = '/api/state', { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { host: '127.0.0.1:8787', ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => { let data; try { data = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, data, text }); });
    });
    req.on('error', reject); req.end(body);
  });
  return { ...f, request, server };
}

test('HTTP Host/Origin/fetch metadata checks protect state and CSRF mutations', async t => {
  const { c, request, server } = await httpFixture(t);
  assert.equal(server.address().address, '127.0.0.1');
  const state = await request(); assert.equal(state.status, 200); assert.match(state.data.csrfToken, /^[a-f0-9]{64}$/);
  for (const headers of [{ host: 'evil.example:8787' }, { host: '127.0.0.1:8787.evil' },
    { origin: 'http://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
    assert.equal((await request('/api/state', { headers })).status, 403);
  }
  assert.equal((await request('/api/state', { headers: { host: 'localhost:8787', origin: 'http://localhost:8787' } })).status, 200);
  const path = '/api/sandboxes'; const body = JSON.stringify({ name: 'space-http' });
  const headers = { 'content-type': 'application/json', 'x-csrf-token': state.data.csrfToken };
  assert.equal((await request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 403);
  assert.equal((await request(path, { method: 'POST', headers: { ...headers, 'x-csrf-token': '0'.repeat(64) }, body })).status, 403);
  assert.equal((await request(path, { method: 'POST', headers: { ...headers, origin: 'http://evil.example' }, body })).status, 403);
  assert.equal((await request(path, { method: 'POST', headers: { ...headers, origin: 'http://127.0.0.1:8787', 'sec-fetch-site': 'same-origin' }, body })).status, 202);
  assert.equal((await c.state()).jobs[0].status, 'queued');
  assert.equal((await request('/api/sandboxes/space-http/actions', { method: 'POST', headers, body: '{"action":"delete"}' })).status, 400);
  assert.equal((await request('/api/sandboxes/space-nope/actions', { method: 'POST', headers, body: '{"action":"kill"}' })).status, 404);
});

test('HTTP validates body and only serves three allowlisted local static assets with security headers', async t => {
  const { request } = await httpFixture(t);
  const csrf = (await request()).data.csrfToken;
  const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf };
  for (const body of ['invalid', '[]', 'null', '{"name":"space-a","command":"bad"}']) {
    assert.equal((await request('/api/sandboxes', { method: 'POST', headers, body })).status, 400);
  }
  assert.equal((await request('/api/sandboxes', { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  const oversized = JSON.stringify({ name: 'x'.repeat(5000) });
  assert.equal((await request('/api/sandboxes', { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(oversized) }, body: oversized })).status, 413);
  assert.equal((await request('/api/sandboxes', { method: 'POST', headers: { ...headers, 'transfer-encoding': 'chunked' }, body: oversized })).status, 413);
  for (const path of ['/', '/index.html', '/app.js', '/style.css']) {
    const response = await request(path); assert.equal(response.status, 200); assert.match(response.text, /^safe/);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff'); assert.equal(response.headers['cache-control'], 'no-store');
  }
  for (const path of ['/controller.mjs', '/..%2fcontroller.mjs', '/api/unknown']) assert.equal((await request(path)).status, 404);
});

test('CLI calls only fixed local API, confirms delete exactly, and never prints CSRF or credentials', async () => {
  const calls = [], output = [];
  const state = { csrfToken: 'SECRET_CSRF', host: { cpuTotal: 18 }, policy: { maxRunning: 2 }, inventory: {},
    sandboxes: [{ ...vm('space-cli'), cpu: 8, memoryGiB: 14, diskGiB: 150, password: 'SECRET_PASSWORD' }], jobs: [] };
  const request = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/api/state') ? state : { job: { id: 'job', name: 'space-cli', action: 'delete', status: 'queued', password: 'SECRET_PASSWORD' } }));
  };
  await runCli(['list'], { request, print: text => output.push(text) });
  await runCli(['delete', 'space-cli', '--confirm', 'space-cli'], { request, print: text => output.push(text) });
  assert(calls.every(call => call.url.startsWith('http://127.0.0.1:8787/api/')));
  const mutation = calls.find(call => call.options.method === 'POST');
  assert.equal(mutation.options.headers['x-csrf-token'], 'SECRET_CSRF');
  assert.deepEqual(JSON.parse(mutation.options.body), { action: 'delete', confirmation: 'space-cli' });
  assert(!output.join('').includes('SECRET'));
  const before = calls.length;
  for (const args of [['delete', 'space-cli'], ['delete', 'space-cli', '--confirm', 'other'], ['start', 'space-a;bad'], ['shell', 'anything']]) {
    await assert.rejects(runCli(args, { request }), /Usage:/);
  }
  assert.equal(calls.length, before);
});

test('REST read endpoints expose sandboxes, one sandbox and jobs without secrets', async t => {
  const { c, request } = await httpFixture(t);
  const csrf = (await request()).data.csrfToken;
  const created = await request('/api/sandboxes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: '{"name":"space-rest"}' });
  assert.equal(created.status, 202);
  const list = await request('/api/sandboxes'); assert.equal(list.status, 200); assert(list.data.sandboxes.some(s => s.name === 'space-rest'));
  assert.equal(list.data.csrfToken, undefined);
  const one = await request('/api/sandboxes/space-rest'); assert.equal(one.status, 200); assert.equal(one.data.sandbox.name, 'space-rest');
  assert.equal((await request('/api/sandboxes/space-none')).status, 404);
  const job = await request(`/api/jobs/${created.data.job.id}`); assert.equal(job.status, 200); assert.equal(job.data.job.action, 'create');
  assert.equal((await request('/api/jobs/00000000-0000-0000-0000-000000000000')).status, 404);
  assert(!JSON.stringify([list.data, one.data, job.data]).includes('SECRET'));
  void c;
});

test('MCP server lists tools, enforces delete confirmation locally and drives the API with CSRF', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/state')) return new Response(JSON.stringify({ csrfToken: 'CSRF', host: { cpuTotal: 18, memoryGiB: 36, diskAvailableGiB: 300 }, policy: { maxRunning: 2 }, inventory: { activeCount: 0 }, sandboxes: [], jobs: [] }));
    return new Response(JSON.stringify({ job: { id: 'j', name: 'space-a', action: 'create', status: 'queued', password: 'SECRET' } }), { status: 202 });
  };
  const init = await mcpHandle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, request);
  assert.equal(init.result.serverInfo.name, 'mac-sandboxes'); assert(init.result.capabilities.tools);
  assert.equal(await mcpHandle({ jsonrpc: '2.0', method: 'notifications/initialized' }, request), null);
  const list = await mcpHandle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, request);
  assert.deepEqual(list.result.tools.map(t => t.name), mcpTools.map(t => t.name));
  assert(list.result.tools.find(t => t.name === 'delete_sandbox').annotations.destructiveHint);
  const denied = await mcpHandle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delete_sandbox', arguments: { name: 'space-a', confirm_name: 'space-b' } } }, request);
  assert.equal(denied.result.isError, true); assert.equal(calls.length, 0);
  const created = await mcpHandle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_sandbox', arguments: { name: 'space-a' } } }, request);
  assert.equal(created.result.isError, false); assert.equal(created.result.structuredContent.job.status, 'queued');
  const post = calls.find(call => call.options.method === 'POST');
  assert.equal(post.options.headers['x-csrf-token'], 'CSRF'); assert(post.url.endsWith('/api/sandboxes'));
  assert(!JSON.stringify(created).includes('SECRET'));
  const unknown = await mcpHandle({ jsonrpc: '2.0', id: 5, method: 'nope' }, request);
  assert.equal(unknown.error.code, -32601);
});

test('network MCP requires a per-person token, rejects browsers, honours revocation', async t => {
  const { createMcpServer } = await import('./mcp-http.mjs');
  const { createHash } = await import('node:crypto');
  const dir = mkdtempSync(join(here, '.test-mcp-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'tokens.json'); const token = 'a'.repeat(43);
  const save = revoked => writeFileSync(file, JSON.stringify({ tokens: [{ name: 'operator', hash: createHash('sha256').update(token).digest('hex'), ...(revoked ? { revokedAt: 'x' } : {}) }] }), { mode: 0o600 });
  save(false);
  const api = async url => new Response(JSON.stringify(url.endsWith('/api/state') ? { csrfToken: 'c', host: {}, policy: {}, inventory: {}, sandboxes: [], jobs: [] } : {}));
  const server = createMcpServer({ tokensFile: file, request: api });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const post = (body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await post(list)).status, 401);
  assert.equal((await post(list, { authorization: 'Bearer ' + 'b'.repeat(43) })).status, 401);
  assert.equal((await post(list, { authorization: 'Bearer ' + token, origin: 'http://evil.example' })).status, 403);
  const ok = await post(list, { authorization: 'Bearer ' + token });
  assert.equal(ok.status, 200); assert((await ok.json()).result.tools.some(x => x.name === 'create_sandbox'));
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { authorization: 'Bearer ' + token })).status, 202);
  save(true);
  assert.equal((await post(list, { authorization: 'Bearer ' + token })).status, 401);
});

test('exec runs only in a running provisioned sandbox via its pinned key and reports exit codes', async t => {
  const { c, fake, root } = fixture(t);
  assert.equal((await action(c, 'space-exec', 'create')).status, 'succeeded');
  mkdirSync(join(root, 'credentials'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'credentials/space-exec.json'), JSON.stringify({ username: 'spaceuser', verified: true }), { mode: 0o600 });
  const seen = [];
  c.execRunner = async (file, args) => { seen.push({ file, args }); if (args.at(-1) === 'false') throw Object.assign(new Error('x'), { code: 1, stdout: '', stderr: 'nope' }); return { stdout: 'hi\n', stderr: '' }; };
  const ok = await c.exec('space-exec', 'echo hi');
  assert.deepEqual(ok, { exitCode: 0, stdout: 'hi\n', stderr: '', timedOut: false });
  assert.equal(seen[0].file, '/usr/bin/ssh'); assert(seen[0].args.includes('StrictHostKeyChecking=yes'));
  assert(seen[0].args.includes('spaceuser@192.168.64.2')); assert.equal(seen[0].args.at(-1), 'echo hi');
  assert.equal((await c.exec('space-exec', 'false')).exitCode, 1);
  await assert.rejects(c.exec('space-exec', ''), /1-16384/);
  await assert.rejects(c.exec('space-unknown', 'id'), /not managed/);
  fake.rows.find(v => v.name === 'space-exec').status = 'stopped'; c.snapshot = null;
  await assert.rejects(c.exec('space-exec', 'id'), /not running/);
});

test('MCP run_command and get_login call the right places; connection_info gives a LAN desktop URL', async t => {
  const { callTool } = await import('./mcp.mjs');
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/state')) return new Response(JSON.stringify({ csrfToken: 'C' }));
    if (url.endsWith('/exec')) return new Response(JSON.stringify({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }));
    return new Response(JSON.stringify({ sandbox: { name: 'space-a', status: 'running', securityReady: true, desktopState: {ready: true, connected: true, port: 5901} } }));
  };
  const r = await callTool('run_command', { name: 'space-a', command: 'sw_vers', timeout_seconds: 30 }, request);
  assert.equal(r.stdout, 'ok');
  const post = calls.find(x => x.url.endsWith('/exec'));
  assert.deepEqual(JSON.parse(post.options.body), { command: 'sw_vers', timeoutSeconds: 30 }); assert.equal(post.options.headers['x-csrf-token'], 'C');
  const info = await callTool('connection_info', { name: 'space-a' }, request);
  assert.equal(info.name, 'space-a'); assert.equal(info.password, undefined); assert.equal(info.desktopPassword, undefined);
});

test('desktop is disabled by default: boot creates no VNC credentials and passes no password', async t => {
  const {c, fake, root} = fixture(t, {desktopEnabled: undefined});
  assert.equal(c.desktopEnabled, false);
  assert.equal((await action(c, 'space-private', 'create')).status, 'succeeded');
  const run = fake.calls.find(call => call.args[0] === 'run').args;
  assert.equal(run[run.indexOf('--vnc') + 1], 'disabled');
  assert(!run.includes('--vnc-port')); assert(!run.includes('--vnc-password'));
  assert(!existsSync(join(root, 'credentials/space-private.vnc')));
  assert(!existsSync(join(root, 'control/desktop-ports.json')));
  assert.equal((await c.state()).policy.desktopEnabled, false);
});

test('controller diagnostic redacts VNC password in args and both output streams', async t => {
  const {c, root} = fixture(t);
  const password = 'UniqueVncTestPassword';
  c.runner = async () => {throw Object.assign(new Error(password), {code: 12, stdout: 'out ' + password, stderr: password + ' stderr'});};
  await assert.rejects(c.invoke(['run', 'space-a', '--vnc-password', password]), /Command failed/);
  const text = readFileSync(join(root, 'control/last-command-error.log'), 'utf8');
  assert(!text.includes(password));
  const diagnostic = JSON.parse(text);
  assert.equal(diagnostic.args.at(-1), '[REDACTED]');
  assert.match(diagnostic.stdout, /\[REDACTED\]/); assert.match(diagnostic.stderr, /\[REDACTED\]/);
});

test('controller helpers share the configured root and desktop policy', async t => {
  const {c, fake, root} = fixture(t, {desktopEnabled: false});
  await action(c, 'space-env', 'create');
  const call = fake.calls.find(call => call.file === c.provisioner);
  assert.equal(call.config.env.SANDBOX_STATE_ROOT, root);
  assert.equal(call.config.env.SANDBOX_VM_STORAGE, root);
  assert.equal(call.config.env.SANDBOX_STATE_DIR, join(root, 'control'));
  assert.equal(call.config.env.SANDBOX_DESKTOP_ENABLED, '0');
});

test('desktop credentials and helper environment honor a state root separate from control directory', async t => {
  const {c, fake, root} = fixture(t);
  c.stateRoot = join(root, 'separate-private-root');
  assert.equal((await action(c, 'space-root', 'create')).status, 'succeeded');
  assert(existsSync(join(c.stateRoot, 'credentials/space-root.vnc')));
  assert(existsSync(join(c.stateRoot, 'credentials/space-root.vnc-upstream')));
  const run = fake.calls.find(call => call.args[0] === 'run');
  assert.equal(run.config.env.SANDBOX_STATE_ROOT, c.stateRoot);
  assert.equal(run.config.env.SANDBOX_STATE_DIR, join(root, 'control'));
  assert.equal((await action(c, 'space-root', 'stop')).status, 'succeeded');
  assert.equal((await action(c, 'space-root', 'delete', 'space-root')).status, 'succeeded');
  assert(!existsSync(join(c.stateRoot, 'credentials/space-root.vnc-upstream')));
});

test('large hosts are not incorrectly clamped to a private host memory size', async t => {
  const {c, fake} = fixture(t, {resources: () => ({cpuTotal: 32, memoryGiB: 128, diskGiB: 300})});
  fake.rows.push(vm('unmanaged', 'running', 32));
  assert.equal((await action(c, 'space-large', 'create')).status, 'succeeded');
});

test('runtime overrides stale Lume running and blocks SSH, start, delete and capacity release', async t => {
  for (const status of ['crashed', 'unknown']) {
    await t.test(status, async t => {
      const { c, fake } = fixture(t, { runtimeInspector: async row => ({
        status: row.name === 'macos-template' ? 'stopped' : status,
        processState: row.name === 'macos-template' ? 'stopped' : status === 'crashed' ? 'dead' : 'unknown',
      }) });
      seed(c, 'space-stale'); fake.rows.push(vm('space-stale', 'running'), vm('unmanaged-stale', 'running'));
      c.execRunner = async () => assert.fail('No SSH for unproved runtime');
      await assert.rejects(c.exec('space-stale', 'true'), /not running/);
      const state = await c.state(), row = state.sandboxes[0];
      assert.equal(row.status, status); assert.equal(row.ipAddress, null);
      assert.equal(row.runtime.guestSsh, 'unverified'); assert.equal(state.inventory.activeCount, 2);
      const described = describeSandboxes(state.sandboxes, state.inventory);
      assert.equal(described[0].canExec, false); assert.equal(described[0].active, null);
      assert.equal(described[0].running, status === 'crashed' ? false : null);
      assert.equal(filterSandboxes(described, 'active').length, 1);
      assert.equal(filterSandboxes(described, 'running').length, 0);
      assert.match((await action(c, 'space-stale', 'start')).error, /must be stopped/);
      assert.match((await action(c, 'space-stale', 'delete', 'space-stale')).error, /Stop or kill/);
      assert.match((await action(c, 'space-blocked', 'create')).error, /Maximum two/);
      assert(fake.calls.every(call => call.args[0] === 'ls'), 'inspection never repairs, kills or restarts VMs');
    });
  }
});

test('injected runtime failures are unknown and never disclose provider diagnostics', async t => {
  const { c, fake } = fixture(t, { runtimeInspector: async () => { throw new Error('SECRET_PROCESS_ARGS'); } });
  seed(c, 'space-a'); fake.rows.push(vm('space-a', 'running'));
  const state = await c.state();
  assert.equal(state.sandboxes[0].status, 'unknown'); assert.equal(state.inventory.activeCount, 2);
  assert(!JSON.stringify(state).includes('SECRET')); assert.equal(state.policy.templateReady, false);
});

test('incomplete or contradictory runtime provider proof cannot enable execution', async t => {
  for (const health of [null, {}, { status: 'running' }, { status: 'running', processState: 'dead' }, { status: 'stopped', processState: 'unknown' }]) {
    const { c, fake } = fixture(t, { runtimeInspector: async () => health });
    seed(c, 'space-unproved'); fake.rows.push(vm('space-unproved', 'running'));
    const state = await c.state();
    assert.equal(state.sandboxes[0].status, 'unknown');
    assert.equal(describeSandboxes(state.sandboxes, state.inventory)[0].canExec, false);
  }
});

test('inventory and async runtime inspector use the configured custom storage and Lume path', async t => {
  const inspected = [];
  const { c, fake, options } = fixture(t, { runtimeInspector: async (row, context) => {
    await Promise.resolve(); inspected.push({ row, context });
    return { status: row.status, processState: row.status };
  } });
  await c.inventory();
  assert.deepEqual(fake.calls[0].args, ['ls', '--storage', options.storage, '--format', 'json']);
  assert.deepEqual(inspected[0].context, { storage: options.storage, lume: options.lume });
});

test('lifecycle completion invalidates a previously cached running inventory immediately', async t => {
  const { c, fake } = fixture(t);
  seed(c, 'space-cache'); fake.rows.push(vm('space-cache', 'running'));
  assert.equal((await c.state()).sandboxes[0].status, 'running');
  assert.equal((await action(c, 'space-cache', 'kill')).status, 'succeeded');
  assert.equal((await c.state()).sandboxes[0].status, 'stopped');
  assert.equal((await action(c, 'space-cache', 'start')).status, 'succeeded');
  assert.equal((await c.state()).sandboxes[0].status, 'running');
});

test('a pre-completion in-flight inventory refresh cannot restore the old snapshot', async t => {
  const { c, fake } = fixture(t);
  seed(c, 'space-race'); fake.rows.push(vm('space-race', 'running'));
  const original = c.inventory.bind(c);
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  let first = true;
  c.inventory = async () => {
    const rows = await original();
    if (first) { first = false; started(); await new Promise(resolve => { release = resolve; }); }
    return rows;
  };
  const state = c.state(); await waiting;
  assert.equal((await action(c, 'space-race', 'kill')).status, 'succeeded');
  release();
  assert.equal((await state).sandboxes[0].status, 'stopped');
  assert.equal((await c.state()).sandboxes[0].status, 'stopped');
});

test('desktop boot uses distinct private upstream credentials, never human password in Lume argv', async t => {
  const {c, fake, root} = fixture(t);
  assert.equal((await action(c, 'space-relay', 'create')).status, 'succeeded');
  const human = readFileSync(join(root, 'credentials/space-relay.vnc'), 'utf8');
  const upstream = readFileSync(join(root, 'credentials/space-relay.vnc-upstream'), 'utf8');
  assert.notEqual(human, upstream); assert.match(upstream, /^[A-Za-z0-9]{8}$/);
  const run = fake.calls.find(call => call.args[0] === 'run').args;
  assert.equal(run[run.indexOf('--vnc-password') + 1], upstream); assert(!run.includes(human));
  assert.equal(run[run.indexOf('--vnc-port') + 1], '15901');
  assert.deepEqual(c.desktopFor('space-relay'), {port: 5901, password: human, upstreamPassword: upstream});
});

test('console faults retain partial-boot reservation without killing or retrying compute', async t => {
  const {c, fake} = fixture(t, {consoleCheck: () => ({ready: false, connected: false, reason: 'stale', error: 'SECRET'})});
  const result = await action(c, 'space-partial', 'create');
  assert.equal(result.status, 'failed'); assert.match(result.error, /not ready/);
  assert.equal(c.owned('space-partial').reserved, 1);
  const row = (await c.state()).sandboxes[0];
  assert.equal(row.status, 'running'); assert.equal(row.desktopState.ready, false); assert.equal(row.desktopState.reason, 'stale');
  assert(!JSON.stringify(row).includes('SECRET'));
  assert.match((await action(c, 'space-partial', 'start')).error, /unresolved/);
  assert.equal(fake.calls.filter(call => call.args[0] === 'run').length, 1);
  assert(!fake.calls.some(call => call.args[0] === 'stop'));
});

test('headless startup also waits for pinned guest SSH before releasing its reservation', async t => {
  const {c, fake} = fixture(t, {desktopEnabled: false, guestProbe: async () => false});
  assert.match((await action(c, 'space-ssh', 'create')).error, /Guest SSH/);
  assert.equal(c.owned('space-ssh').reserved, 1);
  assert.equal((await c.state()).sandboxes[0].status, 'running');
  assert.equal(fake.calls.filter(call => call.args[0] === 'run').length, 1);
});

test('boot cannot finish on console proof alone; both probes succeed before reservation release', async t => {
  let checks = 0;
  const {c} = fixture(t, {bootTimeoutMs: 100, guestProbe: async () => ++checks > 1});
  assert.equal((await action(c, 'space-both', 'create')).status, 'succeeded');
  assert(checks >= 2); assert.equal(c.owned('space-both').reserved, 0);
});

test('MCP refuses console URL when compute runs but console is unready', async () => {
  const {callTool} = await import('./mcp.mjs');
  const request = async () => new Response(JSON.stringify({sandbox: {name: 'space-a', status: 'running', securityReady: true,
    desktopState: {ready: false, connected: false, reason: 'stale', port: 5901}}}));
  await assert.rejects(callTool('connection_info', {name: 'space-a'}, request), /console is not ready/);
});

test('dashboard desktop password: POST+CSRF only, relay password only, never created, gated on running+ready', async t => {
  let consoleReady = true;
  const f = fixture(t, {consoleCheck: () => consoleReady ? {ready: true, connected: true, reason: 'ready'} : {ready: false, connected: false, reason: 'stale'}});
  const {c, root, fake} = f;
  assert.equal((await action(c, 'space-desk', 'create')).status, 'succeeded');
  const human = readFileSync(join(root, 'credentials/space-desk.vnc'), 'utf8');
  const upstream = readFileSync(join(root, 'credentials/space-desk.vnc-upstream'), 'utf8');
  const publicDir = join(root, 'public'); mkdirSync(publicDir);
  const server = createServer(c, {publicDir});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = (path, {method = 'POST', headers = {}, body = '{}'} = {}) => new Promise((resolve, reject) => {
    const req = http.request({hostname: '127.0.0.1', port: server.address().port, path, method, headers: {host: '127.0.0.1:8787', ...headers}}, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', d => text += d);
      res.on('end', () => { let data; try { data = JSON.parse(text); } catch {} resolve({status: res.statusCode, headers: res.headers, data, text}); });
    });
    req.on('error', reject); req.end(method === 'GET' ? undefined : body);
  });
  const csrf = (await request('/api/state', {method: 'GET'})).data.csrfToken;
  const ok = {'content-type': 'application/json', 'x-csrf-token': csrf};
  const path = '/api/sandboxes/space-desk/desktop-password';
  assert.equal((await request(path, {method: 'GET'})).status, 404);
  assert.equal((await request(path, {headers: {'content-type': 'application/json'}})).status, 403);
  assert.equal((await request(path, {headers: {...ok, origin: 'http://evil.example'}})).status, 403);
  assert.equal((await request(path, {headers: ok, body: '{"extra":1}'})).status, 400);
  const good = await request(path, {headers: ok});
  assert.equal(good.status, 200); assert.equal(good.headers['cache-control'], 'no-store');
  assert.deepEqual(good.data, {name: 'space-desk', port: 5901, password: human});
  assert(!good.text.includes(upstream));
  // State/listing endpoints still never carry the password.
  assert(!(await request('/api/state', {method: 'GET'})).text.includes(human));
  consoleReady = false;
  assert.equal((await request(path, {headers: ok})).status, 409);
  consoleReady = true;
  fake.rows.find(v => v.name === 'space-desk').status = 'stopped'; c.snapshot = null;
  assert.equal((await request(path, {headers: ok})).status, 409);
  assert.equal((await request('/api/sandboxes/space-none/desktop-password', {headers: ok})).status, 404);
  // Never mints a credential that does not already exist.
  fake.rows.find(v => v.name === 'space-desk').status = 'running';
  rmSync(join(root, 'credentials/space-desk.vnc'));
  assert.equal((await request(path, {headers: ok})).status, 503);
  assert(!existsSync(join(root, 'credentials/space-desk.vnc')));
});

test('dashboard desktop password is refused when remote desktop is disabled', async t => {
  const {c} = fixture(t, {desktopEnabled: false});
  assert.equal((await action(c, 'space-off', 'create')).status, 'succeeded');
  await assert.rejects(c.desktopLogin('space-off'), /disabled/);
});
