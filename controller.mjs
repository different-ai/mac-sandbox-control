import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import {controlDir, storageRoot, lumeBin, appDir, desktopEnabled, stateRoot as stateRootConfig, publicHost as publicHostConfig} from './config.mjs';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync,
  statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntimeInspector, unknownRuntime } from './runtime-health.mjs';
import { parseLumeJSON } from './lume-json.mjs';
import { inspectDesktopHealth } from './desktop-health.mjs';

const execute = promisify(execFile);
export const GiB = 1024 ** 3;
export const NAME = /^space-[a-z0-9][a-z0-9-]{0,30}$/;
const TEMPLATE = 'macos-template';
const ACTIONS = new Set(['start', 'stop', 'kill', 'delete']);
const STATUSES = new Set(['running', 'stopped', 'suspended', 'provisioning', 'pulling', 'starting', 'stopping']);
const now = () => new Date().toISOString();
export class ControlError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
const requireThat = (condition, message, status) => {
  if (!condition) throw new ControlError(message, status);
};
function privatePath(path, directory = false) {
  const st = lstatSync(path);
  requireThat((directory ? st.isDirectory() : st.isFile()) && st.uid === process.getuid(), 'Unsafe private state path.', 500);
  requireThat(directory || st.nlink === 1, 'Unsafe private state file.', 500);
  chmodSync(path, directory ? 0o700 : 0o600);
}
function acquireLock(stateDir) {
  const lock = join(stateDir, 'controller.lock');
  const guard = join(stateDir, 'acquiring.lock');
  // All acquisitions use this guard. A crash in acquisition is uncertain: refuse, never steal it.
  try { mkdirSync(guard, { mode: 0o700 }); }
  catch { throw new ControlError('Lock acquisition uncertain; inspect the private state directory.', 500); }
  const ownerFile = join(lock, 'owner.json');
  const owner = { pid: process.pid, token: randomUUID() };
  try {
    if (existsSync(lock)) {
      privatePath(lock, true);
      let old;
      try { privatePath(ownerFile); old = JSON.parse(readFileSync(ownerFile, 'utf8')); }
      catch { throw new ControlError('Controller lock ownership uncertain.', 500); }
      requireThat(Number.isSafeInteger(old.pid) && old.pid > 0 && typeof old.token === 'string', 'Controller lock ownership uncertain.', 500);
      let dead = false;
      try { process.kill(old.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') dead = true; }
      requireThat(dead, 'Another controller is alive, or its PID cannot be safely checked.', 500);
      unlinkSync(ownerFile);
      rmdirSync(lock); // Unknown extra files cause a fail-closed refusal.
    }
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(ownerFile, JSON.stringify(owner), { mode: 0o600, flag: 'wx', flush: true });
  } finally { rmdirSync(guard); }
  return () => {
    const current = JSON.parse(readFileSync(ownerFile, 'utf8'));
    requireThat(current.token === owner.token, 'Controller lock changed; refusing to remove it.', 500);
    unlinkSync(ownerFile); rmdirSync(lock);
  };
}

// Lume v0.6.1: VMDetails.swift / VMDetailsPrinter.swift. Deliberately allowlist fields;
// vncUrl, machine identifiers, directories, and command output never reach the API.
export function parseInventory(stdout) {
  let rows;
  try { rows = parseLumeJSON(stdout); } catch { throw new ControlError('Lume inventory is invalid.', 503); }
  requireThat(Array.isArray(rows), 'Lume inventory is invalid.', 503);
  return rows.map(row => {
    const integer = value => Number.isSafeInteger(value) && value >= 0;
    requireThat(row && typeof row.name === 'string' && typeof row.status === 'string'
      && typeof row.locationName === 'string' && typeof row.os === 'string'
      && integer(row.cpuCount) && integer(row.memorySize)
      && integer(row.diskSize?.allocated) && integer(row.diskSize?.total), 'Lume inventory is invalid.', 503);
    return { name: row.name, status: STATUSES.has(row.status) ? row.status : 'unknown',
      cpu: row.cpuCount, memoryGiB: row.memorySize / GiB, diskGiB: row.diskSize.total / GiB,
      os: row.os.toLowerCase(), ipAddress: typeof row.ipAddress === 'string' && isIP(row.ipAddress) ? row.ipAddress : null };
  });
}

export class Controller {
  constructor(options = {}) {
    process.umask(0o077);
    this.stateDir = resolve(options.stateDir ?? controlDir);
    this.storage = resolve(options.storage ?? storageRoot);
    this.stateRoot = resolve(options.stateRoot ?? (options.stateDir ? dirname(this.stateDir) : stateRootConfig));
    this.readyFile = options.readyFile ?? join(this.stateRoot, 'template-ready');
    this.lume = options.lume ?? lumeBin;
    this.provisioner = resolve(options.provisioner ?? process.env.SANDBOX_PROVISIONER ?? join(appDir, 'provision.sh'));
    this.powerHelper = resolve(options.powerHelper ?? process.env.SANDBOX_POWER_HELPER ?? join(appDir, 'power.sh'));
    this.runner = options.runner ?? ((file, args, config) => execute(file, args, config));
    this.runtimeInspector = options.runtimeInspector ?? createRuntimeInspector();
    this.inventoryGeneration = 0;
    this.resources = options.resources ?? (() => {
      const st = statfsSync(this.storage, { bigint: true });
      return { cpuTotal: cpus().length, memoryGiB: totalmem() / GiB, diskGiB: Number(st.bavail * st.bsize) / GiB,
        diskTotalGiB: Number(st.blocks * st.bsize) / GiB };
    });
    this.desktopEnabled = options.desktopEnabled ?? desktopEnabled;
    this.consoleCheck = options.consoleCheck ?? inspectDesktopHealth;
    this.guestProbe = options.guestProbe ?? (async (name) => {
      try { const result = await this.exec(name, 'true', 10); return result.exitCode === 0 && !result.timedOut; }
      catch { return false; }
    });
    this.bootTimeoutMs = options.bootTimeoutMs ?? 120_000;
    this.pollMs = options.pollMs ?? 500;
    this.paused = options.autoStart === false;
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 }); privatePath(this.stateDir, true);
    this.unlock = acquireLock(this.stateDir);
    try {
      const dbPath = join(this.stateDir, 'control.sqlite');
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        try { privatePath(dbPath + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      this.db = new DatabaseSync(dbPath); privatePath(dbPath);
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS sandboxes (
          name TEXT PRIMARY KEY, createdAt TEXT NOT NULL, securityReady INTEGER NOT NULL DEFAULT 0,
          stage TEXT NOT NULL DEFAULT 'queued', reserved INTEGER NOT NULL DEFAULT 0,
          claimed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
          createdAt TEXT NOT NULL, startedAt TEXT, finishedAt TEXT, error TEXT);
        CREATE INDEX IF NOT EXISTS job_queue ON jobs(status, createdAt);`);
      this.db.prepare("UPDATE jobs SET status='failed', finishedAt=?, error='Interrupted; not retried.' WHERE status='running'").run(now());
      // Reservations survive restart: a detached VM may still be starting. Never silently release them.
      this.wake();
    } catch (error) { this.db?.close(); this.unlock(); throw error; }
  }
  owned(name) {
    requireThat(typeof name === 'string' && NAME.test(name), 'Invalid managed sandbox name.', 400);
    const row = this.db.prepare('SELECT * FROM sandboxes WHERE name=?').get(name);
    requireThat(row, 'Sandbox is not managed by this controller.', 404);
    return row;
  }
  enqueue(name, action, confirmation) {
    requireThat(!this.closing, 'Controller is shutting down.', 503);
    requireThat(typeof name === 'string' && NAME.test(name), 'Use space- followed by 1–31 lowercase letters, digits, or hyphens.', 400);
    requireThat(action === 'create' || ACTIONS.has(action), 'Invalid action.', 400);
    if (action !== 'create') this.owned(name);
    if (action === 'delete') requireThat(confirmation === name, 'Delete requires exact sandbox name confirmation.', 400);
    const job = { id: randomUUID(), name, action, status: 'queued', createdAt: now(), startedAt: null, finishedAt: null, error: null };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (action === 'create') {
        requireThat(!this.db.prepare('SELECT 1 FROM sandboxes WHERE name=?').get(name), 'Sandbox name is already registered.');
        this.db.prepare('INSERT INTO sandboxes(name,createdAt) VALUES (?,?)').run(name, job.createdAt);
      }
      this.db.prepare('INSERT INTO jobs(id,name,action,status,createdAt) VALUES (?,?,?,?,?)').run(job.id, name, action, 'queued', job.createdAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.wake(); return job;
  }
  wake() {
    if (this.worker || this.closing || this.paused) return;
    this.worker = Promise.resolve().then(async () => {
      while (!this.closing) {
        const job = this.db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY rowid LIMIT 1").get();
        if (!job) break;
        this.db.prepare("UPDATE jobs SET status='running', startedAt=? WHERE id=?").run(now(), job.id);
        let error = null;
        try { await this.perform(job); }
        catch (failure) { error = failure instanceof ControlError ? failure.message : 'Internal operation failed.'; }
        // Also invalidates an in-flight refresh begun before this job finished.
        this.inventoryGeneration++;
        this.snapshot = null;
        this.db.prepare('UPDATE jobs SET status=?, finishedAt=?, error=? WHERE id=?').run(error ? 'failed' : 'succeeded', now(), error, job.id);
      }
    }).finally(() => {
      this.worker = null;
      // An enqueue can land between the empty-queue read and this finally callback.
      if (!this.closing && !this.paused && this.db.prepare("SELECT 1 FROM jobs WHERE status='queued' LIMIT 1").get()) this.wake();
    });
  }
  async idle() { while (this.worker) await this.worker; }
  async close() {
    this.closePromise ??= (async () => {
      this.closing = true; await this.idle(); this.db.close(); this.unlock(); this.closed = true;
    })();
    await this.closePromise;
  }
  async invoke(args, helper = null) {
    try {
      const result = await this.runner(helper === 'provision' ? this.provisioner : helper === 'power' ? this.powerHelper : this.lume, args, {
        encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: helper || args[0] === 'clone' ? 30 * 60_000 : 35_000,
        killSignal: 'SIGKILL', windowsHide: true,
        env: { ...process.env, SANDBOX_STATE_ROOT: this.stateRoot, SANDBOX_STATE_DIR: this.stateDir, SANDBOX_DESKTOP_ENABLED: this.desktopEnabled ? '1' : '0', SANDBOX_VM_STORAGE: this.storage, LUME_BIN: this.lume },
      });
      return typeof result === 'string' ? result : result.stdout;
    } catch (error) {
      // Diagnostics remain on the host, never in an API response or browser log.
      try {
        const log = join(this.stateDir, 'last-command-error.log');
        try { privatePath(log); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
        const passwords = args.flatMap((arg, index) => arg === '--vnc-password' ? [args[index + 1]] : []).filter(Boolean);
        const redact = value => passwords.reduce((text, password) => text.split(password).join('[REDACTED]'), String(value ?? ''));
        const safeArgs = args.map((arg, index) => args[index - 1] === '--vnc-password' ? '[REDACTED]' : redact(arg));
        writeFileSync(log, JSON.stringify({at: now(), helper, args: safeArgs, code: Number.isInteger(error.code) ? error.code : null,
          stdout: redact(error.stdout).slice(-65536), stderr: redact(error.stderr).slice(-65536)}) + '\n', {mode: 0o600, flush: true});
      } catch {}
      const code = Number.isInteger(error.code) ? ` (exit code ${error.code})` : error.killed ? ' (timed out)' : '';
      throw new ControlError(`Command failed${code}.`, 503);
    }
  }
  async inventory() {
    const rows = parseInventory(await this.invoke(['ls', '--storage', this.storage, '--format', 'json']));
    return Promise.all(rows.map(async row => {
      let health;
      try { health = await this.runtimeInspector(row, { storage: this.storage, lume: this.lume }); }
      catch { health = unknownRuntime(); }
      const expectedProcessState = { running: 'running', stopped: 'stopped', crashed: 'dead' };
      const status = Object.hasOwn(expectedProcessState, health?.status) && health.processState === expectedProcessState[health.status]
        ? health.status : 'unknown';
      return { ...row, status, ipAddress: status === 'running' ? row.ipAddress : null,
        runtime: { processState: ['running', 'stopped', 'dead', 'unknown'].includes(health?.processState) ? health.processState : 'unknown',
          guestSsh: 'unverified' } };
    }));
  }
  vm(rows, name, optional = false) {
    const matches = rows.filter(vm => vm.name === name);
    requireThat(matches.length <= 1, 'VM name is ambiguous across Lume storage locations.');
    requireThat(optional || matches.length === 1, 'Registered VM is missing from Lume.');
    return matches[0];
  }
  templateReady() {
    try { const st = lstatSync(this.readyFile); return st.isFile() && st.uid === process.getuid(); }
    catch { return false; }
  }
  async checkCapacity(rows, name) {
    const host = await this.resources();
    requireThat(Number.isFinite(host.memoryGiB) && Number.isFinite(host.diskGiB), 'Host resources unavailable.', 503);
    const active = rows.filter(vm => vm.status !== 'stopped');
    const reservations = this.db.prepare('SELECT name FROM sandboxes WHERE reserved=1').all()
      .filter(row => row.name !== name && !active.some(vm => vm.name === row.name));
    requireThat(active.length + reservations.length < 2, 'Maximum two running or starting VMs.');
    const used = active.reduce((sum, vm) => sum + vm.memoryGiB, 0) + reservations.length * 14;
    requireThat(host.memoryGiB - used - 14 >= 6, 'At least 6 GiB host memory must remain reserved.');
    return host;
  }
  async waitFor(name, status, end = Date.now() + this.bootTimeoutMs) {
    do {
      if (this.vm(await this.inventory(), name).status === status) return;
      if (Date.now() >= end) break;
      await delay(this.pollMs);
    } while (true);
    throw new ControlError(`VM did not reach ${status} before timeout; no automatic retry.`);
  }
  async boot(name) {
    const owned = this.owned(name);
    requireThat(owned.claimed === 1 && owned.securityReady === 1, 'Sandbox has not completed secure provisioning.');
    requireThat(!owned.reserved, 'VM has an unresolved boot reservation; use kill to settle it.');
    const rows = await this.inventory();
    const vm = this.vm(rows, name);
    requireThat(vm.status === 'stopped', 'VM must be stopped before starting.');
    requireThat(vm.os === 'macos' && vm.cpu === 8 && vm.memoryGiB === 14 && vm.diskGiB === 150,
      'Managed VM configuration changed; inspect before starting.');
    await this.checkCapacity(rows, name);
    const desktop = this.desktopEnabled ? this.desktopFor(name) : null;
    this.db.prepare("UPDATE sandboxes SET reserved=1, stage='starting' WHERE name=?").run(name);
    // Native VNC is private upstream ONLY. Human clients always use the persistent relay.
    await this.invoke(['run', name, '--storage', this.storage, '--display', 'none',
      ...(desktop ? ['--vnc', 'enabled', '--vnc-port', String(desktop.port + 10000), '--vnc-password', desktop.upstreamPassword] : ['--vnc', 'disabled']),
      '--detach', '--log-file', '/dev/null']);
    const end = Date.now() + this.bootTimeoutMs;
    await this.waitFor(name, 'running', end);
    do {
      const vm = this.vm(await this.inventory(), name);
      let sshReady = false;
      try { sshReady = vm.status === 'running' && await this.guestProbe(name, vm) === true; } catch {}
      const consoleReady = !desktop || this.desktopHealth(name).ready;
      if (Date.now() >= end) throw new ControlError('Guest SSH or desktop console not ready before timeout; no automatic retry.');
      if (sshReady && consoleReady) break;
      await delay(this.pollMs);
    } while (true);
    this.db.prepare("UPDATE sandboxes SET reserved=0, stage='ready' WHERE name=?").run(name);
  }
  // Stable desktop port (5901-5949) and VNC password per sandbox; VNC passwords are 8 characters (protocol limit).
  desktopFor(name) {
    const portsFile = join(this.stateDir, 'desktop-ports.json');
    let ports = {};
    try { ports = JSON.parse(readFileSync(portsFile, 'utf8')); } catch {}
    let port = ports[name];
    requireThat(port === undefined || Number.isInteger(port) && port >= 5901 && port <= 5949, 'Invalid desktop port allocation; inspect private state.', 503);
    if (!Number.isInteger(port)) {
      const used = new Set(Object.values(ports));
      for (let candidate = 5901; candidate <= 5949; candidate++) if (!used.has(candidate)) { port = candidate; break; }
      requireThat(Number.isInteger(port), 'No free desktop port.', 503);
      ports[name] = port;
      writeFileSync(portsFile, JSON.stringify(ports, null, 2) + '\n', { mode: 0o600 });
    }
    const credentials = join(this.stateRoot, 'credentials');
    mkdirSync(credentials, { recursive: true, mode: 0o700 });
    const credential = (suffix, differentFrom) => {
      const file = join(credentials, name + suffix);
      let password;
      try { privatePath(file); password = readFileSync(file, 'utf8').trim(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!/^[A-Za-z0-9]{8}$/.test(password ?? '') || password === differentFrom) {
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
        do { password = Array.from(randomBytes(8), b => alphabet[b % alphabet.length]).join(''); } while (password === differentFrom);
        writeFileSync(file, password, { mode: 0o600 });
      }
      return password;
    };
    const password = credential('.vnc');
    return { port, password, upstreamPassword: credential('.vnc-upstream', password) };
  }
  desktopHealth(name) {
    if (!this.desktopEnabled) return {ready: false, connected: false, reason: 'disabled', port: null};
    try {
      const health = this.consoleCheck(name, {stateDir: this.stateDir, storage: this.storage, stateRoot: this.stateRoot});
      // Explicit allowlist even for injected inspectors.
      return {ready: health?.ready === true && health?.connected === true, connected: health?.connected === true,
        reason: ['ready', 'stale', 'inventory-unverified', 'owner-unverified', 'generation-mismatch', 'not-ready', 'unallocated', 'unavailable'].includes(health?.reason) ? health.reason : 'unavailable',
        port: this.readDesktopPort(name),
        ...(Number.isFinite(health?.lastFrameAt) ? {lastFrameAt: health.lastFrameAt} : {}),
        ...(Number.isSafeInteger(health?.frames) && health.frames >= 0 ? {frames: health.frames} : {})};
    } catch { return {ready: false, connected: false, reason: 'unavailable', port: this.readDesktopPort(name)}; }
  }
  // Human relay password only — never the native upstream or macOS account password.
  // Read-only: never creates or rotates credentials; requires a verified-running VM and a ready console.
  async desktopLogin(name) {
    requireThat(this.desktopEnabled, 'Remote desktop is disabled on this host.', 409);
    const owned = this.owned(name);
    requireThat(owned.securityReady === 1, 'Sandbox has not completed secure provisioning.', 409);
    const vm = this.vm(await this.inventory(), name);
    requireThat(vm.status === 'running', 'Start the sandbox before opening its desktop.', 409);
    const desktop = this.desktopHealth(name);
    requireThat(desktop.ready && Number.isInteger(desktop.port), 'Desktop console is not ready yet. Try again shortly.', 409);
    let password;
    try {
      const file = join(this.stateRoot, 'credentials', name + '.vnc');
      privatePath(file); password = readFileSync(file, 'utf8').trim();
    } catch {}
    requireThat(/^[A-Za-z0-9]{8}$/.test(password ?? ''), 'Desktop password is unavailable; inspect private state.', 503);
    return { name, port: desktop.port, password };
  }
  readDesktopPort(name) {
    try {
      const port = JSON.parse(readFileSync(join(this.stateDir, 'desktop-ports.json'), 'utf8'))[name];
      return Number.isInteger(port) && port >= 5901 && port <= 5949 ? port : null;
    } catch { return null; }
  }
  cleanupCredentials(name) {
    const root = this.stateRoot;
    for (const folder of ['keys', 'credentials']) {
      try { privatePath(join(root, folder), true); }
      catch (error) { if (error.code !== 'ENOENT') throw new ControlError('Credential cleanup needs operator inspection.', 503); }
    }
    const paths = [join(root, 'keys', name), join(root, 'keys', name + '.pub'),
      join(root, name + '.known_hosts'), join(root, 'credentials', name + '.json'), join(root, 'credentials', name + '.vnc'),
      join(root, 'credentials', name + '.vnc-upstream')];
    try {
      const portsFile = join(this.stateDir, 'desktop-ports.json');
      const ports = JSON.parse(readFileSync(portsFile, 'utf8'));
      if (name in ports) { delete ports[name]; writeFileSync(portsFile, JSON.stringify(ports, null, 2) + '\n', { mode: 0o600 }); }
    } catch {}
    for (const target of paths) {
      try { privatePath(target); unlinkSync(target); }
      catch (error) { if (error.code !== 'ENOENT') throw new ControlError('VM deleted; private credential cleanup needs operator inspection.', 503); }
    }
  }
  async perform({ name, action }) {
    this.owned(name); // Recheck at execution, not just enqueue time.
    if (action === 'create') {
      requireThat(this.templateReady(), 'Template readiness marker is missing.');
      const rows = await this.inventory();
      requireThat(!rows.some(vm => vm.name === name), 'A Lume VM with that name already exists.');
      const template = this.vm(rows, TEMPLATE);
      requireThat(template.os === 'macos' && template.status === 'stopped' && template.diskGiB === 150, 'Template must be a stopped 150 GiB macOS VM.');
      const host = await this.checkCapacity(rows, name);
      requireThat(host.diskGiB >= 60, 'At least 60 GiB disk space is required before cloning.');
      this.db.prepare("UPDATE sandboxes SET stage='cloning' WHERE name=?").run(name);
      await this.invoke(['clone', TEMPLATE, name, '--source-storage', this.storage, '--dest-storage', this.storage]);
      // Only a successful clone establishes ownership. Ambiguous partial clones require operator inspection.
      this.db.prepare("UPDATE sandboxes SET claimed=1, stage='identity' WHERE name=?").run(name);
      await this.invoke(['set', name, '--storage', this.storage, '--cpu', '8', '--memory', '14GB', '--machine-identifier', 'random', '--mac-address', 'random']);
      // The provisioner may boot the clone. Recheck ALL guests immediately before handing it control.
      const fresh = await this.inventory();
      requireThat(this.vm(fresh, name).status === 'stopped', 'Cloned VM must be stopped before provisioning.');
      await this.checkCapacity(fresh, name);
      this.db.prepare("UPDATE sandboxes SET reserved=1, stage='provisioning' WHERE name=?").run(name);
      await this.invoke([name], 'provision');
      requireThat(this.vm(await this.inventory(), name).status === 'stopped', 'Provisioner must finish with the VM stopped.');
      this.db.prepare("UPDATE sandboxes SET securityReady=1, reserved=0, stage='ready' WHERE name=?").run(name);
      await this.boot(name); return;
    }
    if (action === 'start') return this.boot(name);
    const owned = this.owned(name);
    // Registration alone is not ownership: a failed name collision must never adopt an outside VM.
    if (!owned.claimed) {
      requireThat(action === 'delete', 'Controller did not create this VM.');
      this.db.prepare('DELETE FROM sandboxes WHERE name=?').run(name); return;
    }
    const vm = this.vm(await this.inventory(), name, action === 'delete');
    if (action === 'delete') {
      requireThat(!owned.reserved && (!vm || vm.status === 'stopped'), 'Stop or kill the VM before deleting; unresolved starts cannot be deleted.');
      if (vm) await this.invoke(['delete', name, '--storage', this.storage, '--force']);
      this.cleanupCredentials(name);
      this.db.prepare('DELETE FROM sandboxes WHERE name=?').run(name); return;
    }
    if (action === 'stop') {
      requireThat(!owned.reserved, 'Unresolved boot reservation; use kill instead.');
      if (vm.status === 'stopped') return;
      requireThat(owned.securityReady === 1 && vm.status === 'running', 'Secure running VM required for graceful shutdown.');
      await this.invoke([name], 'power'); // Key-based guest authentication; no password in argv.
      await this.waitFor(name, 'stopped'); // Never escalate graceful stop to power-off.
    } else {
      if (vm.status !== 'stopped' || owned.reserved) await this.invoke(['stop', name, '--storage', this.storage, '--force']);
      await this.waitFor(name, 'stopped');
    }
    this.db.prepare("UPDATE sandboxes SET reserved=0, stage=CASE WHEN securityReady=1 THEN 'ready' ELSE stage END WHERE name=?").run(name);
  }
  // Run one command inside a running, provisioned sandbox over its pinned per-sandbox key.
  // Executes in the GUEST only; never a host shell. Not queued: read-mostly and parallel-safe.
  async exec(name, command, timeoutSeconds = 120) {
    const owned = this.owned(name);
    requireThat(owned.securityReady === 1, 'Sandbox has not completed secure provisioning.');
    requireThat(typeof command === 'string' && command.length > 0 && command.length <= 16384, 'command must be 1-16384 characters.', 400);
    const timeout = Math.min(600, Math.max(1, Number.isInteger(timeoutSeconds) ? timeoutSeconds : 120));
    const vm = this.vm(await this.inventory(), name);
    requireThat(vm.status === 'running' && vm.ipAddress, `${name} is not running. Start it first.`);
    const root = this.stateRoot;
    let user;
    try { user = JSON.parse(readFileSync(join(root, 'credentials', name + '.json'), 'utf8')).username; } catch { user = null; }
    requireThat(typeof user === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(user), 'Sandbox account information unavailable.', 503);
    const args = ['-T', '-i', join(root, 'keys', name), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${join(root, name + '.known_hosts')}`, '-o', `HostKeyAlias=${name}`,
      `${user}@${vm.ipAddress}`, command];
    const runner = this.execRunner ?? ((file, a, config) => execute(file, a, config));
    try {
      const { stdout, stderr } = await runner('/usr/bin/ssh', args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: timeout * 1000, killSignal: 'SIGKILL' });
      return { exitCode: 0, stdout, stderr, timedOut: false };
    } catch (error) {
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new ControlError('Output exceeded 1 MB; redirect it to a file inside the sandbox.', 413);
      if (error.killed) return { exitCode: null, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), timedOut: true };
      if (Number.isInteger(error.code) && error.code !== 255) return { exitCode: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), timedOut: false };
      throw new ControlError('Could not reach the sandbox over SSH.', 503);
    }
  }
  async state() {
    // Only inventory/resources are cached. Durable job state and newly registered records are always live.
    while (!this.snapshot || this.snapshot.generation !== this.inventoryGeneration || Date.now() - this.snapshot.at >= 3000) {
      this.refreshing ??= (async () => {
        const generation = this.inventoryGeneration;
        let rows = [], host = { cpuTotal: cpus().length, memoryGiB: totalmem() / GiB, diskGiB: null }, error = null;
        try { rows = await this.inventory(); host = { ...host, ...await this.resources() }; }
        catch (failure) { error = failure instanceof ControlError ? failure.message : 'Host resources unavailable.'; }
        const templates = rows.filter(vm => vm.name === TEMPLATE);
        const templateReady = !error && this.templateReady() && templates.length === 1
          && templates[0].status === 'stopped' && templates[0].os === 'macos' && templates[0].diskGiB === 150;
        this.snapshot = { at: Date.now(), generation, rows, host, error, templateReady };
      })().finally(() => { this.refreshing = null; });
      await this.refreshing;
    }
    const { rows, host, error, templateReady, at } = this.snapshot;
    const sandboxes = this.db.prepare('SELECT * FROM sandboxes ORDER BY createdAt, name').all().map(row => {
      const matches = rows.filter(vm => vm.name === row.name);
      const vm = row.claimed && matches.length === 1 ? matches[0] : null;
      return { name: row.name, createdAt: row.createdAt, securityReady: row.securityReady === 1,
        stage: row.stage, starting: row.reserved === 1, status: error ? 'unknown' : vm?.status ?? (matches.length ? 'unknown' : 'missing'),
        runtime: vm?.runtime ?? { processState: 'unknown', guestSsh: 'unverified' },
        desktopState: this.desktopHealth(row.name),
        cpu: vm?.cpu ?? 8, memoryGiB: vm?.memoryGiB ?? 14, diskGiB: vm?.diskGiB ?? 150, ipAddress: vm?.ipAddress ?? null, desktopPort: this.desktopEnabled ? this.readDesktopPort(row.name) : null };
    });
    return { host: { ...host, diskAvailableGiB: host.diskGiB }, policy: { maxRunning: 2, networkIsolationVerified: false, templateReady, desktopEnabled: this.desktopEnabled }, publicHost: publicHostConfig, sandboxes,
      jobs: this.db.prepare('SELECT * FROM jobs ORDER BY rowid DESC LIMIT 100').all(),
      inventory: { updatedAt: new Date(at).toISOString(), error, activeCount: error ? null : rows.filter(vm => vm.status !== 'stopped').length } };
  }
}
