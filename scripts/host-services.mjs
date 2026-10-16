import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {serviceEntries, loadHostConfig} from './install-util.mjs';
const action = process.argv[2];
if (action === '--help') {console.log('Usage: node scripts/host-services.mjs start|stop. This manages host user services, not VM power.'); process.exit(0);}
try {
  if (!['start', 'stop'].includes(action)) throw new Error('Expected start or stop.');
  if (process.platform !== 'darwin' || process.getuid() === 0) throw new Error('Run as the installed macOS user, not root.');
  await loadHostConfig();
  const domain = 'gui/' + process.getuid();
  execFileSync('/bin/launchctl', ['print', domain], {stdio: 'ignore'});
  for (const service of serviceEntries) {
    let loaded = false;
    try {execFileSync('/bin/launchctl', ['print', domain + '/' + service.label], {stdio: 'ignore'}); loaded = true;} catch {}
    if (action === 'start') {
      if (loaded) {console.log(service.label + ': already loaded (not restarted).'); continue;}
      const file = path.join(os.homedir(), 'Library/LaunchAgents', service.label + '.plist');
      await fs.access(file);
      execFileSync('/bin/launchctl', ['bootstrap', domain, file], {stdio: 'inherit'});
      console.log(service.label + ': launched. Check the listener and logs before declaring it healthy.');
    } else {
      if (!loaded) {console.log(service.label + ': not loaded.'); continue;}
      // Explicit operator shutdown. It can interrupt in-flight API calls; do not replay them blindly.
      execFileSync('/bin/launchctl', ['bootout', domain + '/' + service.label], {stdio: 'inherit'});
      console.log(service.label + ': unloaded. Existing VMs were not powered off.');
    }
  }
} catch (error) {console.error('Service operation failed: ' + error.message); console.error('Confirm the host account is logged in and host:install completed.'); process.exitCode = 1;}
