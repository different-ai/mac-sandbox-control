// Manage per-person tokens for the network MCP endpoint.
//   sandbox-mcp-token add NAME      -> prints a new token ONCE (only its hash is stored)
//   sandbox-mcp-token list
//   sandbox-mcp-token revoke NAME
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { TOKENS, validTokenData } from './mcp-http.mjs';
process.umask(0o077);
const [command, name] = process.argv.slice(2);
const fail = message => { console.error(message); process.exit(1); };
const read = () => {
  try {
    const st = fs.lstatSync(TOKENS);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() || (st.mode & 0o077)) fail('Token file is unsafe; inspect it before changing anything.');
    const data = JSON.parse(fs.readFileSync(TOKENS, 'utf8'));
    if (!validTokenData(data)) fail('Unknown token data; refusing to overwrite it.');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return {tokens: []};
    fail('Token file unreadable; inspect it before changing anything.');
  }
};
const write = data => {
  fs.mkdirSync(path.dirname(TOKENS), {recursive: true, mode: 0o700});
  const tmp = TOKENS + '.' + randomBytes(8).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  fs.renameSync(tmp, TOKENS);
};
const data = read();
if (command === 'add') {
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(name ?? '')) fail('Usage: sandbox-mcp-token add NAME (letters, digits, . _ -)');
  if (data.tokens.some(t => t.name === name && !t.revokedAt)) fail(`${name} already has an active token. Revoke it first.`);
  const token = randomBytes(32).toString('base64url');
  data.tokens.push({ name, hash: createHash('sha256').update(token).digest('hex'), createdAt: new Date().toISOString() });
  write(data);
  process.stdout.write(token + '\n'); // Explicit issuance only; never copied to diagnostic or audit logs.
} else if (command === 'list') {
  for (const t of data.tokens) console.log(`${t.name}\t${t.revokedAt ? 'revoked ' + t.revokedAt : 'active since ' + t.createdAt}`);
  if (!data.tokens.length) console.log('No tokens.');
} else if (command === 'revoke') {
  const active = data.tokens.filter(t => t.name === name && !t.revokedAt);
  if (!active.length) fail(`No active token for ${name}.`);
  for (const t of active) t.revokedAt = new Date().toISOString();
  write(data); console.log(`Revoked ${name}. Takes effect on the next request.`);
} else fail('Usage: sandbox-mcp-token add|list|revoke NAME');
