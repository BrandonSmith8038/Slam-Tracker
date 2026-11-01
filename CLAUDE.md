# Slam Tracker

LAN-only dashboard for tracking progress in the Topps Slam trading card game. The user creates a "set" when it is released, chooses which rarity levels/variations to chase, and logs cards as collected. Shows Active sets and Expired sets (muted, read-only) with progress bars, countdowns, and ntfy reminders. Port 8187 -> container 3000.

Game rules behind the design: levels are Uncommon, Rare, Super Rare, Iconic, Legendary; levels can have variations (e.g. Rare Chrome Green); card counts per set are arbitrary; every set has an end date; some sets drop cards per day or per week that are only obtainable during that day/week. Drops appear on the dashboard at 11:00 local time.

Look: dark, minimal; near-black, darker red, off-white (never pure black/white).

## Stack
Node 20 + Express 4 (only dependency), vanilla HTML/CSS/JS front end (no build step), JSON file storage, `node:20-alpine`. Uses modern CSS/JS: `zoom`, container query units (`cqw`), Web Animations API, `matchMedia`. Viewed in desktop Firefox on Windows.

Optional second container `upscaler/` (Enhance for cover images): `ubuntu:24.04` + distro `nodejs` + lavapipe software Vulkan + `realesrgan-ncnn-vulkan` v0.2.5.0 (downloaded at build). Not published to the LAN; only the app talks to it.

## Structure
- `server.js` - Express app: JSON store (atomic writes), validation (`cleanSet`), REST API, image upload, `/api/enhance*` proxy, ntfy scheduler, expired-set pruning
- `upscaler/server.js` + `upscaler/Dockerfile` - dependency-free job server wrapping Real-ESRGAN (one job at a time)
- `public/dates.js` - shared (server `require` + browser `<script>`): timezone-aware "now", date math, drop slots, drop-time helpers, missing/remaining, progress, ended/archived. **Single source of truth for these rules.**
- `public/index.html` - sticky header (stat tiles; buttons `#stackToggle`, `#testNtfy`, `#newSet`), grids `#active` / `#expired`, modal containers, toast
- `public/style.css` - all styling, including card effects and collapsed-stack rules (`#active.stack ...`)
- `public/app.js` - rendering, set form modal, cropper, enhance flow, toasts, card tilt, stack toggle + animation
- `docker-compose.yml` (services `slam-tracker` and `upscaler`), `.env.example`, `README.md`

No automated test suite. `node --check public/app.js` / `server.js` is the quick smoke check. `package.json` version (0.1.0) is stale and not synced with feature labels (current 0.5.2).

## Configuration
- ntfy `NTFY_SERVER` / `NTFY_TOPIC` / `NTFY_TOKEN` come from `.env`; compose uses `${NTFY_SERVER:-https://ntfy.sh}` etc. Notifications are off when `NTFY_TOPIC` is empty.
- Env vars on `slam-tracker`: `TZ` (default America/Phoenix), `NOTIFY_TIME` (09:00 in compose), `PORT`, `DATA_DIR` (`/data`), `KEEP_EXPIRED` (default 15; `0` = delete all expired; non-number like `off` = never delete), `UPSCALER_URL=http://upscaler:3000` (without it Enhance is hidden; it went missing once, check it).
- **Drop time is NOT an env var**: `DROP_HOUR = 11` in `public/dates.js`; changing it needs a rebuild. Making it an env var (server returns it via `/api/state`) was offered, no answer yet.
- `data.json` is read only at startup and rewritten on every save, so hand edits need `docker stop slam-tracker` first. It is not writable by the user's normal account (probably root-owned); edit from the Unraid web terminal. Changes to `public/*` or `server.js` need a rebuild and a hard browser refresh (Ctrl+F5).

## Data model (`DATA_DIR/data.json`)
```
{ sets: [ { id, name, type: 'longterm'|'weekly'|'daily', startDate|null, endDate 'YYYY-MM-DD',
            endAt epoch-ms (long-term only; absent on sets saved before 0.4.6),
            releaseDay 0-6|null (weekly), cover '/images/<uuid>.jpg'|'', createdAt,
            items: [ { id, level, variation ('' if none), total, owned } ],
            slots: [ { date } ],  // daily/weekly only, one per drop
            perDrop 1-20 (absent on older sets = 1)
          } ],
  notified: { '<setId>:<date>:<release|ending>': true }  // pruned after 30 days
}
```
- Long-term: server stores `endAt` = now + `daysLeft` days + `hoursLeft` hours at save; `endDate` = the `TZ` date of `endAt` (sorting, display, ntfy day counts). The form never sends a date.
- Daily/weekly: user gives start date (+ release weekday) and `perDrop`; drops = `ceil(largest item total / perDrop)`; `endDate` is derived (daily: last drop; weekly: last drop + 6 days). Old `got` on slots is ignored.
- A corrupt `data.json` is renamed `data.json.corrupt-<ts>` at startup, not overwritten.
- Browser-only: `localStorage` `slamStacked` (`'1'` = collapsed).
- Don't change the shape without a migration in `load()`; the user's data lives there.

## API
`GET /api/state` (`tz`, `ntfy: {configured, notifyTime}`, `enhance`, `sets`); `POST /api/sets`; `PUT /api/sets/:id`; `DELETE /api/sets/:id` (404 unknown, 403 if ended; clears `notified` keys and the cover file unless shared); `POST /api/sets/:id/items/:itemId` ({delta} or {value}, returns updated set); `POST /api/upload` (raw png/jpeg/webp); `POST /api/ntfy/test`. Ended sets (including grace day) reject edits/progress with 403 (`locked()` uses `D.isExpired`).

Set body: `{ name, type, startDate, daysLeft, hoursLeft, keepEnd, perDrop, releaseDay, cover, items: [{ id, level, variation, total }] }`. `daysLeft` (0-3650) / `hoursLeft` (0-23) / `keepEnd` are long-term only: blank counts as 0, both blank -> "Enter the time remaining", zero total -> "Time remaining must be more than 0"; `keepEnd: true` on PUT keeps the existing `endAt`/`endDate` (form sends it when days/hours are unchanged). `startDate`, `perDrop`, `releaseDay` are daily/weekly only (`perDrop` outside 1-20 -> "Cards per drop must be between 1 and 20"). A legacy `endDate` field on long-term is ignored.

Enhance (proxied; 503 if `UPSCALER_URL` unset, 502 if unreachable): `POST /api/enhance?model=fast|best&scale=2..4` (raw image <= 12 MB) -> `{id}` (429 busy, 400 bad image); `GET /api/enhance/:id` -> `{status, progress, error}`; `GET /api/enhance/:id/result` -> PNG; `DELETE /api/enhance/:id`. Upscaler has the same under `/jobs` plus `/health`; finished jobs are dropped after 20 min.

## How it fits together
Browser loads `/api/state` (refresh every 60s and on tab focus, not while the set form is open), renders client-side with `dates.js`, and posts small changes. Cover is cropped in the browser (canvas) and uploaded as JPEG only on form save. The server scheduler (every 60s) uses the same `dates.js` helpers to decide ntfy messages; pruning runs at startup and every 10 min.

`render()` in `app.js` rebuilds the whole Active and Expired innerHTML every time. Anything stored on a card element (tilt CSS vars, stack `--i`) must be re-applied at the end of `render()` (`reapplyTilt()` and the stack code do this).

Enhance flow: in the cropper, "Use crop" grabs native pixels; if enhancing is on (Off/Fast/Best, default Fast) and the crop's long side is < 900px, the PNG goes to `/api/enhance`, progress polls every 1.2s with Cancel, then a before/after with Use enhanced / Use original / Cancel. Chosen image is shrunk to <= 1400px JPEG (.92) and held until the set is saved. Fast picks scale 2-4 for ~1000px output; Best always 4x (about a minute on the server).

Long-term form: `#f-days` / `#f-hours` (`F.daysLeft`/`F.hoursLeft`) are pre-filled on edit from `D.minutesLeft(set, now)`; originals kept in `F.origDays`, `F.origHours`, `F.origType`; `keepEnd` is true only if an existing long-term set's values are unchanged. Duplicate opens them blank.

## Behavior and key decisions

### Ending, grace day, expiry
- `D.isExpired(set, today)` = "has ended": `Date.now() >= endAt` if `endAt` exists, else `today > endDate`. Read-only from this point.
- `dates.js`: `endedAtMs(set, tz)` = `endAt`, or start of the day after `endDate` in `tz`; `isArchived(set, tz)` = `Date.now() >= endedAtMs + 24h`. Ended but not archived = the **grace day**.
- Use `D.isArchived` for "is it in the Expired section" and `D.isExpired` for "has it ended (read-only)".
- `render()`: Active = all non-archived sets, sorted ended-last (grace), then weekly-with-live-card first, then `endDate`, then name. Expired = archived, newest `endDate` first. Stat tiles (Running, Need to finish, Completed, Ending <= 3 days) use only Active sets that have not ended.
- `card(s, expired)`: second arg means "has ended"; `grace = expired && !D.isArchived(...)`. Classes: `expired` only when ended and archived; grace cards get `grace` plus `gdone` or `gmiss`; `complete` is not applied to grace cards. Label `Ended <m>m ago` / `<h>h <m>m ago` / `<1m ago`, updated on re-render only. Archived keep `Ended <date>`.
- Grace styling: `.card.grace` has `opacity .88`, children `filter: grayscale(1)`, and an `::after` using `mix-blend-mode: color` (gdone `rgba(95,140,110,.6)`, gmiss `rgba(150,85,92,.6)`). Don't remove the opacity or `position: relative` without re-checking in the browser.
- Auto-prune: `pruneExpired()` (startup + every 10 min) selects only `D.isArchived` sets, keeps the newest `KEEP_EXPIRED` (sorted by `endDate` desc, then `createdAt` desc), deletes the rest via `removeSets()` (also used by the delete route; removes `notified` keys and unshared cover files). Permanent.
- `endAt` sets expire by machine clock, independent of `TZ`; `TZ` only sets the calendar date of `endDate` and when daily/weekly sets end (midnight in `TZ`).

### Drop time
- `dates.js`: `DROP_HOUR = 11`, module variable `curTz`, helpers `dropLive(today)`, `dropDate(today)` (previous day before the drop hour), `todaySlot(set, today)` (today's slot only once live). `released(set, today)` counts slots with `date <= dropDate(today)`, so `itemMissing` (the "N missing" badge, behind rows, weekly ntfy "behind" check) lags until 11:00. The rule applies to the real current date only.
- **Hidden dependency:** `curTz` is set as a side effect of the exported `D.nowParts(tz)`. Anything calling `released`/`itemMissing`/`todaySlot` needs `nowParts` called earlier in the same process/page (browser: top of `render()`; server: `locked()`, `pruneExpired()`, `runNotifications()`). Otherwise it silently uses America/Phoenix.
- Use `D.todaySlot` (not `slots.find(date === today)`) anywhere you ask "is there a live drop today".
- `remaining()` / `windowEnd()` ("X days/weeks remaining") and set end times are deliberately calendar-day based, not drop-time based.

### Card effects (0.5.0)
- CSS rules are scoped `.card:not(.grace):not(.expired)` so grace/expired cards stay flat (a `transform` there would break the tint's stacking context). Live cards: `perspective(900px) rotateX(var(--rx)) rotateY(var(--ry)) translateY(var(--lift))`, layered shadow, `.15s` transform transition, hover `--lift:-5px`, and a `::before` glare at `--mx/--my` (`rgba(235,233,228,.16)`). `prefers-reduced-motion` removes it all.
- JS (above the final `load()`): one `pointermove` listener on `document`, fraction computed from the card's own bounding rect (correct under the grid's `zoom:.75`), sets `--rx`/`--ry` (fraction x 10 deg) and `--mx`/`--my`. State in `tilt`; `dropTilt()` on leave; `reapplyTilt()` at the end of `render()`. Cards carry `data-id`. `calm = matchMedia('(prefers-reduced-motion: reduce)')`.
- **Gotcha:** if Windows "Animation effects" is OFF, browsers report reduced motion and both the card effect and the Collapse/Expand animation are skipped. Check `matchMedia('(prefers-reduced-motion: reduce)').matches` first if "nothing happens".

### Collapse / Expand stacked view (0.5.1)
- `#stackToggle` text is set by `render()`. `stacked` state is a module-level `let` in `app.js`, saved to `localStorage` `slamStacked`. Only `#active` ever stacks.
- End of `render()` (before `reapplyTilt()`): toggles class `stack` on `#active`, sets `--n` on `#active` and `--i` on each card.
- CSS: `#active.stack` is a flex row, `--peek:110px`, `container-type:inline-size`. Cards are `flex:none; width:420px; z-index:calc(var(--n) + 1 - var(--i))` (soonest-ending on top, at the LEFT). All but the last get a negative `margin-right: calc(min(var(--peek), (100cqw - 420px) / (var(--n) - 1)) - 420px)`. Hover: `z-index:500`, `--lift:-14px`. `.badges` is `row-reverse` (type badge top-right, status badges top-left); `.badge .xtra{display:none}` shortens the type text to Weekly / Daily / Long-term. `#active.stack ...` selectors use the id on purpose to beat class-only rules.
- Animation is FLIP in the `#stackToggle` click handler: record rects by `data-id`, flip `stacked`, `render()`, then `animate()` each card from `translate(dx,dy) scale(k)` to `none` over 450 ms, `cubic-bezier(.2,.8,.2,1)`. Deltas are divided by `ZOOM = .75`, which **must match the `zoom` on `.grid`** (also re-check the 420px width if it changes). Skipped when `calm.matches`.

### Other behavior
- Progress counts unique cards per chased level/variation (no per-card tracking). Overall = completed bars / chased bars. Every set must chase at least one level.
- Daily/weekly: drops ARE the cards of the chased level/variation. Cards due = released drops x `perDrop`, capped at the item total (`itemMissing`). If owned is lower, a red "N missing" badge shows (tooltip lists which) and behind rows get a reddish label. Card shows "X weeks/days remaining" (windows still open: daily = that day, weekly = release day + 6). Long-term shows "Ends <date> · Xd Yh left".
- Start date is kept for daily/weekly so a late-added set can be backdated.
- Release badges: for daily and weekly sets when `todaySlot` exists, a red pulsing "NEW CARD TODAY" (`badge rel`) while behind, or green "Collected today ✓" (`badge ok`) when caught up. Only weekly sets jump to the front of Active. The red release-day border was removed; `.card.release` in `style.css` is dead code.
- Look: portrait cards (`aspect-ratio: 5/7`, cover flexes, card grows with many bars). 25% size reduction via `zoom:.75` on `.grid`. Background is a dark overlay over an inline-SVG diamond-plate tile (`body` in `style.css`). Set modal scaled with `#modal .dialog{zoom:.75; max-height:calc(92vh / .75)}` (cropper not scaled). Cropper default 1:1; plain crop capped at 1400px. Red "urgent" border when < 24h remain (not for ended sets).
- ntfy: weekly -> on release day once the drop is live (11:00) and `NOTIFY_TIME` passed, if behind on any chased item and set incomplete; long-term -> daily from 5 days before the end date through it, listing missing cards, skipped if complete or ended; daily -> none. Once per day; logged as sent only if ntfy accepted it. Uses ntfy's JSON publish API.
- Level colors: Uncommon green, Rare blue, Super Rare purple, Iconic red, Legendary gold. Completed bars are a muted green with a checkmark.
- Editing: item ids are preserved so progress survives edits; removing a level/variation deletes its progress. Saving daily/weekly recalculates slots and `endDate`; saving long-term with changed days/hours restarts the countdown. Active sets can be deleted from the Edit dialog (two-click confirm). Card footer Edit/Duplicate are icon-only (`ICONS` in `app.js`). Ended sets can only be duplicated.

## Modifying safely
- Keep rule logic (expiry, grace/archived, drop timing, missing, progress) in `public/dates.js` so server and UI stay consistent.
- Preserve item `id`s when editing sets (`cleanSet` matches by id) or progress is lost.
- All writes go through `save()` (atomic rename).
- No build step; escape user text with `esc()` before putting it in HTML.
- Keep `.env` in `.gitignore` and `.dockerignore`; keep `.env.example` blank.
- The upscaler needs explicit tiling (`-t`, set per model in `upscaler/server.js`); an untiled run hung for minutes.
- `render()` replaces every card element; stack/tilt CSS depends on `data-id` and the `grace`/`expired` classes on `<article class="card ...">`.

## Status
- 0.4.2 (auto-prune of expired sets beyond newest 15) awaits user confirmation once enough sets have expired.
- 0.5.2 (weekly ntfy uses `D.todaySlot` in `runNotifications()`) is not yet confirmed; the real 11:00 ntfy has never been observed. Verify the line is present in `server.js`.
- Files after the 0.5.1 edits were applied by hand and never re-read by Claude in the old chat; check `app.js`, `style.css`, `index.html` against the descriptions above before trusting them.
- Unconfirmed: stronger resting card shadow (`inset 0 1px 0 rgba(235,233,228,.08)` plus 1px dark outline) offered, unknown if applied; whether the ntfy topic was rotated if once pushed to GitHub.
- Not tested: stack with 15+ sets or exactly one; other browsers; grace -> Expired after 24h in real use; DST zones in the browser; Enhance edge cases (cancel, error path, crops >= 900px, upscaler down).

## Known limitations
- `pruneExpired()` has an unused `today` variable.
- Stack: status badges and names hidden on buried cards until hover; fixed 420px card width; Expired section and page below don't animate (user fine with it for now).
- `DROP_HOUR` is one hardcoded value for all sets.
- Cards per drop is one value per set; different release rates per level aren't supported.
- Weekly ntfy only knows if the user is behind overall, not whether this week's card was collected.
- Covers cropped before 0.3.0 (5:2) are center-cropped; re-crop via Edit > Replace.
- Replaced covers aren't deleted from `images/` (orphans accumulate; prune removes only covers of pruned sets).
- Ended sets can't be edited or manually deleted.
- Enhance: one job at a time; abandoning mid-job leaves it running; Best is slow on CPU; crops >= 900px skip enhancing.
- No per-card tracking, auth, or snooze/quiet hours.

## Next tasks
- Confirm 0.4.2 and 0.5.2 with the user.
- Possible: animate Expired/page below on stack toggle; keep status badges visible on buried cards; `DROP_HOUR` as env var; delete dead `.card.release` CSS; clean up orphaned images; sync `package.json` version.
- The user wants to build a larger feature; scope undefined, ask them.
