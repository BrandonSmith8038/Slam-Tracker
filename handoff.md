# Slam Tracker - Handoff

Last updated: 2026-10-24 (version 0.4.4). Change log since the last handoff: 0.4.3 moved the ntfy settings out of `docker-compose.yml` into a gitignored `.env` (new `.env.example`); 0.4.4 changed the long-term set form to take "days remaining" instead of an end date. Both were tested and approved by the user. 0.4.2 (automatic deletion of expired sets beyond the newest 15) is still awaiting the user's test. `package.json` still says version 0.1.0 (it is not kept in sync with these labels).

## What it does
LAN-only web dashboard (Docker on Unraid) for tracking progress in the Topps Slam trading card game. The user creates a "set" when it is released, chooses which rarity levels/variations to chase, and logs cards as they are collected. The dashboard shows Active sets (soonest end first) and Expired sets (muted, read-only), with progress bars, countdowns, and ntfy reminders. Used only on a 27" 1440p desktop monitor; no login, no mobile layout.

Game rules that drive the design: levels are Uncommon, Rare, Super Rare, Iconic, Legendary; levels can have variations (e.g. Rare Chrome Green); card counts per set are arbitrary; cards can be traded; every set has an end date (the game shows "days left", which is why long-term sets are entered that way); some sets drop one card per day or per week that is only obtainable during that day/week.

## Stack
Node 20 + Express 4 (only dependency), vanilla HTML/CSS/JS front end (no build step), JSON file storage. Docker (`node:20-alpine`). Node's built-in `fetch` is used for ntfy and for the upscaler proxy (Node >= 18).

Second container (`upscaler/`, optional): `ubuntu:24.04` + distro `nodejs` (no npm dependencies) + `mesa-vulkan-drivers` (lavapipe software Vulkan, so no GPU needed) + the `realesrgan-ncnn-vulkan` v0.2.5.0 Linux release binary downloaded from GitHub at build time (models used: `realesr-animevideov3` x2/x3/x4 and `realesrgan-x4plus`). Free and offline at run time.

## Structure
- `server.js` - Express app: JSON store (atomic writes), validation (`cleanSet`), REST API, image upload, `/api/enhance*` proxy to the upscaler, ntfy scheduler, expired-set pruning
- `upscaler/server.js` + `upscaler/Dockerfile` - separate container: dependency-free Node job server wrapping the Real-ESRGAN binary (one job at a time)
- `public/dates.js` - shared (server `require` + browser `<script>`) logic: timezone-aware "now", date math, drop-slot generation, missing/remaining calculations, progress. **Single source of truth for these rules.**
- `public/index.html`, `style.css`, `app.js` - dashboard, set form modal, image cropper modal, toasts
- `Dockerfile`, `docker-compose.yml` (two services: `slam-tracker` host port 8187 -> container 3000, and `upscaler` not published), `.env.example` (blank NTFY_SERVER/NTFY_TOPIC/NTFY_TOKEN; the real `.env` is gitignored and dockerignored), `.dockerignore` (also excludes `upscaler/` from the app image), `.gitignore`, `package.json`, `package-lock.json`, `README.md`, `handoff.md`

## Configuration and secrets
- The ntfy server, topic and token come from `.env` (copied from `.env.example`, sits next to `docker-compose.yml`). `docker-compose.yml` references them as `${NTFY_SERVER:-https://ntfy.sh}`, `${NTFY_TOPIC:-}`, `${NTFY_TOKEN:-}`, so nothing sensitive is committed. Notifications stay off when `NTFY_TOPIC` is empty. On Unraid Compose Manager, `.env` must live in the stack folder (or be set through the stack's env file option).
- Other settings are plain environment variables on the `slam-tracker` service: `TZ` (default America/Phoenix), `NOTIFY_TIME` (set to 09:00 in the compose file), `PORT`, `DATA_DIR` (`/data` in Docker), `KEEP_EXPIRED` (default 15; number, 0 = delete all expired, any non-number such as `off` = never delete), `UPSCALER_URL` (enables Enhance).
- **Check:** the `docker-compose.yml` last seen in this project does NOT set `UPSCALER_URL` or `KEEP_EXPIRED` on `slam-tracker`. Without `UPSCALER_URL` (`http://upscaler:3000`) the app reports `enhance: false` and the Enhance option is hidden. The user tested Enhance successfully in 0.4.0, so their real deployment probably sets it; confirm against their actual file before changing anything.
- If the ntfy topic was ever pushed to GitHub in an earlier commit, the user was advised to rotate it (public ntfy.sh topics act like passwords). Whether they did is not known.

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
Long-term: the stored `endDate` is derived by the server at save time as today (in `TZ`) + the `daysLeft` the form sends (0 to 3650); the form never sends a date. Daily/weekly: the user enters a start date (and release weekday for weekly); the number of drops equals the largest `total` among the set's items (a 12-card set runs 12 weeks) and `endDate` is derived (daily: last drop date; weekly: last drop + 6 days). Older records may still contain `got` on slots; it is ignored. A corrupt `data.json` is renamed to `data.json.corrupt-<ts>` on startup rather than overwritten. The data shape did not change in 0.4.3 or 0.4.4, so no migration was needed.

## API
`GET /api/state` (returns `tz`, `ntfy: {configured, notifyTime}`, `enhance: true|false`, `sets`); `POST /api/sets`; `PUT /api/sets/:id`; `DELETE /api/sets/:id` (404 unknown, 403 expired; also clears that set's `notified` keys and deletes its cover file unless another set still uses the same cover); `POST /api/sets/:id/items/:itemId` ({delta} or {value}); `POST /api/upload` (raw png/jpeg/webp body); `POST /api/ntfy/test`. Item route returns the updated set. Expired sets reject edits/progress with 403.

Set body for POST/PUT: `{ name, type, startDate, daysLeft, releaseDay, cover, items: [{ id, level, variation, total }] }`. `daysLeft` is used only for `type: 'longterm'` (error "Enter the days remaining" if missing or outside 0-3650); `startDate` and `releaseDay` only for daily/weekly. A client sending the old `endDate` field for a long-term set is ignored.

Enhance (proxied to the upscaler, 503 if `UPSCALER_URL` is unset, 502 if unreachable): `POST /api/enhance?model=fast|best&scale=2..4` (raw PNG/JPEG body, <= 12 MB) -> `{id}` (429 if the upscaler is busy, 400 for a bad image); `GET /api/enhance/:id` -> `{status: running|done|error, progress 0-100, error}`; `GET /api/enhance/:id/result` -> PNG; `DELETE /api/enhance/:id` cancels/discards. Upscaler's own API is the same under `/jobs` plus `/health`; finished jobs are dropped after 20 minutes.

## How components interact
The browser loads `/api/state` (refreshes every 60s and on tab focus, but not while the set form is open), renders everything client-side with `dates.js`, and posts small changes. The cover is cropped in the browser (canvas) and uploaded as a JPEG only when the set form is saved. The server's scheduler (every 60s) uses the same `dates.js` helpers to decide which ntfy messages are due. The server also prunes expired sets at startup and every 10 minutes.

Enhance flow: in the cropper, "Use crop" grabs the crop at native pixels; if enhancing is on (Off/Fast/Best buttons, default Fast, remembered per page load in `enhMode`) and the crop's long side is under 900px, the PNG is posted to `/api/enhance`, the dialog shows a progress bar (polls every 1.2s) with Cancel, then a before/after comparison with Use enhanced / Use original / Cancel. The chosen image is shrunk to <= 1400px JPEG (.92) and held until the set form is saved (same upload path as a plain crop). Errors offer "Use original crop". Fast picks scale 2-4 so output is about 1000px; Best always runs 4x.

Long-term form flow: the form's **Days remaining** number input (`#f-days`, state `F.daysLeft`) is sent as `daysLeft`. When editing, it is pre-filled with `max(0, diffDays(now.date, set.endDate))` using the page's last-rendered `now`; Duplicate opens it blank; switching a weekly/daily set to long-term pre-fills from its derived end date.

## Key decisions / behavior
- "N days remaining" means the set ends N days from today and stays active through the end of that day (expiry is after the end date's day is over, in `TZ`); 0 = ends today. If the game turns out to count today as day 1, change `days` to `days - 1` in the `cleanSet` long-term branch of `server.js`.
- Auto-prune (0.4.2): `pruneExpired()` in `server.js` runs once at startup and every 10 minutes. It keeps the newest `KEEP_EXPIRED` expired sets (default 15; sorted by `endDate` desc, then `createdAt` desc, matching the dashboard's Expired order) and deletes the rest via `removeSets()` (also used by the delete route), which removes the sets, their `notified` keys, and cover files not used by any remaining set. Deletion is permanent and happens on the first startup after upgrading if the user already has more than 15 expired sets.
- Expiry: a set is expired when today (in `TZ`) is after its `endDate`. Default TZ `America/Phoenix`.
- Progress counts unique cards per chased level/variation (no per-card tracking). Overall = completed bars / chased bars. Every set must chase at least one level.
- Daily/weekly sets: the drops ARE the cards of the chased level/variation (there is no separate drop bar, per-drop chips, or separate "number of drops" field; the length comes from the largest item total, and the user ticks a level to reveal its card-count field). Cards you should have by now = drops released so far (capped at the item total); if owned is lower a red "N missing" badge (sum across items; tooltip lists which) shows in the card's top-right corner and the behind rows get a reddish label. The card shows "X weeks/days remaining" (drops whose availability window hasn't closed; daily window = that day, weekly = release day + 6) instead of an end date. Long-term cards show "Ends <date> · Xd Yh left".
- Start date is kept for daily/weekly so a set added late can be backdated to when the first card dropped.
- Look: portrait trading-card cards (`aspect-ratio: 5/7`, cover flexes to fill, card grows if many bars). The 25% size reduction is done with `zoom: .75` on `.grid` (works in Firefox 126+/Chromium). Page background is a dark overlay (`linear-gradient(rgba(0,0,0,.4) ...)`) over an inline-SVG diamond-plate tile (see `body` in `style.css`; raise the .4 for darker/subtler). The add/edit set modal is scaled with `#modal .dialog{zoom:.75; max-height:calc(92vh / .75)}` so it fits without scrolling (the cropper dialog is intentionally not scaled). Cropper default is 1:1. The plain (non-enhanced) crop is capped at 1400px on its longest side.
- Weekly release-day highlight (red glow + badge "NEW CARD TODAY", or "Collected today" if caught up) shows only on the release date.
- ntfy: weekly -> on release day if behind on any chased item and set incomplete; long-term -> daily from 5 days before the end date through the end date listing missing cards, skipped if complete; daily -> none. Sent once per day after `NOTIFY_TIME`; only logged as sent if ntfy accepted it. Uses ntfy's JSON publish API.
- Level colors: Uncommon green, Rare blue, Super Rare purple, Iconic red, Legendary gold. Completed bars use a different, muted green with a checkmark.
- Editing: item ids are preserved so progress survives edits; removing a level/variation deletes its progress. Saving a daily/weekly set recalculates slots and `endDate` from the start date, release day and the largest item total. Saving a long-term set recalculates `endDate` from today + the days remaining in the field.
- Expired sets are read-only, cannot be deleted or edited (Duplicate is allowed). Active sets can be deleted from the Edit dialog (button on the left of the dialog actions; first click turns it into "Click again to delete for good", second click deletes). Card footer Edit/Duplicate are icon-only (inline SVGs in `ICONS` in `app.js`, with title/aria-label tooltips).

## Verified
- By the user (this conversation): 0.4.3 `.env` refactor reported as working ("everything from the changes seem to be working"). Whether the Test ntfy notification actually arrived on their device was not reported separately.
- By the user: 0.4.4 days remaining reported as working. They did not explicitly confirm that the day count matches the game's own countdown (the "N days from today" interpretation above).
- By the user: 0.4.0 Enhance tested in their real setup; both Fast and Best worked (Best took about a minute on their server, and they plan to mostly use Best), so the Docker build of `upscaler/` and the UI flow are confirmed working
- By the user: 0.4.1 delete button (Edit dialog) and icon-only Edit/Duplicate buttons work and look good
- By the user (real Firefox, 27" monitor): everything good through 0.3.1. They viewed screenshots of the weekly card (missing badge) and the edit modal, uploaded and cropped a cover, edited a weekly set, and approved the card shape/size, diamond-plate texture and modal size. Exactly which other scenarios they exercised is not known.
- NOT yet seen by the user: 0.4.2 auto-prune of expired sets (sandbox-tested earlier only: crafted data.json with 6 expired sets + 1 active, run with KEEP_EXPIRED=3 -> the 3 oldest removed with their notified keys and images, a cover shared with a kept set was kept, tie on end date broken by newer createdAt; default 15 and `off` prune nothing; 0 prunes all expired; the 10-minute timer itself was not observed)
- By Claude in a sandbox earlier (scratch scripts, NOT saved in the repo): JS syntax checks; API for long-term/weekly/daily creation, validation errors, +1 clamped at item total, expired sets return 403, image upload/retrieval; ntfy messages against a local fake ntfy server; headless DOM (jsdom) render with no JS errors; Enhance end-to-end through the app server + upscaler server run directly with node (busy 429, progress, 4x result, bad-image 400, cancel, 503 when unconfigured). `realesrgan-ncnn-vulkan` ran with lavapipe on a 1-core CPU (Fast ~15 s on a 249x249 sample; the x4plus model was far slower on that single core). The 0.4.3/0.4.4 edits were NOT run in a sandbox; they were applied by the user as search/replace edits and tested in the user's own setup.

## NOT verified
- Real ntfy delivery to the user's phone/computer from the new `.env` setup (Test ntfy result not reported)
- Whether the user's real `docker-compose.yml` sets `UPSCALER_URL` (the copy last seen does not; see Configuration and secrets)
- Days remaining edge cases: editing a set that ends today (field shows 0), and a form left open across midnight (the server uses its own "today", so the end date can shift by a day)
- Enhance edge cases: cancel mid-run, the error path, crops >= 900px, upscaler container down, very small crops; whether enhanced covers look good on text-heavy screenshots (AI upscalers can invent texture)
- Behavior across a real day rollover, container restart, or a set actually expiring
- Docker/Unraid deployment details beyond the user running it on port 8187 (they changed the port because 8099 was taken)
- Cropper edge cases (very large or very small images)
- There is no automated test suite in the repo

## Known limitations / unfinished
- Enhance: one job at a time (second request gets "busy"); abandoning the page mid-job leaves it running until it finishes or times out; Best is slow on CPU; crops >= 900px skip enhancing; no GPU passthrough support configured
- Daily/weekly sets have no separate "number of drops" field; the run length is the largest chased card total. If the drops in a set ever differ from the card total, the "missing" and "remaining" numbers will be off. The user considered and set aside adding a Number of drops field (it would be required, drive slots and `endDate`, and be pre-filled from existing sets on edit).
- Weekly notification only knows if the user is behind overall, not specifically whether this week's card was collected
- Covers cropped before 0.3.0 (5:2) are center-cropped on the portrait cards; re-crop via Edit > Replace
- Saving an existing weekly set recalculates its end date (last drop + 6 days); saving an existing long-term set recalculates it from today + the days in the field
- Replaced covers are not deleted from `images/` (orphans accumulate)
- Expired sets cannot be edited or manually deleted (no Edit button, API returns 403); they are removed automatically once outside the newest 15. A mistyped end date can only be fixed by duplicating (do it before the set expires or while it is still among the newest 15)
- No per-card tracking, no auth, no snooze/quiet hours

## Modifying safely
- Keep rule logic (expiry, drops remaining/missing, progress) in `public/dates.js` so server notifications and the UI stay consistent
- Preserve item `id`s when editing sets (`cleanSet` matches by id) or progress is lost
- Don't change the `data.json` shape without a migration in `load()`; the user's data lives there
- Never put real secrets (ntfy topic/token) in committed files; they belong in `.env`. Keep `.env` in `.gitignore` and `.dockerignore`, and keep `.env.example` blank
- The upscaler must run with explicit tiling (`-t`, set per model in `upscaler/server.js`); an early untiled run in the sandbox hung for minutes
- The upscaler container must not be published to the LAN; only the app talks to it
- All writes go through `save()` (atomic rename)
- Front end has no build step; escape user text with `esc()` before putting it in HTML

## Working agreement with the user (follow these)
- After the user requests a feature, prompt them to test it and report whether it's good
- When they say it's good / looks good, give them a git commit message to use
- If a change needs fewer than 6 edits, give search/replace edits (file, exact find text, exact replacement) instead of a full re-download; 6 or more edits means a full updated project zip
- Keep README.md and handoff.md updated; when asked for an updated handoff.md, update this file rather than starting a new one. The user prefers complete replacement files they can download over edit instructions for these two docs
- The user wants dark, minimal styling with accents: near-black, darker red, off-white (never pure black/white); everything is viewed on a desktop monitor

## Next planned tasks
- Confirm the user's real `docker-compose.yml` sets `UPSCALER_URL=http://upscaler:3000` on the `slam-tracker` service (add it if missing) and that the README/handoff match it
- Get the user's test result for 0.4.2 (auto-prune) and give a commit message when they approve
- Optional: add a "Number of drops" field for daily/weekly sets (see Known limitations)
- Smaller candidates: cleanup of orphaned images (covers replaced during edits are still never deleted; auto-prune only removes covers of pruned sets)
- If Best enhance is too slow on their CPU: consider a smaller/faster model, a `cpus` limit tradeoff, or making Fast the only option (the user said Best took about a minute and plans to use it, so this is low priority)
- The user mentioned wanting to build a larger feature in a new chat; its scope is still not defined in this file (ask them)
