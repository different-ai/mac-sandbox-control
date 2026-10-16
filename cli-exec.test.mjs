import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {parseExecArgs, renderExecResult} from './exec-options.mjs';
import {runCli} from './cli.mjs';
import {runClient} from './sandbox-client.mjs';

const response = result => new Response(JSON.stringify(result));
const success = {exitCode: 0, stdout: 'macOS\n', stderr: '', timedOut: false};

test('exec parses explicit shell strings, timeouts, JSON and literal argv safely', () => {
  assert.deepEqual(parseExecArgs(['space-1', '--timeout', '60', '--json', '--', 'cd /tmp && pwd']), {
    name: 'space-1', command: 'cd /tmp && pwd', timeoutSeconds: 60, json: true,
  });
  const literal = "one two; printf BAD '$HOME' $(printf PWN)";
  const parsed = parseExecArgs(['space-1', '--', 'printf', '%s', literal]);
  assert.equal(execFileSync('/bin/sh', ['-c', parsed.command], {encoding: 'utf8'}), literal);
  assert.equal(parsed.timeoutSeconds, 120);
});

test('invalid exec input is rejected before dispatch', () => {
  for (const args of [[], ['space-1'], ['space-1', '--'], ['space-1', '--', ''], ['../bad', '--', 'id'],
    ['space-1', '--timeout', '0', '--', 'id'], ['space-1', '--timeout', '601', '--', 'id'],
    ['space-1', '--timeout', '2.5', '--', 'id'], ['space-1', '--json', '--json', '--', 'id'],
    ['space-1', '--bad', '--', 'id'], ['space-1', '--', 'a\0b'], ['space-1', '--', 'x'.repeat(16385)]]) {
    assert.throws(() => parseExecArgs(args), /Usage:/);
  }
});

test('exec preserves stdout, stderr, exit status, JSON and timeout status', () => {
  const out = [], err = [], printed = [];
  const io = {stdout: s => out.push(s), stderr: s => err.push(s), print: s => printed.push(s)};
  assert.equal(renderExecResult({exitCode: 7, stdout: 'out', stderr: 'err', timedOut: false}, io), 7);
  assert.deepEqual(out, ['out']); assert.deepEqual(err, ['err']);
  assert.equal(renderExecResult({...success, timedOut: true, exitCode: null}, {...io, json: true}), 124);
  assert.equal(JSON.parse(printed[0]).timedOut, true);
  assert.throws(() => renderExecResult({stdout: 'bad'}), /Invalid exec response/);
});

test('host CLI exec uses the controller API with CSRF and preserves guest status', async () => {
  const calls = [], out = [], err = [];
  const request = async (url, options) => {
    calls.push({url, options});
    if (url.endsWith('/api/state')) return response({csrfToken: 'PRIVATE_CSRF'});
    return response({exitCode: 7, stdout: 'hello\n', stderr: 'warning\n', timedOut: false});
  };
  const code = await runCli(['exec', 'space-1', '--timeout', '60', '--', 'printf', '%s', 'hello world'], {request, stdout: s => out.push(s), stderr: s => err.push(s)});
  assert.equal(code, 7); assert.deepEqual(out, ['hello\n']); assert.deepEqual(err, ['warning\n']);
  const call = calls[1]; assert.equal(call.url, 'http://127.0.0.1:8787/api/sandboxes/space-1/exec');
  assert.equal(call.options.headers['x-csrf-token'], 'PRIVATE_CSRF');
  assert.deepEqual(JSON.parse(call.options.body), {command: "'printf' '%s' 'hello world'", timeoutSeconds: 60});
  assert(![...out, ...err].join('').includes('PRIVATE_CSRF'));
});

test('host CLI JSON output and stopped-VM error are returned without retry', async () => {
  let count = 0; const printed = [];
  const request = async url => {count++; return response(url.endsWith('/api/state') ? {csrfToken: 'c'} : success);};
  assert.equal(await runCli(['exec', 'space-1', '--json', '--', 'sw_vers'], {request, print: s => printed.push(s)}), 0);
  assert.deepEqual(JSON.parse(printed[0]), success); assert.equal(count, 2);
  await assert.rejects(runCli(['exec', 'space-1', '--', 'id'], {request: async url => url.endsWith('/api/state') ? response({csrfToken: 'c'}) : new Response('{"error":"space-1 is not running. Start it first."}', {status: 409})}), /not running/);
});

function fakeMcp(result = success) {
  const calls = [];
  const request = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({url, options, body});
    if (body.method === 'notifications/initialized') return new Response(null, {status: 202});
    if (body.method === 'initialize') return response({jsonrpc: '2.0', id: body.id, result: {protocolVersion: '2025-06-18'}});
    return response({jsonrpc: '2.0', id: body.id, result: {structuredContent: result, isError: false}});
  };
  return {calls, request};
}
const env = {MAC_SANDBOX_TOKEN: 'x'.repeat(43), MAC_SANDBOX_URL: 'http://100.64.0.10:8788/mcp'};

test('client CLI exec uses network MCP, not host SSH, with separate output streams', async () => {
  const {calls, request} = fakeMcp({exitCode: 9, stdout: 'out\n', stderr: 'err\n', timedOut: false});
  const out = [], err = [];
  const code = await runClient(['exec', 'space-1', '--timeout', '30', '--', 'echo hello'], {request, env, stdout: s => out.push(s), stderr: s => err.push(s)});
  assert.equal(code, 9); assert.deepEqual(out, ['out\n']); assert.deepEqual(err, ['err\n']);
  assert.equal(calls.length, 3); assert(calls.every(c => c.url === env.MAC_SANDBOX_URL));
  assert.deepEqual(calls[2].body.params, {name: 'run_command', arguments: {name: 'space-1', command: 'echo hello', timeout_seconds: 30}});
  assert.equal(calls[2].options.headers.authorization, 'Bearer ' + env.MAC_SANDBOX_TOKEN);
});

test('client CLI list and JSON output work through MCP', async () => {
  const m = fakeMcp({sandboxes: [{name: 'space-1', status: 'running'}]}); const printed = [];
  assert.equal(await runClient(['list'], {request: m.request, env, print: s => printed.push(s)}), 0);
  assert.equal(JSON.parse(printed[0])[0].name, 'space-1');
  const json = []; const exec = fakeMcp({...success, timedOut: true, exitCode: null});
  assert.equal(await runClient(['exec', 'space-1', '--json', '--', 'sleep 5'], {request: exec.request, env, print: s => json.push(s)}), 124);
  assert.equal(JSON.parse(json[0]).timedOut, true);
});

test('client CLI validates before dispatch and reports token rejection clearly', async () => {
  let count = 0;
  const request = async () => {count++; return new Response(null, {status: 401});};
  await assert.rejects(runClient(['exec', 'space-1'], {request, env}), /Usage:/); assert.equal(count, 0);
  await assert.rejects(runClient(['list'], {request, env}), /rejected or revoked/); assert.equal(count, 1);
});
