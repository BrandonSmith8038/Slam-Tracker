# Slam Tracker

A small LAN-only dashboard for tracking set progress in the Topps Slam trading card game. Runs as a Docker container (built for Unraid) and serves a dark, desktop-oriented web page.

## Features
- Create/edit/duplicate sets: name, cover image (upload + crop), levels to chase (Uncommon, Rare, Super Rare, Iconic, Legendary), optional variations per level, card total per variation/level
- Set types: **Long-term** (has an end date), **Weekly drops** (start date + release weekday; runs one week per card) and **Daily drops** (start date; runs one day per card). The length is the biggest card total among the chased levels/variations
- Portrait trading-card-shaped cards in a grid on a subtle diamond-plate background, with Active (soonest end first) and Expired (muted, read-only) sections
- Progress bars with centered `owned/total`, +1/-1 buttons, muted green + check when complete, and overall set progress (completed bars / chased bars)
- Daily/weekly sets show "X weeks/days remaining" and show an "N missing" badge in the card's top-right corner when you have fewer cards than drops released so far
- Sets expire after the end of their last day (in the configured timezone); a weekly set ends 6 days after its last drop
- ntfy reminders (see below)

## Run with Docker
```bash
docker compose up -d --build
```
Then open `http://<server-ip>:8187`. Edit `docker-compose.yml` first to set `NTFY_TOPIC` and your appdata path.

On Unraid you can use the Compose Manager plugin with this compose file, or `docker build -t slam-tracker .` and add the container manually (port 3000, path `/mnt/user/appdata/slam-tracker` -> `/data`, plus the variables below).

## Run locally
```bash
npm install
npm start        # http://localhost:3000, data in ./data
```

## Configuration (environment variables)
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port inside the container |
| `DATA_DIR` | `/data` (Docker) / `./data` | Where `data.json` and `images/` live |
| `TZ` | `America/Phoenix` | Timezone for end-of-day expiry and notification time |
| `NTFY_SERVER` | `https://ntfy.sh` | ntfy server URL |
| `NTFY_TOPIC` | _(empty)_ | Topic to publish to; notifications are off if empty |
| `NTFY_TOKEN` | _(empty)_ | Optional bearer token |
| `NOTIFY_TIME` | `09:00` | Time of day (24h, in `TZ`) reminders are sent |

## Notifications
Checked every minute; each is sent at most once per day, after `NOTIFY_TIME`.
- **Weekly sets:** on a release day, if you are behind (fewer cards than drops released so far) and the set isn't complete
- **Long-term sets:** starting 5 days before the end date through the end date, listing what's still missing; skipped if the set is complete
- **Daily sets:** none

Use the **Test ntfy** button to verify settings.

## Data
Everything is in `DATA_DIR`: `data.json` (sets, progress, sent-notification log) and `images/` (cropped covers). Back up that folder. No database.
