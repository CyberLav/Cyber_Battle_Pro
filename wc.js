'use strict';
/*
 * Cyber Battle Pro, White Cell console
 * Finds the team HQs on the exercise network, connects to each with the exercise code,
 * and serves the White Cell console on http://localhost (this laptop only).
 * The White Cell sees a summary of each team and the RFIs and RFCs addressed to WC.
 * It answers RFIs and sends injects. The console state is checkpointed to the sessions folder
 * so an exercise paused overnight resumes with its teams, answers and injects.
 */
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;

const SVC = '_cbp-hq._tcp.local';

exports.start = async function start({ args, ask, openBrowser, genCode, VERSION, store, DATA_DIR, resume, onStop }) {
  const str = v => (v && v !== true ? String(v) : '');
  const tty = process.stdin.isTTY && !args['no-prompt'];
  const NOSAVE = !!args['no-save'];
  const SAVE = { file: '', pass: '', dirty: false, timer: null, busy: false, at: 0, startedAt: new Date().toISOString() };
  let CODE = resume ? resume.payload.code : str(args['wc-code']).toUpperCase().trim();
  if (!CODE && tty) CODE = (await ask('\n  WHITE CELL\n\n  Exercise code (press Enter to generate one): ')).toUpperCase().trim();
  if (!CODE) CODE = genCode();
  if (resume) { SAVE.file = resume.file; SAVE.pass = resume.pass || ''; SAVE.startedAt = resume.payload.startedAt || SAVE.startedAt; }
  else if (!NOSAVE) {
    SAVE.pass = str(args.passphrase);
    if (!SAVE.pass && tty) for (;;) {
      const p = await store.askHidden('  Passphrase to protect the saved White Cell session (press Enter for none): ');
      if (!p) break;
      if (p.length < 6) { console.log('  Use at least 6 characters, or press Enter for none.'); continue; }
      if (await store.askHidden('  Type it again: ') === p) { SAVE.pass = p; break; }
      console.log('  The two entries do not match.');
    }
    SAVE.file = store.newFile(DATA_DIR, 'wc', 'white-cell');
  }
  const PORT = Number(args.port) || 8450;
  const hqs = new Map();            // key -> hq
  const injects = [];               // {id, text, prec, keys, at, sentAt, status}
  const uiClients = new Set();
  let uiTimer = null;
  const short = k => crypto.createHash('sha1').update(k).digest('hex').slice(0, 6);
  const log = s => console.log(`  [${new Date().toISOString().slice(11, 16)}Z] ${s}`);

  /* ---------- HQ connections ---------- */
  function addHq(address, team, source) {
    address = String(address || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[\w.-]+:\d{2,5}$/.test(address)) return false;
    if (hqs.has(address)) { const h = hqs.get(address); if (team && !h.team) h.team = team; return true; }
    const h = { key: address, address, team: team || '', source, status: 'connecting', reason: '', fp: '', summary: null, items: new Map(), retry: 0, ws: null, timer: null, stopped: false };
    hqs.set(address, h); connect(h); pushUi(); markDirty();
    return true;
  }
  // An HQ resumed on another address (new IP in the morning) comes back with the same server ID: fold the old entry into the new one
  function merge(into, serverId) {
    for (const old of [...hqs.values()]) {
      if (old === into || old.serverId !== serverId) continue;
      for (const [k, v] of old.items) if (!into.items.has(k)) into.items.set(k, v);
      if (old.pending && old.pending.length) (into.pending = into.pending || []).push(...old.pending);
      into.team = into.team || old.team;
      injects.forEach(inj => { inj.keys = inj.keys.map(k => k === old.key ? into.key : k); });
      old.stopped = true; clearTimeout(old.timer); try { old.ws && old.ws.close(); } catch (e) {}
      hqs.delete(old.key);
      log(`${into.team || into.address} is back on a new address (${into.address})`);
    }
  }
  function connect(h) {
    clearTimeout(h.timer);
    if (h.stopped) return;
    h.status = 'connecting'; pushUi();
    let ws;
    try { ws = new WebSocket(`wss://${h.address}/ws`, { rejectUnauthorized: false, headers: { Origin: `https://${h.address}` }, handshakeTimeout: 8000 }); }
    catch (e) { h.status = 'offline'; h.reason = e.message; return later(h); }
    h.ws = ws;
    ws.on('upgrade', res => {
      try {
        const fp = res.socket.getPeerCertificate().fingerprint256 || '';
        if (h.fp && fp && fp !== h.fp) { h.status = 'blocked'; h.reason = 'Certificate changed. Remove and add this HQ again only if the IC confirms the new fingerprint.'; h.stopped = true; ws.terminate(); pushUi(); return; }
        h.fp = h.fp || fp;
      } catch (e) {}
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'wchello', code: CODE })));
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.t === 'denied') { h.status = 'refused'; h.reason = m.reason || 'Refused'; h.stopped = /code/i.test(h.reason); pushUi(); return; }
      if (m.t === 'wcwelcome') {
        if (h.serverId && h.serverId !== m.serverId) h.items.clear();
        merge(h, m.serverId);
        h.serverId = m.serverId; h.summary = m.summary; h.team = m.summary.team || h.team; h.paused = false;
        h.status = 'online'; h.reason = ''; h.retry = 0; log(`Connected to ${h.team} (${h.address})`);
        flushPending(h); pushUi(); markDirty(); return;
      }
      if (m.t === 'wcsummary') { h.summary = m.summary; pushUi(); markDirty(); return; }
      if (m.t === 'hqpaused') { h.paused = true; log(`${h.team || h.address} paused the exercise`); pushUi(); return; }
      if (m.t === 'entries') { for (const it of m.items || []) h.items.set(it.kind + ':' + it.id, it); pushUi(); markDirty(); }
    });
    ws.on('close', () => { if (h.ws !== ws) return; h.ws = null; if (h.status !== 'refused' && h.status !== 'blocked') { h.status = h.paused ? 'paused' : 'offline'; later(h); } pushUi(); });
    ws.on('error', e => { h.reason = e.code || e.message; });
  }
  function later(h) { if (h.stopped) return; h.timer = setTimeout(() => connect(h), h.paused ? 30000 : Math.min(15000, 2000 * 2 ** Math.min(h.retry++, 3))); pushUi(); }
  function sendTo(h, items) {
    markDirty();
    if (h.ws && h.ws.readyState === 1 && h.status === 'online') { h.ws.send(JSON.stringify({ t: 'wcpush', items })); return true; }
    (h.pending = h.pending || []).push(...items); return false;
  }

  /* ---------- Saved session ---------- */
  function snapshot() {
    return { v: 1, app: VERSION, code: CODE, startedAt: SAVE.startedAt,
      hqs: [...hqs.values()].map(h => ({ key: h.key, address: h.address, team: h.team, source: h.source, serverId: h.serverId || '', summary: h.summary, pending: h.pending || [], items: [...h.items.values()] })),
      injects: injects.map(({ timer, ...x }) => x) };
  }
  const meta = () => ({ kind: 'wc', team: 'White Cell', incident: CODE });
  function markDirty() {
    if (!SAVE.file) return;
    SAVE.dirty = true;
    if (SAVE.timer || SAVE.busy) return;
    SAVE.timer = setTimeout(checkpoint, Math.max(5000, SAVE.at + 15000 - Date.now()));
  }
  async function checkpoint() {
    SAVE.timer = null; if (!SAVE.dirty || !SAVE.file) return;
    SAVE.dirty = false; SAVE.busy = true;
    try { await store.saveAsync(SAVE.file, snapshot(), SAVE.pass, meta()); SAVE.at = Date.now(); SAVE.error = ''; }
    catch (e) { SAVE.dirty = true; SAVE.error = e.message; log('Could not save the White Cell session: ' + e.message); }
    SAVE.busy = false; if (SAVE.dirty) markDirty();
  }
  function saveNow() {
    if (!SAVE.file) return false;
    clearTimeout(SAVE.timer); SAVE.timer = null;
    try { store.save(SAVE.file, snapshot(), SAVE.pass, meta()); SAVE.at = Date.now(); SAVE.dirty = false; return true; } catch (e) { console.log('  Could not save: ' + e.message); return false; }
  }
  if (onStop) onStop(() => saveNow() ? 'White Cell stopped. The session is saved: start CBP-HQ again and choose it to resume.' : '');
  if (resume) {
    const d = resume.payload;
    for (const x of d.hqs || []) {
      // Certificate pins are not carried over: an HQ laptop that changed address overnight gets a new certificate
      const h = { key: x.key, address: x.address, team: x.team || '', source: x.source, status: 'connecting', reason: '', fp: '', summary: x.summary || null, serverId: x.serverId || '',
        items: new Map((x.items || []).map(it => [it.kind + ':' + it.id, it])), pending: x.pending || [], retry: 0, ws: null, timer: null, stopped: false, paused: true };
      hqs.set(h.key, h);
    }
    for (const inj of d.injects || []) {
      // A scheduled inject whose time passed during the pause is held for the White Cell to send or cancel
      if (inj.status === 'scheduled') {
        const at = new Date(inj.at).getTime();
        if (at > Date.now() + 1000) inj.timer = setTimeout(() => sendInject(inj), at - Date.now()); else inj.status = 'held';
      }
      injects.push(inj);
    }
  }
  function flushPending(h) { if (h.pending && h.pending.length) { const p = h.pending; h.pending = []; sendTo(h, p); } }

  /* ---------- Discovery (mDNS) ---------- */
  let mdns = null;
  try {
    mdns = require('multicast-dns')();
    mdns.on('response', r => {
      const all = [...(r.answers || []), ...(r.additionals || [])];
      for (const p of all.filter(x => x.type === 'PTR' && String(x.name).toLowerCase() === SVC)) {
        const srv = all.find(x => x.type === 'SRV' && x.name === p.data);
        if (!srv) continue;
        const a = all.find(x => x.type === 'A' && String(x.name).toLowerCase() === String(srv.data.target).toLowerCase());
        const txt = all.find(x => x.type === 'TXT' && x.name === p.data);
        let team = '', wc = '1';
        if (txt) for (const b of [].concat(txt.data)) { const t = String(b); if (t.startsWith('team=')) team = t.slice(5); if (t.startsWith('wc=')) wc = t.slice(3); }
        if (a && wc !== '0') addHq(`${a.data}:${srv.data.port}`, team, 'found');
      }
    });
    mdns.on('error', () => {});
    const q = () => { try { mdns.query({ questions: [{ name: SVC, type: 'PTR' }] }); } catch (e) {} };
    q(); setInterval(q, 8000);
  } catch (e) { console.log('  Automatic discovery unavailable: add HQs by address in the console.'); }
  /* ---------- Discovery (network scan) ----------
     mDNS is often blocked on exercise networks or sent out the wrong adapter (VMware, Hyper-V).
     So the White Cell also checks its own /24 for HQs on the HQ port. One HTTPS request per address,
     the same port analysts already use, so no firewall change is needed on the HQ laptops. */
  const VIRTUAL = /(vethernet|hyper-v|wsl|virtualbox|vbox|vmware|vmnet|docker|br-|veth|loopback|bluetooth|tailscale|zerotier|utun|tun|tap|vpn|npcap)/i;
  const PORTS = [8443, ...String(str(args['scan-ports']) || '').split(',').map(Number).filter(n => n > 0 && n < 65536)];
  let scanning = false, lastScan = null, scanFound = 0;
  function probe(ip, port) {
    return new Promise(res => {
      const req = https.get({ host: ip, port, path: '/cbp/info', rejectUnauthorized: false, timeout: 1200, agent: false }, r => {
        let b = ''; r.on('data', d => { b += d; if (b.length > 4096) r.destroy(); });
        r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } });
      });
      req.on('timeout', () => req.destroy()); req.on('error', () => res(null));
    });
  }
  async function scan() {
    if (scanning || args['no-scan']) return;
    scanning = true; pushUi();
    const mine = [], targets = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
      if (!(a.family === 'IPv4' || a.family === 4) || a.internal || a.address.startsWith('169.254.') || VIRTUAL.test(name) || /^192\.168\.56\./.test(a.address)) continue;
      mine.push(a.address);
      const b = a.address.split('.').slice(0, 3).join('.');
      for (let i = 1; i < 255; i++) for (const port of PORTS) targets.push([`${b}.${i}`, port]);
    }
    let found = 0, idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        const [ip, port] = targets[idx++];
        if (hqs.has(`${ip}:${port}`)) continue;
        const info = await probe(ip, port);
        if (info && info.app === 'cbp' && info.wc !== false) { found++; addHq(`${ip}:${port}`, info.hq || '', 'found'); }
      }
    };
    await Promise.all(Array.from({ length: 64 }, worker));
    scanning = false; lastScan = new Date().toISOString(); scanFound = found; pushUi();
  }
  setTimeout(scan, 300); setInterval(scan, 45000);
  [].concat(args.hq || []).filter(x => x && x !== true).forEach(a => String(a).split(',').forEach(x => addHq(x, '', 'manual')));

  /* ---------- Actions from the console ---------- */
  function sendInject(inj) {
    inj.sentAt = new Date().toISOString(); inj.status = 'sent';
    for (const key of inj.keys) {
      const h = hqs.get(key); if (!h) continue;
      sendTo(h, [{ kind: 'wcmsg', id: `${inj.id}.${short(key)}`, data: { type: 'inject', inject: inj.id, text: inj.text, prec: inj.prec, ts: inj.sentAt } }]);
    }
    log(`Inject sent to ${inj.keys.length} HQ(s)`);
    pushUi();
  }
  function onUi(m) {
    if (m.t === 'add') { if (!addHq(m.address, '', 'manual')) uiNotice('Use an address like 192.168.1.20:8443 or cpt1.local:8443'); return; }
    if (m.t === 'scan') { scan(); return; }
    if (m.t === 'remove') { const h = hqs.get(m.key); if (h) { h.stopped = true; clearTimeout(h.timer); try { h.ws && h.ws.close(); } catch (e) {} hqs.delete(m.key); pushUi(); markDirty(); } return; }
    if (m.t === 'retry') { const h = hqs.get(m.key); if (h) { h.stopped = false; h.retry = 0; connect(h); } return; }
    if (m.t === 'answer') {
      const h = hqs.get(m.key); const text = String(m.text || '').trim().slice(0, 4000);
      const on = m.on === 'rfc' ? 'rfc' : 'rfi';
      const decision = on === 'rfc' && ['Approved', 'Rejected', 'More information required'].includes(m.decision) ? m.decision : '';
      if (!h || (!text && !decision)) return;
      const id = 'ans.' + crypto.randomBytes(5).toString('hex');
      sendTo(h, [{ kind: 'wcmsg', id, data: { type: 'answer', on, ref: m.ref, decision, text, ts: new Date().toISOString() } }]);
      log(`${on.toUpperCase()} ${decision ? decision.toLowerCase() : 'answered'} for ${h.team}`); pushUi(); return;
    }
    if (m.t === 'inject') {
      markDirty();
      const text = String(m.text || '').trim().slice(0, 4000);
      const keys = (m.keys || []).filter(k => hqs.has(k));
      if (!text || !keys.length) return uiNotice('Write the inject and pick at least one team.');
      const inj = { id: 'inj.' + crypto.randomBytes(5).toString('hex'), text, prec: ['FLASH', 'IMMEDIATE', 'PRIORITY', 'ROUTINE'].includes(m.prec) ? m.prec : 'PRIORITY', keys, at: null, sentAt: null, status: 'scheduled' };
      const at = Number(m.at) || 0;
      injects.push(inj);
      if (at > Date.now() + 1000) { inj.at = new Date(at).toISOString(); inj.timer = setTimeout(() => sendInject(inj), at - Date.now()); pushUi(); }
      else sendInject(inj);
      return;
    }
    if (m.t === 'cancel') { const inj = injects.find(x => x.id === m.id && ['scheduled', 'held'].includes(x.status)); if (inj) { clearTimeout(inj.timer); inj.status = 'cancelled'; pushUi(); markDirty(); } return; }
    if (m.t === 'sendnow') { const inj = injects.find(x => x.id === m.id && ['scheduled', 'held'].includes(x.status)); if (inj) { clearTimeout(inj.timer); sendInject(inj); } return; }
    if (m.t === 'endex') {
      if (SAVE.file) store.remove(SAVE.file);
      SAVE.file = '';
      log('Exercise ended by the White Cell. The saved session was deleted.');
      uiNotice('Exercise ended. You can close this tab.');
      setTimeout(() => process.exit(0), 800);
    }
  }

  /* ---------- Console (this laptop only) ---------- */
  function state() {
    return {
      t: 'state', code: CODE, version: VERSION, now: Date.now(), scanning, lastScan, scanFound,
      save: SAVE.file ? { on: true, encrypted: !!SAVE.pass, at: SAVE.at || null, error: SAVE.error || '', resumed: !!resume } : { on: false },
      hqs: [...hqs.values()].map(h => ({ key: h.key, address: h.address, team: h.team, status: h.status, reason: h.reason, fp: h.fp, source: h.source, summary: h.summary,
        pending: (h.pending || []).length, items: [...h.items.values()].map(it => ({ kind: it.kind, id: it.id, data: it.data, from: it.from })) })),
      injects: injects.map(({ timer, ...x }) => x)
    };
  }
  function pushUi() { if (uiTimer) return; uiTimer = setTimeout(() => { uiTimer = null; const s = JSON.stringify(state()); uiClients.forEach(c => c.readyState === 1 && c.send(s)); }, 150); }
  function uiNotice(text) { const s = JSON.stringify({ t: 'notice', text }); uiClients.forEach(c => c.readyState === 1 && c.send(s)); }

  const local = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const server = http.createServer((req, res) => {
    if (!local(req)) { res.writeHead(403); return res.end('White Cell console is only available on this laptop.'); }
    const p = new URL(req.url, 'http://x').pathname;
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' }); res.end(body); };
    if (p === '/' || p === '/index.html') return fs.readFile(path.join(__dirname, 'public', 'wc.html'), (e, b) => e ? send(404, 'text/plain', 'Not found') : send(200, 'text/html; charset=utf-8', b));
    const BRAND = path.join(__dirname, 'public', 'brand');
    const brandFile = p === '/favicon.ico' ? 'favicon.ico' : (/^\/brand\/([\w-]+\.(svg|png|ico))$/.exec(p) || [])[1];
    if (brandFile) return fs.readFile(path.join(BRAND, brandFile), (e, b) => e ? send(404, 'text/plain', 'Not found') : send(200, { svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon' }[brandFile.split('.').pop()], b));
    send(404, 'text/plain', 'Not found');
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, sock, head) => {
    if (!local(req) || new URL(req.url, 'http://x').pathname !== '/ui') return sock.destroy();
    try { if (new URL(req.headers.origin).host !== req.headers.host) return sock.destroy(); } catch (e) { return sock.destroy(); }
    wss.handleUpgrade(req, sock, head, ws => {
      uiClients.add(ws); ws.send(JSON.stringify(state()));
      ws.on('message', raw => { try { onUi(JSON.parse(raw)); } catch (e) {} });
      ws.on('close', () => uiClients.delete(ws));
    });
  });
  server.on('error', err => {
    console.log(err.code === 'EADDRINUSE' ? `\n  Port ${PORT} is already in use. Start with --port 8451.\n` : '\n  Could not start: ' + err.message + '\n');
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('  CYBER BATTLE PRO  ·  WHITE CELL  v' + VERSION);
    console.log('  ' + '─'.repeat(52));
    console.log('  Exercise code  ' + CODE);
    console.log('  Give this code to every IC. They type it when their HQ asks for the White Cell code.');
    console.log('');
    console.log('  Console: http://localhost:' + PORT + '   (keep this window open)');
    if (resume) console.log(`  Resumed      ${hqs.size} team(s) and ${injects.length} inject(s) restored`);
    console.log('  Saved to     ' + (SAVE.file ? 'sessions' + path.sep + path.basename(SAVE.file) + (SAVE.pass ? ' (encrypted)' : ' (no passphrase)') : 'nothing (--no-save)'));
    if (injects.some(i => i.status === 'held')) console.log('  Some scheduled injects came due during the pause: they are held in the console until you send or cancel them.');
    console.log('  Team HQs on this network are found automatically (local name lookup and a scan of this subnet on port ' + PORTS.join(', ') + ').');
    console.log('');
    if (!args['no-browser']) openBrowser(`http://localhost:${PORT}/`);
  });
  setInterval(() => { if (uiClients.size) pushUi(); }, 15000);
  if (resume) for (const h of hqs.values()) connect(h);
  if (SAVE.file) { saveNow(); setInterval(() => { if (SAVE.dirty && !SAVE.timer && !SAVE.busy) checkpoint(); }, 60000); }
};
