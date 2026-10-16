// Passive desktop-port metadata reader. No proxy daemon is provided.
import fs from 'node:fs';
import path from 'node:path';
import {controlDir} from './config.mjs';

export const PORTS = process.env.SANDBOX_DESKTOP_PORTS ?? path.join(controlDir, 'desktop-ports.json');
export function readPorts(file = PORTS) {
  try {
    const ports = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!ports || Array.isArray(ports) || typeof ports !== 'object') return {};
    return Object.fromEntries(Object.entries(ports).filter(([name, port]) =>
      /^space-[a-z0-9][a-z0-9-]{0,30}$/.test(name) && Number.isInteger(port) && port >= 5901 && port <= 5949));
  } catch { return {}; }
}
