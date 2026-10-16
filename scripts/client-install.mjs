import os from 'node:os';
import path from 'node:path';
import {requireNode, installFile, wrapper} from './install-util.mjs';
if (process.argv.includes('--help')) {console.log('Install ~/.local/bin/mac-sandbox as a thin token-authenticated network MCP client. Does not install Lume or start services.'); process.exit(0);}
try {
  requireNode();
  if (process.platform === 'win32') throw new Error('This installer writes a POSIX shell launcher. On Windows invoke node sandbox-client.mjs directly.');
  await installFile(path.join(os.homedir(), '.local/bin/mac-sandbox'), wrapper('sandbox-client.mjs'));
  console.log('Installed mac-sandbox. Add ~/.local/bin to PATH and set MAC_SANDBOX_URL plus your private token file.');
  console.log('Keep this checkout in place: the installed launcher references it.');
} catch (error) {console.error(error.message); process.exitCode = 1;}
