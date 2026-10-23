// Shared by server (require) and browser (<script>). Dates are 'YYYY-MM-DD' strings.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SlamDates = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const label = i => i.level + (i.variation ? ' ' + i.variation : '');
  function nowParts(tz) {
    const p = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
    return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24, minute: +p.minute };
  }
  const utc = d => { const [y, m, n] = d.split('-').map(Number); return Date.UTC(y, m - 1, n); };
  const diffDays = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);
  const addDays = (d, n) => new Date(utc(d) + n * 864e5).toISOString().slice(0, 10);
  const weekday = d => new Date(utc(d)).getUTCDay();
  const isExpired = (s, today) => today > s.endDate; // expires after the end date's day is over
  const minutesLeft = (s, now) => diffDays(now.date, s.endDate) * 1440 + 1440 - (now.hour * 60 + now.minute);

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
  const released = (set, today) => set.type === 'longterm' ? 0 : set.slots.filter(s => s.date <= today).length;
  // Cards you should have by now for a chased item in a daily/weekly set (one per released drop) minus what you own
  const itemMissing = (set, item, today) => set.type === 'longterm' ? 0 : Math.max(0, Math.min(item.total, released(set, today)) - item.owned);
  const remaining = (set, today) => set.slots.filter(s => windowEnd(set, s) >= today).length;
  // Each chased level/variation is one bar; overall = completed bars / bars.
  function progress(set) {
    const done = set.items.filter(i => i.total > 0 && i.owned >= i.total).length;
    return { done, total: set.items.length, complete: set.items.length > 0 && done === set.items.length };
  }
  const missing = set => set.items.filter(i => i.owned < i.total).map(i => `${label(i)} (${i.total - i.owned} more)`);
  return { label, nowParts, diffDays, addDays, weekday, isExpired, minutesLeft, buildSlots, endDateFor, released, itemMissing, remaining, progress, missing };
});
