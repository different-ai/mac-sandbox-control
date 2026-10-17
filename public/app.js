'use strict';
const $ = id => document.getElementById(id);
let state = null, online = false, csrf = '', deletionName = '', rowSignature = '', requestPending = false, openMenu = '', toastTimer;

const PENDING = {create: 'Creating…', start: 'Starting…', stop: 'Stopping…', kill: 'Force stopping…', delete: 'Deleting…'};
const DONE = {create: 'Created', start: 'Started', stop: 'Stopped', kill: 'Force stopped', delete: 'Deleted'};
const svg = path => `<svg aria-hidden="true" viewBox="0 0 24 24">${path}</svg>`;
const ICONS = {
  play: svg('<path d="M7 5v14l11-7z"/>'), stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  screen: svg('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(label, handler, {disabled = false, className = '', icon = '', title = ''} = {}) {
  const node = element('button', undefined, className);
  node.type = 'button'; node.disabled = disabled; if (title) node.title = title;
  if (icon) node.insertAdjacentHTML('afterbegin', ICONS[icon]); // static, trusted markup only
  if (label) node.append(document.createTextNode(label));
  node.addEventListener('click', handler); return node;
}
function showError(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function toast(message) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200);
}
async function copy(text, done) {
  // Synchronous fallback first: it keeps the click gesture and works over plain HTTP.
  if (legacyCopy(text)) return toast(done);
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch { showError(`Clipboard access was blocked. Copy manually: ${text}`); }
}
const pendingJob = name => state?.jobs?.find(job => job.name === name && ['queued', 'running'].includes(job.status));
const maxRunning = () => state?.policy?.maxRunning || 2;
const activeCount = () => state?.inventory?.activeCount ?? (state?.sandboxes || []).filter(s => s.status === 'running').length;
const loopback = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);

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
const action = (name, selected) => mutate('/api/sandboxes/' + encodeURIComponent(name) + '/actions', {action: selected});

// One plain-language status per row; never claim "ready" from process state alone.
function describe(sandbox) {
  const job = pendingJob(sandbox.name);
  const status = String(sandbox.status || 'unknown').toLowerCase();
  if (job) return {label: PENDING[job.action] || 'Working…', tone: 'busy', running: false};
  if (sandbox.starting) return {label: 'Starting…', tone: 'busy', running: false};
  if (sandbox.securityReady === false) return {label: 'Setup incomplete · check recent activity', tone: 'bad', running: false};
  if (status === 'running') {
    const desk = sandbox.desktopState;
    const extra = desk && desk.ready === false && state?.policy?.desktopEnabled !== false && desk.reason !== 'disabled' ? ' · desktop unavailable' : '';
    return {label: 'Running' + extra, tone: 'ok', running: true};
  }
  if (status === 'stopped') return {label: 'Stopped · files kept', tone: 'idle', running: false};
  if (status === 'crashed') return {label: 'Stopped unexpectedly', tone: 'bad', running: false, crashed: true};
  return {label: 'Can’t verify state', tone: 'bad', running: false, unknown: true};
}

// Fetched only on click, copied to the clipboard, never rendered or kept in page state.
async function fetchDesktopLogin(name) {
  const response = await fetch('/api/sandboxes/' + encodeURIComponent(name) + '/desktop-password',
    {method: 'POST', cache: 'no-store', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrf}, body: '{}'});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Couldn’t get the desktop password.');
  return result;
}
// The async Clipboard API exists only in secure contexts (HTTPS/localhost). On a plain-HTTP
// tailnet address fall back to execCommand('copy'), which needs a live user gesture.
function legacyCopy(text) {
  const area = document.createElement('textarea');
  area.value = text; area.setAttribute('readonly', ''); area.className = 'offscreen';
  document.body.append(area); area.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch {}
  area.remove(); window.getSelection()?.removeAllRanges();
  return copied;
}
async function copyDesktopPassword(name) {
  showError();
  const login = fetchDesktopLogin(name);
  if (window.isSecureContext && window.ClipboardItem && navigator.clipboard?.write) {
    try {
      // A promise-backed ClipboardItem keeps the click's activation (required by Safari).
      const blob = login.then(r => new Blob([r.password], {type: 'text/plain'}));
      await navigator.clipboard.write([new ClipboardItem({'text/plain': blob})]);
      return {login: await login, copied: true};
    } catch {}
  }
  let result;
  try { result = await login; } catch (failure) { showError(failure.message); return null; }
  return {login: result, copied: legacyCopy(result.password)};
}
let desktopTarget = '';
function showDesktopDialog(name, password, target) {
  desktopTarget = target || '';
  $('desktop-name').textContent = name;
  $('desktop-password').value = password;
  $('desktop-open').hidden = !desktopTarget;
  $('desktop-dialog').showModal();
  $('desktop-password').select();
}
async function openDesktop(name, url) {
  const outcome = await copyDesktopPassword(name);
  if (!outcome) return;
  const target = url || desktopFor({desktopState: {ready: true, port: outcome.login.port}});
  if (outcome.copied && target) { location.href = target; toast('Password copied — paste it with ⌘V when Screen Sharing asks'); }
  else if (outcome.copied) toast('Desktop password copied');
  else showDesktopDialog(name, outcome.login.password, target);
}

function desktopFor(sandbox) {
  const port = sandbox.desktopState?.ready ? (sandbox.desktopState.port || sandbox.desktopPort) : null;
  if (!port) return null;
  const host = !loopback(location.hostname) ? location.hostname : state?.publicHost;
  return host ? `vnc://${host}:${port}` : null;
}

function renderRow(sandbox) {
  const name = sandbox.name, info = describe(sandbox);
  const locked = !online || Boolean(pendingJob(name)) || requestPending;
  const row = element('article', undefined, 'row');
  row.append(element('span', undefined, 'dot ' + info.tone));
  const text = element('div');
  text.append(element('div', name, 'title'));
  text.append(element('div', `${info.label} · ${sandbox.cpu || 8} cores · ${sandbox.memoryGiB || 14} GB`, 'meta' + (info.tone === 'bad' ? ' bad' : '')));
  row.append(text);

  const actions = element('div', undefined, 'actions');
  const url = info.running ? desktopFor(sandbox) : null;
  if (info.running && url) {
    actions.append(button('Open desktop', () => openDesktop(name, url), {icon: 'screen', disabled: locked,
      title: 'Copies the desktop password, then opens Screen Sharing'}));
  }
  if (info.running) {
    actions.append(button('Stop', () => action(name, 'stop'), {icon: 'stop', disabled: locked}));
  } else if (!info.unknown) {
    const full = activeCount() >= maxRunning();
    actions.append(button('Start', () => action(name, 'start'), {icon: 'play',
      disabled: locked || full || sandbox.starting || sandbox.securityReady === false || !['stopped', 'crashed'].includes(String(sandbox.status)),
      title: full ? 'Both slots are in use. Stop another sandbox first.' : ''}));
  }

  const wrap = element('div', undefined, 'menu-wrap');
  const toggle = button('', event => { event.stopPropagation(); openMenu = openMenu === name ? '' : name; rowSignature = ''; renderRows(); }, {className: 'ghost', icon: 'more'});
  toggle.setAttribute('aria-label', `More actions for ${name}`);
  toggle.setAttribute('aria-haspopup', 'menu'); toggle.setAttribute('aria-expanded', String(openMenu === name));
  wrap.append(toggle);
  if (openMenu === name) {
    const menu = element('div', undefined, 'menu'); menu.setAttribute('role', 'menu');
    const item = (label, handler, opts = {}) => { const b = button(label, () => { openMenu = ''; rowSignature = ''; handler(); renderRows(); }, opts); b.setAttribute('role', 'menuitem'); menu.append(b); };
    item('Copy terminal command', () => copy(`mac-sandbox exec ${name} -- sw_vers`, 'Terminal command copied'));
    if (url) {
      item('Copy desktop password', async () => {
        const outcome = await copyDesktopPassword(name);
        if (outcome?.copied) toast('Desktop password copied');
        else if (outcome) showDesktopDialog(name, outcome.login.password, '');
      });
      item('Copy desktop address', () => copy(url, 'Desktop address copied'));
    }
    menu.append(element('hr'));
    if (info.running || sandbox.starting || info.crashed) item('Force stop', () => action(name, 'kill'), {disabled: locked, className: 'danger'});
    item('Delete…', () => {
      deletionName = name; $('delete-name').textContent = name;
      $('delete-warning').textContent = `This permanently removes ${name}, its disk and its saved credentials.`;
      $('confirmation').value = ''; $('confirmation').placeholder = name; $('delete-dialog').showModal();
    }, {disabled: locked || info.running || sandbox.starting, className: 'danger', title: info.running ? 'Stop the sandbox before deleting it.' : ''});
    wrap.append(menu);
  }
  actions.append(wrap); row.append(actions);
  return row;
}

function renderRows() {
  const sandboxes = state?.sandboxes || [];
  const signature = JSON.stringify([online, openMenu, requestPending, sandboxes, (state?.jobs || []).filter(j => ['queued', 'running'].includes(j.status)), activeCount()]);
  if (signature === rowSignature) return;
  rowSignature = signature;
  const root = $('sandboxes'); root.replaceChildren(); root.setAttribute('aria-busy', 'false');
  if (!sandboxes.length) {
    const empty = element('div', undefined, 'empty');
    const ready = state?.policy?.templateReady;
    empty.append(element('strong', ready ? 'No sandboxes yet' : 'Starter image not ready'));
    empty.append(element('p', ready ? 'Create one to get a fresh macOS workspace.' : 'An operator needs to verify the macOS starter image first.'));
    if (ready) empty.append(button('New sandbox', openCreate, {className: 'primary', disabled: !online}));
    root.append(empty); return;
  }
  for (const sandbox of sandboxes) root.append(renderRow(sandbox));
}

function render() {
  const used = activeCount(), max = maxRunning();
  [...$('slots').children].forEach((slot, i) => slot.classList.toggle('on', i < used));
  $('running').textContent = online ? `${used} of ${max} running` : 'State not verified';
  const disk = state?.host?.diskAvailableGiB ?? state?.host?.diskGiB;
  $('capacity-detail').textContent = !online ? '' : used >= max ? '· Stop one to start another'
    : typeof disk === 'number' ? `· ${Math.floor(disk)} GB free` : '';
  const templateReady = state?.policy?.templateReady === true;
  $('create').disabled = !online || !templateReady || used >= max;
  $('create').title = !templateReady ? 'The starter image is not ready.' : used >= max ? 'Both slots are in use. Stop a sandbox first.' : '';
  $('connection').textContent = online ? 'Live' : 'Can’t reach host';
  $('connection-dot').className = 'dot ' + (online ? 'ok' : 'bad');
  $('isolation').hidden = state?.policy?.networkIsolationVerified === true;
  renderRows();
  const jobs = state?.jobs || [];
  $('jobs').replaceChildren();
  for (const job of jobs.slice(0, 10)) {
    const li = element('li');
    const verb = job.status === 'succeeded' ? DONE[job.action] : job.status === 'failed' ? `Couldn’t ${job.action}` : PENDING[job.action];
    li.append(element('span', `${verb || job.action} ${job.name || ''}`, job.status === 'failed' ? 'failed' : ''));
    const when = job.finishedAt || job.createdAt;
    li.append(element('span', job.error ? job.error : when ? new Date(when).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}) : ''));
    $('jobs').append(li);
  }
  if (!jobs.length) $('jobs').append(element('li', 'Nothing yet.'));
}

async function refresh() {
  try {
    const response = await fetch('/api/state', {cache: 'no-store'});
    if (!response.ok) throw new Error('Unavailable');
    const next = await response.json(); csrf = next.csrfToken;
    if (next.inventory?.error) {
      state = state ? {...next, host: state.host, sandboxes: state.sandboxes} : next;
      online = false; showError('Couldn’t verify the host’s VM state. Nothing has been assumed stopped.');
    } else {
      state = next; online = true;
      if ($('error').textContent.startsWith('Couldn’t verify')) showError();
      $('verified').textContent = 'Updated ' + new Date(next.inventory?.updatedAt || Date.now()).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit', second: '2-digit'});
    }
    render();
  } catch {
    online = false;
    if (state) render();
    else {
      $('connection').textContent = 'Can’t reach host'; $('connection-dot').className = 'dot bad';
      $('running').textContent = 'State not verified';
      $('sandboxes').setAttribute('aria-busy', 'false');
      const empty = element('div', undefined, 'empty');
      empty.append(element('strong', 'Can’t reach the sandbox host'), element('p', 'Check your Tailscale or SSH connection. This page retries automatically.'));
      $('sandboxes').replaceChildren(empty);
    }
  }
}

function openCreate() { $('name').value = ''; $('create-dialog').showModal(); }
$('create').addEventListener('click', openCreate);
for (const node of document.querySelectorAll('[data-close]')) node.addEventListener('click', () => $(node.dataset.close).close());
document.addEventListener('click', event => { if (openMenu && !event.target.closest('.menu-wrap')) { openMenu = ''; rowSignature = ''; renderRows(); } });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && openMenu) { openMenu = ''; rowSignature = ''; renderRows(); } });
$('create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = 'space-' + $('name').value.trim();
  if (await mutate('/api/sandboxes', {name})) { $('create-dialog').close(); toast(`Creating ${name}…`); }
});
$('delete-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('confirmation').value !== deletionName) { $('confirmation').setCustomValidity('Enter the exact sandbox name.'); $('confirmation').reportValidity(); return; }
  if (await mutate('/api/sandboxes/' + encodeURIComponent(deletionName) + '/actions', {action: 'delete', confirmation: deletionName})) { $('delete-dialog').close(); toast(`Deleting ${deletionName}…`); }
});
$('confirmation').addEventListener('input', () => $('confirmation').setCustomValidity(''));
// Dialog buttons run in a fresh click, so execCommand('copy') works even over plain HTTP.
$('desktop-copy').addEventListener('click', () => {
  if (legacyCopy($('desktop-password').value)) toast('Desktop password copied');
  else { $('desktop-password').select(); toast('Press ⌘C to copy the selected password'); }
});
$('desktop-form').addEventListener('submit', event => {
  event.preventDefault();
  const copied = legacyCopy($('desktop-password').value);
  $('desktop-dialog').close();
  if (desktopTarget) location.href = desktopTarget;
  toast(copied ? 'Password copied — paste it with ⌘V when Screen Sharing asks' : 'Paste the password when Screen Sharing asks');
});
// Never leave the credential in the DOM after the dialog closes.
$('desktop-dialog').addEventListener('close', () => { $('desktop-password').value = ''; desktopTarget = ''; });
async function loop() { await refresh(); setTimeout(loop, 3000); }
loop();
