import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const home = os.homedir();
export const appDir = path.dirname(fileURLToPath(import.meta.url));
export const stateRoot = path.resolve(process.env.SANDBOX_STATE_ROOT ?? path.join(home, '.local/state/mac-sandboxes'));
export const controlDir = path.resolve(process.env.SANDBOX_STATE_DIR ?? path.join(stateRoot, 'control'));
export const storageRoot = path.resolve(process.env.SANDBOX_VM_STORAGE ?? path.join(home, '.lume'));
export const lumeBin = process.env.LUME_BIN ?? path.join(home, '.local/bin/lume');
export const publicHost = process.env.SANDBOX_PUBLIC_HOST ?? 'mac-host.local';
export const apiUrl = process.env.SANDBOX_API ?? 'http://127.0.0.1:8787';
export const mcpBind = process.env.SANDBOX_MCP_BIND ?? '127.0.0.1';
export const mcpPort = Number(process.env.SANDBOX_MCP_PORT ?? 8788);
export const desktopEnabled = process.env.SANDBOX_DESKTOP_ENABLED === '1';
