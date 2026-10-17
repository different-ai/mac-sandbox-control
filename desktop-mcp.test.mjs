import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

test('MCP login distinguishes console readiness and never returns native upstream credentials', t => {
  const root = mkdtempSync(join(import.meta.dirname, '.test-mcp-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'credentials'));
  writeFileSync(join(root, 'credentials/space-a.json'), JSON.stringify({verified: true, username: 'spaceuser', password: 'AccountFixture!'}));
  writeFileSync(join(root, 'credentials/space-a.vnc'), 'Human123');
  writeFileSync(join(root, 'credentials/space-a.vnc-upstream'), 'Priv1234');
  const script = `
    const {callTool} = await import('./mcp.mjs');
    const output = [];
    for (const ready of [false, true]) {
      const request = async () => new Response(JSON.stringify({sandbox: {name: 'space-a', status: 'running', securityReady: true,
        desktopState: {ready, connected: ready, reason: ready ? 'ready' : 'not-ready', port: 5901}}}));
      output.push(await callTool('get_login', {name: 'space-a'}, request));
    }
    process.stdout.write(JSON.stringify(output));
  `;
  const text = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: import.meta.dirname, encoding: 'utf8', env: {...process.env, SANDBOX_STATE_ROOT: root, SANDBOX_DESKTOP_ENABLED: '1', SANDBOX_PUBLIC_HOST: 'mac-host.local'},
  });
  const [unready, ready] = JSON.parse(text);
  assert.equal(unready.desktop, null); assert.equal(unready.desktopPassword, null);
  assert.equal(unready.desktopState.ready, false); assert.equal(unready.macPassword, 'AccountFixture!');
  assert.equal(ready.desktop, 'vnc://mac-host.local:5901'); assert.equal(ready.desktopPassword, 'Human123');
  assert(!text.includes('Priv1234'));
});
