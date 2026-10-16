// Baseline publication hygiene, not a replacement for secret scanning or review.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skip = new Set(['.git', 'node_modules', 'coverage']);
const findings = [];
const checks = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['credential-like literal', /\b(?:ghp_|github_pat_|xox[baprs]-|sk_live_|comp_)[A-Za-z0-9_-]{16,}/],
  ['literal bearer credential', /Bearer\s+[A-Za-z0-9_-]{32,}/],
  ['hardcoded secret assignment', /(?:password|apiKey|token)\s*[:=]\s*["'][A-Za-z0-9_-]{24,}["']/i],
  ['deployment-specific tailnet', /\btail[0-9a-f]{4,}\.ts\.net/i],
  ['developer home directory', /\/Users\/(?!lume\b|spaceuser\b|\$|<|your-user\b)[A-Za-z0-9._-]+/],
];
let files = 0;
async function walk(dir) {
  for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name); const relative = path.relative(root, full);
    if (entry.isSymbolicLink()) {findings.push(relative + ': symlink needs review'); continue;}
    if (entry.isDirectory()) {
      if (['credentials', 'keys', 'runtime', 'state', '.lume'].includes(entry.name) || entry.name.startsWith('.test-state-') || entry.name.startsWith('.test-mcp-')) findings.push(relative + ': runtime data directory');
      else await walk(full);
      continue;
    }
    if (/\.(?:png|jpe?g|gif|pdf|b64|ipsw|img|qcow2|sqlite(?:-.*)?|db|pem|key|p12|pfx)$/i.test(entry.name)
        || (entry.name.startsWith('.env') && entry.name !== '.env.example')
        || /^(?:mcp-tokens|desktop-ports|owner)\.json$/.test(entry.name)) {
      findings.push(relative + ': private/binary artifact type'); continue;
    }
    const bytes = await fs.readFile(full);
    if (bytes.includes(0)) {findings.push(relative + ': unexpected binary file'); continue;}
    files++;
    const text = bytes.toString('utf8');
    for (const [label, pattern] of checks) if (pattern.test(text)) findings.push(relative + ': ' + label);
  }
}
await walk(root);
if (findings.length) {console.error('Publication check failed (values withheld):\n' + findings.map(f => '- ' + f).join('\n')); process.exitCode = 1;}
else console.log(`Publication hygiene check passed for ${files} text files. Manual review and external secret scanning are still required.`);
