#!/usr/bin/env node
// Client-Mac CLI: authenticated network MCP, not host SSH access.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseExecArgs, renderExecResult, ExecUsageError} from './exec-options.mjs';
import {describeSandboxes, filterSandboxes, parseListArgs, formatSandboxTable} from './sandbox-status.mjs';
const USAGE = 'Usage: mac-sandbox ls [--json] | ps [-a|--all] [--json] | list [--json]\n       mac-sandbox status NAME [--json]\n       mac-sandbox exec NAME [--timeout SECONDS] [--json] -- COMMAND [ARGS...]\nExample: mac-sandbox exec space-1 -- "cd /tmp && sw_vers"';
export class ClientError extends Error {}

export async function runClient(args, {request = fetch, env = process.env, home = os.homedir(), print = console.log, stdout, stderr} = {}) {
  const command = args[0];
  let listing = null;
  if (['list', 'ls', 'ps'].includes(command)) {
    try {listing = parseListArgs(command, args.slice(1));} catch (error) {throw new ExecUsageError(error.message);}
  }
  const status = command === 'status';
  if (status && (!/^space-[a-z0-9][a-z0-9-]{0,30}$/.test(args[1] || '') || args.length > 3 || (args.length === 3 && args[2] !== '--json'))) throw new ExecUsageError(USAGE);
  if (!listing && !status && command !== 'exec') throw new ExecUsageError(USAGE);
  const exec = command === 'exec' ? parseExecArgs(args.slice(1)) : null;
  let token = env.MAC_SANDBOX_TOKEN;
  if (!token) {
    try {token = fs.readFileSync(env.MAC_SANDBOX_TOKEN_FILE || path.join(home, '.config/mac-sandbox-control/token'), 'utf8').trim();}
    catch {throw new ClientError('No MCP token found. Set MAC_SANDBOX_TOKEN or MAC_SANDBOX_TOKEN_FILE.');}
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new ClientError('The MCP token has an invalid format.');
  const endpoint = env.MAC_SANDBOX_URL || 'http://127.0.0.1:8788/mcp';
  try {const u = new URL(endpoint); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error();}
  catch {throw new ClientError('MAC_SANDBOX_URL must be an HTTP or HTTPS MCP endpoint.');}
  let id = 0;
  async function rpc(method, params, timeoutMs = 20000, notification = false) {
    let response;
    try {
      response = await request(endpoint, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token},
        body: JSON.stringify({jsonrpc: '2.0', ...(notification ? {} : {id: ++id}), method, params}), redirect: 'error', signal: AbortSignal.timeout(timeoutMs)});
    } catch {throw new ClientError('Could not reach the MCP server. Check your network access. If exec was dispatched, inspect the sandbox before retrying.');}
    if (!response.ok) throw new ClientError(response.status === 401 ? 'MCP token rejected or revoked.' : `MCP request failed (HTTP ${response.status}).`);
    if (notification && response.status === 202) return;
    const text = await response.text();
    if (text.length > 16 * 1024 * 1024) throw new ClientError('MCP response exceeded the output limit.');
    let message;
    try {message = JSON.parse(text);} catch {throw new ClientError('MCP returned an invalid response.');}
    if (message.error) throw new ClientError('MCP protocol error.');
    if (message.result?.isError) {
      const error = message.result.content?.find(c => c.type === 'text')?.text;
      throw new ClientError(typeof error === 'string' ? error.slice(0, 500) : 'MCP tool failed.');
    }
    return message.result;
  }
  await rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'mac-sandbox-cli', version: '1.0.0'}});
  await rpc('notifications/initialized', {}, 20000, true);
  if (exec) {
    const result = await rpc('tools/call', {name: 'run_command', arguments: {name: exec.name, command: exec.command, timeout_seconds: exec.timeoutSeconds}}, (exec.timeoutSeconds + 45) * 1000);
    return renderExecResult(result.structuredContent, {json: exec.json, print, stdout, stderr});
  }
  const result = await rpc('tools/call', {name: 'list_sandboxes', arguments: {}});
  const data = result.structuredContent;
  const allRows = describeSandboxes(data.sandboxes, data.inventory);
  const rows = status ? allRows.filter(row => row.name === args[1]) : filterSandboxes(allRows, listing.filter);
  if (status && !rows.length) throw new ClientError('Sandbox is not managed by this controller.');
  if (listing?.json || (status && args[2] === '--json')) print(JSON.stringify(status ? rows[0] : rows, null, 2));
  else {
    print(formatSandboxTable(rows, {allRows, activeVMs: data.activeVMs, maxRunning: data.policy?.maxRunning, inventoryError: data.inventory?.error}));
    if (status) print(rows[0].note);
  }
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {process.exitCode = await runClient(process.argv.slice(2));}
  catch (error) {console.error(error instanceof ClientError || error instanceof ExecUsageError ? error.message : 'Could not execute the command. Check the control plane.'); process.exitCode = 1;}
}
