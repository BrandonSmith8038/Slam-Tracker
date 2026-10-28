const D = SlamDates;
const LEVELS = ['Uncommon', 'Rare', 'Super Rare', 'Iconic', 'Legendary'];
const COLORS = { Uncommon: '#76ad5b', Rare: '#4b86c4', 'Super Rare': '#9366c9', Iconic: '#c2453c', Legendary: '#c9973a' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TYPES = { longterm: 'Long-term', weekly: 'Weekly drops', daily: 'Daily drops' };
const ICON = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  dup: ICON('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  edit: ICON('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>')
};
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dt = d => new Date(d + 'T12:00:00');
const fmt = d => dt(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const fmtMD = d => dt(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtLeft = m => { const d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60); return d ? `${d}d ${h}h left` : `${h}h ${m % 60}m left`; };

let state = { sets: [], tz: 'America/Phoenix', ntfy: {}, enhance: false }, now = null, formOpen = false, F = null, enhMode = 'fast';
let stacked = false; try { stacked = localStorage.getItem('slamStacked') === '1'; } catch {} // collapsed (stacked) view of the Active section

async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
let toastT;
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, 2600);
}

// ---------- dashboard ----------
async function load() { state = await api('/api/state'); render(); }

function bar(label, color, owned, total, ctl, cls = '', miss = 0) {
  if (miss) cls += ' behind';
  const done = total > 0 && owned >= total;
  const pct = total ? Math.min(100, owned / total * 100) : 0;
  return `<div class="row ${cls} ${done ? 'done' : ''}"><div class="lbl" title="${esc(label)}">${color ? `<i style="background:${color}"></i>` : ''}${esc(label)}</div>
    <div class="bar"><div class="fill" style="width:${pct}%;${done || !color ? '' : 'background:' + color}"></div><span class="num">${done ? '✓ ' : ''}${owned}/${total}</span></div>${ctl}</div>`;
}

function card(s, expired) {
  const prog = D.progress(s), mins = D.minutesLeft(s, now), timed = s.type !== 'longterm', weekly = s.type === 'weekly';
  const urgent = !expired && !prog.complete && mins < 1440;
  const rel = !expired && timed ? D.todaySlot(s, now.date) || null : null;
  const caughtUp = s.items.every(i => D.itemMissing(s, i, now.date) === 0);
  const grace = expired && !D.isArchived(s, state.tz); // ended under a day ago: stays in Active, greyed and tinted
  const cls = ['card', expired && !grace && 'expired', grace && 'grace', grace && (prog.complete ? 'gdone' : 'gmiss'), prog.complete && !grace && 'complete', urgent && 'urgent'].filter(Boolean).join(' ');
  let meta;
  if (grace) { const m = Math.floor((Date.now() - D.endedAtMs(s, state.tz)) / 60000); meta = `Ended ${m < 1 ? '<1m' : m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + m % 60 + 'm'} ago`; }
  else if (expired) meta = `Ended ${fmt(s.endDate)}`;
  else if (timed) { const n = D.remaining(s, now.date); meta = `${n} ${weekly ? 'week' : 'day'}${n === 1 ? '' : 's'} remaining`; }
  else meta = `Ends ${fmt(s.endDate)} · ${fmtLeft(mins)}`;
  const ctl = id => expired ? '<div></div>' : `<div class="ctl"><button data-act="dec" data-set="${s.id}" data-item="${id}">−</button><button data-act="inc" data-set="${s.id}" data-item="${id}">+</button></div>`;
  const rows = bar('Overall', '', prog.done, prog.total, '<div></div>', 'overall') +
    s.items.map(i => bar(i.level + (i.variation ? ' · ' + i.variation : ''), COLORS[i.level], i.owned, i.total, ctl(i.id), '', D.itemMissing(s, i, now.date))).join('');
  const behind = s.items.reduce((n, i) => n + D.itemMissing(s, i, now.date), 0);
  const tip = s.items.filter(i => D.itemMissing(s, i, now.date)).map(i => `${i.level}${i.variation ? ' ' + i.variation : ''}: ${D.itemMissing(s, i, now.date)}`).join(', ');
  const right = (prog.complete ? '<span class="badge ok">✓ Complete</span>' : rel ? `<span class="badge ${caughtUp ? 'ok' : 'rel'}">${caughtUp ? 'Collected today ✓' : 'NEW CARD TODAY'}</span>` : '') +
    (behind ? `<span class="badge miss" title="${esc(tip)}">${behind} missing</span>` : '');
  const badges = `<span class="badge">${TYPES[s.type].replace(' drops', '')}<span class="xtra">${s.type !== 'longterm' ? ' drops' : ''}${weekly ? ' · ' + DAYS[s.releaseDay] + 's' : ''}</span></span><div class="rb">${right}</div>`;
  return `<article class="${cls}" data-id="${s.id}"><div class="cover" ${s.cover ? `style="background-image:url('${esc(s.cover)}')"` : ''}>
    <div class="badges">${badges}</div><div class="ttl"><h3>${esc(s.name)}</h3><div class="meta ${urgent ? 'hot' : ''}">${meta}</div></div></div>
    <div class="rows">${rows}</div>
    <div class="foot"><button class="btn sm icon" data-act="dup" data-set="${s.id}" title="Duplicate" aria-label="Duplicate">${ICONS.dup}</button>${expired ? '' : `<button class="btn sm icon" data-act="edit" data-set="${s.id}" title="Edit" aria-label="Edit">${ICONS.edit}</button>`}</div></article>`;
}

function render() {
  now = D.nowParts(state.tz);
  const archived = s => D.isArchived(s, state.tz), ended = s => D.isExpired(s, now.date);
  const dropToday = s => s.type === 'weekly' && !ended(s) && !!D.todaySlot(s, now.date); // weekly set whose card is live today (after drop time)
  const active = state.sets.filter(s => !archived(s)).sort((a, b) => ended(a) - ended(b) || dropToday(b) - dropToday(a) || a.endDate.localeCompare(b.endDate) || a.name.localeCompare(b.name)); // grace-period sets sort last; new-card-today sets sort first
  const expired = state.sets.filter(archived).sort((a, b) => b.endDate.localeCompare(a.endDate));
  const live = active.filter(s => !ended(s));
  const todo = live.filter(s => !D.progress(s).complete);
  const soon = todo.filter(s => D.minutesLeft(s, now) < 3 * 1440).length;
  $('#stats').innerHTML = [['Running', live.length, ''], ['Need to finish', todo.length, ''], ['Completed', live.length - todo.length, 'ok'], ['Ending ≤ 3 days', soon, soon ? 'hot' : '']]
    .map(([l, n, c]) => `<div class="stat ${c}"><b>${n}</b><span>${l}</span></div>`).join('');
  $('#activeCount').textContent = active.length; $('#expiredCount').textContent = expired.length;
  $('#active').innerHTML = active.map(s => card(s, ended(s))).join('') || '<div class="empty">No active sets. Click “+ New Set” to add one.</div>';
  $('#expired').innerHTML = expired.map(s => card(s, true)).join('') || '<div class="empty">Nothing expired yet.</div>';
  const act = $('#active'), cards = [...act.querySelectorAll('.card')];
  act.classList.toggle('stack', stacked);
  act.style.setProperty('--n', cards.length);
  cards.forEach((c, i) => c.style.setProperty('--i', i)); // stack order: first (soonest) card on top
  $('#stackToggle').textContent = stacked ? 'Expand' : 'Collapse';
  reapplyTilt();
}
const find = id => state.sets.find(s => s.id === id);
function replace(set) { state.sets[state.sets.findIndex(s => s.id === set.id)] = set; render(); }

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const { act, set: id } = b.dataset;
  try {
    if (act === 'inc' || act === 'dec') replace(await api(`/api/sets/${id}/items/${b.dataset.item}`, 'POST', { delta: act === 'inc' ? 1 : -1 }));
    else if (act === 'edit') openForm(find(id), 'edit');
    else if (act === 'dup') openForm(find(id), 'dup');
  } catch (err) { toast(err.message, true); load(); }
});
$('#newSet').onclick = () => openForm(null, 'new');
$('#stackToggle').onclick = () => {
  const ZOOM = .75; // must match `zoom` on .grid in style.css
  const first = new Map([...document.querySelectorAll('#active .card')].map(c => [c.dataset.id, c.getBoundingClientRect()])); // where each card is now
  stacked = !stacked; try { localStorage.setItem('slamStacked', stacked ? '1' : '0'); } catch {}
  render();
  if (calm.matches) return; // reduced motion: just snap
  document.querySelectorAll('#active .card').forEach(c => { // FLIP: start each card at its old spot/size, glide to the new one
    const a = first.get(c.dataset.id); if (!a) return;
    const b = c.getBoundingClientRect(), k = a.width / b.width;
    c.animate([
      { transformOrigin: '0 0', transform: `translate(${(a.left - b.left) / ZOOM}px, ${(a.top - b.top) / ZOOM}px) scale(${k})` },
      { transformOrigin: '0 0', transform: 'none' }
    ], { duration: 450, easing: 'cubic-bezier(.2,.8,.2,1)' });
  });
};
$('#testNtfy').onclick = async () => {
  try { await api('/api/ntfy/test', 'POST', {}); toast('Test notification sent'); } catch (e) { toast(e.message, true); }
};

// ---------- set form ----------
function openForm(set, mode) {
  formOpen = true;
  const levels = {};
  LEVELS.forEach(l => { levels[l] = { on: false, total: '', id: null, vars: [] }; });
  if (set) set.items.forEach(i => {
    const L = levels[i.level], id = mode === 'edit' ? i.id : null;
    L.on = true;
    if (i.variation) L.vars.push({ id, name: i.variation, total: i.total }); else { L.total = i.total; L.id = id; }
  });
  F = {
    mode, id: mode === 'edit' ? set.id : null, name: set ? (mode === 'dup' ? set.name + ' (copy)' : set.name) : '',
    type: set ? set.type : 'longterm', startDate: mode === 'edit' && set.startDate ? set.startDate : now.date,
    daysLeft: mode === 'edit' ? Math.floor(D.minutesLeft(set, now) / 1440) : '', hoursLeft: mode === 'edit' ? Math.floor(D.minutesLeft(set, now) % 1440 / 60) : '', origType: mode === 'edit' ? set.type : null, releaseDay: set && set.releaseDay != null ? set.releaseDay : 1,
    perDrop: set && set.perDrop ? set.perDrop : 1,
    levels, cover: set ? set.cover : '', preview: set ? set.cover : '', blob: null
  };
  F.origDays = F.daysLeft; F.origHours = F.hoursLeft;
  drawForm();
}
function closeForm() {
  if (F && F.preview.startsWith('blob:')) URL.revokeObjectURL(F.preview);
  formOpen = false; F = null; $('#modal').classList.add('hidden'); $('#modal').innerHTML = '';
}
function syncForm() {
  const m = $('#modal'); if (!F || !$('#f-name', m)) return;
  F.name = $('#f-name', m).value;
  if ($('#f-days', m)) F.daysLeft = $('#f-days', m).value;
  if ($('#f-hours', m)) F.hoursLeft = $('#f-hours', m).value;
  if ($('#f-start', m)) F.startDate = $('#f-start', m).value;
  if ($('#f-per', m)) F.perDrop = $('#f-per', m).value;
  if ($('#f-rel', m)) F.releaseDay = +$('#f-rel', m).value;
  m.querySelectorAll('[data-total]').forEach(i => { F.levels[i.dataset.total].total = i.value; });
  m.querySelectorAll('[data-vname]').forEach(i => { const [l, n] = i.dataset.vname.split(':'); F.levels[l].vars[n].name = i.value; });
  m.querySelectorAll('[data-vtotal]').forEach(i => { const [l, n] = i.dataset.vtotal.split(':'); F.levels[l].vars[n].total = i.value; });
}
function drawForm() {
  const lv = LEVELS.map(l => {
    const L = F.levels[l]; let body = '';
    if (L.on) body = L.vars.length
      ? `<div class="vars">${L.vars.map((v, i) => `<div class="var"><input placeholder="Variation (e.g. Chrome Green)" maxlength="60" data-vname="${l}:${i}" value="${esc(v.name)}"><input type="number" min="1" placeholder="Cards" data-vtotal="${l}:${i}" value="${esc(v.total)}"><button type="button" class="x" data-f="delvar" data-v="${l}:${i}">✕</button></div>`).join('')}<button type="button" class="btn sm" data-f="addvar" data-v="${l}">+ Add variation</button></div>`
      : `<div class="var"><input type="number" min="1" placeholder="Cards in set" data-total="${l}" value="${esc(L.total)}"><button type="button" class="btn sm" data-f="addvar" data-v="${l}">+ Add variations</button></div>`;
    return `<div class="lvl ${L.on ? 'on' : ''}"><label class="lh"><input type="checkbox" data-lvl="${l}" ${L.on ? 'checked' : ''}><i style="background:${COLORS[l]}"></i>${l}</label>${body}</div>`;
  }).join('');
  $('#modal').innerHTML = `<div class="dialog"><h2>${F.mode === 'edit' ? 'Edit set' : F.mode === 'dup' ? 'New set (copied)' : 'New set'}</h2>
    <label class="fld">Set name<input id="f-name" maxlength="100" placeholder="e.g. Royal Rumble" value="${esc(F.name)}"></label>
    <div class="fld"><span>Set type</span><div class="seg">${Object.keys(TYPES).map(k => `<button type="button" class="${F.type === k ? 'on' : ''}" data-f="type" data-v="${k}">${TYPES[k]}</button>`).join('')}</div></div>
    <div class="dates">
      ${F.type !== 'longterm' ? `<label class="fld">Starts<input type="date" id="f-start" value="${F.startDate}"></label><label class="fld">Cards per drop<input type="number" min="1" max="20" id="f-per" value="${esc(F.perDrop)}"></label>` : ''}
      ${F.type === 'weekly' ? `<label class="fld">Release day<select id="f-rel">${DAYS.map((d, i) => `<option value="${i}" ${F.releaseDay === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>` : ''}
      ${F.type === 'longterm' ? `<label class="fld">Days remaining<input type="number" min="0" max="3650" id="f-days" placeholder="e.g. 4" value="${esc(F.daysLeft)}"></label><label class="fld">Hours remaining<input type="number" min="0" max="23" id="f-hours" placeholder="e.g. 3" value="${esc(F.hoursLeft)}"></label>` : ''}
    </div>
    ${F.type === 'longterm' ? `<p class="hint">Enter the time left exactly as the game shows it, for example 4 days 3 hours. The set expires at that exact moment.</p>` : ''}
    ${F.type !== 'longterm' ? `<p class="hint">Runs one ${F.type === 'weekly' ? 'week' : 'day'} per drop. The biggest card total below divided by cards per drop sets the length (14 cards at 2 per drop = 7 ${F.type === 'weekly' ? 'weeks' : 'days'}). If you're adding this late, set Starts to the date the first card dropped.</p>` : ''}
    <div class="fld"><span>Cover image</span><div class="cov"><div class="covprev" style="${F.preview ? `background-image:url('${F.preview}')` : ''}"></div><button type="button" class="btn" data-f="pick">${F.preview ? 'Replace…' : 'Upload…'}</button><input type="file" id="f-file" accept="image/*" hidden></div></div>
    <div class="fld"><span>Levels to chase</span>${lv}</div>
    <div class="err" id="f-err"></div>
    <div class="dlg-actions">${F.mode === 'edit' ? `<button type="button" class="btn danger" data-f="delete">${F.confirmDel ? 'Click again to delete for good' : 'Delete set'}</button>` : ''}<button type="button" class="btn" data-f="cancel">Cancel</button><button type="button" class="btn primary" data-f="save">Save set</button></div></div>`;
  $('#modal').classList.remove('hidden');
}
$('#modal').addEventListener('click', async e => {
  const t = e.target.closest('[data-f]'); if (!t || !F) return;
  syncForm();
  const k = t.dataset.f, v = t.dataset.v;
  if (k === 'type') { F.type = v; drawForm(); }
  else if (k === 'addvar') {
    const L = F.levels[v];
    if (!L.vars.length) { L.vars.push({ id: L.id, name: '', total: L.total }); L.id = null; L.total = ''; }
    else L.vars.push({ id: null, name: '', total: '' });
    drawForm();
  } else if (k === 'delvar') {
    const [l, n] = v.split(':'), L = F.levels[l], [rem] = L.vars.splice(+n, 1);
    if (!L.vars.length) { L.id = rem.id; L.total = rem.total; }
    drawForm();
  } else if (k === 'pick') $('#f-file').click();
  else if (k === 'cancel') closeForm();
  else if (k === 'save') saveForm();
  else if (k === 'delete') {
    if (!F.confirmDel) { F.confirmDel = true; drawForm(); return; } // first click arms it, second deletes
    try { await api('/api/sets/' + F.id, 'DELETE'); closeForm(); await load(); toast('Set deleted'); }
    catch (err) { F.confirmDel = false; drawForm(); $('#f-err').textContent = err.message; }
  }
});
$('#modal').addEventListener('change', async e => {
  if (!F) return;
  if (e.target.dataset.lvl) { syncForm(); F.levels[e.target.dataset.lvl].on = e.target.checked; drawForm(); }
  else if (e.target.id === 'f-file' && e.target.files[0]) {
    syncForm();
    const blob = await openCropper(e.target.files[0]);
    if (blob) { if (F.preview.startsWith('blob:')) URL.revokeObjectURL(F.preview); F.blob = blob; F.preview = URL.createObjectURL(blob); }
    drawForm();
  }
});
async function saveForm() {
  syncForm();
  const err = $('#f-err'); err.textContent = '';
  const items = [];
  for (const l of LEVELS) {
    const L = F.levels[l]; if (!L.on) continue;
    if (L.vars.some(v => !v.name.trim())) { err.textContent = `Name every ${l} variation`; return; }
    if (L.vars.length) L.vars.forEach(v => items.push({ id: v.id, level: l, variation: v.name, total: v.total }));
    else items.push({ id: L.id, level: l, variation: '', total: L.total });
  }
  try {
    let cover = F.cover;
    if (F.blob) {
      const r = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': F.blob.type }, body: F.blob });
      const j = await r.json(); if (!r.ok) throw new Error(j.error); cover = j.path;
    }
    const body = { name: F.name, type: F.type, startDate: F.startDate, daysLeft: F.daysLeft, hoursLeft: F.hoursLeft, keepEnd: !!(F.id && F.type === 'longterm' && F.origType === 'longterm' && String(F.daysLeft) === String(F.origDays) && String(F.hoursLeft) === String(F.origHours)), perDrop: F.perDrop, releaseDay: F.releaseDay, cover, items };
    await (F.id ? api('/api/sets/' + F.id, 'PUT', body) : api('/api/sets', 'POST', body));
    closeForm(); await load(); toast('Set saved');
  } catch (e) { err.textContent = e.message; }
}

// ---------- cover enhancement (optional upscaler container) ----------
const ENH_MAX_INPUT = 900; // crops with a longer side than this are already big enough; skip enhancing
const toBlob = (canvas, type, q) => new Promise(res => canvas.toBlob(res, type, q));
// Sends the crop to the upscaler, polls until done, returns the enhanced PNG blob. ctl = { cancel, id }.
async function enhanceCanvas(c, mode, ctl, onPct) {
  const long = Math.max(c.width, c.height);
  const scale = mode === 'best' ? 4 : Math.min(4, Math.max(2, Math.ceil(1000 / long)));
  const r = await fetch(`/api/enhance?model=${mode}&scale=${scale}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await toBlob(c, 'image/png') });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Enhance failed');
  ctl.id = j.id;
  if (ctl.cancel) { api('/api/enhance/' + j.id, 'DELETE').catch(() => {}); throw new Error('cancelled'); }
  for (;;) {
    await new Promise(res => setTimeout(res, 1200));
    if (ctl.cancel) throw new Error('cancelled');
    const s = await api('/api/enhance/' + j.id);
    if (s.status === 'error') throw new Error(s.error || 'Enhance failed');
    onPct(s.progress || 0);
    if (s.status === 'done') break;
  }
  const rr = await fetch(`/api/enhance/${j.id}/result`);
  if (!rr.ok) throw new Error('Could not fetch the enhanced image');
  return rr.blob();
}
async function shrinkToJpeg(blob, maxSide) {
  const bmp = await createImageBitmap(blob), s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, c.width, c.height);
  return toBlob(c, 'image/jpeg', .92);
}

// ---------- image cropper ----------
function openCropper(file) {
  return new Promise(resolve => {
    const ASPECTS = [['1:1 (matches cards)', 1], ['4:3', 4 / 3], ['16:9', 16 / 9], ['Free', null]];
    const ENH = [['none', 'Off'], ['fast', 'Fast (seconds)'], ['best', 'Best (minutes)']];
    const box = $('#modal2'), url = URL.createObjectURL(file);
    box.innerHTML = `<div class="dialog crop"><h2>Crop cover image</h2>
      <div class="aspects">${ASPECTS.map((a, i) => `<button type="button" class="btn sm ${i ? '' : 'on'}" data-i="${i}">${a[0]}</button>`).join('')}</div>
      ${state.enhance ? `<div class="aspects"><span class="hint">Enhance after crop:</span>${ENH.map(([k, l]) => `<button type="button" class="btn sm ${k === enhMode ? 'on' : ''}" data-e="${k}">${l}</button>`).join('')}</div>` : ''}
      <div class="stage"><img id="cimg" alt=""><div id="sel"><b data-h="nw"></b><b data-h="ne"></b><b data-h="sw"></b><b data-h="se"></b></div></div>
      <p class="hint">Drag the box to move it, drag the corner dots to resize.</p>
      <div class="dlg-actions"><button type="button" class="btn" id="c-cancel">Cancel</button><button type="button" class="btn primary" id="c-ok">Use crop</button></div></div>`;
    box.classList.remove('hidden');
    const img = $('#cimg', box), sel = $('#sel', box), clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    let W, H, ratio = ASPECTS[0][1], r = { x: 0, y: 0, w: 0, h: 0 }, drag = null;
    const draw = () => Object.assign(sel.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    function init() {
      if (ratio) { let w = W * .9, h = w / ratio; if (h > H * .9) { h = H * .9; w = h * ratio; } r = { w, h, x: (W - w) / 2, y: (H - h) / 2 }; }
      else r = { x: W * .05, y: H * .05, w: W * .9, h: H * .9 };
      draw();
    }
    img.onload = () => { W = img.clientWidth; H = img.clientHeight; init(); };
    img.src = url;
    box.querySelectorAll('[data-i]').forEach(b => b.onclick = () => {
      box.querySelectorAll('[data-i]').forEach(x => x.classList.remove('on')); b.classList.add('on');
      ratio = ASPECTS[b.dataset.i][1]; init();
    });
    box.querySelectorAll('[data-e]').forEach(b => b.onclick = () => {
      box.querySelectorAll('[data-e]').forEach(x => x.classList.remove('on')); b.classList.add('on');
      enhMode = b.dataset.e;
    });
    sel.onpointerdown = e => {
      e.preventDefault(); sel.setPointerCapture(e.pointerId);
      const h = e.target.dataset.h;
      drag = h ? { h, ax: h.includes('w') ? r.x + r.w : r.x, ay: h.includes('n') ? r.y + r.h : r.y } : { sx: e.clientX, sy: e.clientY, ox: r.x, oy: r.y };
    };
    sel.onpointermove = e => {
      if (!drag) return;
      if (!drag.h) { r.x = clamp(drag.ox + e.clientX - drag.sx, 0, W - r.w); r.y = clamp(drag.oy + e.clientY - drag.sy, 0, H - r.h); }
      else {
        const b = img.getBoundingClientRect(), px = clamp(e.clientX - b.left, 0, W), py = clamp(e.clientY - b.top, 0, H);
        let w = Math.abs(px - drag.ax), h = Math.abs(py - drag.ay);
        if (ratio) { if (w / Math.max(h, 1) > ratio) w = h * ratio; else h = w / ratio; }
        w = Math.max(w, 24); h = ratio ? w / ratio : Math.max(h, 24);
        r.w = w; r.h = h;
        r.x = clamp(px < drag.ax ? drag.ax - w : drag.ax, 0, W - w); r.y = clamp(py < drag.ay ? drag.ay - h : drag.ay, 0, H - h);
      }
      draw();
    };
    sel.onpointerup = () => { drag = null; };
    const done = blob => { box.classList.add('hidden'); box.innerHTML = ''; URL.revokeObjectURL(url); resolve(blob); };
    // the crop at native pixels (shrunk only if longer than maxSide)
    const grab = maxSide => {
      const k = img.naturalWidth / W, sw = r.w * k, sh = r.h * k, s = Math.min(1, maxSide / Math.max(sw, sh));
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(sw * s)); c.height = Math.max(1, Math.round(sh * s));
      c.getContext('2d').drawImage(img, r.x * k, r.y * k, sw, sh, 0, 0, c.width, c.height);
      return c;
    };
    $('#c-cancel', box).onclick = () => done(null);
    $('#c-ok', box).onclick = async () => {
      const plain = await toBlob(grab(1400), 'image/jpeg', .92), src = grab(2000);
      if (!state.enhance || enhMode === 'none') return done(plain);
      if (Math.max(src.width, src.height) >= ENH_MAX_INPUT) { toast('Crop is already high resolution - enhancement skipped'); return done(plain); }
      const ctl = { cancel: false, id: null };
      const shell = (inner, wire) => {
        box.innerHTML = `<div class="dialog crop"><h2>Enhance cover</h2>${inner}</div>`;
        Object.entries(wire || {}).forEach(([id, fn]) => { $('#' + id, box).onclick = fn; });
      };
      shell(`<p class="hint">Enhancing (${enhMode === 'best' ? 'best quality - this can take a few minutes' : 'fast'})…</p>
        <div class="bar eb"><div class="fill" id="e-fill" style="width:0%;background:var(--red)"></div><span class="num" id="e-pct">0%</span></div>
        <div class="dlg-actions"><button type="button" class="btn" id="e-cancel">Cancel</button></div>`,
        { 'e-cancel': () => { ctl.cancel = true; if (ctl.id) api('/api/enhance/' + ctl.id, 'DELETE').catch(() => {}); done(null); } });
      try {
        const out = await enhanceCanvas(src, enhMode, ctl, p => {
          const f = $('#e-fill', box); if (f) { f.style.width = p + '%'; $('#e-pct', box).textContent = Math.round(p) + '%'; }
        });
        const better = await shrinkToJpeg(out, 1400), after = URL.createObjectURL(better), before = src.toDataURL('image/png');
        const fin = blob => { URL.revokeObjectURL(after); done(blob); };
        shell(`<div class="cmp"><figure><img src="${before}" alt=""><figcaption>Original crop</figcaption></figure><figure><img src="${after}" alt=""><figcaption>Enhanced</figcaption></figure></div>
          <div class="dlg-actions"><button type="button" class="btn" id="e-no">Cancel</button><button type="button" class="btn" id="e-orig">Use original</button><button type="button" class="btn primary" id="e-use">Use enhanced</button></div>`,
          { 'e-no': () => fin(null), 'e-orig': () => fin(plain), 'e-use': () => fin(better) });
      } catch (e) {
        if (ctl.cancel) return;
        shell(`<p class="err">${esc(e.message)}</p><div class="dlg-actions"><button type="button" class="btn" id="e-no">Cancel</button><button type="button" class="btn primary" id="e-orig">Use original crop</button></div>`,
          { 'e-no': () => done(null), 'e-orig': () => done(plain) });
      }
    };
  });
}

// ---------- card tilt (live cards only; grace/expired stay flat) ----------
const calm = matchMedia('(prefers-reduced-motion: reduce)');
let tilt = null; // { id, rx, ry, mx, my } for the card under the pointer
const cardEl = id => $(`.card[data-id="${id}"]`);
const paintTilt = c => ['rx', 'ry', 'mx', 'my'].forEach(k => c.style.setProperty('--' + k, tilt[k]));
const clearTilt = c => ['rx', 'ry', 'mx', 'my'].forEach(k => c.style.removeProperty('--' + k));
function dropTilt() { if (tilt) { const o = cardEl(tilt.id); if (o) clearTilt(o); tilt = null; } }
function reapplyTilt() { if (!tilt) return; const c = cardEl(tilt.id); if (c) paintTilt(c); else tilt = null; } // render() rebuilds the cards
document.addEventListener('pointermove', e => {
  if (calm.matches || e.pointerType === 'touch') return;
  let c = e.target.closest ? e.target.closest('.card') : null;
  if (c && (c.classList.contains('grace') || c.classList.contains('expired'))) c = null;
  if (tilt && (!c || c.dataset.id !== tilt.id)) dropTilt();
  if (!c) return;
  const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  tilt = { id: c.dataset.id, rx: ((.5 - y) * 10).toFixed(2) + 'deg', ry: ((x - .5) * 10).toFixed(2) + 'deg', mx: (x * 100).toFixed(1) + '%', my: (y * 100).toFixed(1) + '%' };
  paintTilt(c);
});
document.documentElement.addEventListener('pointerleave', dropTilt);

load().catch(e => toast(e.message, true));
setInterval(() => { if (!formOpen) load().catch(() => {}); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !formOpen) load().catch(() => {}); });
