/*
 * Cyber Battle Pro
 * Copyright (C) 2026 Alexander Lavrinenko <https://cyberlav.io>
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Free software under the GNU Affero General Public License version 3, with the
 * additional terms in NOTICE (author credit, marking of modified versions, name and logo).
 * It comes with NO WARRANTY. See LICENSE and NOTICE, or <https://www.gnu.org/licenses/>.
 */
'use strict';
/*
 * Cyber Battle Pro, saved sessions
 * One file per HQ or White Cell session, gzip compressed, optionally encrypted with
 * AES-256-GCM using a key derived from the IC's passphrase (scrypt).
 * Written atomically (temp file, then rename) so a power cut never leaves a half file.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const EXT_HQ = '.cbps', EXT_WC = '.cbpwc';
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function dirOf(dataDir) { const d = path.join(dataDir, 'sessions'); fs.mkdirSync(d, { recursive: true }); return d; }

let keyCache = null;
function encode(raw, passphrase, meta) {
  const head = { format: 'cbp-session', v: 1, kind: meta.kind, team: meta.team || '', incident: meta.incident || '', savedAt: new Date().toISOString(), encrypted: !!passphrase };
  if (!passphrase) return Buffer.concat([Buffer.from(JSON.stringify(head) + '\n'), raw]);
  // The key is derived once per session (scrypt is deliberately slow); every save still gets a fresh IV
  if (!keyCache || keyCache.pass !== passphrase) { const salt = crypto.randomBytes(16); keyCache = { pass: passphrase, salt, key: crypto.scryptSync(String(passphrase), salt, 32, SCRYPT) }; }
  const { salt, key } = keyCache, iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(JSON.stringify(head)));
  const data = Buffer.concat([c.update(raw), c.final()]);
  head.salt = salt.toString('base64'); head.iv = iv.toString('base64'); head.tag = c.getAuthTag().toString('base64');
  return Buffer.concat([Buffer.from(JSON.stringify(head) + '\n'), data]);
}

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, 0);
    const nl = buf.subarray(0, n).indexOf(10); if (nl < 0) return null;
    const head = JSON.parse(buf.subarray(0, nl).toString());
    return head && head.format === 'cbp-session' ? { head, offset: nl + 1 } : null;
  } catch (e) { return null; } finally { fs.closeSync(fd); }
}

function decode(file, passphrase) {
  const all = fs.readFileSync(file);
  const nl = all.indexOf(10);
  const head = JSON.parse(all.subarray(0, nl).toString());
  let body = all.subarray(nl + 1);
  if (head.encrypted) {
    if (!passphrase) { const e = new Error('Passphrase required'); e.code = 'NEEDPASS'; throw e; }
    const { salt, iv, tag, ...aad } = head;
    const key = crypto.scryptSync(String(passphrase), Buffer.from(salt, 'base64'), 32, SCRYPT);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAAD(Buffer.from(JSON.stringify(aad)));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    try { body = Buffer.concat([d.update(body), d.final()]); }
    catch (e) { const err = new Error('Wrong passphrase or damaged file'); err.code = 'BADPASS'; throw err; }
  }
  return { head, payload: JSON.parse(zlib.gunzipSync(body).toString()) };
}

// Synchronous save: used on exit paths (pause, Ctrl+C) where the process must not leave before the file is written
function save(file, payload, passphrase, meta) {
  const buf = encode(zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 6 }), passphrase, meta);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, buf, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return buf.length;
}
// Background checkpoint: compression off the main thread so the HQ keeps relaying while it writes
async function saveAsync(file, payload, passphrase, meta) {
  const raw = await new Promise((ok, ko) => zlib.gzip(Buffer.from(JSON.stringify(payload)), { level: 6 }, (e, b) => e ? ko(e) : ok(b)));
  const buf = encode(raw, passphrase, meta);
  const tmp = file + '.tmp';
  await fs.promises.writeFile(tmp, buf, { mode: 0o600 });
  await fs.promises.rename(tmp, file);
  return buf.length;
}

function list(dataDir) {
  let d; try { d = dirOf(dataDir); } catch (e) { return []; }
  return fs.readdirSync(d).filter(f => f.endsWith(EXT_HQ) || f.endsWith(EXT_WC)).map(f => {
    const file = path.join(d, f), h = readHead(file);
    if (!h) return null;
    return { file, ...h.head, size: fs.statSync(file).size };
  }).filter(Boolean).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

function remove(file) { try { fs.unlinkSync(file); } catch (e) {} try { fs.unlinkSync(file + '.tmp'); } catch (e) {} }

function newFile(dataDir, kind, label) {
  const d = dirOf(dataDir), p = n => String(n).padStart(2, '0'), t = new Date();
  const stamp = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}`;
  const name = (String(label || kind).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || kind) + '-' + stamp;
  return path.join(d, name + (kind === 'wc' ? EXT_WC : EXT_HQ));
}

// Masked input for passphrases in the black window
function askHidden(q) {
  return new Promise(res => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = s => { if (!muted) rl.output.write(s); else if (s.includes('\n') || s.includes('\r')) rl.output.write('\n'); else rl.output.write('*'.repeat(s.length ? 1 : 0)); };
    rl.question(q, a => { rl.close(); res(a || ''); });
    muted = true;
  });
}

function when(iso) {
  const d = new Date(iso), p = n => String(n).padStart(2, '0'), M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${p(d.getHours())}${p(d.getMinutes())} ${p(d.getDate())} ${M[d.getMonth()]}`;
}

module.exports = { save, saveAsync, decode, list, remove, newFile, askHidden, when, EXT_HQ, EXT_WC };
