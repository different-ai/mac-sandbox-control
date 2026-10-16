// Authenticated Streamable HTTP MCP. Loopback by default; access is full VM administration.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {handle, tools} from './mcp.mjs';
import {controlDir, mcpBind, mcpPort} from './config.mjs';

export const TOKENS = process.env.SANDBOX_MCP_TOKENS ?? path.join(controlDir, 'mcp-tokens.json');
const sha = value => createHash('sha256').update(value).digest();
const validName = name => typeof name === 'string' && /^[a-z0-9][a-z0-9._-]{0,40}$/i.test(name);
export function validTokenData(data) {
  return data && !Array.isArray(data) && typeof data === 'object'
    && Object.keys(data).every(key => key === 'tokens') && Array.isArray(data.tokens)
    && data.tokens.every(t => t && validName(t.name) && typeof t.hash === 'string'
      && /^[a-f0-9]{64}$/.test(t.hash) && (t.createdAt === undefined || typeof t.createdAt === 'string')
      && (t.revokedAt === undefined || typeof t.revokedAt === 'string')
      && Object.keys(t).every(key => ['name', 'hash', 'createdAt', 'revokedAt'].includes(key)));
}
export function loadTokens(file = TOKENS) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() || (st.mode & 0o077)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validTokenData(data) ? data.tokens.filter(t => !t.revokedAt) : [];
  } catch { return []; }
}
export function authenticate(header, tokens) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header ?? '');
  if (!match) return null;
  const presented = sha(match[1]);
  let who = null;
  for (const token of tokens) if (typeof token.hash === 'string' && /^[a-f0-9]{64}$/.test(token.hash)
    && timingSafeEqual(presented, Buffer.from(token.hash, 'hex'))) who = token.name;
  return who;
}
const knownTools = new Set(tools.map(tool => tool.name));
export function auditMetadata(actor, item, reply, started) {
  const tool = knownTools.has(item?.params?.name) ? item.params.name : 'unknown';
  const sandbox = item?.params?.arguments?.name;
  return {actor: validName(actor) ? actor : 'unknown', tool,
    ...(/^space-[a-z0-9][a-z0-9-]{0,30}$/.test(sandbox ?? '') ? {sandbox} : {}),
    outcome: reply?.error || reply?.result?.isError ? 'error' : 'success', duration: Math.max(0, Date.now() - started)};
}
export function createMcpServer({tokensFile = TOKENS, request = fetch, log = () => {}, maxConcurrent = 8, bodyTimeoutMs = 10_000} = {}) {
  const failures = new Map();
  let active = 0;
  const server = http.createServer(async (req, res) => {
    let admitted = false;
    let timer;
    const send = (status, body, headers = {}) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close', ...headers});
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    // Never leave rejected/unread bodies streaming on persistent connections.
    res.once('finish', () => { if (!req.complete) req.destroy(); });
    try {
      const ip = req.socket.remoteAddress ?? '?';
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/mcp') return send(404, {error: 'Not found. The MCP endpoint is /mcp.'});
      if (req.headers.origin !== undefined) return send(403, {error: 'Browser origins are not allowed.'});
      for (const [key, value] of failures) if (Date.now() - value.at >= 60_000) failures.delete(key);
      const recent = failures.get(ip);
      if (recent?.count >= 10) return send(429, {error: 'Too many failed attempts. Try again in a minute.'});
      const who = authenticate(req.headers.authorization, loadTokens(tokensFile));
      if (!who) {
        if (!failures.has(ip) && failures.size >= 1024) failures.delete(failures.keys().next().value);
        failures.set(ip, {count: (recent?.count ?? 0) + 1, at: Date.now()});
        return send(401, {error: 'Missing or invalid access token.'}, {'WWW-Authenticate': 'Bearer'});
      }
      if (req.method === 'GET') return send(405, {error: 'This server does not offer an SSE stream.'}, {Allow: 'POST, DELETE'});
      if (req.method === 'DELETE') return send(200, {});
      if (req.method !== 'POST') return send(405, {error: 'Use POST.'}, {Allow: 'POST, DELETE'});
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return send(415, {error: 'Content-Type must be application/json.'});
      if (active >= maxConcurrent) return send(503, {error: 'Server busy. Inspect dispatched operations before retrying.'});
      active++; admitted = true;
      timer = setTimeout(() => { send(408, {error: 'Request body timed out.'}); req.destroy(); }, bodyTimeoutMs);
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) return send(413, {error: 'Request too large.'});
        chunks.push(chunk);
      }
      clearTimeout(timer);
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return send(400, {jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}}); }
      const batch = Array.isArray(message) ? message : [message];
      if (batch.length < 1 || batch.length > 32) return send(400, {error: 'Expected 1–32 requests.'});
      const replies = [];
      for (const item of batch) {
        const started = Date.now();
        const reply = await handle(item, request);
        if (item?.method === 'tools/call') {
          try { log(JSON.stringify(auditMetadata(who, item, reply, started))); } catch {}
        }
        if (reply) replies.push(reply);
      }
      if (!replies.length) return send(202);
      send(200, Array.isArray(message) ? replies : replies[0]);
    } catch { send(500, {error: 'Internal error.'}); }
    finally { clearTimeout(timer); if (admitted) active--; }
  });
  server.requestTimeout = bodyTimeoutMs;
  server.headersTimeout = Math.min(15_000, bodyTimeoutMs);
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 40;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.umask(0o077);
  const auditFile = path.join(path.dirname(TOKENS), 'mcp-audit.log');
  const server = createMcpServer({log: line => fs.appendFile(auditFile, line + '\n', {mode: 0o600}, () => {})});
  server.on('error', () => {console.error('Could not start MCP listener.'); process.exitCode = 1;});
  server.listen(mcpPort, mcpBind, () => console.log(`Sandbox MCP listening on ${mcpBind}:${mcpPort}/mcp (token required).`));
}
