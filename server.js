const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('./public/dates.js');

const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || 'America/Phoenix';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NTFY_TOKEN = process.env.NTFY_TOKEN || '';
const NOTIFY_TIME = /^\d{1,2}:\d{2}$/.test(process.env.NOTIFY_TIME || '') ? process.env.NOTIFY_TIME : '09:00';
const KE = process.env.KEEP_EXPIRED; // how many expired sets to keep (newest by end date); older ones are deleted. -1 = never delete
const KEEP_EXPIRED = KE === undefined || KE === '' ? 15 : /^\d+$/.test(KE) ? +KE : -1;
const UPSCALER_URL = (process.env.UPSCALER_URL || '').replace(/\/+$/, ''); // optional cover-image enhancer container
const LEVELS = ['Uncommon', 'Rare', 'Super Rare', 'Iconic', 'Legendary'];
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const IMG_DIR = path.join(DATA_DIR, 'images');
fs.mkdirSync(IMG_DIR, { recursive: true });

// ---------- JSON store ----------
let db = { sets: [], notified: {} };
function load() {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') {
      const bak = `${DATA_FILE}.corrupt-${Date.now()}`;
      try { fs.renameSync(DATA_FILE, bak); console.error('Unreadable data.json moved to', bak); } catch {}
    }
  }
  db.sets = Array.isArray(db.sets) ? db.sets : [];
  db.notified = db.notified || {};
}
function save() { // atomic write
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
load();
const getSet = id => db.sets.find(s => s.id === id);
const locked = s => D.isExpired(s, D.nowParts(TZ).date);

// Deletes sets, their sent-notification records, and their cover files (unless another set still uses the same cover).
function removeSets(list) {
  if (!list.length) return;
  const covers = new Set(list.map(s => s.cover).filter(Boolean));
  db.sets = db.sets.filter(s => !list.includes(s));
  for (const k of Object.keys(db.notified)) if (list.some(s => k.startsWith(s.id + ':'))) delete db.notified[k];
  save();
  for (const c of covers) if (!db.sets.some(o => o.cover === c)) fs.rm(path.join(IMG_DIR, path.basename(c)), { force: true }, () => {});
}
// Keeps only the newest KEEP_EXPIRED expired sets (by end date, then creation time) and deletes the rest.
function pruneExpired() {
  if (KEEP_EXPIRED < 0) return;
  const today = D.nowParts(TZ).date;
  const expired = db.sets.filter(s => D.isExpired(s, today)).sort((a, b) => b.endDate.localeCompare(a.endDate) || (b.createdAt || 0) - (a.createdAt || 0));
  const drop = expired.slice(KEEP_EXPIRED);
  if (drop.length) { removeSets(drop); console.log(`Pruned ${drop.length} expired set(s) beyond the newest ${KEEP_EXPIRED}: ${drop.map(s => s.name).join(', ')}`); }
}

// ---------- validation ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanSet(b, existing) {
  const err = error => ({ error });
  const name = String(b.name || '').trim().slice(0, 100);
  if (!name) return err('Name is required');
  const type = ['longterm', 'weekly', 'daily'].includes(b.type) ? b.type : 'longterm';
  const old = new Map(((existing && existing.items) || []).map(i => [i.id, i]));
  const items = [];
  for (const i of Array.isArray(b.items) ? b.items : []) {
    if (!LEVELS.includes(i.level)) return err('Invalid level');
    const total = parseInt(i.total, 10);
    if (!(total >= 1 && total <= 9999)) return err(`Enter a card total for ${i.level}`);
    const prev = old.get(i.id);
    items.push({ id: prev ? prev.id : crypto.randomUUID(), level: i.level, variation: String(i.variation || '').trim().slice(0, 60), total, owned: Math.min(prev ? prev.owned : 0, total) });
  }
  if (!items.length) return err('Choose at least one level to chase');
  let startDate = null, releaseDay = null, slots = [], endDate = b.endDate;
  if (type === 'longterm') {
    if (!DATE_RE.test(endDate || '')) return err('End date is required');
  } else {
    startDate = b.startDate;
    if (!DATE_RE.test(startDate || '')) return err('Start date is required');
    const count = Math.max(...items.map(i => i.total)); // one drop per card in the biggest chased item
    if (count > (type === 'weekly' ? 104 : 200)) return err(`A ${type} set can't run that many drops (${count})`);
    if (type === 'weekly') {
      releaseDay = Number(b.releaseDay);
      if (!(releaseDay >= 0 && releaseDay <= 6)) return err('Choose a release day');
    }
    slots = D.buildSlots(type, startDate, count, releaseDay);
    endDate = D.endDateFor(type, slots);
  }
  const cover = typeof b.cover === 'string' && /^\/images\/[\w.-]+$/.test(b.cover) ? b.cover : '';
  return { set: { id: existing ? existing.id : crypto.randomUUID(), name, type, startDate, endDate, releaseDay, cover, items, slots, createdAt: existing ? existing.createdAt : Date.now() } };
}

// ---------- API ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(IMG_DIR, { maxAge: '7d', immutable: true }));

app.get('/api/state', (req, res) => res.json({ tz: TZ, ntfy: { configured: !!NTFY_TOPIC, notifyTime: NOTIFY_TIME }, enhance: !!UPSCALER_URL, sets: db.sets }));

app.post('/api/sets', (req, res) => {
  const r = cleanSet(req.body || {});
  if (r.error) return res.status(400).json(r);
  db.sets.push(r.set); save(); res.json(r.set);
});
app.put('/api/sets/:id', (req, res) => {
  const s = getSet(req.params.id);
  if (!s) return res.status(404).json({ error: 'Set not found' });
  if (locked(s)) return res.status(403).json({ error: 'Expired sets are read-only' });
  const r = cleanSet(req.body || {}, s);
  if (r.error) return res.status(400).json(r);
  db.sets[db.sets.indexOf(s)] = r.set; save(); res.json(r.set);
});
app.delete('/api/sets/:id', (req, res) => {
  const s = getSet(req.params.id);
  if (!s) return res.status(404).json({ error: 'Set not found' });
  if (locked(s)) return res.status(403).json({ error: 'Expired sets are read-only' });
  removeSets([s]);
  res.json({ ok: true });
});
app.post('/api/sets/:id/items/:itemId', (req, res) => {
  const s = getSet(req.params.id);
  const it = s && s.items.find(i => i.id === req.params.itemId);
  if (!it) return res.status(404).json({ error: 'Not found' });
  if (locked(s)) return res.status(403).json({ error: 'Expired sets are read-only' });
  const b = req.body || {};
  const next = b.value !== undefined ? parseInt(b.value, 10) : it.owned + (parseInt(b.delta, 10) || 0);
  it.owned = Math.max(0, Math.min(it.total, Number.isFinite(next) ? next : it.owned));
  save(); res.json(s);
});
const IMG_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
app.post('/api/upload', express.raw({ type: Object.keys(IMG_TYPES), limit: '8mb' }), (req, res) => {
  const ext = IMG_TYPES[(req.headers['content-type'] || '').split(';')[0]];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Unsupported image' });
  const name = crypto.randomUUID() + '.' + ext;
  fs.writeFileSync(path.join(IMG_DIR, name), req.body);
  res.json({ path: '/images/' + name });
});

// ---------- cover enhancement (proxy to the upscaler container) ----------
const JOB_ID = /^[\w-]{36}$/;
async function upscaler(res, pathAndQuery, init = {}) {
  if (!UPSCALER_URL) { res.status(503).json({ error: 'Upscaler is not configured (UPSCALER_URL)' }); return null; }
  try { return await fetch(UPSCALER_URL + pathAndQuery, { ...init, signal: AbortSignal.timeout(30000) }); }
  catch (e) { res.status(502).json({ error: 'Upscaler is not reachable' }); return null; }
}
async function passJson(res, r) {
  const j = await r.json().catch(() => ({}));
  res.status(r.ok ? 200 : [400, 404, 429].includes(r.status) ? r.status : 502).json(r.ok ? j : { error: j.error || `Upscaler responded ${r.status}` });
}
app.post('/api/enhance', express.raw({ type: ['image/png', 'image/jpeg'], limit: '12mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Unsupported image' });
  const model = req.query.model === 'best' ? 'best' : 'fast';
  const scale = Math.min(4, Math.max(2, parseInt(req.query.scale, 10) || 4));
  const r = await upscaler(res, `/jobs?model=${model}&scale=${scale}`, { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] }, body: req.body });
  if (r) await passJson(res, r);
});
app.get('/api/enhance/:id', async (req, res) => {
  if (!JOB_ID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const r = await upscaler(res, '/jobs/' + req.params.id);
  if (r) await passJson(res, r);
});
app.get('/api/enhance/:id/result', async (req, res) => {
  if (!JOB_ID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const r = await upscaler(res, `/jobs/${req.params.id}/result`);
  if (!r) return;
  if (!r.ok) return res.status(502).json({ error: 'Enhanced image not available' });
  res.type('image/png').send(Buffer.from(await r.arrayBuffer()));
});
app.delete('/api/enhance/:id', async (req, res) => {
  if (!JOB_ID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const r = await upscaler(res, '/jobs/' + req.params.id, { method: 'DELETE' });
  if (r) await passJson(res, r);
});

app.post('/api/ntfy/test', async (req, res) => {
  const r = await ntfy('Slam Tracker', 'Test notification - ntfy is working.', 3, ['white_check_mark']);
  r.ok ? res.json({ ok: true }) : res.status(400).json({ error: r.error });
});
app.use((err, req, res, next) => res.status(400).json({ error: err.message }));

// ---------- ntfy reminders ----------
async function ntfy(title, message, priority = 3, tags = []) {
  if (!NTFY_TOPIC) return { ok: false, error: 'NTFY_TOPIC is not set' };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (NTFY_TOKEN) headers.Authorization = 'Bearer ' + NTFY_TOKEN;
    const r = await fetch(NTFY_SERVER, { method: 'POST', headers, body: JSON.stringify({ topic: NTFY_TOPIC, title, message, priority, tags }) });
    return r.ok ? { ok: true } : { ok: false, error: `ntfy responded ${r.status}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Runs every minute; once NOTIFY_TIME has passed each day, sends anything due that hasn't been sent yet.
async function runNotifications() {
  if (!NTFY_TOPIC) return;
  const now = D.nowParts(TZ);
  const [h, m] = NOTIFY_TIME.split(':').map(Number);
  if (now.hour * 60 + now.minute < h * 60 + m) return;
  let changed = false;
  for (const s of db.sets) {
    if (D.isExpired(s, now.date) || D.progress(s).complete) continue;
    let kind = null, title, msg, prio = 3, tags;
    if (s.type === 'weekly') {
      const slot = s.slots.find(x => x.date === now.date);
      if (!slot || s.items.every(i => D.itemMissing(s, i, now.date) === 0)) continue; // no drop today, or already caught up
      kind = 'release'; title = `${s.name}: new card today`; msg = "This week's card is available today.";
      prio = 4; tags = ['tada'];
    } else if (s.type === 'longterm') {
      const left = D.diffDays(now.date, s.endDate);
      if (left > 5) continue;
      kind = 'ending';
      const when = left === 0 ? 'ends today' : `ends in ${left} day${left > 1 ? 's' : ''}`;
      title = `${s.name} ${when}`; msg = `You're missing: ${D.missing(s).join(', ')}`;
      prio = left <= 1 ? 4 : 3; tags = ['hourglass_flowing_sand'];
    }
    if (!kind) continue;
    const key = `${s.id}:${now.date}:${kind}`;
    if (db.notified[key]) continue;
    const r = await ntfy(title, msg, prio, tags);
    if (r.ok) { db.notified[key] = true; changed = true; } else console.error('ntfy failed:', r.error);
  }
  const cutoff = D.addDays(now.date, -30);
  for (const k of Object.keys(db.notified)) if (k.split(':')[1] < cutoff) { delete db.notified[k]; changed = true; }
  if (changed) save();
}
setInterval(() => runNotifications().catch(e => console.error(e)), 60000);
pruneExpired();
setInterval(() => { try { pruneExpired(); } catch (e) { console.error(e); } }, 10 * 60000);
setTimeout(() => runNotifications().catch(e => console.error(e)), 5000);

app.listen(PORT, '0.0.0.0', () => console.log(`Slam Tracker on :${PORT} (tz ${TZ}, data ${DATA_DIR}, ntfy ${NTFY_TOPIC ? 'on' : 'off'}, enhance ${UPSCALER_URL ? 'on' : 'off'}, keep expired ${KEEP_EXPIRED < 0 ? 'all' : KEEP_EXPIRED})`));
