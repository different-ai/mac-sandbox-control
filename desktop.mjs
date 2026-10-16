// Host helper for a sandbox desktop (Lume's built-in VNC server):
//   sandbox-desktop url NAME        -> vnc://mac-host.local:PORT
//   sandbox-desktop password NAME   -> desktop password, ONLY when piped (e.g. into pbcopy)
import fs from 'node:fs';
import path from 'node:path';
import {stateRoot as state, publicHost, desktopEnabled} from './config.mjs';
import {readPorts} from './forward.mjs';
const [mode, name] = process.argv.slice(2);
const fail = message => { console.error(message); process.exit(1); };
if (!desktopEnabled) fail('Desktop access is disabled; ask the host operator.');
if (!['url', 'password'].includes(mode) || !/^space-[a-z0-9][a-z0-9-]{0,30}$/.test(name || '')) fail('Usage: sandbox-desktop url|password space-NAME');
if (mode === 'url') {
  const ports = readPorts();
  if (!Number.isInteger(ports[name])) fail(`${name} has no desktop yet. Start it first.`);
  process.stdout.write(`vnc://${publicHost}:${ports[name]}\n`);
} else {
  if (process.stdout.isTTY) fail('Refusing to print a password to a terminal. Pipe it, e.g.: ... | pbcopy');
  try { process.stdout.write(fs.readFileSync(path.join(state, 'credentials', name + '.vnc'), 'utf8').trim()); }
  catch { fail(`${name} has no desktop password yet. Start it first.`); }
}
