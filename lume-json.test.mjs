import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseLumeJSON} from './lume-json.mjs';
import {parseInventory, ControlError} from './controller.mjs';

const timestamp = '[2026-10-16T23:40:57Z]';
const cleanup = `${timestamp} INFO: Cleaned up stale session file name=space-example`;

test('plain Lume arrays, objects and empty inventories retain their JSON values', () => {
  for (const value of [[], [{name: 'space-example', status: 'stopped'}], {status: 'running'}, null, true, 2, 'INFO']) {
    assert.deepEqual(parseLumeJSON(JSON.stringify(value)), value);
  }
});

test('normal stop cleanup INFO is not mistaken for the beginning of a JSON array', () => {
  assert.deepEqual(parseLumeJSON(`${cleanup}\n[\n {"name":"space-example","status":"stopped"}\n]\n`),
    [{name: 'space-example', status: 'stopped'}]);
});

test('only complete recognized log lines are removed, including interleaved DEBUG and WARN', () => {
  const stdout = `\u001b[32m${cleanup}\u001b[0m\r\n[\r\n${timestamp} DEBUG: Reading VM details\r\n{\r\n  "WARN": "keep this JSON field",\r\n${timestamp} WARN: Stale session removed\r\n  "status": "stopped"\r\n}\r\n]\r\n${timestamp} INFO: Finished\r\n`;
  assert.deepEqual(parseLumeJSON(stdout), [{WARN: 'keep this JSON field', status: 'stopped'}]);
  assert.deepEqual(parseLumeJSON('\u001b[36m[]\u001b[0m'), []);
});

test('JSON string content, escaped ANSI, quotes, backslashes and log-like fields are preserved', () => {
  const value = {
    WARN: `${timestamp} WARN: a value, not a log`,
    text: `before\n${cleanup}\nafter`,
    ansi: '\u001b[31mnot terminal decoration\u001b[0m',
    escaped: '\\"quoted"\\',
    DEBUG: 'still a field',
  };
  assert.deepEqual(parseLumeJSON(`${cleanup}\n${JSON.stringify(value, null, 2)}`), value);
});

test('malformed, missing, unknown and error output fail closed without leaking stdout', () => {
  const sensitive = 'fixture-private-value';
  for (const stdout of [
    '', ' \n', cleanup, `${timestamp} ERROR: ${sensitive}`, `${timestamp} ERROR: ${sensitive}\n[]`,
    `${timestamp} TRACE: ${sensitive}\n[]`, `INFO: ${sensitive}\n[]`, `${sensitive}\n[]`,
    `${cleanup}\n[{"password":"${sensitive}",}]`, `[]\n${sensitive}`, '[] []',
    `${cleanup}\n[`, `${cleanup} []`, `[{"WARN": "${sensitive}"`,
    `{"value":"before\n${cleanup}\nafter"}`, '{"value":"\u001b[31mraw escape"}',
    null, undefined, Buffer.from('[]'),
  ]) {
    assert.throws(() => parseLumeJSON(stdout), error => {
      assert.equal(error.name, 'SyntaxError');
      assert.equal(error.message, 'Lume JSON output is invalid.');
      assert.equal(error.cause, undefined);
      assert.equal(Object.keys(error).length, 0);
      assert(!error.stack.includes(sensitive));
      return true;
    });
  }
});

test('inventory uses the shared parser but retains generic ControlError and field allowlisting', () => {
  const row = {name: 'space-example', status: 'stopped', locationName: 'default', os: 'macOS',
    cpuCount: 8, memorySize: 14 * 2 ** 30, diskSize: {allocated: 1, total: 150 * 2 ** 30},
    vncUrl: 'fixture-private-value'};
  const parsed = parseInventory(`${cleanup}\n${JSON.stringify([row], null, 2)}`);
  assert.equal(parsed[0].status, 'stopped');
  assert.equal(parsed[0].vncUrl, undefined);
  assert.throws(() => parseInventory(`${timestamp} ERROR: fixture-private-value\n[]`), error => {
    assert(error instanceof ControlError);
    assert.equal(error.status, 503);
    assert.equal(error.message, 'Lume inventory is invalid.');
    return true;
  });
});

test('power confirms a normal stop after cleanup INFO without replaying the shutdown mutation', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lume-json-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(path.join(root, 'credentials'));
  writeFileSync(path.join(root, 'credentials', 'space-example.json'), JSON.stringify({
    verified: true, username: 'spaceuser', password: 'fixture-password',
  }));
  const calls = path.join(root, 'calls.jsonl');
  const preload = path.join(root, 'mock-commands.mjs');
  // Replace every spawn before power.mjs is imported: neither Lume nor SSH nor
  // any live VM is invoked. The only credentials are the temporary fixture above.
  writeFileSync(preload, `
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {appendFileSync} from 'node:fs';
let reads = 0, stopped = false;
childProcess.spawn = (file, args) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => {throw new Error('Unexpected timeout.');};
  const isGet = file === 'fixture-lume' && args[0] === 'get';
  const isShutdown = file === '/usr/bin/ssh' && args.at(-1).includes('/sbin/shutdown -h now');
  if (!isGet && !isShutdown) throw new Error('Unexpected command.');
  appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(isGet ? 'get' : 'shutdown') + '\\n');
  child.stdin.on('finish', () => process.nextTick(() => {
    if (isGet) {
      reads++;
      if (reads > 1 && !stopped) throw new Error('Shutdown not requested.');
      const value = [{name: 'space-example', status: stopped ? 'stopped' : 'running', ipAddress: '192.0.2.2'}];
      child.stdout.write((stopped ? ${JSON.stringify(cleanup + '\n')} : '') + JSON.stringify(value));
    } else stopped = true;
    child.stdout.end(); child.stderr.end(); child.emit('close', 0);
  }));
  return child;
};
syncBuiltinESMExports();
`);
  const stdout = execFileSync(process.execPath, ['--import', preload, fileURLToPath(new URL('./power.mjs', import.meta.url)), 'space-example'], {
    encoding: 'utf8', timeout: 10000,
    env: {...process.env, NODE_OPTIONS: '', LUME_BIN: 'fixture-lume', SANDBOX_STATE_ROOT: root,
      SANDBOX_VM_STORAGE: path.join(root, 'vm-storage'), FIXTURE_CALLS: calls},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(stdout, 'Sandbox stopped gracefully.\n');
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)), ['get', 'shutdown', 'get']);
});
