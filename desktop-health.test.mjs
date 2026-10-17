import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, lstatSync, rmSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {inspectDesktopHealth} from './desktop-health.mjs';

function fixture(t) {
  const root = mkdtempSync(join(import.meta.dirname, '.test-state-'));
  const stateDir = join(root, 'control'), storage = join(root, 'vms');
  mkdirSync(stateDir); mkdirSync(join(storage, 'space-a'), {recursive: true});
  const owner = join(storage, 'space-a', '.native-display-owner.json');
  writeFileSync(owner, JSON.stringify({processIdentifier: 12345}));
  writeFileSync(join(stateDir, 'desktop-ports.json'), JSON.stringify({'space-a': 5901}));
  const now = Date.now();
  const session = {generation: `12345:${lstatSync(owner, {bigint: true}).mtimeNs}`, ready: true, connected: true,
    frames: 1, lastFrameAt: (now - 300000) / 1000, port: 5901, password: 'SECRET', error: 'SECRET_TRACE'};
  const health = {at: now / 1000, inventoryVerified: true, sessions: {'space-a': session}, failures: ['SECRET']};
  const save = () => writeFileSync(join(root, 'vnc-relay-health.json'), JSON.stringify(health));
  save(); t.after(() => rmSync(root, {recursive: true, force: true}));
  return {health, session, save, owner, check: () => inspectDesktopHealth('space-a', {stateDir, storage, now})};
}
test('fresh initialized heartbeat accepts static old frames and allowlists output', t => {
  const f = fixture(t), result = f.check();
  assert.deepEqual(result, {ready: true, connected: true, reason: 'ready', port: 5901, lastFrameAt: f.session.lastFrameAt, frames: 1});
  assert(!JSON.stringify(result).includes('SECRET'));
});
test('stale, future, uninitialized, disconnected and wrong-generation consoles fail closed', t => {
  const f = fixture(t);
  for (const change of [() => {f.health.at -= 5;}, () => {f.health.at += 6;},
    () => {f.health.at -= 1; f.session.ready = false;}, () => {f.session.ready = true; f.session.connected = false;},
    () => {f.session.connected = true; f.session.frames = 0;}, () => {f.session.frames = 1; f.session.generation += '0';}]) {
    change(); f.save(); assert.equal(f.check().ready, false);
  }
});
test('owner symlinks and malformed health never expose errors', t => {
  const f = fixture(t); rmSync(f.owner); symlinkSync('/does-not-exist', f.owner);
  assert.equal(f.check().ready, false); assert(!JSON.stringify(f.check()).includes('TRACE'));
});
