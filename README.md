# Slam Tracker

A small LAN-only dashboard for tracking set progress in the Topps Slam trading card game. Runs as a Docker container (built for Unraid) and serves a dark, desktop-oriented web page.

## Features
- Create/edit/duplicate/delete sets (card footer has Duplicate and Edit icon buttons; Delete is inside the Edit dialog and asks for a second click to confirm; ended sets can't be edited or deleted by hand; see Ended and expired sets below): name, cover image (upload + crop, optional AI enhance), levels to chase (Uncommon, Rare, Super Rare, Iconic, Legendary), optional variations per level, card total per variation/level
- Set types: **Long-term** (you enter the days and hours remaining, exactly as the game shows them, and the app works out the exact end time), **Weekly drops** (start date + release weekday) and **Daily drops** (start date). Weekly/daily sets also take **Cards per drop** (default 1; use 2 for sets that release two cards each day or week). The length is the biggest card total among the chased levels/variations divided by cards per drop, rounded up: 14 cards at 2 per drop runs 7 days
- Portrait trading-card-shaped cards in a grid on a subtle diamond-plate background, with Active and Expired (muted, read-only) sections. Active order: weekly sets with a card live today first, then running sets by soonest end, then greyed-out sets in their grace day last
- **3D card effect:** live cards look like raised slabs and, on hover, lift, tilt toward the pointer and show a soft off-white glare (see Card hover effect below)
- **Collapse / Expand:** a header button stacks the Active cards into one overlapping row (soonest-ending on top, at the left) and expands them back into the grid, with a glide animation (see Collapse / Expand below)
- Progress bars with centered `owned/total`, +1/-1 buttons, muted green + check when complete, and overall set progress (completed bars / chased bars)
- Daily/weekly sets show "X weeks/days remaining" and an "N missing" badge in the card's top-right corner when you have fewer cards than have been released so far (drops released x cards per drop, capped at each level's total). New drops count as released at 11:00, not midnight (see Drop time)
- Daily and weekly sets show a red pulsing **NEW CARD TODAY** badge from 11:00 on a drop day until you've collected today's card, then a green **Collected today ✓** badge until midnight
- Sets end at their end time (see below), then spend one more day greyed out at the end of the Active section before moving to Expired; a weekly set ends 6 days after its last drop
- ntfy reminders (see below)
- **Cover enhance (optional):** after cropping a phone screenshot, the cropper can upscale it 2-4x with Real-ESRGAN (runs on CPU in a second container, free, no internet needed at run time) and shows a before/after to pick from

## Run with Docker
```bash
cp .env.example .env     # then edit .env and set NTFY_TOPIC (and NTFY_TOKEN if you use one)
docker compose up -d --build
```
Then open `http://<server-ip>:8187`. Edit `docker-compose.yml` first to set your appdata path.

Your ntfy settings live in `.env` (next to `docker-compose.yml`). That file is gitignored and dockerignored, so your topic is never committed. Compose reads it automatically and fills in the `${NTFY_...}` values in `docker-compose.yml`. Only `.env.example` (blank values) is in the repo. On public ntfy.sh the topic name acts like a password, so use a long random one and don't share it.

The compose file starts two containers: `slam-tracker` (the app) and `slam-upscaler` (the optional enhancer, built from `./upscaler`; the first build downloads the Real-ESRGAN tools). The app talks to the enhancer through `UPSCALER_URL=http://upscaler:3000`, which must be set in the `slam-tracker` service's `environment` in `docker-compose.yml`. To run without the enhancer, delete the `upscaler` service and the `UPSCALER_URL` line; the Enhance option then disappears from the cropper.

The front end files in `public/` are baked into the image, so after changing them run `docker compose up -d --build` and hard-refresh the browser (Ctrl+F5).

On Unraid you can use the Compose Manager plugin with this compose file (put `.env` in the stack's folder, or use the stack's env file option), or `docker build -t slam-tracker .` and add the container manually (port 3000, path `/mnt/user/appdata/slam-tracker` -> `/data`, plus the variables below).

## Run locally
```bash
npm install
npm start        # http://localhost:3000, data in ./data
```
When running locally, `.env` is not read by Node; export the variables in your shell (for example `NTFY_TOPIC=mytopic npm start`).

## Configuration (environment variables)
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port inside the container |
| `DATA_DIR` | `/data` (Docker) / `./data` | Where `data.json` and `images/` live |
| `TZ` | `America/Phoenix` | Timezone for end dates, the moment daily/weekly sets end, the 11:00 drop time and notification time |
| `NTFY_SERVER` | `https://ntfy.sh` | ntfy server URL |
| `NTFY_TOPIC` | _(empty)_ | Topic to publish to; notifications are off if empty. With Docker, set it in `.env`, not in `docker-compose.yml` |
| `NTFY_TOKEN` | _(empty)_ | Optional bearer token. With Docker, set it in `.env` |
| `NOTIFY_TIME` | `09:00` | Time of day (24h, in `TZ`) reminders are sent (set in `docker-compose.yml`) |
| `KEEP_EXPIRED` | `15` | How many sets to keep in the Expired section (newest by end date); older ones are deleted automatically along with their cover image. A number (0 = delete every expired set), or `off` to never delete |
| `UPSCALER_URL` | _(empty)_ | URL of the upscaler container (`http://upscaler:3000` with the compose file); Enhance is off if empty |

The drop time is not an environment variable: it is the `DROP_HOUR` constant (11) near the top of the drop helpers in `public/dates.js`. Change it there and rebuild.

Upscaler container (`upscaler/`): `JOB_TIMEOUT_MIN` (default 45) kills a stuck job; `PORT` (3000).

## Long-term sets and time remaining
The form asks for **Days remaining** and **Hours remaining** (for example 4 days 3 hours, as the game shows it), not an end date. When you save, the app stores the exact end moment (now + that time) and the card counts down to it, such as "4d 3h left". The set ends at that exact moment, not at the end of the day. Either field can be left blank (blank = 0), but the total must be more than 0 and hours must be 0-23. When you edit a set, the fields are pre-filled with the time left; saving without changing them keeps the exact same end moment, and changing either one restarts the countdown from now. Long-term sets saved before this change have only an end date: they keep ending at the end of that day, and show the time left until then.

## Cards per drop
Daily and weekly sets have a **Cards per drop** field (1 to 20, default 1). With 2 per drop, the set releases two cards each day (or week), so by the end of day 2 you should own 4. Sets created before this field existed have no value stored and behave as 1 per drop. Changing the value on an existing set recalculates its drops and end date; collected cards are kept.

## Drop time
Daily and weekly drops go live at 11:00 in `TZ`, not at midnight. Before 11:00 on a drop day, the app still measures you against the previous drops, so a daily set won't show a missing card until 11:00. From 11:00 until midnight the day's card shows the NEW CARD TODAY / Collected today badge, and a weekly set with a live card moves to the front of the Active section. How many days or weeks remain, and when a set ends, still follow calendar days.

## Card hover effect
Live cards (not greyed-out grace-day cards and not Expired cards) have a layered shadow so they look slightly raised. When you hover one it lifts a few pixels, tilts up to about 5 degrees toward the pointer and shows a soft off-white glare that follows the pointer. The tilt is re-applied after every +1/-1 click and every 60-second refresh so the card doesn't snap flat while you are on it. Grace-day and Expired cards stay flat so their grey tint is unaffected.

The effect is switched off when the operating system asks for reduced motion. On Windows that is **Settings > Accessibility > Visual effects > Animation effects**: if that is turned off, the browser reports reduced motion and the tilt, lift, glare and the Collapse/Expand animation are all skipped. Turn Animation effects on to see them.

## Collapse / Expand
The **Collapse** button in the header stacks the Active cards into one overlapping row; the button then reads **Expand** and puts the cards back in the grid. Only the Active section is affected (Expired always stays a grid).
- The soonest-ending card (or a weekly set with a card live today) is the top card at the left; the rest fan out to the right in Active order, with greyed-out grace-day sets at the very back (far right).
- Stacked cards are a fixed width; the overlap adjusts to the number of sets so the stack always fits the window (each buried card shows up to about 110px).
- In the stack, the set type is shown in the top-right corner of every card, shortened to Weekly / Daily / Long-term so it fits the visible strip. The status badges (N missing, NEW CARD TODAY, Complete) move to the top-left, so on buried cards they are hidden until you hover. Expanding restores the normal badge layout and the full type text (for example "Weekly drops · Fridays").
- Hovering a card brings it to the front and lifts it, so you can read it and even use +1/-1; for everyday updates the expanded grid is easier.
- Switching views plays a short glide animation (cards slide and resize from their old position to the new one, about 0.45s). It is skipped when the system asks for reduced motion (see above). The Expired section below does not animate; it just jumps when the Active section changes height.
- Your choice is remembered in the browser (`localStorage`, key `slamStacked`), per browser; it is not stored in `data.json`.

## Ended and expired sets
A set **ends** at its exact end time (long-term sets saved with days/hours) or at midnight (in `TZ`) after its end date (daily and weekly sets, and older long-term sets). Ending has two stages:

1. **Grace day (24 hours after it ends):** the card stays in the Active section, sorted after the sets still running, greyed out. It is tinted green-grey if everything you were chasing is complete, or red-grey if any cards are missing. Its label reads "Ended 3h 12m ago" and counts up (it refreshes about once a minute with the dashboard). It is read-only: no +1/-1 and no Edit, but Duplicate still works. It no longer counts toward the Running, Need to finish and Completed totals, and it gets no ntfy reminders.
2. **Expired:** after the 24 hours it moves to the Expired section (muted grey, read-only, labelled "Ended <date>").

The app keeps only the newest `KEEP_EXPIRED` (default 15, by end date) sets in the Expired section and permanently deletes older ones, their sent-notification records, and their cover image (unless another set still uses that image). Only sets that have fully moved to Expired are counted or deleted; a set in its grace day is never pruned. Checked at startup and every 10 minutes. This cannot be undone, so back up `DATA_DIR` if you care about old sets.

## Cover enhance
In the cover cropper choose **Off**, **Fast** or **Best** before clicking *Use crop*.
- **Fast** (`realesr-animevideov3`): seconds on CPU, crisp edges, can look a little painterly on textured art
- **Best** (`realesrgan-x4plus`): keeps texture/grain but is slow on CPU (minutes for a small crop; scales with image size and CPU cores)
- Crops already 900px or larger on the long side skip enhancing. The upscaler handles one image at a time; a progress bar and Cancel button are shown. If it fails you can still use the plain crop.

## Notifications
Checked every minute; each is sent at most once per day, after `NOTIFY_TIME`.
- **Weekly sets:** on a release day, once the drop is live (11:00 or later in `TZ`) and `NOTIFY_TIME` has passed, if you are behind (fewer cards than released so far) and the set isn't complete. With the default `NOTIFY_TIME` of 09:00 the reminder goes out at about 11:00
- **Long-term sets:** starting 5 days before the end date through the end date, listing what's still missing; skipped if the set is complete or has already ended (a set that ends in the early morning has ended before the 09:00 reminder, so the last alert for it is the day before)
- **Daily sets:** none

Use the **Test ntfy** button to verify settings.

## Data
Everything is in `DATA_DIR`: `data.json` (sets, progress, sent-notification log) and `images/` (cropped covers). Back up that folder. No database. The upscaler keeps nothing (temporary files only). The app reads `data.json` only at startup, so stop the container before editing it by hand. On Unraid the file is owned by root, so edit it from the Unraid web terminal rather than over a network share. The only thing kept outside `DATA_DIR` is the Collapse/Expand choice, which lives in each browser's `localStorage`.
