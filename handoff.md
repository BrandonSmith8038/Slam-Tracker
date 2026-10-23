# Slam Tracker - Handoff

Last updated: 2026-10-22 (version 0.3.0 - second round of user feedback applied)

## What it does
LAN-only web dashboard (Docker on Unraid) for tracking progress in the Topps Slam trading card game. The user creates a "set" when it is released, chooses which rarity levels/variations to chase, and logs cards as they are collected. The dashboard shows Active sets (soonest end first) and Expired sets (muted, read-only), with progress bars, countdowns, and ntfy reminders. Used only on a 27" 1440p desktop monitor; no login, no mobile layout.

Game rules that drive the design: levels are Uncommon, Rare, Super Rare, Iconic, Legendary; levels can have variations (e.g. Rare Chrome Green); card counts per set are arbitrary; cards can be traded; every set has an end date; some sets drop one card per day or per week that is only obtainable during that day/week.

## Stack
Node 20 + Express 4 (only dependency), vanilla HTML/CSS/JS front end (no build step), JSON file storage. Docker (`node:20-alpine`). Node's built-in `fetch` is used for ntfy (Node >= 18).

## Structure
- `server.js` - Express app: JSON store (atomic writes), validation (`cleanSet`), REST API, image upload, ntfy scheduler
- `public/dates.js` - shared (server `require` + browser `<script>`) logic: timezone-aware "now", date math, drop-slot generation, missing/remaining calculations, progress. **Single source of truth for these rules.**
- `public/index.html`, `style.css`, `app.js` - dashboard, set form modal, image cropper modal, toasts
- `Dockerfile`, `docker-compose.yml` (host port 8187 -> container 3000), `.dockerignore`, `.gitignore`, `package.json`, `package-lock.json`, `README.md`, `handoff.md`

## Data model (`DATA_DIR/data.json`)
```
{ sets: [ { id, name, type: 'longterm'|'weekly'|'daily', startDate|null, endDate 'YYYY-MM-DD',
            releaseDay 0-6|null (weekly), cover '/images/<uuid>.jpg'|'', createdAt,
            items: [ { id, level, variation ('' if none), total, owned } ],
            slots: [ { date } ]   // daily/weekly only: one per drop, built from startDate (+ releaseDay)
          } ],
  notified: { '<setId>:<date>:<release|ending>': true }  // pruned after 30 days
}
```
Long-term: `endDate` is user-entered. Daily/weekly: the user enters a start date (and release weekday for weekly); the number of drops equals the largest `total` among the set's items (a 12-card set runs 12 weeks) and `endDate` is derived (daily: last drop date; weekly: last drop + 6 days). Older records may still contain `got` on slots; it is ignored. A corrupt `data.json` is renamed to `data.json.corrupt-<ts>` on startup rather than overwritten.

## API
`GET /api/state`; `POST /api/sets`; `PUT /api/sets/:id`; `POST /api/sets/:id/items/:itemId` ({delta} or {value}); `POST /api/upload` (raw png/jpeg/webp body); `POST /api/ntfy/test`. Item route returns the updated set. Expired sets reject edits/progress with 403.

## How components interact
The browser loads `/api/state` (refreshes every 60s and on tab focus), renders everything client-side with `dates.js`, and posts small changes. The cover is cropped in the browser (canvas) and uploaded as a JPEG only when the set form is saved. The server's scheduler (every 60s) uses the same `dates.js` helpers to decide which ntfy messages are due.

## Key decisions / behavior
- Expiry: a set is expired when today (in `TZ`) is after its `endDate`. Default TZ `America/Phoenix`.
- Progress counts unique cards per chased level/variation (no per-card tracking). Overall = completed bars / chased bars. Every set must chase at least one level.
- Daily/weekly sets: the drops ARE the cards of the chased level/variation (there is no separate drop bar or per-drop chips). Cards you should have by now = drops released so far (capped at the item total); if owned is lower a red "N missing" badge (sum across items; tooltip lists which) shows in the card's top-right corner and the behind rows get a reddish label. The card shows "X weeks/days remaining" (drops whose availability window hasn't closed; daily window = that day, weekly = release day + 6) instead of an end date.
- Start date is kept for daily/weekly so a set added late can be backdated to when the first card dropped.
- Look: portrait trading-card cards (`aspect-ratio: 5/7`, cover flexes to fill, card grows if many bars). The 25% size reduction is done with `zoom: .75` on `.grid` (works in Firefox 126+/Chromium). Page background is an inline-SVG diamond-plate tile (see `body` in `style.css`). Cropper default is 1:1.
- Weekly release-day highlight (red glow + badge "NEW CARD TODAY", or "Collected today" if caught up) shows only on the release date.
- ntfy: weekly -> on release day if behind on any chased item and set incomplete; long-term -> daily from 5 days before the end date through the end date listing missing cards, skipped if complete; daily -> none. Sent once per day after `NOTIFY_TIME`; only logged as sent if ntfy accepted it. Uses ntfy's JSON publish API.
- Level colors: Uncommon green, Rare blue, Super Rare purple, Iconic red, Legendary gold. Completed bars use a different, muted green with a checkmark.
- Editing: item ids are preserved so progress survives edits; removing a level/variation deletes its progress. Saving a daily/weekly set recalculates slots and `endDate` from start/count.
- Expired sets are read-only, cannot be deleted or edited (Duplicate is allowed).

## Verified (sandbox, by Claude, 2026-10-22; re-run after the 0.2.0 changes)
- JS syntax checks pass; `npm install` works
- API: long-term/weekly/daily creation (slots and derived end dates correct), validation errors (missing start date, no levels), +1 clamped at item total, expired sets return 403, image upload/retrieval (from the 0.1.0 run)
- ntfy against a local fake server: long-term (2 days left) and weekly release-day notifications sent
- Headless DOM (jsdom) of the real front end: cards show "N weeks/days remaining", the "N missing" badge in the top-right badge row (none inside bars), release highlight badge; weekly edit form has start/release day but no end date or count field; creating a daily set through the form works; no JS errors

## NOT verified
- Visual appearance of the 0.3.0 layout in a real browser: portrait card shape, `zoom` scaling, diamond-plate texture strength (jsdom has no layout/CSS rendering)
- Image cropper behavior (jsdom cannot exercise it; the user did upload and crop a cover successfully in 0.1.0)
- Real ntfy delivery, behavior across a real day rollover or container restart
- User acceptance of the 0.2.0 and 0.3.0 changes

## Known limitations / unfinished
- Weekly notification only knows if the user is behind overall, not specifically whether this week's card was collected
- Covers cropped for 0.1.0/0.2.0 (5:2) get center-cropped on the new portrait cards; re-crop via Edit > Replace
- Saving an existing weekly set recalculates its end date (last drop + 6 days), which may differ from a previously typed end date
- Replaced covers are not deleted from `images/` (orphans accumulate)
- No delete, no editing of expired sets (by design); a mistyped past end date can only be fixed by duplicating
- No per-card tracking, no auth, no snooze/quiet hours

## Modifying safely
- Keep rule logic (expiry, drops remaining/missing, progress) in `public/dates.js` so server notifications and the UI stay consistent
- Preserve item `id`s when editing sets (`cleanSet` matches by id) or progress is lost
- Don't change the `data.json` shape without a migration in `load()`; the user's data lives there
- All writes go through `save()` (atomic rename)
- Front end has no build step; escape user text with `esc()` before putting it in HTML

## Next planned tasks
None defined yet; the user is testing 0.3.0 and sending feedback. Likely candidates: cleanup of orphaned images, delete/archive for expired sets.
