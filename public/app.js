'use strict';
const $ = id => document.getElementById(id);
let state = null;
let online = false;
let csrf = '';
let deletionName = '';
let rowSignature = '';
let requestPending = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function showError(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function busy(name) { return state?.jobs?.some(job => job.name === name && ['queued', 'running'].includes(job.status)); }
function makeButton(text, handler, disabled, className) {
  const node = element('button', text, className);
  node.type = 'button'; node.disabled = disabled; node.addEventListener('click', handler); return node;
}
async function mutate(path, body) {
  if (!online || requestPending) return false;
  requestPending = true; showError();
  try {
    const response = await fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrf}, body: JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Action failed. Refresh and try again.');
    await refresh(); return true;
  } catch (error) { showError(error.message); return false; }
  finally { requestPending = false; }
}
function action(name, selected) { return mutate('/api/sandboxes/' + encodeURIComponent(name) + '/actions', {action: selected}); }
function renderRows() {
  const sandboxes = state?.sandboxes || [];
  const signature = JSON.stringify([online, sandboxes, (state?.jobs || []).filter(j => ['queued', 'running'].includes(j.status))]);
  if (signature === rowSignature) return;
  rowSignature = signature;
  const expanded = new Set([...document.querySelectorAll('[data-details][open]')].map(n => n.dataset.details));
  const root = $('sandboxes'); root.replaceChildren(); root.setAttribute('aria-busy', 'false');
  if (!sandboxes.length) {
    const empty = element('div', undefined, 'empty');
    empty.append(element('strong', state?.policy?.templateReady ? 'No sandboxes' : 'Template not ready'));
    empty.append(element('span', state?.policy?.templateReady ? 'Create a sandbox from your clean macOS template.' : 'Creation is unavailable until the macOS template is verified.'));
    root.append(empty); return;
  }
  for (const sandbox of sandboxes) {
    const name = sandbox.name;
    const status = sandbox.status || sandbox.state || 'unknown';
    const running = status.toLowerCase() === 'running';
    const locked = !online || busy(name);
    const article = element('article', undefined, 'sandbox');
    const row = element('div', undefined, 'row');
    row.append(element('span', name, 'name'));
    row.append(element('span', busy(name) ? 'Action pending' : status[0].toUpperCase() + status.slice(1), 'state' + (status === 'failed' ? ' failed' : '')));
    row.append(element('span', `${sandbox.cpu || 8} cores · ${sandbox.memoryGiB || 14} GB · ${sandbox.diskGiB || 150} GB disk`, 'spec'));
    const buttons = element('div', undefined, 'actions');
    const normalAction = makeButton(running ? 'Stop' : 'Start', () => action(name, running ? 'stop' : 'start'), locked || sandbox.starting || sandbox.securityReady === false || !['running', 'stopped'].includes(status.toLowerCase()));
    if (sandbox.starting || sandbox.securityReady === false) normalAction.title = 'Provisioning is incomplete. Inspect recent activity; force kill can settle an interrupted boot.';
    buttons.append(normalAction);
    row.append(buttons); article.append(row);
    const details = element('details', undefined, 'advanced'); details.dataset.details = name; details.open = expanded.has(name);
    details.append(element('summary', 'Connection and actions'));
    const extra = element('div');
    const copy = (label, text) => makeButton(label, async () => {
      try { await navigator.clipboard.writeText(text); showError(); }
      catch { showError('Clipboard access was blocked. Copy the command shown here.'); }
    }, locked || !running || sandbox.securityReady === false);
    const terminal = `mac-sandbox exec ${name} -- sw_vers`;
    extra.append(copy('Copy terminal command', terminal));
    extra.append(element('code', terminal));
    if (state?.policy?.desktopEnabled && sandbox.desktopPort) {
      const url = `vnc://${state.publicHost || location.hostname}:${sandbox.desktopPort}`;
      extra.append(copy('Copy desktop URL', url));
      extra.append(element('code', url));
    }
    if (running || sandbox.starting) extra.append(makeButton('Force kill', () => action(name, 'kill'), locked));
    extra.append(makeButton('Delete sandbox', () => { deletionName = name; $('delete-warning').textContent = `Delete ${name} and all of its files. This cannot be undone.`; $('confirmation').value = ''; $('confirmation').placeholder = name; $('delete-dialog').showModal(); }, locked || running, 'destructive'));
    details.append(extra); article.append(details); root.append(article);
  }
}
function render() {
  const sandboxes = state?.sandboxes || [];
  const running = sandboxes.filter(s => (s.status || s.state || '').toLowerCase() === 'running');
  const totalRunning = state?.inventory?.activeCount ?? running.length;
  $('running').textContent = `${totalRunning} / ${state?.policy?.maxRunning || 2}`;
  $('memory').textContent = `${running.reduce((sum, s) => sum + (s.memoryGiB || 14), 0)} / ${state?.host?.memoryGiB ?? '?' } GB`;
  const available = state?.host?.diskAvailableGiB ?? state?.host?.diskGiB ?? state?.host?.freeDiskGiB;
  $('storage').textContent = typeof available === 'number' ? `${Math.floor(available)} GB` : 'Not verified';
  $('host').textContent = `${state?.host?.cpuTotal ?? '?' } cores · ${state?.host?.memoryGiB ?? '?' } GB RAM`;
  $('create').disabled = !online || !state?.policy?.templateReady || totalRunning >= (state?.policy?.maxRunning || 2);
  $('create').title = !state?.policy?.templateReady ? 'The clean template is not ready.' : totalRunning >= 2 ? 'Stop a sandbox to free a running slot.' : '';
  $('isolation').hidden = state?.policy?.networkIsolationVerified === true;
  $('template-state').hidden = state?.policy?.templateReady === true;
  $('slot-note').hidden = !(online && state?.policy?.templateReady && totalRunning >= (state?.policy?.maxRunning || 2));
  $('connection').textContent = online ? 'Connected' : 'Could not verify';
  $('connection-dot').classList.toggle('connected', online);
  renderRows();
  const jobs = state?.jobs || [];
  $('job-count').textContent = jobs.length ? String(jobs.length) : '';
  $('jobs').replaceChildren();
  for (const job of jobs.slice(0, 12)) {
    const li = element('li');
    li.append(element('span', `${job.action || job.type || 'Action'} ${job.name || ''}`));
    li.append(element('span', job.status + (job.error ? ` — ${job.error}` : '')));
    $('jobs').append(li);
  }
  if (!jobs.length) $('jobs').append(element('li', 'No actions recorded.'));
}
async function refresh() {
  try {
    const response = await fetch('/api/state', {cache: 'no-store'});
    if (!response.ok) throw new Error('Unavailable');
    const next = await response.json(); csrf = next.csrfToken;
    if (next.inventory?.error) {
      state = state ? {...next, host: state.host, sandboxes: state.sandboxes} : next;
      online = false; showError('Could not verify host state. Check the service and refresh.');
    } else {
      state = next; online = true;
      $('verified').textContent = 'Verified ' + new Date(next.inventory?.updatedAt || Date.now()).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
    }
    render();
  } catch {
    online = false;
    if (state) render();
    else { $('connection').textContent = 'Could not connect'; $('sandboxes').setAttribute('aria-busy', 'false'); $('sandboxes').replaceChildren(element('p', 'Could not reach the control plane. Check the SSH tunnel, then refresh.', 'empty')); }
  }
}
$('create').addEventListener('click', () => { $('name').value = ''; $('create-dialog').showModal(); });
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
$('create-form').addEventListener('submit', async event => {
  event.preventDefault(); const name = $('name').value.trim();
  if (await mutate('/api/sandboxes', {name})) $('create-dialog').close();
});
$('delete-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('confirmation').value !== deletionName) { $('confirmation').setCustomValidity('Enter the exact sandbox name.'); $('confirmation').reportValidity(); return; }
  if (await mutate('/api/sandboxes/' + encodeURIComponent(deletionName) + '/actions', {action: 'delete', confirmation: deletionName})) $('delete-dialog').close();
});
$('confirmation').addEventListener('input', () => $('confirmation').setCustomValidity(''));
async function loop() { await refresh(); setTimeout(loop, 4000); }
loop();
