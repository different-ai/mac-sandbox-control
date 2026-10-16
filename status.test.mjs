import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describeSandbox, describeSandboxes, filterSandboxes, stateCounts, formatSandboxTable, parseListArgs} from './sandbox-status.mjs';
import {runCli} from './cli.mjs';
import {runClient} from './sandbox-client.mjs';
import {callTool, tools} from './mcp.mjs';

const vm = (name, status, extra = {}) => ({name, status, securityReady: true, cpu: 8, memoryGiB: 14, diskGiB: 150, ...extra});
const rows = [vm('space-1', 'running'), vm('space-2', 'stopped')];
const inventory = {activeCount: 1, updatedAt: '2026-10-16T22:00:00.000Z', error: null};
const state = {csrfToken: 'PRIVATE_TOKEN', sandboxes: rows, jobs: [], policy: {maxRunning: 2}, inventory, host: {cpuTotal: 18, memoryGiB: 36, diskAvailableGiB: 288}};

test('setup-ready is explicitly separate from active, running and exec eligibility', () => {
  const [running, stopped] = describeSandboxes(rows, inventory);
  assert.equal(running.active, true); assert.equal(running.running, true); assert.equal(running.canExec, true);
  assert.equal(stopped.ready, true); assert.equal(stopped.active, false); assert.equal(stopped.running, false); assert.equal(stopped.canExec, false);
  assert.match(stopped.note, /Start this sandbox/); assert.equal(running.observedAt, inventory.updatedAt);
  assert.equal(describeSandbox(vm('space-x', 'running', {securityReady: false})).canExec, false);
});

test('starting and unknown states do not become stopped or executable', () => {
  const starting = describeSandbox(vm('space-start', 'stopped', {starting: true}));
  assert.equal(starting.state, 'starting'); assert.equal(starting.active, true); assert.equal(starting.canExec, false);
  const unknown = describeSandbox(vm('space-unknown', 'running'), {verified: false});
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.active, null); assert.equal(unknown.running, null); assert.equal(unknown.canExec, false);
  assert.equal(filterSandboxes([starting, unknown], 'active').length, 2);
  assert.equal(filterSandboxes([starting, unknown], 'stopped').length, 0);
});

test('ls/ps filters and counts match explicit VM state', () => {
  const described = describeSandboxes([...rows, vm('space-start', 'stopped', {starting: true}), vm('space-unknown', 'unknown')]);
  assert.deepEqual(stateCounts(described), {total: 4, running: 1, stopped: 1, transitioning: 1, unknown: 1});
  assert.deepEqual(filterSandboxes(described, 'active').map(s => s.name), ['space-1', 'space-start', 'space-unknown']);
  assert.deepEqual(filterSandboxes(described, 'running').map(s => s.name), ['space-1']);
  assert.deepEqual(filterSandboxes(described, 'stopped').map(s => s.name), ['space-2']);
});

test('table shows clear state/active/exec columns and warns on unknown inventory', () => {
  const table = formatSandboxTable(describeSandboxes(rows, inventory), {activeVMs: 1});
  assert.match(table, /NAME\s+STATE\s+ACTIVE\s+EXEC/);
  assert.match(table, /space-1\s+RUNNING\s+yes\s+yes/);
  assert.match(table, /space-2\s+STOPPED\s+no\s+no/);
  assert.match(table, /1 running, 1 stopped/); assert.match(table, /1\/2 active/);
  const failed = formatSandboxTable(describeSandboxes(rows, {error: 'offline'}), {inventoryError: 'offline'});
  assert.match(failed, /UNKNOWN\s+\?\s+no/); assert.match(failed, /WARNING: host state could not be verified/);
});

test('list command flags preserve legacy JSON and support ps -a', () => {
  assert.deepEqual(parseListArgs('list', []), {json: true, filter: 'all'});
  assert.deepEqual(parseListArgs('ls', []), {json: false, filter: 'all'});
  assert.deepEqual(parseListArgs('ps', []), {json: false, filter: 'active'});
  assert.deepEqual(parseListArgs('ps', ['-a', '--json']), {json: true, filter: 'all'});
  for (const flags of [['--bad'], ['--json', '--json'], ['-a', '--all']]) assert.throws(() => parseListArgs('ps', flags), /Usage:/);
});

test('host CLI ls/ps and JSON expose state without secrets or mutations', async () => {
  const printed = [], calls = [];
  const request = async (url, opts) => {calls.push({url, opts}); return new Response(JSON.stringify(state));};
  await runCli(['ls'], {request, print: s => printed.push(s)}); assert.match(printed.pop(), /space-2\s+STOPPED/);
  await runCli(['ps'], {request, print: s => printed.push(s)}); const ps = printed.pop(); assert.match(ps, /space-1\s+RUNNING/); assert(!ps.includes('space-2'));
  await runCli(['ps', '-a', '--json'], {request, print: s => printed.push(s)}); const data = JSON.parse(printed.pop()); assert.equal(data[1].active, false);
  await runCli(['list'], {request, print: s => printed.push(s)}); assert.equal(JSON.parse(printed.pop()).length, 2);
  assert(calls.every(c => !c.opts.method)); assert(!JSON.stringify(data).includes('PRIVATE_TOKEN'));
});

function mcpRequest() {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === 'notifications/initialized') return new Response(null, {status: 202});
    return new Response(JSON.stringify({jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? {} : {structuredContent: {...state, activeVMs: 1}, isError: false}}));
  };
}
const env = {MAC_SANDBOX_TOKEN: 'x'.repeat(43)};

test('client CLI ls/ps/status clearly distinguish stopped from ready', async () => {
  const printouts = []; const options = {request: mcpRequest(), env, print: s => printouts.push(s)};
  await runClient(['ls'], options); assert.match(printouts.pop(), /space-2\s+STOPPED\s+no\s+no/);
  await runClient(['ps'], options); assert(!printouts.pop().includes('space-2'));
  await runClient(['ps', '-a', '--json'], options); assert.equal(JSON.parse(printouts.pop())[1].active, false);
  await runClient(['status', 'space-2'], options); assert.match(printouts.pop(), /Start this sandbox/); printouts.pop();
  await assert.rejects(runClient(['ps', '--bad'], options), /Usage:/);
  await assert.rejects(runClient(['status', '../bad'], options), /Usage:/);
});

test('MCP list supports ls/ps filters, gives explicit booleans and preserves full counts', async () => {
  const request = async () => new Response(JSON.stringify(state));
  const all = await callTool('list_sandboxes', {}, request);
  assert.equal(all.sandboxes[0].active, true); assert.equal(all.sandboxes[1].active, false); assert.equal(all.sandboxes[1].canExec, false);
  assert.deepEqual(all.counts, {total: 2, running: 1, stopped: 1, transitioning: 0, unknown: 0});
  const active = await callTool('list_sandboxes', {status: 'active'}, request);
  assert.equal(active.sandboxes.length, 1); assert.equal(active.counts.total, 2); assert.equal(active.counts.stopped, 1);
  const stopped = await callTool('list_sandboxes', {status: 'stopped'}, request); assert.equal(stopped.sandboxes[0].name, 'space-2');
  assert.equal(all.inventory.updatedAt, inventory.updatedAt);
  assert(!JSON.stringify(all).includes('PRIVATE_TOKEN'));
  assert.deepEqual(tools.find(t => t.name === 'list_sandboxes').inputSchema.properties.status.enum, ['all', 'active', 'running', 'stopped']);
  await assert.rejects(callTool('list_sandboxes', {status: 'bad'}, request), /status must be/);
});

test('MCP inventory errors return unknown instead of false inactive status', async () => {
  const request = async () => new Response(JSON.stringify({...state, inventory: {error: 'Inventory unavailable', activeCount: null}}));
  const result = await callTool('list_sandboxes', {status: 'active'}, request);
  assert.equal(result.sandboxes.length, 2); assert(result.sandboxes.every(s => s.active === null && !s.canExec));
  assert.equal(result.activeVMs, null); assert.equal(result.counts.unknown, 2);
});
