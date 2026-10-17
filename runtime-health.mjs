import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const execute = promisify(execFile);
const validPID = pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647;
const result = (status, processState, reason) => ({ status, processState, reason, guestSsh: 'unverified' });
export const unknownRuntime = () => result('unknown', 'unknown', 'inspection-unavailable');

const MACH_O = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
const isNative = bytes => bytes.length >= 4 && MACH_O.has(bytes.subarray(0, 4).toString('hex'));
async function executablePrefix(fs, file) {
  const handle = await fs.open(file, 'r');
  try {
    const st = await handle.stat();
    if (!st.isFile() || !Number.isSafeInteger(st.size) || st.size < 4) return null;
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { bytes: buffer.subarray(0, bytesRead), size: st.size };
  } finally { await handle.close(); }
}
async function nativeExecutable(fs, lume) {
  const configured = await fs.realpath(lume);
  const prefix = await executablePrefix(fs, configured);
  if (!prefix) return null;
  if (isNative(prefix.bytes)) return configured;
  // The official installer writes a literal two-line shell launcher, not a
  // symlink. Parse ONLY this exact form; never execute/source a wrapper or
  // expand shell syntax. Bound reads and reject truncated/extra script text.
  if (prefix.size > 4096 || prefix.bytes.length !== prefix.size) return null;
  const text = prefix.bytes.toString('utf8');
  if (!prefix.bytes.equals(Buffer.from(text, 'utf8'))) return null;
  const match = text.match(/^#!\/bin\/sh\nexec "(\/[^"\\$`\x00-\x1f\x7f]+)" "\$@"\n?$/);
  if (!match || match[0] !== text) return null;
  const target = await fs.realpath(match[1]);
  const native = await executablePrefix(fs, target);
  // Do not follow chains of scripts, even if each looks like a launcher.
  return native && isNative(native.bytes) ? target : null;
}

// Public Lume v0.6.1 NativeDisplayAttachService.swift defines exactly
// {processIdentifier: Int32}; do not infer a session PID from URLs or argv.
// RunLockProbe.swift uses lsof on config.json (held open under flock by run).
// https://github.com/trycua/cua/tree/lume-v0.6.1/libs/lume/src
// All commands are local, bounded, and read-only. Never request args/command,
// probe SSH/VNC, signal a VM, or repair/remove stale Lume metadata here.
export function createRuntimeInspector({ platform = process.platform, runner = execute,
  fs = { lstat, open, readFile, realpath }, lockHolders, inspectProcess } = {}) {
  const command = (file, args) => runner(file, args, {
    encoding: 'utf8', timeout: 2500, maxBuffer: 64 * 1024, killSignal: 'SIGKILL', windowsHide: true,
  });
  lockHolders ??= async file => {
    let stdout;
    try {
      const response = await command('/usr/sbin/lsof', ['-n', '-P', '-t', file]);
      if (String(response.stderr ?? '').trim()) throw new Error('Inconclusive lsof');
      stdout = response.stdout;
    } catch (error) {
      if (error.code === 1 && !error.killed && !String(error.stdout ?? '').trim() && !String(error.stderr ?? '').trim()) return [];
      throw error;
    }
    const lines = String(stdout ?? '').trim().split(/\s+/).filter(Boolean);
    if (!lines.length || lines.some(line => !/^\d+$/.test(line) || !validPID(Number(line)))) throw new Error('Invalid lsof');
    return [...new Set(lines.map(Number))];
  };
  inspectProcess ??= async pid => {
    let response;
    try { response = await command('/bin/ps', ['-p', String(pid), '-o', 'stat=', '-o', 'comm=']); }
    catch (error) {
      if (error.code === 1 && !error.killed && !String(error.stdout ?? '').trim() && !String(error.stderr ?? '').trim()) return null;
      throw error;
    }
    if (String(response.stderr ?? '').trim()) throw new Error('Inconclusive ps');
    const match = String(response.stdout ?? '').trim().match(/^(\S+)\s+([^\r\n]+)$/);
    if (!match) throw new Error('Invalid ps');
    return { stat: match[1], comm: match[2].trim() };
  };
  return async (row, { storage, lume }) => {
    if (platform !== 'darwin') return unknownRuntime();
    // Names originate in Lume, not just in the controller's managed-name API.
    if (!row.name || row.name === '.' || row.name === '..' || /[\/\\\x00-\x1f]/.test(row.name)) return unknownRuntime();
    try {
      const directory = join(storage, row.name), config = join(directory, 'config.json');
      if (!(await fs.lstat(directory)).isDirectory() || !(await fs.lstat(config)).isFile()) return unknownRuntime();
      const holders = await lockHolders(config);
      if (!Array.isArray(holders) || holders.some(pid => !validPID(pid))) return unknownRuntime();
      if (holders.length > 1) return result('unknown', 'unknown', 'ambiguous-lock-owner');
      // Native-display owner metadata can survive a NORMAL graceful stop.
      // An independently verified empty config-holder list settles Lume's
      // stopped report; the historical PID must not block the next start.
      if (row.status === 'stopped' && holders.length === 0) return result('stopped', 'stopped', 'no-run-lock');
      let owner = null;
      try {
        const file = join(directory, '.native-display-owner.json');
        const st = await fs.lstat(file);
        if (!st.isFile() || st.size > 4096) return unknownRuntime();
        owner = JSON.parse(await fs.readFile(file, 'utf8')).processIdentifier;
        if (!validPID(owner)) return unknownRuntime();
      } catch (error) { if (error.code !== 'ENOENT') return unknownRuntime(); }
      const pid = holders[0] ?? owner;
      // Without a settled stopped report, an empty lock and missing owner
      // cannot turn Lume's stale running claim into stopped.
      if (pid === null || pid === undefined) return result('unknown', 'unknown', 'missing-runtime-owner');
      const process = await inspectProcess(pid);
      if (process === null) return result('crashed', 'dead', 'owner-exited');
      if (typeof process?.stat !== 'string' || typeof process?.comm !== 'string') return unknownRuntime();
      if (process.stat.includes('Z')) return result('crashed', 'dead', 'owner-zombie');
      if (!isAbsolute(process.comm) || !isAbsolute(lume)) return unknownRuntime();
      const [actual, expected] = await Promise.all([fs.realpath(process.comm), nativeExecutable(fs, lume)]);
      if (!expected) return unknownRuntime();
      if (resolve(actual) !== resolve(expected)) return result('crashed', 'dead', 'owner-pid-reused');
      // A live PID (even another Lume) is NOT VM identity. Require its config
      // ownership, and recheck after ps so an exited/reused PID is not enough.
      if (holders[0] !== pid || (owner !== null && owner !== pid)) return result('unknown', 'unknown', 'unproven-vm-owner');
      const fresh = await lockHolders(config);
      if (!Array.isArray(fresh) || fresh.length !== 1 || fresh[0] !== pid) return unknownRuntime();
      return result('running', 'running', 'config-owner-alive');
    } catch { return unknownRuntime(); }
  };
}
