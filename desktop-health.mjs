// Read-only console health. No credentials, provider errors or traces cross this boundary.
import {lstatSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {controlDir, storageRoot, stateRoot as configuredRoot} from './config.mjs';

export function inspectDesktopHealth(name, {stateDir = controlDir, storage = storageRoot, now = Date.now(),
  stateRoot = stateDir === controlDir ? configuredRoot : dirname(stateDir)} = {}) {
  let port = null;
  const fail = reason => ({ready: false, connected: false, reason, port});
  if (!/^space-[a-z0-9][a-z0-9-]{0,30}$/.test(name ?? '')) return fail('invalid-name');
  try {
    const value = JSON.parse(readFileSync(join(stateDir, 'desktop-ports.json'), 'utf8'))[name];
    if (!Number.isInteger(value) || value < 5901 || value > 5949) return fail('unallocated');
    port = value;
    const healthFile = join(stateRoot, 'vnc-relay-health.json');
    const healthStat = lstatSync(healthFile);
    if (!healthStat.isFile() || healthStat.uid !== process.getuid()) return fail('unavailable');
    const health = JSON.parse(readFileSync(healthFile, 'utf8'));
    const age = now - health.at * 1000;
    if (!Number.isFinite(age) || age < 0 || age >= 5000) return fail('stale');
    if (health.inventoryVerified !== true) return fail('inventory-unverified');
    const ownerFile = join(storage, name, '.native-display-owner.json');
    const ownerStat = lstatSync(ownerFile, {bigint: true});
    if (!ownerStat.isFile() || ownerStat.uid !== BigInt(process.getuid())) return fail('owner-unverified');
    const owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
    if (!Number.isSafeInteger(owner.processIdentifier) || owner.processIdentifier <= 1) return fail('owner-unverified');
    const session = health.sessions?.[name];
    if (session?.generation !== `${owner.processIdentifier}:${ownerStat.mtimeNs}`) return fail('generation-mismatch');
    if (session.port !== port || session.ready !== true || session.connected !== true
        || !Number.isSafeInteger(session.frames) || session.frames < 1
        || !Number.isFinite(session.lastFrameAt) || session.lastFrameAt <= 0) return fail('not-ready');
    return {ready: true, connected: true, reason: 'ready', port, lastFrameAt: session.lastFrameAt, frames: session.frames};
  } catch { return fail('unavailable'); }
}
