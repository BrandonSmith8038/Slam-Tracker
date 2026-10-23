# Slam Tracker - Handoff

Last updated: 2026-10-23 (version 0.4.1 - 0.4.0 optional AI cover enhancement was tested and approved by the user; 0.4.1 adds set delete in the Edit dialog and icon-only Edit/Duplicate buttons, awaiting the user's test)

## What it does
LAN-only web dashboard (Docker on Unraid) for tracking progress in the Topps Slam trading card game. The user creates a "set" when it is released, chooses which rarity levels/variations to chase, and logs cards as they are collected. The dashboard shows Active sets (soonest end first) and Expired sets (muted, read-only), with progress bars, countdowns, and ntfy reminders. Used only on a 27" 1440p desktop monitor; no login, no mobile layout.

Game rules that drive the design: levels are Uncommon, Rare, Super Rare, Iconic, Legendary; levels can have variations (e.g. Rare Chrome Green); card counts per set are arbitrary; cards can be traded; every set has an end date; some sets drop one card per day or per week that is only obtainable during that day/week.

## Stack
Node 20 + Express 4 (only dependency), vanilla HTML/CSS/JS front end (no build step), JSON file storage. Docker (`node:20-alpine`). Node's built-in `fetch` is used for ntfy and for the upscaler proxy (Node >= 18).

Second container (`upscaler/`, optional): `ubuntu:24.04` + distro `nodejs` (no npm dependencies) + `mesa-vulkan-drivers` (lavapipe software Vulkan, so no GPU needed) + the `realesrgan-ncnn-vulkan` v0.2.5.0 Linux release binary downloaded from GitHub at build time (models used: `realesr-animevideov3` x2/x3/x4 and `realesrgan-x4plus`). Free and offline at run time.

## Structure
- `server.js` - Express app: JSON store (atomic writes), validation (`cleanSet`), REST API, image upload, `/api/enhance*` proxy to the upscaler, ntfy scheduler
- `upscaler/server.js` + `upscaler/Dockerfile` - separate container: dependency-free Node job server wrapping the Real-ESRGAN binary (one job at a time)
- `public/dates.js` - shared (server `require` + browser `<script>`) logic: timezone-aware "now", date math, drop-slot generation, missing/remaining calculations, progress. **Single source of truth for these rules.**
- `public/index.html`, `style.css`, `app.js` - dashboard, set form modal, image cropper modal, toasts
- `Dockerfile`, `docker-compose.yml` (two services: `slam-tracker` host port 8187 -> container 3000, and `upscaler` not published), `.dockerignore` (also excludes `upscaler/` from the app image), `.gitignore`, `package.json`, `package-lock.json`, `README.md`, `handoff.md`

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
`GET /api/state` (now includes `enhance: true|false`); `POST /api/sets`; `PUT /api/sets/:id`; `DELETE /api/sets/:id` (404 unknown, 403 expired; also clears that set's `notified` keys and deletes its cover file unless another set still uses the same cover); `POST /api/sets/:id/items/:itemId` ({delta} or {value}); `POST /api/upload` (raw png/jpeg/webp body); `POST /api/ntfy/test`. Item route returns the updated set. Expired sets reject edits/progress with 403.

Enhance (proxied to the upscaler, 503 if `UPSCALER_URL` is unset, 502 if unreachable): `POST /api/enhance?model=fast|best&scale=2..4` (raw PNG/JPEG body, <= 12 MB) -> `{id}` (429 if the upscaler is busy, 400 for a bad image); `GET /api/enhance/:id` -> `{status: running|done|error, progress 0-100, error}`; `GET /api/enhance/:id/result` -> PNG; `DELETE /api/enhance/:id` cancels/discards. Upscaler's own API is the same under `/jobs` plus `/health`; finished jobs are dropped after 20 minutes.

## How components interact
The browser loads `/api/state` (refreshes every 60s and on tab focus), renders everything client-side with `dates.js`, and posts small changes. The cover is cropped in the browser (canvas) and uploaded as a JPEG only when the set form is saved. The server's scheduler (every 60s) uses the same `dates.js` helpers to decide which ntfy messages are due.

Enhance flow: in the cropper, "Use crop" grabs the crop at native pixels; if enhancing is on (Off/Fast/Best buttons, default Fast, remembered per page load in `enhMode`) and the crop's long side is under 900px, the PNG is posted to `/api/enhance`, the dialog shows a progress bar (polls every 1.2s) with Cancel, then a before/after comparison with Use enhanced / Use original / Cancel. The chosen image is shrunk to <= 1400px JPEG (.92) like before and held until the set form is saved (same upload path as before). Errors offer "Use original crop". Fast picks scale 2-4 so output is about 1000px; Best always runs 4x.

## Key decisions / behavior
- Expiry: a set is expired when today (in `TZ`) is after its `endDate`. Default TZ `America/Phoenix`.
- Progress counts unique cards per chased level/variation (no per-card tracking). Overall = completed bars / chased bars. Every set must chase at least one level.
- Daily/weekly sets: the drops ARE the cards of the chased level/variation (there is no separate drop bar or per-drop chips). Cards you should have by now = drops released so far (capped at the item total); if owned is lower a red "N missing" badge (sum across items; tooltip lists which) shows in the card's top-right corner and the behind rows get a reddish label. The card shows "X weeks/days remaining" (drops whose availability window hasn't closed; daily window = that day, weekly = release day + 6) instead of an end date.
- Start date is kept for daily/weekly so a set added late can be backdated to when the first card dropped.
- Look: portrait trading-card cards (`aspect-ratio: 5/7`, cover flexes to fill, card grows if many bars). The 25% size reduction is done with `zoom: .75` on `.grid` (works in Firefox 126+/Chromium). Page background is a dark overlay (`linear-gradient(rgba(0,0,0,.4) ...)`) over an inline-SVG diamond-plate tile (see `body` in `style.css`; raise the .4 for darker/subtler). The add/edit set modal is scaled with `#modal .dialog{zoom:.75; max-height:calc(92vh / .75)}` so it fits without scrolling (the cropper dialog is intentionally not scaled). Cropper default is 1:1. The plain (non-enhanced) crop is now capped at 1400px on its longest side (was width only).
- Weekly release-day highlight (red glow + badge "NEW CARD TODAY", or "Collected today" if caught up) shows only on the release date.
- ntfy: weekly -> on release day if behind on any chased item and set incomplete; long-term -> daily from 5 days before the end date through the end date listing missing cards, skipped if complete; daily -> none. Sent once per day after `NOTIFY_TIME`; only logged as sent if ntfy accepted it. Uses ntfy's JSON publish API.
- Level colors: Uncommon green, Rare blue, Super Rare purple, Iconic red, Legendary gold. Completed bars use a different, muted green with a checkmark.
- Editing: item ids are preserved so progress survives edits; removing a level/variation deletes its progress. Saving a daily/weekly set recalculates slots and `endDate` from the start date, release day and the largest item total.
- Expired sets are read-only, cannot be deleted or edited (Duplicate is allowed). Active sets can be deleted from the Edit dialog (button on the left of the dialog actions; first click turns it into "Click again to delete for good", second click deletes). Card footer Edit/Duplicate are icon-only (inline SVGs in `ICONS` in `app.js`, with title/aria-label tooltips).

## Verified
- By the user: 0.4.0 Enhance tested in their real setup; both Fast and Best worked (Best took about a minute on their server, and they plan to mostly use Best), so the Docker build of `upscaler/` and the UI flow are confirmed working
- NOT yet seen by the user: 0.4.1 delete button and icon buttons (sandbox-tested only: API delete incl. shared-cover/404/403 cases; jsdom confirms icon-only buttons, delete shown only in Edit mode, two-click confirm sends DELETE and closes the dialog)
- By the user (real Firefox, 27" monitor): the user reported everything is good through 0.3.1. They viewed screenshots of the weekly card (missing badge, 0.2 layout) and the edit modal, uploaded and cropped a cover, edited a weekly set, and approved the card shape/size, diamond-plate texture and modal size after the final tweaks. Exactly which other scenarios they exercised is not known.
- By Claude in a sandbox (scratch scripts, NOT saved in the repo): JS syntax checks; API for long-term/weekly/daily creation (slots and derived end dates), validation errors, +1 clamped at item total, expired sets return 403, image upload/retrieval; ntfy messages against a local fake ntfy server (long-term 2 days left, weekly release day); headless DOM (jsdom) render of the real front end with no JS errors
- By Claude in a sandbox for 0.4.0: `realesrgan-ncnn-vulkan` runs with lavapipe on a 1-core CPU. On the user's 249x249 sample: `realesr-animevideov3` 4x took ~15 s and looks crisper but a bit painterly; `realesrgan-x4plus` looks best (keeps texture) but took ~170 s for just a 130x80 crop (estimated ~19 min for the full image) on that 1 core. End-to-end through the real app server + upscaler server (run directly with node, not in Docker): start job, busy 429, progress 0->50->100, result PNG at 4x size, bad-image 400, cancel kills the process, unconfigured app returns 503 and `enhance:false`; jsdom: cropper shows Off/Fast/Best buttons and toggles, cancel resolves null, no JS errors

## NOT verified
- Enhance edge cases the user may not have hit: cancel mid-run, the error path, crops >= 900px, upscaler container down, very small crops
- Whether enhanced covers look good on text-heavy screenshots (AI upscalers can invent texture)
- Visual look of the new icon buttons and the Delete button styling in a real browser
- Real ntfy delivery to the user's phone/computer (the Test ntfy button's result was never reported back)
- Behavior across a real day rollover, container restart, or a set actually expiring
- Docker/Unraid deployment details beyond the user running it on port 8187 (they changed the port because 8099 was taken)
- Cropper edge cases (very large or very small images)
- There is no automated test suite in the repo

## Known limitations / unfinished
- Enhance: one job at a time (second request gets "busy"); abandoning the page mid-job leaves it running until it finishes or times out; Best is slow on CPU; crops >= 900px skip enhancing; no GPU passthrough support configured (the binary would use a real Vulkan GPU if one were exposed and `VK_ICD_FILENAMES` unset, untested)
- Weekly notification only knows if the user is behind overall, not specifically whether this week's card was collected
- Covers cropped before 0.3.0 (5:2) are center-cropped on the portrait cards; re-crop via Edit > Replace
- Saving an existing weekly set recalculates its end date (last drop + 6 days), which may differ from a previously typed end date
- Replaced covers are not deleted from `images/` (orphans accumulate)
- Delete exists only in the Edit dialog, so expired sets (no Edit button, API returns 403) cannot be deleted or edited by design; a mistyped past end date can only be fixed by duplicating. Allowing delete for expired sets was raised as an open question
- No per-card tracking, no auth, no snooze/quiet hours

## Modifying safely
- Keep rule logic (expiry, drops remaining/missing, progress) in `public/dates.js` so server notifications and the UI stay consistent
- Preserve item `id`s when editing sets (`cleanSet` matches by id) or progress is lost
- Don't change the `data.json` shape without a migration in `load()`; the user's data lives there
- The upscaler must run with explicit tiling (`-t`, set per model in `upscaler/server.js`); an early untiled run in the sandbox hung for minutes
- The upscaler container must not be published to the LAN; only the app talks to it
- All writes go through `save()` (atomic rename)
- Front end has no build step; escape user text with `esc()` before putting it in HTML

## Working agreement with the user (follow these)
- After the user requests a feature, prompt them to test it and report whether it's good
- When they say it's good / looks good, give them a git commit message to use
- If a change needs fewer than 6 edits, give search/replace edits (file, exact find text, exact replacement) instead of a full re-download; 6 or more edits means a full updated project zip
- Keep README.md and handoff.md updated; when asked for an updated handoff.md, update this file rather than starting a new one
- The user wants dark, minimal styling with accents: near-black, darker red, off-white (never pure black/white); everything is viewed on a desktop monitor

## Next planned tasks
- Get the user's test results for 0.4.0 (build the two containers, try Fast and Best on a real phone screenshot) and fix whatever the first Docker build or UI test turns up; then give them a commit message when they approve
- If Best is too slow on their CPU: consider a smaller/faster model, a `cpus` limit tradeoff, or making Fast the only option
- Get the user's test result for 0.4.1 (delete flow, icons) and give a commit message when they approve
- Smaller candidates: cleanup of orphaned images (covers replaced during edits are still never deleted), allow delete/archive for expired sets
- The user mentioned wanting to build a larger feature in a new chat; its scope is still not defined in this file (ask them)
