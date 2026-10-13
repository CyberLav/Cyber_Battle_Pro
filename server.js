#!/usr/bin/env node
'use strict';
/*
 * Cyber Battle Pro, Field HQ server v1.1
 * Runs on the Incident Commander's laptop. Serves the app to the section over the local network
 * and relays the shared session log over WebSocket. Everything is held in memory: when the HQ stops,
 * the session is gone. Any client can reseed a new HQ from its own copy.
 */
const https = require('https');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const VERSION = '1.8.0';
const args = parseArgs(process.argv.slice(2));
if (args.help) { printHelp(); process.exit(0); }

/* Where we can write: next to the .exe when packaged, else next to this file */
const APP_DIR = __dirname;
const DATA_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const CERT_DIR = path.join(DATA_DIR, 'certs');
const PUBLIC = path.join(APP_DIR, 'public');
const PPTX_BUNDLE = path.join(APP_DIR, 'node_modules', 'pptxgenjs', 'dist', 'pptxgen.bundle.js');
const PDFLIB_BUNDLE = path.join(APP_DIR, 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.min.js');

const USE_HTTP = !!args.http;
const PORT = Number(args.port) || (USE_HTTP ? 8080 : 8443);
const HOST = args.host && args.host !== true ? args.host : '0.0.0.0';
const MAX_CLIENTS = Number(args['max-clients']) || 25;
const MAX_STORE_BYTES = 512 * 1024 * 1024;
const KINDS = new Set(['log', 'finding', 'rfi', 'rfc', 'sitrep', 'frago', 'backbrief', 'doc', 'blob', 'state', 'aar', 'wcmsg', 'hoststat']);
const SERVER_ID = crypto.randomBytes(6).toString('hex');
const slug = v => String(v || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
const str = v => (v && v !== true ? String(v) : '');

let TEAM = '', HQ_NAME = 'cbp-hq', MDNS_HOST = '', INCIDENT = '', CODE = '', FINGERPRINT = '';
let ICINFO = null;           // QR codes and addresses for the IC panel
let ending = null;
let WC_CODE = '';
const wcClients = new Set();
let TWO_IC = '';             // name|callsign of the member designated 2IC by the IC
const opKey = op => (op.name || '').trim().toLowerCase() + '|' + (op.call || '').trim().toLowerCase();
let INTEL = '';              // name|callsign of the member designated Intel by the IC
const hqRole = ws => { if (ws.meta.local) return 'IC'; const k = opKey(ws.meta.op || {}); return TWO_IC && k === TWO_IC ? '2IC' : INTEL && k === INTEL ? 'Intel' : 'member'; };
const isCommand = ws => ['IC', '2IC'].includes(hqRole(ws));
const COMMAND_DOCS = new Set(['wngo', 'orders', 'frago', 'bb', 'stand']);
const COMMAND_STATE = new Set(['incident', 'roster', 'incid']);           // {at} while the end of session countdown runs

/* ---------------- Session store (memory only) ---------------- */
let SEQ = 0, storeBytes = 0;
const items = [], known = new Map(), clients = new Set(), failures = new Map();

function storeItem(kind, id, data, from) {
  const key = kind + ':' + id;
  const size = Buffer.byteLength(JSON.stringify(data));
  if (kind === 'state') {
    const prev = known.get(key);
    if (prev) { const i = items.indexOf(prev); if (i >= 0) items.splice(i, 1); storeBytes -= prev.size; }
  } else if (known.has(key)) return null;
  if (storeBytes + size > MAX_STORE_BYTES) return 'full';
  const it = { seq: ++SEQ, kind, id, data, from, size };
  items.push(it); known.set(key, it); storeBytes += size;
  return it;
}
const pub = it => ({ seq: it.seq, kind: it.kind, id: it.id, data: it.data, from: it.from });

/* ---------------- Start ---------------- */
async function main() {
  TEAM = str(args.team) || str(args.name) || '';
  if (!TEAM && !args.team && process.stdin.isTTY && !args['no-prompt']) TEAM = await ask('\n  CYBER BATTLE PRO FIELD HQ\n\n  Team for this session (e.g. CPT 1), then press Enter: ');
  TEAM = TEAM.trim().slice(0, 40);
  if (args['white-cell'] || /^(wc|white\s*cell)$/i.test(TEAM)) return require('./wc.js').start({ args, ask, openBrowser, genCode, VERSION });
  WC_CODE = (str(args['wc-code']) || '').toUpperCase().trim();
  if (!WC_CODE && !args['wc-code'] && process.stdin.isTTY && !args['no-prompt']) WC_CODE = (await ask('  White Cell exercise code (press Enter if there is no White Cell): ')).toUpperCase().trim();
  HQ_NAME = slug(args.name) || slug(TEAM) || 'cbp-hq';
  INCIDENT = str(args.incident) || genIncident();
  CODE = (str(args.code) || genCode()).toUpperCase();
  MDNS_HOST = args['no-mdns'] ? '' : await freeMdnsName(HQ_NAME);

  const handler = (req, res) => route(req, res).catch(err => { console.error(err); send(res, 500, 'text/plain', 'Server error'); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  wss.on('connection', onSocket);
  const upgrade = (srv, plainOnly) => srv.on('upgrade', (req, sock, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return sock.destroy();
    if (plainOnly && !USE_HTTP && !isLocal(req)) return sock.destroy(); // section devices must use wss
    wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req));
  });

  // The IC uses http://localhost (a secure context in every browser, so no certificate warning).
  // Section devices use https. Plain http from another device is redirected to https.
  const plain = http.createServer((req, res) => {
    if (USE_HTTP || isLocal(req)) return handler(req, res);
    const host = (req.headers.host || ('localhost:' + PORT)).replace(/[^\w.:\[\]-]/g, '');
    res.writeHead(301, { Location: 'https://' + host + (req.url || '/'), 'Cache-Control': 'no-store' }); res.end();
  });
  upgrade(plain, true);
  let secure = null;
  if (!USE_HTTP) {
    const tls = await loadOrCreateCert();
    FINGERPRINT = tls.fingerprint;
    secure = https.createServer({ key: tls.key, cert: tls.cert }, handler);
    upgrade(secure);
  }
  const front = net.createServer(sock => {
    sock.once('data', buf => {
      sock.pause(); sock.unshift(buf);
      ((secure && buf[0] === 22) ? secure : plain).emit('connection', sock);
      process.nextTick(() => sock.resume());
    });
    sock.on('error', () => {});
  });
  front.on('error', err => {
    if (err.code === 'EADDRINUSE') console.log(`\n  Port ${PORT} is already in use. Is another HQ running on this laptop? Close it or start with --port 9443.\n`);
    else console.log('\n  Could not start: ' + err.message + '\n');
    pauseThenExit(1);
  });
  front.listen(PORT, HOST, async () => {
    startMdns();
    setInterval(() => wss.clients.forEach(ws => {
      if (!ws.meta) return; if (!ws.meta.alive) return ws.terminate();
      ws.meta.alive = false; try { ws.ping(); } catch (e) {}
    }), 25000);
    ICINFO = await buildIcInfo();
    printBanner();
    if (!args['no-browser']) openBrowser(`http://localhost:${PORT}/`);
    // Network check runs in the background; it can take several seconds on Windows
    preflight().then(pf => {
      if (pf.issues.some(i => i.level === 'error')) {
        console.log('  ! Pre-flight found problems that will stop analysts from connecting:');
        pf.issues.forEach(i => console.log('    - ' + i.text));
        console.log('    Use "Fix it" in the Section panel of the app.\n');
      } else if (pf.checked) console.log('  Network check: ready.\n');
    }).catch(() => {});
  });
}

function printBanner() {
  const L = s => console.log('  ' + s);
  console.log('');
  L('CYBER BATTLE PRO  ·  FIELD HQ  v' + VERSION);
  L('─'.repeat(52));
  if (TEAM) L('Team         ' + TEAM);
  L('Incident     ' + INCIDENT);
  L('Access code  ' + CODE);
  L('White Cell   ' + (WC_CODE ? 'exercise code set' : 'none'));
  L('');
  L('Section joins at:');
  if (MDNS_HOST) L('  ' + MDNS_HOST + ':' + PORT);
  shownInterfaces().forEach(i => L('  ' + (i.ip + ':' + PORT).padEnd(22) + i.name));
  if (!shownInterfaces().length) L('  (no Wi-Fi or Ethernet connection found)');
  if (FINGERPRINT) { L(''); L('Certificate  ' + FINGERPRINT.slice(0, 23) + '…'); }
  L('');
  L('IC: the app opens in your browser. If it does not, open  http://localhost:' + PORT);
  L('Keep this window open: closing it ends the session.');
  console.log('');
}

/* ---------------- HTTP routes ---------------- */
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const local = isLocal(req);
  if (req.method === 'POST' && p.startsWith('/hq/')) {
    if (!local || req.headers['x-cbp'] !== '1') return send(res, 403, 'text/plain', 'Forbidden');
    if (p === '/hq/fix') return send(res, 200, 'application/json', JSON.stringify(await fixNetwork()));
    if (p === '/hq/end') { startEnding(Number(url.searchParams.get('s')) || 60); return send(res, 200, 'application/json', '{"ok":true}'); }
    if (p === '/hq/cancel-end') { cancelEnding(); return send(res, 200, 'application/json', '{"ok":true}'); }
    if (p === '/hq/role') {
      const c = [...clients].find(x => x.meta.id === url.searchParams.get('client'));
      if (!c || c.meta.local) return send(res, 400, 'application/json', '{"ok":false}');
      const k = opKey(c.meta.op), want = url.searchParams.get('role');
      if (want === '2IC') { TWO_IC = k; if (INTEL === k) INTEL = ''; }
      else if (want === 'Intel') { INTEL = k; if (TWO_IC === k) TWO_IC = ''; }
      else { if (TWO_IC === k) TWO_IC = ''; if (INTEL === k) INTEL = ''; }
      clients.forEach(x => out(x, { t: 'role', role: hqRole(x) }));
      sendPresence();
      log(`${label(c)} is now ${hqRole(c) === 'member' ? 'a section member' : hqRole(c)}`);
      return send(res, 200, 'application/json', '{"ok":true}');
    }
    return send(res, 404, 'text/plain', 'Not found');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
  if (p === '/' || p === '/index.html') return sendFile(res, path.join(PUBLIC, 'index.html'), 'text/html; charset=utf-8');
  if (p === '/vendor/pptxgen.bundle.js') return sendFile(res, PPTX_BUNDLE, 'text/javascript; charset=utf-8');
  if (p === '/vendor/pdf-lib.min.js') return sendFile(res, PDFLIB_BUNDLE, 'text/javascript; charset=utf-8');
  if (p === '/cbp/info') {
    const info = { app: 'cbp', wc: !!WC_CODE, version: VERSION, incident: INCIDENT, serverId: SERVER_ID, secure: !USE_HTTP, hq: TEAM || HQ_NAME, host: MDNS_HOST, port: PORT };
    if (local) { info.code = CODE; info.ic = ICINFO; }
    return send(res, 200, 'application/json', JSON.stringify(info));
  }
  if (p.startsWith('/hq')) {
    if (!local) return send(res, 403, 'text/plain', 'The IC panel is only available on the HQ laptop.');
    if (p === '/hq/status') return send(res, 200, 'application/json', JSON.stringify(status()));
    if (p === '/hq/preflight') return send(res, 200, 'application/json', JSON.stringify(await preflight()));
    if (p === '/hq') return send(res, 200, 'text/html; charset=utf-8', hqPage());
  }
  if (p === '/favicon.ico') return send(res, 204, 'text/plain', '');
  return send(res, 404, 'text/plain', 'Not found');
}
function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
  res.end(body);
}
function sendFile(res, file, type) { fs.readFile(file, (err, buf) => err ? send(res, 404, 'text/plain', 'Not found') : send(res, 200, type, buf)); }
function isLocal(req) { const a = req.socket.remoteAddress || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }

/* ---------------- WebSocket hub ---------------- */
function onSocket(ws, req) {
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  try { if (new URL(req.headers.origin || '').host !== req.headers.host) return ws.close(4003, 'Bad origin'); } catch (e) { return ws.close(4003, 'Bad origin'); }
  if (blocked(ip)) return deny(ws, 'Too many wrong codes from this device. Wait a few minutes.');
  ws.meta = { ip, authed: false, alive: true, id: crypto.randomBytes(4).toString('hex'), local: isLocal(req) };
  const helloTimer = setTimeout(() => { if (!ws.meta.authed) ws.close(4001, 'No hello'); }, 10000);
  ws.on('pong', () => { ws.meta.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!ws.meta.authed) {
      if (m.t === 'wchello') {
        clearTimeout(helloTimer);
        if (!WC_CODE || !safeEqual(String(m.code || '').toUpperCase().trim(), WC_CODE)) { fail(ip); deny(ws, WC_CODE ? 'Wrong exercise code.' : 'This HQ has no White Cell code.'); log(`White Cell refused from ${ip}`); return; }
        ws.meta.authed = true; ws.meta.wc = true; ws.meta.op = { name: 'White Cell', call: 'WC', role: 'White Cell' }; wcClients.add(ws);
        out(ws, { t: 'wcwelcome', serverId: SERVER_ID, summary: wcSummary() });
        const vis = items.filter(wcVisible).map(pub);
        for (let i = 0; i < vis.length; i += 200) out(ws, { t: 'entries', items: vis.slice(i, i + 200) });
        broadcast({ t: 'presence', members: members(), wc: wcClients.size });
        log(`White Cell connected from ${ip}`);
        return;
      }
      if (m.t !== 'hello') return;
      clearTimeout(helloTimer);
      if (!safeEqual(String(m.code || '').toUpperCase().trim(), CODE)) {
        fail(ip); deny(ws, 'Wrong access code for this HQ.'); log(`Join refused from ${ip}`); return;
      }
      if (clients.size >= MAX_CLIENTS) return deny(ws, 'This HQ is full.');
      ws.meta.authed = true; ws.meta.op = cleanOp(m.op); clients.add(ws);
      const have = m.sid === SERVER_ID ? Number(m.have) || 0 : 0;
      out(ws, { t: 'welcome', serverId: SERVER_ID, incident: INCIDENT, seq: SEQ, members: members(), you: ws.meta.id, role: hqRole(ws) });
      const backlog = items.filter(it => it.seq > have).map(pub);
      for (let i = 0; i < backlog.length; i += 200) out(ws, { t: 'entries', items: backlog.slice(i, i + 200) });
      out(ws, { t: 'synced', seq: SEQ });
      if (ending) out(ws, { t: 'ending', at: ending.at });
      sendPresence();
      log(`${label(ws)} joined (${clients.size} connected)`);
      return;
    }
    if (ws.meta.wc) return onWhiteCell(ws, m);
    if (m.t === 'op') { ws.meta.op = cleanOp(m.op); out(ws, { t: 'role', role: hqRole(ws) }); sendPresence(); return; }
    if (m.t === 'push' && Array.isArray(m.items)) {
      const fresh = [], command = isCommand(ws);
      let refused = 0;
      for (const x of m.items.slice(0, 500)) {
        if (!x || !KINDS.has(x.kind) || typeof x.id !== 'string' || !x.id || x.id.length > 200) continue;
        const restricted = (x.kind === 'doc' && x.data && COMMAND_DOCS.has(x.data.type)) || (x.kind === 'state' && COMMAND_STATE.has(x.id));
        if (restricted && !command) { refused++; continue; }
        if (x.kind === 'wcmsg' && !(x.data && x.data.type === 'ack')) { refused++; continue; }
        const it = storeItem(x.kind, x.id, x.data, { name: ws.meta.op.name, call: ws.meta.op.call, client: ws.meta.id });
        if (it === 'full') { out(ws, { t: 'notice', text: 'HQ memory limit reached: large artifacts were not stored.' }); continue; }
        if (it) fresh.push(pub(it));
        if (it && x.kind === 'state' && x.id === 'incid' && x.data && typeof x.data.value === 'string' && x.data.value.trim()) {
          const v = x.data.value.trim().slice(0, 60);
          if (v !== INCIDENT) { INCIDENT = v; log('Incident ID changed to ' + INCIDENT); }
        }
      }
      if (fresh.length) {
        broadcast({ t: 'entries', items: fresh });
        const vis = fresh.filter(wcVisible); if (vis.length) wcSend({ t: 'entries', items: vis });
        if (fresh.some(f => f.kind === 'state')) wcSummarySoon();
      }
      if (refused) out(ws, { t: 'notice', text: 'Only the IC or 2IC can issue orders or change the incident.' });
    }
  });
  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (wcClients.delete(ws)) { broadcast({ t: 'presence', members: members(), wc: wcClients.size }); log('White Cell disconnected'); return; }
    if (clients.delete(ws)) { sendPresence(); log(`${label(ws)} left (${clients.size} connected)`); }
  });
}
function sendPresence() { broadcast({ t: 'presence', members: members(), wc: wcClients.size }); wcSummarySoon(); }
/* ---------------- White Cell link ---------------- */
// The White Cell (WC) sees a summary and the RFIs and RFCs addressed to WC, and nothing else.
const wcVisible = it => it.kind === 'wcmsg' || ((it.kind === 'rfi' || it.kind === 'rfc') && it.data && /^(WC|1UP)$/i.test(String(it.data.to || '')));
function wcSend(m) { const t = JSON.stringify(m); wcClients.forEach(c => { if (c.readyState === 1) c.send(t); }); }
function wcSummary() {
  const st = (known.get('state:incident') || {}).data, v = st && st.value || {};
  return { team: TEAM || HQ_NAME, incident: INCIDENT, sev: v.sev || '', phase: v.phase || '', hHour: v.hHour || null, endHour: v.endHour || null,
    onNet: clients.size };
}
let wcTimer = null;
function wcSummarySoon() { if (!wcClients.size || wcTimer) return; wcTimer = setTimeout(() => { wcTimer = null; wcSend({ t: 'wcsummary', summary: wcSummary() }); }, 400); }
function onWhiteCell(ws, m) {
  if (m.t !== 'wcpush' || !Array.isArray(m.items)) return;
  const fresh = [];
  for (const x of m.items.slice(0, 100)) {
    if (!x || x.kind !== 'wcmsg' || typeof x.id !== 'string' || !x.data || !['inject', 'answer'].includes(x.data.type)) continue;
    const it = storeItem('wcmsg', x.id, { ...x.data, by: 'White Cell' }, { name: 'White Cell', call: 'WC', client: ws.meta.id });
    if (it && it !== 'full') { fresh.push(pub(it)); log(`White Cell ${x.data.type === 'inject' ? 'inject' : 'answer'} received`); }
  }
  if (fresh.length) { broadcast({ t: 'entries', items: fresh }); wcSend({ t: 'entries', items: fresh }); }
}
function out(ws, m) { if (ws.readyState === 1) ws.send(JSON.stringify(m)); }
function broadcast(m) { const s = JSON.stringify(m); clients.forEach(c => { if (c.readyState === 1) c.send(s); }); }
function deny(ws, reason) { try { ws.send(JSON.stringify({ t: 'denied', reason })); } catch (e) {} setTimeout(() => ws.close(4001, 'Denied'), 50); }
function members() { return [...clients].map(c => ({ ...c.meta.op, client: c.meta.id, ip: c.meta.ip, hq: hqRole(c) })); }
function cleanOp(op) { op = op || {}; const c = v => String(v || '').slice(0, 80); return { name: c(op.name), call: c(op.call), role: c(op.role) }; }
function label(ws) { const o = ws.meta.op || {}; return (o.call ? o.call + ' ' : '') + (o.name || 'Unnamed'); }
function fail(ip) { const now = Date.now(); const a = (failures.get(ip) || []).filter(t => now - t < 600000); a.push(now); failures.set(ip, a); }
function blocked(ip) { const now = Date.now(); return (failures.get(ip) || []).filter(t => now - t < 600000).length >= 10; }
function safeEqual(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function log(s) { console.log(`  [${new Date().toISOString().slice(11, 16)}Z] ${s}`); }
function status() {
  const count = k => items.filter(i => i.kind === k).length;
  return { incident: INCIDENT, team: TEAM, members: members(), whiteCell: wcClients.size, wcCode: !!WC_CODE, ending: ending ? ending.at : null,
    counts: { log: count('log'), finding: count('finding'), rfi: count('rfi'), rfc: count('rfc'), artifacts: count('blob') },
    memoryMB: +(storeBytes / 1048576).toFixed(1) };
}

/* ---------------- End of session ---------------- */
function startEnding(seconds) {
  if (ending) return;
  seconds = Math.max(10, Math.min(600, seconds));
  ending = { at: Date.now() + seconds * 1000 };
  ending.timer = setTimeout(() => {
    broadcast({ t: 'ended' });
    log('Session ended by the IC. Memory cleared.');
    setTimeout(() => process.exit(0), 800);
  }, seconds * 1000);
  broadcast({ t: 'ending', at: ending.at });
  log(`End of session in ${seconds} s.`);
}
function cancelEnding() { if (!ending) return; clearTimeout(ending.timer); ending = null; broadcast({ t: 'ending-cancelled' }); log('End of session cancelled.'); }

/* ---------------- IC panel data ---------------- */
async function buildIcInfo() {
  const proto = USE_HTTP ? 'http' : 'https';
  const addrs = [];
  if (MDNS_HOST) addrs.push({ label: MDNS_HOST + ':' + PORT, note: 'name', url: `${proto}://${MDNS_HOST}:${PORT}/` });
  shownInterfaces().forEach(i => addrs.push({ label: i.ip + ':' + PORT, note: i.name, url: `${proto}://${i.ip}:${PORT}/` }));
  for (const a of addrs) {
    a.join = a.url + '#join=' + encodeURIComponent(CODE);
    if (a.note !== 'name') a.qr = await QRCode.toDataURL(a.join, { margin: 1, width: 300 });
  }
  return { team: TEAM, code: CODE, fingerprint: FINGERPRINT, addresses: addrs, hidden: lanInterfaces().length - shownInterfaces().length };
}
function hqPage() {
  // Large display for a projector during the briefing
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const a = ICINFO.addresses, q = a.find(x => x.qr);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(TEAM || 'Field HQ')}</title>
<style>body{margin:0;font:18px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#16202B;color:#fff;display:grid;place-items:center;min-height:100vh}
.w{display:grid;grid-template-columns:auto 1fr;gap:48px;align-items:center;padding:32px}img{width:340px;height:340px;background:#fff;border-radius:8px;padding:8px}
h1{margin:0 0 4px;font-size:40px}.m{color:#95A2AF}.c{font:700 64px ui-monospace,Consolas,monospace;letter-spacing:.06em;margin:6px 0 18px}
code{display:block;font:600 28px ui-monospace,Consolas,monospace;margin:4px 0}@media(max-width:800px){.w{grid-template-columns:1fr}}</style></head><body>
<div class="w">${q ? `<img src="${q.qr}" alt="Join QR code">` : ''}<div><h1>${esc(TEAM || 'Field HQ')}</h1><div class="m">Incident ${esc(INCIDENT)}</div>
<p class="m" style="margin-top:24px">Phone: scan the code. Computer: open</p>${a.map(x => `<code>${esc(x.label)}</code>`).join('')}
<p class="m" style="margin-top:20px">Access code</p><div class="c">${esc(CODE)}</div>${FINGERPRINT ? `<div class="m">Certificate ${esc(FINGERPRINT.slice(0, 23))}…</div>` : ''}</div></div></body></html>`;
}

/* ---------------- Pre-flight (Windows) ---------------- */
let lastPreflight = null;
function ps(script, timeoutMs = 20000) {
  return new Promise(resolve => {
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    let outp = '', done = false;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true });
    const t = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch (e) {} resolve({ ok: false, out: '' }); } }, timeoutMs);
    p.stdout.on('data', d => outp += d);
    p.on('error', () => { if (!done) { done = true; clearTimeout(t); resolve({ ok: false, out: '' }); } });
    p.on('close', code => { if (!done) { done = true; clearTimeout(t); resolve({ ok: code === 0, out: outp.trim() }); } });
  });
}
const psq = s => "'" + String(s).replace(/'/g, "''") + "'";
async function preflight() {
  const issues = [];
  const real = lanInterfaces().filter(i => !i.virtual);
  if (!real.length) issues.push({ id: 'nonet', level: 'error', text: 'No Wi-Fi or Ethernet connection found. Connect this laptop to the section network.' });
  if (process.platform !== 'win32') { lastPreflight = { platform: process.platform, checked: true, issues }; return lastPreflight; }
  const exe = process.execPath;
  const r = await ps(`
$ErrorActionPreference='SilentlyContinue'
$p = @(Get-NetConnectionProfile | ForEach-Object { [pscustomobject]@{ alias = $_.InterfaceAlias; cat = "$($_.NetworkCategory)" } })
$b = @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -eq ${psq(exe)} -or $_.Program -like '*\\node.exe' } | Get-NetFirewallRule | Where-Object { "$($_.Direction)" -eq 'Inbound' -and "$($_.Action)" -eq 'Block' -and "$($_.Enabled)" -eq 'True' } | ForEach-Object { $_.DisplayName })
$a = @(Get-NetFirewallRule -DisplayName 'CBP Field HQ' | ForEach-Object { $_.DisplayName })
[pscustomobject]@{ profiles = $p; blocks = $b; allow = $a } | ConvertTo-Json -Depth 4 -Compress`);
  if (!r.ok || !r.out) { issues.push({ id: 'nocheck', level: 'info', text: 'Network checks could not run on this laptop. If analysts cannot connect, see the troubleshooting guide.' }); lastPreflight = { platform: 'win32', checked: false, issues }; return lastPreflight; }
  let d = {}; try { d = JSON.parse(r.out); } catch (e) {}
  const arr = v => Array.isArray(v) ? v : (v ? [v] : []);
  const names = new Set(real.map(i => i.name));
  const pub = arr(d.profiles).filter(x => x && x.cat === 'Public' && (names.has(x.alias) || !names.size));
  pub.forEach(x => issues.push({ id: 'public', level: 'error', alias: x.alias, text: `The network "${x.alias}" is set to Public: Windows blocks analysts from connecting.` }));
  if (arr(d.blocks).length) issues.push({ id: 'block', level: 'error', text: 'Windows Firewall has a rule blocking this HQ (often created when the firewall prompt was dismissed).' });
  if (!arr(d.allow).length && !pub.length && !arr(d.blocks).length) issues.push({ id: 'norule', level: 'info', text: 'No firewall rule yet. If Windows asks, choose Allow, or use Fix it to add the rule now.' });
  lastPreflight = { platform: 'win32', checked: true, issues, publicAliases: pub.map(x => x.alias) };
  return lastPreflight;
}
async function fixNetwork() {
  if (process.platform !== 'win32') return { ok: false, text: 'Automatic fix is only available on Windows.' };
  const pf = lastPreflight || await preflight();
  const aliases = pf.publicAliases || [];
  const exe = process.execPath;
  const inner = `
$ErrorActionPreference='SilentlyContinue'
${aliases.map(a => `Set-NetConnectionProfile -InterfaceAlias ${psq(a)} -NetworkCategory Private`).join('\n')}
Get-NetFirewallApplicationFilter | Where-Object { $_.Program -eq ${psq(exe)} -or $_.Program -like '*\\node.exe' } | Get-NetFirewallRule | Where-Object { "$($_.Direction)" -eq 'Inbound' -and "$($_.Action)" -eq 'Block' } | Remove-NetFirewallRule
Remove-NetFirewallRule -DisplayName 'CBP Field HQ'
Remove-NetFirewallRule -DisplayName 'CBP Field HQ mDNS'
New-NetFirewallRule -DisplayName 'CBP Field HQ' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORT} -Profile Private,Domain | Out-Null
New-NetFirewallRule -DisplayName 'CBP Field HQ mDNS' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 5353 -Profile Private,Domain | Out-Null`;
  const enc = Buffer.from(inner, 'utf16le').toString('base64');
  const r = await ps(`try { $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${enc}'; exit $p.ExitCode } catch { exit 5 }`, 120000);
  const after = await preflight();
  const left = after.issues.filter(i => i.level === 'error');
  if (!r.ok && left.length) return { ok: false, text: 'The fix was cancelled or not allowed. It needs administrator approval; on a managed work laptop, IT may have to do it.', preflight: after };
  return { ok: !left.length, text: left.length ? 'Some problems remain. On a managed work laptop, IT may have to change these settings.' : 'Fixed. Analysts can connect now.', preflight: after };
}

/* ---------------- Local name (mDNS): cpt1.local ---------------- */
async function freeMdnsName(base) {
  let mdns; try { mdns = require('multicast-dns')(); } catch (e) { return base + '.local'; }
  const mine = new Set(lanAddresses());
  const taken = name => new Promise(res => {
    const done = v => { clearTimeout(t); mdns.removeListener('response', on); res(v); };
    const on = r => { if ((r.answers || []).some(a => a.type === 'A' && a.name && a.name.toLowerCase() === name && !mine.has(a.data))) done(true); };
    mdns.on('response', on);
    const t = setTimeout(() => done(false), 1200);
    try { mdns.query({ questions: [{ name, type: 'A' }] }); } catch (e) { done(false); }
  });
  let name = base + '.local';
  for (let n = 2; n <= 9 && await taken(name); n++) { console.log('  ' + name + ' is already used by another HQ on this network.'); name = base + '-' + n + '.local'; }
  try { mdns.destroy(); } catch (e) {}
  return name;
}
function startMdns() {
  if (!MDNS_HOST) return;
  try {
    const mdns = require('multicast-dns')();
    const SVC = '_cbp-hq._tcp.local', INST = HQ_NAME + '.' + SVC;
    mdns.on('query', q => {
      const qs = q.questions || [];
      if (qs.some(x => x.name && x.name.toLowerCase() === SVC && (x.type === 'PTR' || x.type === 'ANY'))) {
        const a = shownInterfaces().map(i => ({ name: MDNS_HOST, type: 'A', ttl: 120, data: i.ip }));
        mdns.respond({ answers: [{ name: SVC, type: 'PTR', ttl: 120, data: INST }],
          additionals: [{ name: INST, type: 'SRV', ttl: 120, data: { port: PORT, target: MDNS_HOST, priority: 0, weight: 0 } },
            { name: INST, type: 'TXT', ttl: 120, data: ['team=' + (TEAM || HQ_NAME), 'v=' + VERSION, 'wc=' + (WC_CODE ? '1' : '0')] }, ...a] });
      }
      if (!qs.some(x => x.name && x.name.toLowerCase() === MDNS_HOST && (x.type === 'A' || x.type === 'ANY'))) return;
      const answers = shownInterfaces().map(i => ({ name: MDNS_HOST, type: 'A', ttl: 120, flush: true, data: i.ip }));
      if (answers.length) mdns.respond({ answers });
    });
    mdns.on('error', () => {});
  } catch (e) { console.log('  Local name ' + MDNS_HOST + ' unavailable: ' + e.message); }
}

/* ---------------- Certificates ---------------- */
async function loadOrCreateCert() {
  if (args.cert && args.key) {
    const cert = fs.readFileSync(args.cert), key = fs.readFileSync(args.key);
    return { cert, key, fingerprint: new crypto.X509Certificate(cert).fingerprint256 };
  }
  const ips = ['127.0.0.1', ...lanAddresses()];
  const certFile = path.join(CERT_DIR, 'hq-cert.pem'), keyFile = path.join(CERT_DIR, 'hq-key.pem');
  try {
    const cert = fs.readFileSync(certFile), key = fs.readFileSync(keyFile);
    const x = new crypto.X509Certificate(cert), sans = x.subjectAltName || '';
    const valid = new Date(x.validTo) > new Date(Date.now() + 86400000) && ips.every(ip => sans.includes('IP Address:' + ip)) && (!MDNS_HOST || sans.includes('DNS:' + MDNS_HOST));
    if (valid) return { cert, key, fingerprint: x.fingerprint256 };
  } catch (e) { /* create below */ }
  const selfsigned = require('selfsigned');
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Cyber Battle Pro Field HQ' }, { name: 'organizationName', value: 'Cyber Battle Pro' }], {
    keySize: 2048, algorithm: 'sha256', notAfterDate: new Date(Date.now() + 30 * 86400000),
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...(MDNS_HOST ? [{ type: 2, value: MDNS_HOST }] : []), ...ips.map(ip => ({ type: 7, ip }))] }]
  });
  try { fs.mkdirSync(CERT_DIR, { recursive: true }); fs.writeFileSync(certFile, pems.cert); fs.writeFileSync(keyFile, pems.private, { mode: 0o600 }); } catch (e) { /* read only location: keep in memory */ }
  return { cert: pems.cert, key: pems.private, fingerprint: new crypto.X509Certificate(pems.cert).fingerprint256 };
}

/* ---------------- Network helpers ---------------- */
function lanAddresses() { return lanInterfaces().map(i => i.ip); }
function shownInterfaces() { const all = lanInterfaces(); if (args['all-interfaces']) return all; const real = all.filter(i => !i.virtual); return real.length ? real : all; }
function lanInterfaces() {
  if (HOST !== '0.0.0.0') return [{ ip: HOST, name: 'selected', score: 0, virtual: false }];
  const VIRTUAL = /(vethernet|hyper-v|wsl|virtualbox|vbox|vmware|vmnet|docker|br-|veth|loopback|bluetooth|tailscale|zerotier|utun|tun|tap|vpn|npcap)/i;
  const PREFER = /(wi-?fi|wlan|wireless|ethernet|^en\d|^eth\d|^wl)/i;
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
    if (!(a.family === 'IPv4' || a.family === 4) || a.internal || a.address.startsWith('169.254.')) continue;
    let score = 50;
    if (PREFER.test(name)) score -= 30;
    if (VIRTUAL.test(name)) score += 40;
    if (/^192\.168\.56\./.test(a.address)) score += 30;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 10;
    if (a.address === '192.168.137.1') score -= 20;
    out.push({ ip: a.address, name, score, virtual: VIRTUAL.test(name) || /^192\.168\.56\./.test(a.address) });
  }
  return out.sort((x, y) => x.score - y.score);
}

/* ---------------- Misc ---------------- */
const WORDS = ['ALPHA', 'ANVIL', 'ARROW', 'ATLAS', 'BADGER', 'BEACON', 'BISON', 'BRAVO', 'CANYON', 'CEDAR', 'COBALT', 'COMET', 'CONDOR', 'COYOTE', 'DELTA', 'EAGLE',
  'EMBER', 'FALCON', 'FOXTROT', 'GRANITE', 'HARBOR', 'HAWK', 'HUNTER', 'INDIGO', 'JAGUAR', 'KESTREL', 'LANCER', 'LYNX', 'MAPLE', 'MARLIN', 'MESA', 'NOMAD',
  'OSPREY', 'OTTER', 'PANTHER', 'PILOT', 'QUARTZ', 'RANGER', 'RAVEN', 'RIDGE', 'SABER', 'SHADOW', 'SIERRA', 'SPARTAN', 'STORM', 'TALON', 'TANGO', 'THUNDER',
  'TIGER', 'TITAN', 'VECTOR', 'VIPER', 'WALRUS', 'WOLF', 'ZULU', 'BOREAL', 'CARIBOU', 'GLACIER', 'HUSKY', 'MOOSE', 'NORTH', 'PRAIRIE', 'TUNDRA', 'YUKON'];
function genCode() { return WORDS[crypto.randomInt(WORDS.length)] + '-' + crypto.randomInt(1000, 10000); }
function genIncident() { const d = new Date(), p = n => String(n).padStart(2, '0'); return 'INC-' + String(d.getUTCFullYear()).slice(2) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + '-' + p(crypto.randomInt(10, 100)); }
function ask(q) { return new Promise(res => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, a => { rl.close(); res(a || ''); }); }); }
function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, windowsHide: true, stdio: 'ignore' }).on('error', () => {}).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch (e) {}
}
function pauseThenExit(code) { if (process.pkg && process.platform === 'win32' && process.stdin.isTTY) { console.log('  Press Enter to close.'); process.stdin.once('data', () => process.exit(code)); } else process.exit(code); }
function parseArgs(a) { const o = {}; for (let i = 0; i < a.length; i++) { if (!a[i].startsWith('--')) continue; const k = a[i].slice(2), v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true; o[k] = v; } return o; }
function printHelp() {
  console.log(`
Cyber Battle Pro Field HQ ${VERSION}

Double click CBP-HQ to start. The first time it asks for the team label and remembers it.

Options:
  --team LABEL       Team label shown to analysts, e.g. "CPT 1"
  --wc-code CODE     White Cell exercise code (lets the White Cell connect)
  --white-cell       Run as the White Cell console instead of a team HQ (or type WC as the team)
  --incident ID      Incident ID for this session (default: generated)
  --code CODE        Access code (default: readable random code, e.g. RAVEN-4721)
  --port N           Port (default 8443)
  --name NAME        Local network name, reachable as NAME.local (default: from the team label)
  --host IP          Listen only on this address
  --cert FILE --key FILE   TLS certificate and key (PEM), e.g. from a training CA or your PKI
  --no-browser       Do not open the app at start
  --no-mdns          Do not announce the .local name
  --all-interfaces   Also list virtual adapters (VMware, Hyper-V, WSL, Docker, VPN)
  --http             No TLS at all. Testing only
  --max-clients N    Maximum connected devices (default 25)
`);
}
process.on('uncaughtException', err => {
  console.log('\n  The HQ stopped because of an error:\n  ' + (err && err.stack || err) + '\n');
  pauseThenExit(1);
});
process.on('SIGINT', () => { console.log('\n  Field HQ stopped. Session data held in memory has been cleared.\n'); process.exit(0); });

main();
