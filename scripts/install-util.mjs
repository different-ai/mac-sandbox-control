import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const hostEnv = path.join(os.homedir(), '.config/mac-sandbox-control/host.env');
export const shellQuote = text => "'" + text.replaceAll("'", "'\\''") + "'";
export const xml = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export async function exists(file) {try {await fs.lstat(file); return true;} catch (e) {if (e.code === 'ENOENT') return false; throw e;}}
export async function installFile(file, content, mode = 0o700) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  if (await exists(file)) {
    const st = await fs.lstat(file);
    if (!st.isFile() || await fs.readFile(file, 'utf8') !== content) throw new Error(`Refusing to replace existing file: ${file}. Inspect it before installing.`);
    return;
  }
  await fs.writeFile(file, content, {mode, flag: 'wx'});
}
export function requireNode() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required.');
}
export async function loadHostConfig() {
  requireNode();
  if (await exists(hostEnv)) process.loadEnvFile(hostEnv);
  const config = await import('../config.mjs');
  for (const p of [config.stateRoot, config.controlDir, config.storageRoot]) {
    const relative = path.relative(root, path.resolve(p));
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Keep runtime state and VM storage outside the repository.');
  }
  return config;
}
export const serviceEntries = [
  {label: 'io.github.mac-sandbox-control.api', entry: 'server.mjs', log: 'controller'},
  {label: 'io.github.mac-sandbox-control.mcp', entry: 'mcp-http.mjs', log: 'mcp-http'},
  {label: 'io.github.mac-sandbox-control.desktop-relay', entry: 'desktop-relay.mjs', log: 'desktop-relay', desktopOnly: true},
];
export function wrapper(entry, {environment = false} = {}) {
  const envArg = environment ? ' ' + shellQuote('--env-file-if-exists=' + hostEnv) : '';
  return '#!/bin/sh\nexport NODE_BIN=' + shellQuote(process.env.NODE_BIN ?? process.execPath) + '\nexec "$NODE_BIN"' + envArg + ' ' + shellQuote(path.join(root, entry)) + ' "$@"\n';
}
export function launchAgent(service, stateRoot) {
  const node = process.env.NODE_BIN ?? process.execPath;
  const values = [node, '--env-file-if-exists=' + hostEnv, path.join(root, service.entry)];
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n' +
    '<key>Label</key><string>' + xml(service.label) + '</string>\n' +
    '<key>ProgramArguments</key><array>' + values.map(v => '<string>' + xml(v) + '</string>').join('') + '</array>\n' +
    '<key>WorkingDirectory</key><string>' + xml(root) + '</string>\n' +
    '<key>EnvironmentVariables</key><dict><key>NODE_BIN</key><string>' + xml(node) + '</string>' +
    '<key>PATH</key><string>' + xml(path.dirname(node) + ':' + path.join(os.homedir(), '.local/bin') + ':/usr/bin:/bin:/usr/sbin:/sbin') + '</string></dict>\n' +
    '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ProcessType</key><string>Background</string>\n' +
    '<key>StandardOutPath</key><string>' + xml(path.join(stateRoot, service.log + '.log')) + '</string>\n' +
    '<key>StandardErrorPath</key><string>' + xml(path.join(stateRoot, service.log + '-error.log')) + '</string>\n</dict></plist>\n';
}
