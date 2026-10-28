# Slam Tracker - Handoff

Last updated: 2026-10-28 (version 0.4.9). Change log since the previous handoff (which described 0.4.6):
- **0.4.7** - 24-hour grace period for every set type. After a set ends it stays at the end of the Active section for one more day, greyed out and tinted (green-grey if everything chased is complete, red-grey if not), with the label "Ended Xh Ym ago" counting up. Then it moves to Expired. Tested and approved by the user (tint strength approved).
- **0.4.8** - Weekly sets with a live card today sort first in Active. The "Collected today ✓" badge is green (`badge ok`, no pulse). Daily sets now show the NEW CARD TODAY / Collected today badge too (no sort-to-front for daily). The red release-day card border and glow were removed. Tested and approved by the user.
- **0.4.9** - Drops go live at 11:00 in `TZ` (constant `DROP_HOUR = 11` in `public/dates.js`), not at midnight. Tested and approved by the user (by temporarily changing `DROP_HOUR`).
- 0.4.2 (automatic deletion of expired sets beyond the newest 15) is still awaiting the user's test report; 0.4.7 changed what it counts (see Key decisions). `package.json` still says version 0.1.0 (it is not kept in sync with these labels).

**Important caveat about this file:** the files attached to the conversation that produced this handoff were the repo as of 0.4.6. Everything from 0.4.7 on was delivered as search/replace edits that the user applied by hand, and Claude never saw the resulting files. The descriptions below are what those edits specify. If you can, ask the user to attach the current repo files and check them against the "Structure" and "Modifying safely" sections. Two edits had find-text variants (see "NOT verified").

## What it does
LAN-only web dashboard (Docker on Unraid) for tracking progress in the Topps Slam trading card game. The user creates a "set" when it is released, chooses which rarity levels/variations to chase, and logs cards as they are collected. The dashboard shows Active sets and Expired sets (muted, read-only), with progress bars, countdowns, and ntfy reminders. Used only on a 27" 1440p desktop monitor; no login, no mobile layout.

Game rules that drive the design: levels are Uncommon, Rare, Super Rare, Iconic, Legendary; levels can have variations (e.g. Rare Chrome Green); card counts per set are arbitrary; cards can be traded; every set has an end date (the game shows "days left", which is why long-term sets are entered that way); some sets drop one or more cards per day or per week that are only obtainable during that day/week. The user wants a drop to appear on the dashboard at 11:00 their time (when it goes live in the game).

## Stack
Node 20 + Express 4 (only dependency), vanilla HTML/CSS/JS front end (no build step), JSON file storage. Docker (`node:20-alpine`). Node's built-in `fetch` is used for ntfy and for the upscaler proxy (Node >= 18).

Second container (`upscaler/`, optional): `ubuntu:24.04` + distro `nodejs` (no npm dependencies) + `mesa-vulkan-drivers` (lavapipe software Vulkan, so no GPU needed) + the `realesrgan-ncnn-vulkan` v0.2.5.0 Linux release binary downloaded from GitHub at build time (models used: `realesr-animevideov3` x2/x3/x4 and `realesrgan-x4plus`). Free and offline at run time.

## Structure
- `server.js` - Express app: JSON store (atomic writes), validation (`cleanSet`), REST API, image upload, `/api/enhance*` proxy to the upscaler, ntfy scheduler, expired-set pruning
- `upscaler/server.js` + `upscaler/Dockerfile` - separate container: dependency-free Node job server wrapping the Real-ESRGAN binary (one job at a time)
- `public/dates.js` - shared (server `require` + browser `<script>`) logic: timezone-aware "now", date math, drop-slot generation, drop-time helpers, missing/remaining calculations, progress, ended/archived logic. **Single source of truth for these rules.**
- `public/index.html`, `style.css`, `app.js` - dashboard, set form modal, image cropper modal, toasts
- `Dockerfile`, `docker-compose.yml` (two services: `slam-tracker` host port 8187 -> container 3000, and `upscaler` not published), `.env.example` (blank NTFY_SERVER/NTFY_TOPIC/NTFY_TOKEN; the real `.env` is gitignored and dockerignored), `.dockerignore` (also excludes `upscaler/` from the app image), `.gitignore`, `package.json`, `package-lock.json`, `README.md`, `handoff.md`

## Configuration and secrets
- The ntfy server, topic and token come from `.env` (copied from `.env.example`, sits next to `docker-compose.yml`). `docker-compose.yml` references them as `${NTFY_SERVER:-https://ntfy.sh}`, `${NTFY_TOPIC:-}`, `${NTFY_TOKEN:-}`, so nothing sensitive is committed. Notifications stay off when `NTFY_TOPIC` is empty. On Unraid Compose Manager, `.env` must live in the stack folder (or be set through the stack's env file option).
- Other settings are plain environment variables on the `slam-tracker` service: `TZ` (default America/Phoenix), `NOTIFY_TIME` (set to 09:00 in the compose file), `PORT`, `DATA_DIR` (`/data` in Docker), `KEEP_EXPIRED` (default 15; number, 0 = delete all expired, any non-number such as `off` = never delete), `UPSCALER_URL` (enables Enhance).
- **The drop time is NOT an environment variable.** It is the constant `DROP_HOUR = 11` in `public/dates.js` (24h clock, in `TZ`). Changing it needs an image rebuild. The user asked where it is set and was offered making it an env var (server reads `DROP_HOUR`, returns it in `/api/state`, `dates.js` takes it from there, compose gets the variable); no answer yet.
- `UPSCALER_URL=http://upscaler:3000` must be set on the `slam-tracker` service in `docker-compose.yml`; without it the app reports `enhance: false` and the Enhance option is hidden. It once went missing from the compose file and the user re-added it. `KEEP_EXPIRED` is not set in the compose file (default 15 applies).
- If the ntfy topic was ever pushed to GitHub in an earlier commit, the user was advised to rotate it (public ntfy.sh topics act like passwords). Whether they did is not known.
- Operational: the app reads `data.json` only at startup and rewrites it on every save, so hand edits require stopping the container first. On the user's Unraid server `data.json` is not writable by their normal user (almost certainly root-owned; cause not confirmed). Edit it from the Unraid web terminal as root (`docker stop slam-tracker`, edit, `docker start slam-tracker`). Changes to `public/*` and `server.js` need `docker compose up -d --build` and a hard browser refresh.

## Data model (`DATA_DIR/data.json`)
```
{ sets: [ { id, name, type: 'longterm'|'weekly'|'daily', startDate|null, endDate 'YYYY-MM-DD',
            endAt epoch-ms (long-term only; absent on long-term sets saved before 0.4.6; endDate is its local date in TZ),
            releaseDay 0-6|null (weekly), cover '/images/<uuid>.jpg'|'', createdAt,
            items: [ { id, level, variation ('' if none), total, owned } ],
            slots: [ { date } ],  // daily/weekly only: one per drop, built from startDate (+ releaseDay)
            perDrop 1-20 (daily/weekly: cards released per drop; absent on older sets = 1)
          } ],
  notified: { '<setId>:<date>:<release|ending>': true }  // pruned after 30 days
}
```
Long-term: the server stores `endAt` (epoch ms) = now + `daysLeft` days + `hoursLeft` hours at save time, and `endDate` = the `TZ` calendar date of `endAt` (used for sorting, display, pruning order and ntfy day counts); the form never sends a date. Long-term sets saved before 0.4.6 have only `endDate`. Daily/weekly: the user enters a start date (and release weekday for weekly) and `perDrop`; the number of drops is `ceil(largest item total / perDrop)` and `endDate` is derived (daily: last drop date; weekly: last drop + 6 days). Older records may still contain `got` on slots; it is ignored. A corrupt `data.json` is renamed to `data.json.corrupt-<ts>` on startup rather than overwritten. No data shape changes were made in 0.4.7-0.4.9 (the grace period and drop time are computed, nothing new is stored).

## API
`GET /api/state` (returns `tz`, `ntfy: {configured, notifyTime}`, `enhance: true|false`, `sets`); `POST /api/sets`; `PUT /api/sets/:id`; `DELETE /api/sets/:id` (404 unknown, 403 if ended; also clears that set's `notified` keys and deletes its cover file unless another set still uses the same cover); `POST /api/sets/:id/items/:itemId` ({delta} or {value}); `POST /api/upload` (raw png/jpeg/webp body); `POST /api/ntfy/test`. Item route returns the updated set. Ended sets (including ones in the grace day) reject edits/progress with 403 (`locked()` in `server.js` still uses `D.isExpired`).

Set body for POST/PUT: `{ name, type, startDate, daysLeft, hoursLeft, keepEnd, perDrop, releaseDay, cover, items: [{ id, level, variation, total }] }`. `daysLeft`, `hoursLeft` and `keepEnd` are used only for `type: 'longterm'`: days 0-3650 and hours 0-23, a blank one counts as 0, both blank gives "Enter the time remaining", a zero total gives "Time remaining must be more than 0"; `keepEnd: true` on a PUT keeps the existing set's `endAt`/`endDate` untouched (the form sends it when the user didn't change days/hours); `startDate`, `perDrop` and `releaseDay` only for daily/weekly (`perDrop` omitted or empty = 1; outside 1-20 gives "Cards per drop must be between 1 and 20"). A client sending the old `endDate` field for a long-term set is ignored.

Enhance (proxied to the upscaler, 503 if `UPSCALER_URL` is unset, 502 if unreachable): `POST /api/enhance?model=fast|best&scale=2..4` (raw PNG/JPEG body, <= 12 MB) -> `{id}` (429 if the upscaler is busy, 400 for a bad image); `GET /api/enhance/:id` -> `{status: running|done|error, progress 0-100, error}`; `GET /api/enhance/:id/result` -> PNG; `DELETE /api/enhance/:id` cancels/discards. Upscaler's own API is the same under `/jobs` plus `/health`; finished jobs are dropped after 20 minutes.

## How components interact
The browser loads `/api/state` (refreshes every 60s and on tab focus, but not while the set form is open), renders everything client-side with `dates.js`, and posts small changes. The cover is cropped in the browser (canvas) and uploaded as a JPEG only when the set form is saved. The server's scheduler (every 60s) uses the same `dates.js` helpers to decide which ntfy messages are due. The server also prunes expired sets at startup and every 10 minutes.

Enhance flow: in the cropper, "Use crop" grabs the crop at native pixels; if enhancing is on (Off/Fast/Best buttons, default Fast, remembered per page load in `enhMode`) and the crop's long side is under 900px, the PNG is posted to `/api/enhance`, the dialog shows a progress bar (polls every 1.2s) with Cancel, then a before/after comparison with Use enhanced / Use original / Cancel. The chosen image is shrunk to <= 1400px JPEG (.92) and held until the set form is saved. Errors offer "Use original crop". Fast picks scale 2-4 so output is about 1000px; Best always runs 4x.

Long-term form flow: the form's **Days remaining** and **Hours remaining** inputs (`#f-days`, `#f-hours`, state `F.daysLeft`/`F.hoursLeft`) are sent as `daysLeft`/`hoursLeft`. When editing, they are pre-filled from `D.minutesLeft(set, now)` and the originals are remembered (`F.origDays`, `F.origHours`, `F.origType`); on save `keepEnd` is true only if an existing long-term set's two values are unchanged. Duplicate opens them blank.

## Key decisions / behavior

### Ending, grace day and expiry (0.4.6-0.4.7)
- `D.isExpired(set, today)` (unchanged since 0.4.6) means "has ended": `Date.now() >= endAt` when `endAt` exists, otherwise `today > endDate` (today in `TZ`). `minutesLeft` is `ceil((endAt - now)/60000)` for `endAt` sets.
- 0.4.7 added in `dates.js`: `endedAtMs(set, tz)` = `endAt`, or the start of the day after `endDate` in `tz` (computed by `startOfDayMs`, which iterates the zone offset); and `isArchived(set, tz)` = `Date.now() >= endedAtMs + 24h`. Ended but not archived = the **grace day**.
- `app.js` `render()`: Active = all non-archived sets, sorted ended-last (grace sets), then by `endDate`, then name; Expired = archived sets, newest `endDate` first. The stat tiles (Running, Need to finish, Completed, Ending <= 3 days) are computed from `live` = Active sets that have not ended, so grace sets are excluded. The section counts are the number of cards in each section (grace sets count toward Active).
- `app.js` `card(s, expired)`: the second argument means "has ended" (`D.isExpired`); inside, `grace = expired && !D.isArchived(s, state.tz)`. Classes: `expired` only when ended and archived; grace cards get `grace` plus `gdone` (all chased bars complete) or `gmiss`; the `complete` class is not applied to grace cards. Grace label: `Ended <m>m ago` / `Ended <h>h <m>m ago` / `Ended <1m ago`, from `Date.now() - endedAtMs`; it only updates when the dashboard re-renders (about once a minute). Archived expired cards keep `Ended <date>`.
- Styling (`style.css`): `.card.grace` has `opacity .88`, its direct children get `filter: grayscale(1)`, and an `::after` overlay uses `mix-blend-mode: color` with `rgba(95,140,110,.6)` (gdone, border `#4a6354`) or `rgba(150,85,92,.6)` (gmiss, border `#6e4f53`). The user viewed it in their browser and approved the look.
- Grace and expired sets are read-only (no +/-, no Edit button, server 403); Duplicate works.
- Auto-prune (0.4.2, changed in 0.4.7): `pruneExpired()` in `server.js` runs at startup and every 10 minutes. It now selects `D.isArchived(s, TZ)` sets only (so grace-day sets are never pruned), keeps the newest `KEEP_EXPIRED` (default 15; sorted by `endDate` desc, then `createdAt` desc) and deletes the rest via `removeSets()` (also used by the delete route), which removes the sets, their `notified` keys, and cover files not used by any remaining set. Deletion is permanent.
- Expiry compares against the machine clock (`Date.now()`), so `endAt` sets do not depend on `TZ`; `TZ` only affects which calendar date `endDate` is and when daily/weekly sets end (midnight in `TZ`).

### Drop time (0.4.9)
- `dates.js` has `DROP_HOUR = 11`, a module variable `curTz` (default `'America/Phoenix'`), and helpers: `dropLive(today)` (true if `today` is not the current local date, or the current local hour >= `DROP_HOUR`), `dropDate(today)` (`today`, or the previous day while before the drop hour), `todaySlot(set, today)` (the slot dated `today`, only once the drop is live, else `undefined`). `released(set, today)` counts slots with `date <= dropDate(today)`, so `itemMissing` (and with it the "N missing" badge, the behind-row styling and the weekly ntfy check) lags by a day until 11:00. Exports added: `todaySlot`, `DROP_HOUR`, `endedAtMs`, `isArchived`.
- **Hidden dependency:** `curTz` is set by the exported `nowParts(tz)`, which is now a wrapper around the original (the original stays internal). Anything calling `released`/`itemMissing`/`todaySlot` relies on `D.nowParts(tz)` having been called earlier in the same process/page. The browser calls it at the top of `render()`, and the server calls it in `locked()`, `pruneExpired()` and `runNotifications()`. If a new code path uses these helpers before any `nowParts` call it silently uses America/Phoenix. The 11:00 rule applies to the real current date only (a `today` argument that is not the current local date counts as live).
- Not drop-time-aware on purpose: `remaining()` / `windowEnd()` ("X days/weeks remaining") and set end times still follow calendar days.
- `app.js` uses `D.todaySlot(s, now.date)` for `rel` (the card's "new card today" state) and in `render()` for `dropToday` (weekly sets with a live card sort first, before the endDate sort); `server.js` `runNotifications()` uses it for the weekly slot, so the weekly "new card today" ntfy goes out at 11:00 (once `NOTIFY_TIME` of 09:00 has passed and the drop is live), not 09:00. Long-term "ending" alerts are unchanged.

### Other behavior
- Progress counts unique cards per chased level/variation (no per-card tracking). Overall = completed bars / chased bars. Every set must chase at least one level.
- Daily/weekly sets: the drops ARE the cards of the chased level/variation (no separate drop bar, chips or "number of drops" field; the length is `ceil(largest item total / perDrop)`). Cards you should have by now = released drops x `perDrop` (capped at the item total, see `itemMissing`); if owned is lower a red "N missing" badge (sum across items; tooltip lists which) shows in the card's top-right corner and the behind rows get a reddish label. The card shows "X weeks/days remaining" (drops whose availability window hasn't closed; daily window = that day, weekly = release day + 6) instead of an end date. Long-term cards show "Ends <date> · Xd Yh left".
- Start date is kept for daily/weekly so a set added late can be backdated to when the first card dropped.
- Release badges (0.4.8): for daily AND weekly sets (`timed`), when `todaySlot` exists the right-hand badge is red pulsing "NEW CARD TODAY" (class `badge rel`) while behind, or green "Collected today ✓" (class `badge ok`) when caught up (all `itemMissing` are 0). They show from 11:00 until midnight on the drop date. Only weekly sets jump to the front of Active; daily sets do not (they would always be first). The red release-day card border/glow was removed in 0.4.8 by deleting `rel && 'release'` from the card's class list; the `.card.release` rule in `style.css` is now dead code (harmless).
- Look: portrait trading-card cards (`aspect-ratio: 5/7`, cover flexes to fill, card grows if many bars). The 25% size reduction is done with `zoom: .75` on `.grid`. Page background is a dark overlay over an inline-SVG diamond-plate tile (see `body` in `style.css`). The add/edit set modal is scaled with `#modal .dialog{zoom:.75; max-height:calc(92vh / .75)}` (the cropper dialog is intentionally not scaled). Cropper default is 1:1. The plain (non-enhanced) crop is capped at 1400px on its longest side. A card still gets a red "urgent" border when under 24 hours remain (not for ended sets).
- ntfy: weekly -> on release day (after the drop is live) if behind on any chased item and set incomplete; long-term -> daily from 5 days before the end date through the end date listing missing cards, skipped if complete or already ended; daily -> none. Sent once per day after `NOTIFY_TIME`; only logged as sent if ntfy accepted it. Uses ntfy's JSON publish API.
- Level colors: Uncommon green, Rare blue, Super Rare purple, Iconic red, Legendary gold. Completed bars use a different, muted green with a checkmark.
- Editing: item ids are preserved so progress survives edits; removing a level/variation deletes its progress. Saving a daily/weekly set recalculates slots and `endDate`; saving a long-term set with changed days/hours restarts the countdown from now.
- Active sets can be deleted from the Edit dialog (button on the left of the dialog actions; first click turns it into "Click again to delete for good", second click deletes). Card footer Edit/Duplicate are icon-only (inline SVGs in `ICONS` in `app.js`).

## Verified
- By the user (they report testing and approving each; details of exactly what they exercised beyond the below are not known):
  - 0.4.7 grace period: sets set to expire in an hour went to the end of Active, greyed, with the right tint and the counting-up label; counters, read-only behavior and the tint look were approved. Whether they waited the full 24 hours to see a set move to Expired is not known.
  - 0.4.8: badge colors, daily badge, sort-to-front and the red border removal ("all the changes seem to be working").
  - 0.4.9 drop time: tested by temporarily changing `DROP_HOUR` ("Setting the time did work").
  - Earlier: 0.4.6 exact end time, 0.4.5 cards per drop, 0.4.4 days remaining, 0.4.3 `.env` refactor (whether the Test ntfy notification arrived on their device was not reported), 0.4.1 delete button and icon buttons, 0.4.0 Enhance (Fast and Best both worked; Best takes about a minute on their server), and everything through 0.3.1 in real Firefox on the 27" monitor.
- By Claude in a sandbox (scratch scripts, NOT saved in the repo): `startOfDayMs` / `endedAtMs` start-of-day math in America/Phoenix, America/New_York (including DST change days), Australia/Sydney and Asia/Kolkata; the drop-time helpers with a mocked clock (before 11:00, 10:59, 11:00, 23:59, after midnight) giving the expected `released` and `todaySlot` results. The 0.4.7-0.4.9 front-end/server edits themselves were not run in a sandbox; the user applied them and tested in their own setup.
- Earlier sandbox tests by Claude (0.4.6 and before): API creation/validation for all set types, +1 clamping, 403 on expired sets, image upload, ntfy messages against a fake server, jsdom renders, Enhance end to end, `realesrgan-ncnn-vulkan` on lavapipe.

## NOT verified
- 0.4.2 auto-prune: the user has not reported testing it. Sandbox-tested earlier only (crafted data.json, `KEEP_EXPIRED=3`, shared cover kept, tie-break by `createdAt`, `off` and default prune nothing, `0` prunes all). The 0.4.7 change to use `isArchived` was not run at all. The 10-minute timer itself has not been observed.
- The exact current text of `app.js`, `dates.js`, `server.js` and `style.css` after the 0.4.7-0.4.9 edits (see the caveat at the top). Two edits had alternates depending on what the user had already applied: the `rel` line in `card()` (`timed ?` after the daily-badge edit, `weekly ?` before it) and the class-list removal of `rel && 'release'` (with or without `weekly &&`). The user reports the behavior is correct, so they are presumably applied.
- A set actually moving from the grace day to Expired after 24 hours, and the daily/weekly midnight rollover into the grace day in real use; behavior across a container restart or a real day rollover; DST zones in the browser (the user's TZ, America/Phoenix, has no DST).
- The real 11:00 rollover for a daily or weekly set without changing `DROP_HOUR`, and the weekly ntfy actually arriving at about 11:00.
- Real ntfy delivery from the `.env` setup; whether the user's real `docker-compose.yml` sets `UPSCALER_URL` (they re-added it and Enhance returned); whether the countdown matches the game's own timer to the hour; ntfy for a long-term set that ends in the early morning (no "ends today" alert is sent for it).
- Enhance edge cases: cancel mid-run, the error path, crops >= 900px, upscaler container down, very small crops; whether enhanced covers look good on text-heavy screenshots.
- Docker/Unraid details beyond the user running it on port 8187; cropper edge cases; there is no automated test suite in the repo.

## Known limitations / unfinished
- `DROP_HOUR` is one hardcoded value for every set and is not configurable without editing `dates.js` and rebuilding.
- `curTz` is module-level state set as a side effect of `D.nowParts` (see Drop time). It works today but is fragile if new code skips `nowParts`.
- "X days/weeks remaining" and set end times are calendar-day based, not drop-time based. For example, early in the morning before 11:00 the current day still counts as remaining.
- Cards per drop is one value for the whole set. If different levels in one daily/weekly set release at different rates, the numbers will be off for the others. No separate "number of drops" field.
- Weekly notification only knows if the user is behind overall, not specifically whether this week's card was collected.
- Covers cropped before 0.3.0 (5:2) are center-cropped on the portrait cards; re-crop via Edit > Replace.
- Replaced covers are not deleted from `images/` (orphans accumulate; auto-prune only removes covers of pruned sets).
- Ended sets (grace and expired) cannot be edited or manually deleted; a mistyped end date can only be fixed by duplicating (before the set ends or while it is still in the Expired top 15).
- Grace-day label updates only on the 60s refresh; the refresh is paused while the set form is open.
- Enhance: one job at a time; abandoning the page mid-job leaves it running until it finishes or times out; Best is slow on CPU; crops >= 900px skip enhancing; no GPU passthrough support configured.
- No per-card tracking, no auth, no snooze/quiet hours. `.card.release` in `style.css` is unused. `package.json` version is stale (0.1.0).

## Modifying safely
- Keep rule logic (expiry, grace/archived, drop timing, drops remaining/missing, progress) in `public/dates.js` so server notifications and the UI stay consistent. Use `D.todaySlot` (not `slots.find(date === today)`) anywhere you ask "is there a live drop today"; use `D.isArchived` for "is it in the Expired section" and `D.isExpired` for "has it ended (read-only)".
- Make sure `D.nowParts(tz)` runs before using `released` / `itemMissing` / `todaySlot` in any new code path.
- Preserve item `id`s when editing sets (`cleanSet` matches by id) or progress is lost.
- Don't change the `data.json` shape without a migration in `load()`; the user's data lives there.
- Never put real secrets (ntfy topic/token) in committed files; they belong in `.env`. Keep `.env` in `.gitignore` and `.dockerignore`, and keep `.env.example` blank.
- The upscaler must run with explicit tiling (`-t`, set per model in `upscaler/server.js`); an early untiled run hung for minutes.
- The upscaler container must not be published to the LAN; only the app talks to it.
- All writes go through `save()` (atomic rename).
- Front end has no build step; escape user text with `esc()` before putting it in HTML.
- The grace-day tint relies on `mix-blend-mode: color` over a stacking context created by the card's `opacity`; don't remove the opacity or the `position: relative` without re-checking it in the browser.

## Working agreement with the user (follow these)
- After the user requests a feature, prompt them to test it and report whether it's good.
- When they say it's good / looks good / works, give them a git commit message to use.
- If a change needs fewer than 6 edits, give search/replace edits (file, exact find text, exact replacement) instead of a full re-download; 6 or more edits means a full updated project zip. (Claude has so far kept every change to 5 or fewer edits by combining adjacent lines, since the repo is not available on disk in the Claude session unless the user attaches it.)
- Before building a feature, the user sometimes asks Claude to confirm understanding (and preview any colors) first; do so when asked.
- Keep README.md and handoff.md updated; when asked for an updated handoff.md, update this file rather than starting a new one. The user prefers complete replacement files they can download over edit instructions for these two docs. The user usually asks for these updates in a batch after a few features.
- The user wants dark, minimal styling with accents: near-black, darker red, off-white (never pure black/white); everything is viewed on a desktop monitor.

## Next planned tasks
- Get the user's test result for 0.4.2 (auto-prune, now counting archived sets only) and give a commit message when they approve.
- Optional: make the drop time an environment variable (`DROP_HOUR` in compose, passed to the browser through `/api/state`); the user has not said yes or no.
- Smaller candidates: delete the dead `.card.release` CSS rule; clean up orphaned images; sync the `package.json` version.
- The user mentioned wanting to build a larger feature in a new chat; its scope is still not defined in this file (ask them).
