import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {root, shellQuote, xml, installFile, wrapper, launchAgent, serviceEntries} from './scripts/install-util.mjs';
import {desktopScript, kcpassword} from './guest.mjs';

test('installer escaping preserves literal shell arguments and XML text', () => {
  const value = "a path; printf NO '$HOME' & <x>";
  assert.equal(execFileSync('/bin/sh', ['-c', 'printf %s ' + shellQuote(value)], {encoding: 'utf8'}), value);
  assert.equal(xml('<x a="v">&\''), '&lt;x a=&quot;v&quot;&gt;&amp;&apos;');
  const script = wrapper('cli.mjs', {environment: true});
  assert(script.includes('--env-file-if-exists=')); assert(script.includes('export NODE_BIN='));
  const plist = launchAgent(serviceEntries[0], '/private/example-state');
  assert(plist.includes('<key>KeepAlive</key><true/>')); assert(plist.includes('controller.log'));
});

test('installer refuses to overwrite an unrelated existing file', async t => {
  const dir = await fs.mkdtemp(path.join(root, '.test-install-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'command');
  await installFile(file, 'original\n');
  await installFile(file, 'original\n');
  await assert.rejects(installFile(file, 'different\n'), /Refusing to replace/);
  assert.equal(await fs.readFile(file, 'utf8'), 'original\n');
});

test('setup help is side-effect-free and does not require a real VM or Lume', () => {
  for (const file of ['init-template.mjs', 'host-install.mjs', 'host-services.mjs', 'client-install.mjs']) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', file), '--help'], {encoding: 'utf8', env: {...process.env, LUME_BIN: '/nonexistent-test-lume'}});
    assert.equal(result.status, 0, file + ': ' + result.stderr); assert(result.stdout.length > 0);
  }
});

test('optional relay LaunchAgent uses Node host.env launcher and configured NODE_BIN', () => {
  const relay = serviceEntries.find(service => service.desktopOnly);
  assert.equal(relay.entry, 'desktop-relay.mjs');
  const old = process.env.NODE_BIN;
  process.env.NODE_BIN = '/example/custom-node';
  try {
    const plist = launchAgent(relay, '/example/private-state');
    assert(plist.includes('/example/custom-node')); assert(plist.includes('--env-file-if-exists='));
    assert(plist.includes('desktop-relay.mjs')); assert(!plist.includes('vnc_relay.py'));
    assert(wrapper('desktop-relay.mjs').includes("export NODE_BIN='/example/custom-node'"));
  } finally { if (old === undefined) delete process.env.NODE_BIN; else process.env.NODE_BIN = old; }
});

test('opt-in auto-login does not enable a separate guest Screen Sharing listener', () => {
  const script = desktopScript('spaceuser', 'fixture-only');
  assert(script.includes('/etc/kcpassword')); assert(!script.includes('com.apple.screensharing'));
  assert.equal(kcpassword('lume').toString('hex'), '11fc3f46d2bcddeaa3b91f7d');
});
