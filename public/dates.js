// Shared by server (require) and browser (<script>). Dates are 'YYYY-MM-DD' strings.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SlamDates = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const label = i => i.level + (i.variation ? ' ' + i.variation : '');
  // Wall-clock parts in `tz` at the instant `ms` (epoch milliseconds)
  function partsAt(ms, tz) {
    const p = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
    return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24, minute: +p.minute };
  }
  const nowParts = tz => partsAt(Date.now(), tz);
  const utc = d => { const [y, m, n] = d.split('-').map(Number); return Date.UTC(y, m - 1, n); };
  const diffDays = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);
  const addDays = (d, n) => new Date(utc(d) + n * 864e5).toISOString().slice(0, 10);
  const weekday = d => new Date(utc(d)).getUTCDay();
  // Long-term sets saved with an exact end instant (endAt, epoch ms) expire at that moment. Everything else
  // (daily/weekly, and long-term sets saved before endAt existed) expires after the end date's day is over.
  const isExpired = (s, today) => s.endAt ? Date.now() >= s.endAt : today > s.endDate;
  const minutesLeft = (s, now) => s.endAt ? Math.max(0, Math.ceil((s.endAt - Date.now()) / 60000)) : diffDays(now.date, s.endDate) * 1440 + 1440 - (now.hour * 60 + now.minute);

  // Drops: `count` slots starting at the start date (weekly: first matching weekday on/after it)
  function buildSlots(type, start, count, releaseDay) {
    let d = start;
    if (type === 'weekly') while (weekday(d) !== releaseDay) d = addDays(d, 1);
    const out = [];
    for (let i = 0; i < count; i++) { out.push({ date: d }); d = addDays(d, type === 'weekly' ? 7 : 1); }
    return out;
  }
  // A weekly card stays available for 6 days after release, so the set ends then.
  const endDateFor = (type, slots) => { const last = slots[slots.length - 1].date; return type === 'weekly' ? addDays(last, 6) : last; };
  function windowEnd(set, slot) {
    if (set.type === 'daily') return slot.date;
    const e = addDays(slot.date, 6);
    return e > set.endDate ? set.endDate : e;
  }
  // Drops go live at DROP_HOUR (11:00 in the app's timezone), not at midnight. Before then, today's drop hasn't happened yet.
  const DROP_HOUR = 11;
  let curTz = 'America/Phoenix'; // remembered by nowParts(), so server and browser both use the configured TZ
  const dropLive = today => { const n = partsAt(Date.now(), curTz); return today !== n.date || n.hour >= DROP_HOUR; };
  const dropDate = today => dropLive(today) ? today : addDays(today, -1);
  const todaySlot = (set, today) => dropLive(today) ? set.slots.find(s => s.date === today) : undefined;
  const released = (set, today) => set.type === 'longterm' ? 0 : set.slots.filter(s => s.date <= dropDate(today)).length;
  // Cards released per drop (daily/weekly sets); older sets have no perDrop and drop one card at a time
  const perDrop = set => set.perDrop || 1;
  // Cards you should have by now for a chased item in a daily/weekly set (perDrop per released drop) minus what you own
  const itemMissing = (set, item, today) => set.type === 'longterm' ? 0 : Math.max(0, Math.min(item.total, released(set, today) * perDrop(set)) - item.owned);
  const remaining = (set, today) => set.slots.filter(s => windowEnd(set, s) >= today).length;
  // Each chased level/variation is one bar; overall = completed bars / bars.
  function progress(set) {
    const done = set.items.filter(i => i.total > 0 && i.owned >= i.total).length;
    return { done, total: set.items.length, complete: set.items.length > 0 && done === set.items.length };
  }
  const missing = set => set.items.filter(i => i.owned < i.total).map(i => `${label(i)} (${i.total - i.owned} more)`);
  // The instant a set counts as ended: its exact endAt, or the start of the day after endDate in `tz`
  function startOfDayMs(date, tz) {
    const want = utc(date); let t = want;
    for (let i = 0; i < 3; i++) { const p = partsAt(t, tz); t -= utc(p.date) + (p.hour * 60 + p.minute) * 60000 - want; }
    return t;
  }
  const endedAtMs = (s, tz) => s.endAt || startOfDayMs(addDays(s.endDate, 1), tz);
  // Ended sets stay in Active (greyed out) for one more day, then count as archived (Expired section)
  const isArchived = (s, tz) => Date.now() >= endedAtMs(s, tz) + 864e5;
  const nowPartsTz = tz => { curTz = tz; return nowParts(tz); }; // also remembers the timezone for the drop-time helpers
  return { label, partsAt, nowParts: nowPartsTz, diffDays, addDays, weekday, isExpired, minutesLeft, buildSlots, endDateFor, released, perDrop, itemMissing, remaining, progress, missing, endedAtMs, isArchived, todaySlot, DROP_HOUR };
});
