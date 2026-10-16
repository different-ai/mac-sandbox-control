import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {root, hostEnv, exists, loadHostConfig, installFile, wrapper, serviceEntries, launchAgent} from './install-util.mjs';
if (process.argv.includes('--help')) {console.log('Install user commands and LaunchAgent files. Does not start services, create VMs, install Lume, or overwrite unrelated files.'); process.exit(0);}
process.umask(0o077);
try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.getuid() === 0) throw new Error('Run as a normal user on an Apple-silicon Mac, not with sudo.');
  if (!(await exists(hostEnv))) {
    await fs.mkdir(path.dirname(hostEnv), {recursive: true, mode: 0o700});
    await fs.writeFile(hostEnv, await fs.readFile(path.join(root, '.env.example'), 'utf8'), {mode: 0o600, flag: 'wx'});
  }
  const c = await loadHostConfig();
  await fs.access(c.lumeBin, 1).catch(() => {throw new Error('Lume executable not found. Install it separately or set LUME_BIN in host.env.');});
  await fs.mkdir(c.stateRoot, {recursive: true, mode: 0o700});
  await fs.mkdir(c.controlDir, {recursive: true, mode: 0o700});
  const commands = {'sandbox': 'cli.mjs', 'sandbox-mcp': 'mcp.mjs', 'sandbox-mcp-token': 'mcp-tokens.mjs', 'sandbox-connect': 'connect.mjs', 'sandbox-desktop': 'desktop.mjs'};
  for (const [name, entry] of Object.entries(commands)) await installFile(path.join(os.homedir(), '.local/bin', name), wrapper(entry, {environment: true}));
  await installFile(path.join(os.homedir(), '.local/bin/mac-sandbox'), wrapper('sandbox-client.mjs'));
  for (const file of ['provision.sh', 'power.sh']) await fs.chmod(path.join(root, file), 0o755);
  const agents = path.join(os.homedir(), 'Library/LaunchAgents');
  for (const service of serviceEntries) {
    const file = path.join(agents, service.label + '.plist');
    await installFile(file, launchAgent(service, c.stateRoot), 0o600);
    execFileSync('/usr/bin/plutil', ['-lint', file], {stdio: 'ignore'});
  }
  console.log('Installed user commands and LaunchAgent files. No service or VM was started.');
  console.log('Review configuration: ' + hostEnv);
  console.log('Add ~/.local/bin to PATH, build a template, then run pnpm host:start.');
} catch (error) {console.error(error.message); process.exitCode = 1;}
