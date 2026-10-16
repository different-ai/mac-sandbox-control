#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {parseExecArgs, renderExecResult, EXEC_USAGE} from './exec-options.mjs';
import {describeSandbox, filterSandboxes, parseListArgs, formatSandboxTable} from './sandbox-status.mjs';

import {apiUrl as BASE} from './config.mjs';
const NAME = /^space-[a-z0-9][a-z0-9-]{0,30}$/;
const usage = 'Usage: sandbox ls [--json] | ps [-a|--all] [--json] | list [--json] | status [name-or-job-id] | create/start/stop/kill NAME | delete NAME --confirm NAME\n' + EXEC_USAGE;
class ApiError extends Error {}
const safeVM = (vm, inventory = {}) => ({...describeSandbox(vm, {verified: !inventory.error, observedAt: inventory.updatedAt ?? null}),
  ipAddress: vm.ipAddress, securityReady: vm.securityReady, stage: vm.stage});
const safeJob = job => ({ id: job.id, name: job.name, action: job.action, status: job.status,
  createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error });
export async function runCli(args, { request = fetch, print = console.log, stdout, stderr } = {}) {
  const [command, name, flag, confirmation] = args;
  const exec = command === 'exec' ? parseExecArgs(args.slice(1)) : null;
  const listing = ['list', 'ls', 'ps'].includes(command) ? parseListArgs(command, args.slice(1)) : null;
  const mutation = ['create', 'start', 'stop', 'kill', 'delete'].includes(command);
  if (mutation) {
    if (!NAME.test(name ?? '') || (command === 'delete'
      ? args.length !== 4 || flag !== '--confirm' || confirmation !== name : args.length !== 2)) throw new Error(usage);
  } else if (!exec && !listing && !(command === 'status' && args.length <= 2)) throw new Error(usage);
  async function api(path, options = {}, timeoutMs = 15000, responseLimit = 1000000) {
    const response = await request(BASE + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    if (text.length > responseLimit) throw new Error('API response is too large.');
    let body;
    try { body = JSON.parse(text); } catch { throw new Error('Invalid API response.'); }
    if (!response.ok) throw new ApiError(typeof body.error === 'string' ? body.error.slice(0, 300).replace(/[\x00-\x1f\x7f]/g, ' ') : `API request failed (${response.status}).`);
    return body;
  }
  const state = await api('/api/state');
  if (exec) {
    const result = await api(`/api/sandboxes/${exec.name}/exec`, {
      method: 'POST', headers: {'content-type': 'application/json', 'x-csrf-token': state.csrfToken},
      body: JSON.stringify({command: exec.command, timeoutSeconds: exec.timeoutSeconds}),
    }, (exec.timeoutSeconds + 30) * 1000, 16 * 1024 * 1024);
    return renderExecResult(result, {json: exec.json, print, stdout, stderr});
  }
  if (listing) {
    const allRows = state.sandboxes.map(vm => safeVM(vm, state.inventory));
    const rows = filterSandboxes(allRows, listing.filter);
    print(listing.json ? JSON.stringify(rows, null, 2) : formatSandboxTable(rows, {allRows, activeVMs: state.inventory?.activeCount, maxRunning: state.policy?.maxRunning, inventoryError: state.inventory?.error}));
    return 0;
  }
  let result;
  if (mutation) {
    const body = command === 'create' ? { name } : { action: command, ...(command === 'delete' ? { confirmation } : {}) };
    const path = command === 'create' ? '/api/sandboxes' : `/api/sandboxes/${name}/actions`;
    result = safeJob((await api(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrfToken }, body: JSON.stringify(body) })).job);
  } else if (name) {
    const vm = state.sandboxes.find(vm => vm.name === name);
    const job = state.jobs.find(job => job.id === name);
    if (!vm && !job) throw new Error('Sandbox or recent job not found.');
    result = vm ? safeVM(vm, state.inventory) : safeJob(job);
  } else result = { host: state.host, policy: state.policy, inventory: state.inventory,
    sandboxes: state.sandboxes.map(vm => safeVM(vm, state.inventory)), jobs: state.jobs.map(safeJob) };
  print(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = (await runCli(process.argv.slice(2))) ?? 0; }
  catch (error) {
    const known = error instanceof ApiError || (error instanceof Error && (error.message.startsWith('Usage:') || error.message === 'Sandbox or recent job not found.'));
    console.error(known ? error.message : 'Could not reach the control service on this host. Check that it is running.');
    process.exitCode = 1;
  }
}
