// Shared state vocabulary for MCP and both CLIs. Setup-ready is not running.
const STATES = new Set(['running', 'stopped', 'starting', 'stopping', 'provisioning', 'pulling', 'suspended', 'crashed', 'missing', 'unknown']);
export function describeSandbox(row, {verified = true, observedAt = null} = {}) {
  const raw = STATES.has(row.status) ? row.status : 'unknown';
  const known = verified && !['unknown', 'missing'].includes(raw);
  const starting = row.starting === true;
  const state = !verified ? 'unknown' : starting && ['running', 'stopped'].includes(raw) ? 'starting' : raw;
  const ready = row.securityReady === true || row.ready === true;
  const running = known ? raw === 'running' : null;
  // A crashed owner is not a safely settled workspace. Keep capacity and ps
  // visibility conservative until an operator resolves its runtime metadata.
  const active = known && raw !== 'crashed' ? starting || !['stopped', 'suspended'].includes(raw) : null;
  const canExec = running === true && ready && !starting && state === 'running';
  let note;
  if (!known) note = 'State could not be verified; do not assume this VM is stopped.';
  else if (state === 'crashed') note = 'The recorded VM process exited or lost its identity. Commands are blocked; operator inspection is required.';
  else if (state === 'starting') note = 'Start is in progress. Wait for its job before executing commands.';
  else if (!ready) note = 'Credential setup is incomplete. Commands and login are blocked.';
  else if (state === 'running') note = 'VM process is running; command execution may be attempted. Guest SSH health is not verified.';
  else if (state === 'stopped') note = 'Stopped. Start this sandbox before executing commands or connecting.';
  else if (state === 'stopping') note = 'Shutdown is in progress.';
  else note = 'Transition in progress; check the lifecycle job.';
  return {
    name: row.name, status: raw, state, active, running, ready, canExec, starting,
    cpu: row.cpu, memoryGiB: row.memoryGiB, diskGiB: row.diskGiB,
    runtime: row.runtime ?? { processState: 'unknown', guestSsh: 'unverified' },
    desktopState: row.desktopState ?? {ready: false, connected: false, reason: 'unavailable', port: null}, observedAt, note,
  };
}
export function describeSandboxes(rows, inventory = {}) {
  return rows.map(row => describeSandbox(row, {verified: !inventory.error, observedAt: inventory.updatedAt ?? null}));
}
export function stateCounts(rows) {
  return {total: rows.length, running: rows.filter(s => s.running === true).length,
    stopped: rows.filter(s => s.state === 'stopped' && s.active === false).length,
    transitioning: rows.filter(s => s.active === true && s.state !== 'running').length,
    unknown: rows.filter(s => s.active === null).length};
}
export function filterSandboxes(rows, filter = 'all') {
  if (filter === 'active') return rows.filter(s => s.active !== false); // unknown may be active
  if (filter === 'running') return rows.filter(s => s.running === true);
  if (filter === 'stopped') return rows.filter(s => s.state === 'stopped' && s.active === false);
  return rows;
}
export function parseListArgs(command, args) {
  if (!['list', 'ls', 'ps'].includes(command)) throw new Error('Not a list command.');
  let json = command === 'list', all = command !== 'ps', jsonSeen = false, allSeen = false;
  for (const flag of args) {
    if (flag === '--json' && !jsonSeen) {json = true; jsonSeen = true;}
    else if (command === 'ps' && ['-a', '--all'].includes(flag) && !allSeen) {all = true; allSeen = true;}
    else throw new Error('Usage: mac-sandbox ls [--json] | ps [-a|--all] [--json] | list [--json]');
  }
  return {json, filter: all ? 'all' : 'active'};
}
const cell = value => String(value ?? '—').replace(/[\x00-\x1f\x7f]/g, ' ');
export function formatSandboxTable(rows, {allRows = rows, activeVMs = null, maxRunning = 2, inventoryError = null} = {}) {
  const data = rows.map(s => [cell(s.name), cell(s.state).toUpperCase(), s.active === null ? '?' : s.active ? 'yes' : 'no',
    s.canExec ? 'yes' : 'no', cell(s.cpu), s.memoryGiB === undefined ? '—' : cell(s.memoryGiB) + ' GB', s.diskGiB === undefined ? '—' : cell(s.diskGiB) + ' GB']);
  const header = ['NAME', 'STATE', 'ACTIVE', 'EXEC', 'CPU', 'MEMORY', 'DISK'];
  const widths = header.map((h, i) => Math.max(h.length, ...data.map(row => row[i].length)));
  const line = row => row.map((value, i) => value.padEnd(widths[i])).join('  ').trimEnd();
  const counts = stateCounts(allRows);
  const lines = [line(header), ...data.map(line)];
  if (!data.length) lines.push('No matching sandboxes.');
  lines.push('', `${counts.running} running, ${counts.stopped} stopped, ${counts.transitioning} transitioning, ${counts.unknown} unknown. Host slots: ${activeVMs ?? '?'}/${maxRunning} active.`);
  if (inventoryError) lines.push('WARNING: host state could not be verified. No start/stop state has been assumed.');
  else if (counts.unknown) lines.push('Unknown VMs remain visible in ps because they may still be active.');
  if (rows.some(s => s.active === true && !s.canExec)) lines.push('EXEC=no: starting or setup incomplete; wait for provisioning before running commands.');
  return lines.join('\n');
}
