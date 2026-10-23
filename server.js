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

app.get('/api/state', (req, res) => res.json({ tz: TZ, ntfy: { configured: !!NTFY_TOPIC, notifyTime: NOTIFY_TIME }, sets: db.sets }));

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
setTimeout(() => runNotifications().catch(e => console.error(e)), 5000);

app.listen(PORT, '0.0.0.0', () => console.log(`Slam Tracker on :${PORT} (tz ${TZ}, data ${DATA_DIR}, ntfy ${NTFY_TOPIC ? 'on' : 'off'})`));
