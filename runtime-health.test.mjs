import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeInspector } from './runtime-health.mjs';

const nativeBytes = Buffer.from('cffaedfe00000000', 'hex');
function executableFile(bytes, onClose = () => {}) {
  bytes = Buffer.from(bytes);
  return {
    async stat() { return { isFile: () => true, size: bytes.length }; },
    async read(buffer, offset, length, position) {
      assert.equal(position, 0); assert(length <= 4097, 'executable reads must be bounded');
      const bytesRead = bytes.copy(buffer, offset, position, position + length);
      return { bytesRead, buffer };
    },
    async close() { onClose(); },
  };
}

// Entirely synthetic filesystem/process providers. No host VM, process, lsof,
// ps, SSH, VNC, or Lume commands are used on macOS or Linux CI.
function fixture({ owner = 4242, holders = [4242], process = { stat: 'S', comm: '/synthetic/bin/lume' },
  status = 'running', platform = 'darwin', missingConfig = false, malformedOwner = false,
  lockFailure = false, processFailure = false, runner, executables = null, realpaths = {} } = {}) {
  const calls = [], files = [], opened = [], closed = [];
  const fs = {
    async lstat(file) {
      files.push(file);
      if (file.endsWith('/config.json') && missingConfig || file.endsWith('/.native-display-owner.json') && owner === null) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return { size: 32, isDirectory: () => file === '/synthetic/custom-vms/space-a', isFile: () => file !== '/synthetic/custom-vms/space-a' };
    },
    async readFile(file) { files.push(file); return malformedOwner ? '{' : JSON.stringify({ processIdentifier: owner }); },
    async realpath(file) { return realpaths[file] ?? file; },
    async open(file, flags) {
      assert.equal(flags, 'r'); opened.push(file);
      const bytes = executables === null ? nativeBytes : executables[file];
      if (bytes === undefined) throw Object.assign(new Error('missing synthetic executable'), { code: 'ENOENT' });
      return executableFile(bytes, () => closed.push(file));
    },
  };
  const options = { fs, platform, runner: async (file, args, config) => {
    calls.push({ file, args, config });
    if (!runner) throw new Error('Unexpected command execution');
    return runner(file, args, config);
  } };
  if (!runner) {
    options.lockHolders = async file => { calls.push({ lock: file }); if (lockFailure) throw new Error('private diagnostic'); return holders; };
    options.inspectProcess = async pid => { calls.push({ pid }); if (processFailure) throw new Error('secret argv'); return process; };
  }
  const inspector = createRuntimeInspector(options);
  return { calls, files, opened, closed, inspect: () => inspector({ name: 'space-a', status }, { storage: '/synthetic/custom-vms', lume: '/synthetic/bin/lume' }), inspector };
}

test('ordinary running verifies the exact config owner and executable, not guest SSH', async () => {
  const f = fixture();
  assert.deepEqual(await f.inspect(), { status: 'running', processState: 'running', reason: 'config-owner-alive', guestSsh: 'unverified' });
  assert.equal(f.calls.filter(c => c.lock === '/synthetic/custom-vms/space-a/config.json').length, 2);
  assert(!f.files.some(file => file.includes('sessions.json')));
});

test('stale running claim with a dead owner is crashed even without sessions metadata', async () => {
  const f = fixture({ status: 'running', holders: [], process: null });
  assert.equal((await f.inspect()).status, 'crashed');
  assert.equal((await f.inspect()).processState, 'dead');
});

test('normal stopped with verified empty config holders ignores historical dead or reused owner PID', async () => {
  for (const process of [null, { stat: 'S', comm: '/synthetic/bin/unrelated' }]) {
    const stopped = fixture({ status: 'stopped', holders: [], process });
    assert.deepEqual(await stopped.inspect(), { status: 'stopped', processState: 'stopped', reason: 'no-run-lock', guestSsh: 'unverified' });
    assert(!stopped.calls.some(call => call.pid), 'historical PID is not needed to settle a verified stopped state');
    const running = fixture({ status: 'running', holders: [], process });
    assert.equal((await running.inspect()).status, 'crashed', 'an identical historical owner cannot settle a stale running claim');
  }
  assert.equal((await fixture({ status: 'stopped', holders: [], malformedOwner: true }).inspect()).status, 'stopped');
  assert.equal((await fixture({ status: 'stopped', holders: [], lockFailure: true }).inspect()).status, 'unknown');
});

const launcher = '/synthetic/bin/lume';
const installedNative = '/synthetic/home/.local/share/lume/lume.app/Contents/MacOS/lume';
const officialWrapper = `#!/bin/sh\nexec "${installedNative}" "$@"\n`;

test('official literal installer wrapper resolves to its native process executable without execution', async () => {
  const f = fixture({ executables: { [launcher]: officialWrapper, [installedNative]: nativeBytes },
    process: { stat: 'S', comm: installedNative } });
  assert.equal((await f.inspect()).status, 'running');
  assert.deepEqual(f.opened, [launcher, installedNative]); assert.deepEqual(f.closed, f.opened);
  assert(!f.calls.some(call => call.file), 'wrapper resolution must never invoke any executable');
});

test('official wrapper does not validate a reused PID with the wrong native executable', async () => {
  const f = fixture({ executables: { [launcher]: officialWrapper, [installedNative]: nativeBytes },
    process: { stat: 'S', comm: '/synthetic/bin/unrelated' } });
  const health = await f.inspect();
  assert.equal(health.status, 'crashed'); assert.equal(health.reason, 'owner-pid-reused');
  assert(!f.calls.some(call => call.file));
});

test('official wrapper native identity still requires the correct PID to own this VM config', async () => {
  for (const holders of [[], [4343]]) {
    const f = fixture({ holders, executables: { [launcher]: officialWrapper, [installedNative]: nativeBytes },
      process: { stat: 'S', comm: installedNative } });
    assert.equal((await f.inspect()).status, 'unknown');
    assert(!f.calls.some(call => call.file));
  }
});

test('unrecognised or dynamic wrappers are unknown rather than misclassified reused PIDs and are never executed', async () => {
  for (const script of [
    '#!/bin/sh\nexec /some/custom/lume "$@"\n',
    officialWrapper + 'echo additional-command\n',
    officialWrapper + '\n',
    '#!/bin/bash\nexec "/synthetic/native" "$@"\n',
    '#!/bin/sh\nexec "relative/native" "$@"\n',
    '#!/bin/sh\nexec "/synthetic/$(some-command)/lume" "$@"\n',
    '#!/bin/sh\nexec "/synthetic/`some-command`/lume" "$@"\n',
    '#!/bin/sh\nexec "/synthetic/$HOME/lume" "$@"\n',
    '#!/bin/sh\nexec "/synthetic/escaped\\\\path/lume" "$@"\n',
    '#!/bin/sh\nexec "/synthetic/native"\n',
    '#!/bin/sh\n' + '#'.repeat(5000),
  ]) {
    const f = fixture({ executables: { [launcher]: script }, process: { stat: 'S', comm: installedNative } });
    assert.equal((await f.inspect()).status, 'unknown');
    assert.deepEqual(f.opened, [launcher]); assert.deepEqual(f.closed, f.opened);
    assert(!f.calls.some(call => call.file), 'no shell, script, or nested command execution');
  }
});

test('wrapper targets must be readable native executables, not another wrapper', async () => {
  for (const target of [undefined, officialWrapper, 'not executable data']) {
    const f = fixture({ executables: { [launcher]: officialWrapper, [installedNative]: target },
      process: { stat: 'S', comm: installedNative } });
    assert.equal((await f.inspect()).status, 'unknown');
    assert(!f.calls.some(call => call.file));
  }
});

test('direct native and symlinked native installations retain executable identity checks', async () => {
  for (const realpaths of [{}, { [launcher]: installedNative }]) {
    const executable = realpaths[launcher] ?? launcher;
    const f = fixture({ realpaths, executables: { [executable]: nativeBytes }, process: { stat: 'S', comm: executable } });
    assert.equal((await f.inspect()).status, 'running');
    assert.deepEqual(f.opened, [executable]); assert.deepEqual(f.closed, f.opened);
    assert(!f.calls.some(call => call.file));
  }
});

test('reused PID with another executable is never running', async () => {
  const f = fixture({ holders: [], process: { stat: 'S', comm: '/synthetic/bin/unrelated' } });
  assert.equal((await f.inspect()).reason, 'owner-pid-reused');
  assert.equal((await f.inspect()).status, 'crashed');
});

test('reused PID of another Lume without this config ownership stays unknown', async () => {
  assert.equal((await fixture({ holders: [] }).inspect()).status, 'unknown');
  assert.equal((await fixture({ holders: [4343] }).inspect()).status, 'unknown');
});

test('zombie owner is crashed despite an existing process-table entry', async () => {
  const health = await fixture({ process: { stat: 'Z+', comm: '/synthetic/bin/lume' } }).inspect();
  assert.equal(health.status, 'crashed'); assert.equal(health.reason, 'owner-zombie');
});

test('missing metadata never turns an unproved running claim into stopped', async () => {
  for (const options of [{ owner: null, holders: [] }, { missingConfig: true }, { malformedOwner: true }]) {
    assert.equal((await fixture(options).inspect()).status, 'unknown');
  }
});

test('missing owner JSON is supported only with independently verified config ownership', async () => {
  assert.equal((await fixture({ owner: null }).inspect()).status, 'running');
});

test('ordinary stopped requires a checked config and empty holders without stale owner evidence', async () => {
  assert.equal((await fixture({ status: 'stopped', owner: null, holders: [] }).inspect()).status, 'stopped');
  assert.equal((await fixture({ status: 'stopped', missingConfig: true }).inspect()).status, 'unknown');
  assert.equal((await fixture({ status: 'stopped' }).inspect()).status, 'running', 'live config owner overrides a missing session');
});

test('process inspection and config-owner inspection failures fail closed without diagnostics', async () => {
  for (const options of [{ processFailure: true }, { lockFailure: true }, { holders: [4242, 4343] }, { process: {} }]) {
    const health = await fixture(options).inspect();
    assert.equal(health.status, 'unknown'); assert(!JSON.stringify(health).includes('secret'));
  }
});

test('config ownership must still exist after process identity inspection', async () => {
  let calls = 0;
  const inspector = createRuntimeInspector({ platform: 'darwin', fs: {
    lstat: async () => ({ isDirectory: () => true, isFile: () => true, size: 32 }),
    readFile: async () => '{"processIdentifier":4242}', realpath: async file => file,
    open: async () => executableFile(nativeBytes),
  }, lockHolders: async () => ++calls === 1 ? [4242] : [], inspectProcess: async () => ({ stat: 'S', comm: '/synthetic/bin/lume' }) });
  assert.equal((await inspector({ name: 'space-a', status: 'running' }, { storage: '/synthetic/custom-vms', lume: '/synthetic/bin/lume' })).status, 'unknown');
  assert.equal(calls, 2);
});

test('unsupported hosts do not run platform-specific commands', async () => {
  const f = fixture({ platform: 'linux' });
  assert.equal((await f.inspect()).status, 'unknown'); assert.deepEqual(f.calls, []); assert.deepEqual(f.files, []);
});

test('real command adapter requests only bounded local PID, stat and executable fields', async () => {
  const f = fixture({ runner: async file => file.endsWith('lsof') ? { stdout: '4242\n', stderr: '' }
    : { stdout: 'S /synthetic/bin/lume\n', stderr: '' } });
  assert.equal((await f.inspect()).status, 'running');
  assert.deepEqual(f.calls.map(c => c.file), ['/usr/sbin/lsof', '/bin/ps', '/usr/sbin/lsof']);
  assert.deepEqual(f.calls[1].args, ['-p', '4242', '-o', 'stat=', '-o', 'comm=']);
  assert.deepEqual(f.calls[0].args, ['-n', '-P', '-t', '/synthetic/custom-vms/space-a/config.json']);
  assert(f.calls.every(c => c.config.timeout === 2500 && c.config.maxBuffer === 64 * 1024));
});

test('real command adapter distinguishes absent PID from permission/timeout/malformed output', async () => {
  for (const kind of ['absent', 'permission', 'timeout', 'malformed']) {
    const f = fixture({ runner: async file => {
      if (file.endsWith('lsof')) return { stdout: '4242\n' };
      if (kind === 'malformed') return { stdout: 'junk' };
      throw Object.assign(new Error('sensitive'), { code: 1, stdout: '', stderr: kind === 'permission' ? 'permission denied' : '', killed: kind === 'timeout' });
    } });
    assert.equal((await f.inspect()).status, kind === 'absent' ? 'crashed' : 'unknown');
  }
});

test('real command adapter treats only clean lsof exit 1 as empty holders', async () => {
  for (const kind of ['empty', 'diagnostic', 'malformed', 'timeout']) {
    const f = fixture({ owner: null, status: 'stopped', runner: async () => {
      if (kind === 'malformed') return { stdout: 'not a pid' };
      throw Object.assign(new Error('sensitive'), { code: 1, stdout: '', stderr: kind === 'diagnostic' ? 'denied' : '', killed: kind === 'timeout' });
    } });
    assert.equal((await f.inspect()).status, kind === 'empty' ? 'stopped' : 'unknown');
  }
});

test('invalid names and invalid public owner PID schema fail closed before process lookup', async () => {
  for (const owner of [0, -1, '4242', 2 ** 40]) {
    const f = fixture({ owner }); assert.equal((await f.inspect()).status, 'unknown'); assert(!f.calls.some(call => call.pid));
  }
  for (const name of ['..', '.', '../outside', 'x/y', 'x\\y']) {
    const f = fixture();
    assert.equal((await f.inspector({ name, status: 'running' }, { storage: '/synthetic/custom-vms', lume: '/synthetic/bin/lume' })).status, 'unknown');
    assert.equal(f.files.length, 0);
  }
});
