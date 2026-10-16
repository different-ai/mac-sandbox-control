import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Controller, ControlError } from './controller.mjs';

const HOSTS = new Set(['127.0.0.1:8787', 'localhost:8787']);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const fail = (message, status) => { throw new ControlError(message, status); };
async function jsonBody(req, limit = 4096) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) fail('Content-Type must be application/json.', 415);
  if (Number(req.headers['content-length']) > limit) { req.resume(); fail('Request body is too large.', 413); }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) { req.resume(); fail('Request body is too large.', 413); }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') fail('Expected a JSON object.', 400);
    return value;
  } catch { fail('Invalid JSON body.', 400); }
}
function keys(body, allowed) {
  if (Object.keys(body).some(key => !allowed.includes(key))) fail('Unexpected request field.', 400);
}
export function createServer(controller, { publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public') } = {}) {
  const csrfToken = randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    try {
      const hostCount = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'host').length;
      if (hostCount !== 1 || !HOSTS.has(req.headers.host)) fail('Host is not allowed.', 403);
      if (req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) fail('Origin is not allowed.', 403);
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') fail('Cross-site requests are not allowed.', 403);
      if (!req.url.startsWith('/') || req.url.startsWith('//')) fail('Invalid request target.', 400);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, { csrfToken, ...await controller.state() });
      if (req.method === 'GET' && url.pathname === '/api/sandboxes') {
        const state = await controller.state();
        return json(200, { sandboxes: state.sandboxes, policy: state.policy, inventory: state.inventory });
      }
      const readOne = /^\/api\/sandboxes\/(space-[a-z0-9][a-z0-9-]{0,30})$/.exec(url.pathname);
      if (req.method === 'GET' && readOne) {
        const state = await controller.state();
        const sandbox = state.sandboxes.find(item => item.name === readOne[1]);
        if (!sandbox) fail('Sandbox is not managed by this controller.', 404);
        return json(200, { sandbox, jobs: state.jobs.filter(job => job.name === sandbox.name).slice(0, 20) });
      }
      const readJob = /^\/api\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (req.method === 'GET' && readJob) {
        const job = (await controller.state()).jobs.find(item => item.id === readJob[1]);
        if (!job) fail('Job not found in recent history.', 404);
        return json(200, { job });
      }
      if (req.method === 'POST') {
        const received = req.headers['x-csrf-token'];
        if (typeof received !== 'string' || !/^[a-f0-9]{64}$/.test(received)
          || !timingSafeEqual(Buffer.from(received), Buffer.from(csrfToken))) fail('CSRF token is required.', 403);
        if (url.pathname === '/api/sandboxes') {
          const body = await jsonBody(req); keys(body, ['name']);
          return json(202, { job: controller.enqueue(body.name, 'create') });
        }
        const execMatch = /^\/api\/sandboxes\/(space-[a-z0-9][a-z0-9-]{0,30})\/exec$/.exec(url.pathname);
        if (execMatch) {
          const body = await jsonBody(req, 32768); keys(body, ['command', 'timeoutSeconds']);
          return json(200, await controller.exec(execMatch[1], body.command, body.timeoutSeconds));
        }
        const match = /^\/api\/sandboxes\/(space-[a-z0-9][a-z0-9-]{0,30})\/actions$/.exec(url.pathname);
        if (match) {
          const body = await jsonBody(req); keys(body, ['action', 'confirmation']);
          if (!['start', 'stop', 'kill', 'delete'].includes(body.action)) fail('Invalid action.', 400);
          return json(202, { job: controller.enqueue(match[1], body.action, body.confirmation) });
        }
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [name, type] = assets.get(url.pathname);
        const file = join(publicDir, name);
        try {
          const info = await lstat(file);
          if (!info.isFile()) return json(404, { error: 'Not found.' });
          const content = await readFile(file);
          res.writeHead(200, { 'Content-Type': type }); return res.end(content);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      json(404, { error: 'Not found.' });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(error instanceof ControlError ? error.status : 500,
        { error: error instanceof ControlError ? error.message : 'Internal request failure.' });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 40;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  let controller;
  try {
    controller = new Controller();
    const server = createServer(controller);
    server.on('error', async () => { console.error('Cannot listen on 127.0.0.1:8787.'); await controller.close(); process.exitCode = 1; });
    server.listen(8787, '127.0.0.1', () => console.log('Sandbox control listening on http://127.0.0.1:8787 (SSH tunnel only).'));
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      if (closing) return; closing = true;
      server.close(); server.closeIdleConnections();
      await controller.close();
    });
  } catch (error) {
    console.error(error instanceof ControlError ? error.message : 'Controller startup failed.');
    process.exitCode = 1;
  }
}
