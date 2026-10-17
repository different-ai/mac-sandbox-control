#!/usr/bin/env node
// MCP server (stdio, JSON-RPC 2.0, newline-delimited) for the Mac sandbox control plane.
// Run over SSH so SSH is the authentication boundary and nothing listens on the network:
//   ssh admin@mac-host.local .local/bin/sandbox-mcp
// Every tool is a thin client of the loopback HTTP API; no Lume or shell access here.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import {apiUrl, publicHost, stateRoot} from './config.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import {describeSandboxes, filterSandboxes, stateCounts} from './sandbox-status.mjs';

const BASE = apiUrl;
const NAME = { type: 'string', pattern: '^space-[a-z0-9][a-z0-9-]{0,30}$', description: 'Sandbox name: space- followed by 1-31 lowercase letters, digits or hyphens.' };
const HOST = publicHost;

export const tools = [
  { name: 'list_sandboxes', title: 'List Mac sandboxes',
    description: 'Equivalent to ls/ps for Mac sandboxes. Each result explicitly reports state, active, running and canExec. ready means credential setup is complete, NOT that the VM is running. status=active includes starting/stopping and unknown VMs (they may still be active); status=running means actually reported running. Includes full counts and last verification time. Never assumes an unknown VM is stopped.',
    inputSchema: { type: 'object', properties: {status: {type: 'string', enum: ['all', 'active', 'running', 'stopped'], description: 'Default all (ls). active is ps; running/stopped filter explicit known states.'}}, additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'create_sandbox', title: 'Create Mac sandbox',
    description: 'Create a macOS sandbox (8 cores, 14 GB RAM, 150 GB disk) from the template with unique credentials, then boot it. Returns a job; use wait_for_job. Fails if 2 VMs are already running.',
    inputSchema: { type: 'object', properties: { name: NAME }, required: ['name'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } },
  { name: 'start_sandbox', title: 'Start Mac sandbox', description: 'Request startup of a stopped, provisioned sandbox. Returns a queued job, not proof that the VM is active. Wait for the job, then use list_sandboxes to check state=running and canExec=true.',
    inputSchema: { type: 'object', properties: { name: NAME }, required: ['name'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  { name: 'stop_sandbox', title: 'Stop Mac sandbox', description: 'Request graceful shutdown; disk is kept. Returns a queued job, not an immediate stopped state. Wait for the job and use list_sandboxes to verify state=stopped and active=false.',
    inputSchema: { type: 'object', properties: { name: NAME }, required: ['name'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  { name: 'kill_sandbox', title: 'Force kill Mac sandbox', description: 'Power off a sandbox immediately. The disk is kept but unsaved work inside it is lost. Returns a job.',
    inputSchema: { type: 'object', properties: { name: NAME }, required: ['name'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
  { name: 'delete_sandbox', title: 'Delete Mac sandbox', description: 'Permanently delete a STOPPED sandbox and all of its files and credentials. confirm_name must exactly equal name. Cannot be undone.',
    inputSchema: { type: 'object', properties: { name: NAME, confirm_name: { type: 'string', description: 'Must exactly equal name.' } }, required: ['name', 'confirm_name'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } },
  { name: 'get_job', title: 'Get job', description: 'Read the status of a control-plane job (queued, running, succeeded, failed).',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } }, required: ['job_id'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'wait_for_job', title: 'Wait for job', description: 'Wait until a job finishes or the timeout passes (default 300s, max 900s). Never retries the job.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string', pattern: '^[0-9a-f-]{36}$' }, timeout_seconds: { type: 'integer', minimum: 1, maximum: 900 } }, required: ['job_id'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'run_command', title: 'Run command in sandbox',
    description: 'Run a shell command (zsh) inside a running sandbox as its admin user "spaceuser" and return exit code, stdout and stderr. Passwordless "sudo -n" works for installs. No TTY: use non-interactive flags (e.g. NONINTERACTIVE=1 for Homebrew). Output is capped at 1 MB; timeout default 120s, max 600s. Runs with full VM administrator authority; not tenant isolation. An SSH timeout does not cancel the guest process. Never runs on the host.',
    inputSchema: { type: 'object', properties: { name: NAME, command: { type: 'string', minLength: 1, maxLength: 16384 }, timeout_seconds: { type: 'integer', minimum: 1, maximum: 600 } }, required: ['name', 'command'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  { name: 'connection_info', title: 'How to connect', description: 'Return how a person views a running sandbox: its desktop address on the local network (vnc://...). No password; use get_login for that.',
    inputSchema: { type: 'object', properties: { name: NAME }, required: ['name'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'get_login', title: 'Get sandbox login', description: 'Return the desktop URL and desktop (VNC) password for a sandbox, plus its macOS account login (for sudo prompts or the lock screen). Sensitive: only show it to the person who asked to connect.',
    inputSchema: { type: 'object', properties: { name: NAME }, required: ['name'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
];

class ToolError extends Error {}
async function api(path, { method = 'GET', body, request = fetch, timeoutMs = 20_000 } = {}) {
  const headers = {};
  if (method !== 'GET') {
    const state = await api('/api/state', { request });
    headers['content-type'] = 'application/json'; headers['x-csrf-token'] = state.csrfToken;
  }
  let response;
  try { response = await request(BASE + path, { method, headers, body: body && JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new ToolError('Control plane unreachable on the host. Check that the service is running.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ToolError(`Control request failed (${response.status}). Inspect the host privately.`);
  return data;
}
const STATE = stateRoot;
async function readySandbox(name, request, mustRun = true) {
  const { sandbox } = await api(`/api/sandboxes/${name}`, { request });
  if (!sandbox.securityReady) throw new ToolError(`${name} is not ready: provisioning did not complete.`);
  if (mustRun && sandbox.status !== 'running') throw new ToolError(`${name} is ${sandbox.status}. Start it first.`);
  return sandbox;
}
const safeJob = j => ({ id: j.id, name: j.name, action: j.action, status: j.status, error: j.error, createdAt: j.createdAt, finishedAt: j.finishedAt });

export async function callTool(name, args = {}, request = fetch) {
  const action = (sandbox, verb, extra = {}) => api(`/api/sandboxes/${sandbox}/actions`, { method: 'POST', body: { action: verb, ...extra }, request }).then(r => ({ job: safeJob(r.job) }));
  switch (name) {
    case 'list_sandboxes': {
      const filter = args.status ?? 'all';
      if (!['all', 'active', 'running', 'stopped'].includes(filter)) throw new ToolError('status must be all, active, running, or stopped.');
      const s = await api('/api/state', { request });
      const rows = describeSandboxes(s.sandboxes, s.inventory);
      return {host: {cpuTotal: s.host.cpuTotal, memoryGiB: s.host.memoryGiB, diskAvailableGiB: typeof s.host.diskAvailableGiB === 'number' ? Math.floor(s.host.diskAvailableGiB) : null},
        policy: s.policy, activeVMs: s.inventory?.activeCount ?? null, counts: stateCounts(rows),
        inventory: s.inventory, filter, sandboxes: filterSandboxes(rows, filter), recentJobs: s.jobs.slice(0, 10).map(safeJob)};
    }
    case 'create_sandbox': return api('/api/sandboxes', { method: 'POST', body: { name: args.name }, request }).then(r => ({ job: safeJob(r.job) }));
    case 'start_sandbox': return action(args.name, 'start');
    case 'stop_sandbox': return action(args.name, 'stop');
    case 'kill_sandbox': return action(args.name, 'kill');
    case 'delete_sandbox':
      if (args.confirm_name !== args.name) throw new ToolError('confirm_name must exactly equal name. Nothing was deleted.');
      return action(args.name, 'delete', { confirmation: args.confirm_name });
    case 'get_job': return api(`/api/jobs/${args.job_id}`, { request }).then(r => ({ job: safeJob(r.job) }));
    case 'wait_for_job': {
      const end = Date.now() + Math.min(900, args.timeout_seconds ?? 300) * 1000;
      for (;;) {
        const { job } = await api(`/api/jobs/${args.job_id}`, { request });
        if (['succeeded', 'failed'].includes(job.status)) return { job: safeJob(job), finished: true };
        if (Date.now() >= end) return { job: safeJob(job), finished: false, note: 'Still in progress. Call wait_for_job again; the job keeps running.' };
        await delay(3000);
      }
    }
    case 'run_command': {
      const timeout = Math.min(600, args.timeout_seconds ?? 120);
      const r = await api(`/api/sandboxes/${args.name}/exec`, { method: 'POST', body: { command: args.command, timeoutSeconds: timeout }, request, timeoutMs: (timeout + 30) * 1000 });
      return { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdout, stderr: r.stderr };
    }
    case 'connection_info': {
      const sandbox = await readySandbox(args.name, request);
      if (!sandbox.desktopState?.ready || !sandbox.desktopState?.connected) throw new ToolError('Desktop console is not ready; guest compute may still be running. Ask the host operator; do not connect to native VNC.');
      const port = sandbox.desktopState.port;
      if (!Number.isInteger(port) || port < 5901 || port > 5949) throw new ToolError('Desktop console port unavailable.');
      return { name: sandbox.name, desktopState: sandbox.desktopState, desktop: `vnc://${HOST}:${port}`,
        how: port ? 'Open the desktop URL (Finder > Go > Connect to Server, or "open <url>"). It asks only for a password: use desktopPassword from get_login. The sandbox is already logged in as spaceuser.' : 'Desktop is disabled or unavailable; ask the host operator.' };
    }
    case 'get_login': {
      const sandbox = await readySandbox(args.name, request, false);
      let credential;
      try { credential = JSON.parse(readFileSync(join(STATE, 'credentials', sandbox.name + '.json'), 'utf8')); } catch { throw new ToolError('Login not available for this sandbox.'); }
      if (credential.verified !== true) throw new ToolError(`${sandbox.name} is not ready: provisioning did not complete.`);
      let desktopPassword = null;
      try { desktopPassword = readFileSync(join(STATE, 'credentials', sandbox.name + '.vnc'), 'utf8').trim(); } catch {}
      const health = sandbox.desktopState;
      const port = sandbox.status === 'running' && health?.ready === true && health?.connected === true
        && Number.isInteger(health.port) && health.port >= 5901 && health.port <= 5949 ? health.port : null;
      return { name: sandbox.name, desktopState: health ?? {ready: false, connected: false, reason: 'unavailable', port: null},
        desktop: port ? `vnc://${HOST}:${port}` : null, desktopPassword: port ? desktopPassword : null,
        macUsername: credential.username, macPassword: credential.password };
    }
    default: throw new ToolError('Unknown tool.');
  }
}

export async function handle(message, request = fetch) {
  if (!message || Array.isArray(message) || typeof message !== 'object') return {jsonrpc: '2.0', id: null, error: {code: -32600, message: 'Invalid request'}};
  const { id, method, params } = message;
  const reply = result => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return reply({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'mac-sandboxes', version: '1.0.0' },
    instructions: 'Control plane for macOS sandboxes on the Mac host. At most 2 run at once. Create/start/stop/kill/delete return jobs; use wait_for_job. Network isolation is NOT verified: trusted workloads only.' });
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools });
  if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments ?? {}, request);
      return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
    } catch (error) {
      return reply({ content: [{ type: 'text', text: error instanceof ToolError ? error.message : 'Tool failed unexpectedly.' }], isError: true });
    }
  }
  if (id === undefined) return null; // notifications such as notifications/initialized
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
    const response = await handle(message);
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  }
}
