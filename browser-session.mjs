#!/usr/bin/env node
// Independent CDP implementation. No profile files, passwords, or Keychain access.
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
export const MAX_BYTES = 8 * 1024 * 1024;
export class SessionError extends Error { constructor() { super('Browser session operation failed. Check consent, origin scope, browser readiness, and snapshot validity.'); } }
const fail = () => { throw new SessionError(); };
export function normalizeOrigins(values) {
  if (!Array.isArray(values) || !values.length || values.length > 16) fail();
  const origins = values.map(value => {
    if (typeof value !== 'string') fail();
    let u; try { u = new URL(value); } catch { fail(); }
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash || ![u.origin, u.origin + '/'].includes(value)) fail();
    return u.origin;
  });
  if (new Set(origins).size !== origins.length) fail();
  return origins.sort();
}
const bounded = value => { if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) fail(); return value; };
function cookieParam(cookie, origins, now, capturing = false) {
  if (!cookie || typeof cookie !== 'object') fail();
  const allowed = capturing ? ['name','value','domain','path','expires','size','httpOnly','secure','session','sameSite','priority','sameParty','sourceScheme','sourcePort'] : ['name','value','url','path','expires','httpOnly','secure','sameSite','priority'];
  // Unknown cookie attributes (including partition keys/opaque partitions) must not be silently lost.
  if (Object.keys(cookie).some(key => !allowed.includes(key))) fail();
  let origin;
  if (capturing) {
    if (typeof cookie.domain !== 'string' || cookie.domain.startsWith('.')) fail();
    origin = origins.find(o => new URL(o).hostname === cookie.domain);
  } else {
    if (typeof cookie.url !== 'string' || !origins.includes(cookie.url)) fail();
    origin = cookie.url;
  }
  if (!origin || typeof cookie.name !== 'string' || !cookie.name || typeof cookie.value !== 'string' || typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || /[\r\n\0]/.test(cookie.path) || typeof cookie.secure !== 'boolean' || typeof cookie.httpOnly !== 'boolean') fail();
  if (cookie.sameSite !== undefined && !['Strict','Lax','None'].includes(cookie.sameSite)) fail();
  if (cookie.priority !== undefined && !['Low','Medium','High'].includes(cookie.priority)) fail();
  const result = {name: cookie.name, value: cookie.value, url: origin, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly};
  for (const key of ['sameSite','priority']) if (cookie[key] !== undefined) result[key] = cookie[key];
  if (capturing && typeof cookie.session !== 'boolean') fail();
  if (!(capturing && cookie.session) && cookie.expires !== undefined) {
    if (!Number.isFinite(cookie.expires) || cookie.expires <= now / 1000) fail();
    result.expires = cookie.expires;
  } else if (!capturing && cookie.expires === undefined) { /* Session cookie: omit expires. */ }
  if (capturing && !cookie.session && result.expires === undefined) fail();
  if (cookie.sameParty === true || (cookie.sourceScheme !== undefined && !['Secure','NonSecure','Unset'].includes(cookie.sourceScheme))) fail();
  return result;
}
export function validateSession(data, expectedOrigins, now = Date.now()) {
  const origins = normalizeOrigins(expectedOrigins);
  if (!data || data.schema !== 1 || JSON.stringify(normalizeOrigins(data.origins)) !== JSON.stringify(origins) || !Array.isArray(data.cookies) || !Array.isArray(data.localStorage) || data.localStorage.length !== origins.length) fail();
  bounded(data);
  const cookies = data.cookies.map(c => cookieParam(c, origins, now));
  const seen = new Set();
  for (const storage of data.localStorage) {
    if (!storage || !origins.includes(storage.origin) || seen.has(storage.origin) || !Array.isArray(storage.items)) fail();
    seen.add(storage.origin);
    const keys = new Set();
    for (const item of storage.items) {
      if (!Array.isArray(item) || item.length !== 2 || item.some(v => typeof v !== 'string') || keys.has(item[0])) fail();
      keys.add(item[0]);
    }
  }
  return {...data, origins, cookies};
}
async function withOrigin(client, origin, action) {
  let targetId;
  try {
    ({targetId} = await client.send('Target.createTarget', {url: origin + '/'}));
    const {sessionId} = await client.send('Target.attachToTarget', {targetId, flatten: true});
    await client.send('Runtime.enable', {}, sessionId);
    let ready = false;
    const deadline = Date.now() + 15000;
    // Target creation can return before its first navigation commits. Retry only this read,
    // never a mutation; navigation may replace the execution context in the meantime.
    while (Date.now() < deadline) {
      try {
        const result = await client.send('Runtime.evaluate', {expression: `location.origin===${JSON.stringify(origin)} && document.readyState!=='loading' && typeof localStorage.length==='number'`, returnByValue: true}, sessionId);
        if (!result.exceptionDetails && result.result?.value === true) {ready = true; break;}
      } catch { /* A navigation may destroy the initial execution context. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) fail();
    await client.send('DOMStorage.enable', {}, sessionId);
    return await action(sessionId, {securityOrigin: origin, isLocalStorage: true});
  } finally { if (targetId) await client.send('Target.closeTarget', {targetId}).catch(() => {}); }
}
export async function captureSession(client, inputOrigins, {now = Date.now()} = {}) {
  const origins = normalizeOrigins(inputOrigins);
  const version = await client.send('Browser.getVersion');
  if (typeof version.product !== 'string' || typeof version.protocolVersion !== 'string' || !/^[A-Za-z0-9 ._/-]{1,120}$/.test(version.product) || !/^[0-9.]{1,24}$/.test(version.protocolVersion)) fail();
  const {cookies: all} = await client.send('Storage.getCookies');
  if (!Array.isArray(all)) fail();
  const hosts = origins.map(o => new URL(o).hostname);
  const relevant = all.filter(c => typeof c.domain === 'string' && hosts.some(h => h === c.domain.replace(/^\./, '') || h.endsWith('.' + c.domain.replace(/^\./, ''))));
  const cookies = relevant.map(c => cookieParam(c, origins, now, true));
  const localStorage = [];
  for (const origin of origins) localStorage.push(await withOrigin(client, origin, async (sid, storageId) => ({origin, items: (await client.send('DOMStorage.getDOMStorageItems', {storageId}, sid)).entries})));
  return validateSession({schema: 1, origins, browser: {product: version.product, protocol: version.protocolVersion}, cookies, localStorage}, origins, now);
}
export async function restoreSession(client, data, origins, {now = Date.now()} = {}) {
  const checked = validateSession(data, origins, now);
  await client.send('Storage.setCookies', {cookies: checked.cookies});
  for (const storage of checked.localStorage) await withOrigin(client, storage.origin, async (sid, storageId) => {
    for (const [key, value] of storage.items) await client.send('DOMStorage.setDOMStorageItem', {storageId, key, value}, sid);
  });
  return {origins: checked.origins, cookieCount: checked.cookies.length, localStorageCount: checked.localStorage.reduce((n, s) => n + s.items.length, 0)};
}
export async function connectCDP(port = 9222, {fetchImpl = fetch, WebSocketImpl = WebSocket} = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail();
  let ws;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {redirect: 'error', signal: AbortSignal.timeout(15000)});
    if (!response.ok) fail();
    const text = await response.text(); if (text.length > 65536) fail();
    const u = new URL(JSON.parse(text).webSocketDebuggerUrl);
    if (u.protocol !== 'ws:' || u.hostname !== '127.0.0.1' || u.port !== String(port) || u.username || u.password || u.search || u.hash || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(u.pathname)) fail();
    ws = new WebSocketImpl(u.href);
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new SessionError()), 15000); ws.addEventListener('open', () => {clearTimeout(timer); resolve();}, {once: true}); ws.addEventListener('error', () => {clearTimeout(timer); reject(new SessionError());}, {once: true}); });
  } catch { ws?.close(); fail(); }
  let id = 0;
  const pending = new Map();
  const rejectAll = () => { for (const p of pending.values()) {clearTimeout(p.timer); p.reject(new SessionError());} pending.clear(); };
  ws.addEventListener('close', rejectAll); ws.addEventListener('error', rejectAll);
  ws.addEventListener('message', event => {
    try {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_BYTES) { rejectAll(); ws.close(); return; }
      const message = JSON.parse(event.data), p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) p.reject(new SessionError()); else p.resolve(message.result);
    } catch { rejectAll(); ws.close(); }
  });
  return {send(method, params = {}, sessionId) { return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {pending.delete(requestId); reject(new SessionError());}, 15000);
    pending.set(requestId, {resolve, reject, timer});
    try { ws.send(JSON.stringify({id: requestId, method, params, ...(sessionId ? {sessionId} : {})})); } catch {rejectAll();}
  }); }, close() {rejectAll(); ws.close();}};
}
export async function handleBrowserSession(request, options = {}) {
  let client;
  try {
    bounded(request);
    if (!request || !['capture','restore','inspect'].includes(request.operation) || Object.keys(request).some(k => !['operation','origins','port','session'].includes(k))) fail();
    const origins = normalizeOrigins(request.origins);
    if (request.operation === 'restore') validateSession(request.session, origins);
    client = options.client ?? await connectCDP(request.port ?? 9222, options);
    if (request.operation === 'restore') return await restoreSession(client, request.session, origins);
    const data = await captureSession(client, origins);
    if (request.operation === 'capture') return data;
    return {origins, browser: data.browser, cookieCount: data.cookies.length, localStorageCount: data.localStorage.reduce((n, s) => n + s.items.length, 0)};
  } catch { fail(); } finally {client?.close?.();}
}
// Also runs when the host transports this source with node --input-type=module -e.
if (!process.argv[1] || import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let size = 0; const chunks = [];
    for await (const chunk of process.stdin) {size += chunk.length; if (size > MAX_BYTES) fail(); chunks.push(chunk);}
    const result = await handleBrowserSession(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {process.stderr.write('Browser session operation failed.\n'); process.exitCode = 1;}
}
