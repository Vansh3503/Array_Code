# TravelPulse

TravelPulse is a personal travel tracker. When an iPhone Shortcut reports your location, a Cloudflare Worker detects travel events and sends a WhatsApp update to each parent individually. Your parents also get a private, auto-refreshing dashboard link.

It runs as a single Cloudflare Worker with these parts:

- **Cloudflare D1** for storage
- **Vanilla JS + Leaflet/OpenStreetMap** for the dashboard
- **Open-Meteo** for weather and timezone
- **WhatsApp Cloud API** for messages

On the Workers Free plan it costs **$0**. WhatsApp is free on Meta's test number, or about ₹0.15 per message on your own number (see [docs/WHATSAPP.md](docs/WHATSAPP.md)).

```
iPhone Shortcut ──POST /api/ping (Bearer DEVICE_TOKEN)──▶ Worker ──▶ D1 (pings, events, cooldowns, outbox)
   (automations: arrive/leave,                            │  ├─▶ Open-Meteo (temp + timezone)
    airplane off, Wi-Fi, battery,                         │  ├─▶ Nominatim (city, only if phone sent none)
    manual, SOS)                                          │  └─▶ WhatsApp Cloud API ──▶ Mom, Dad (individually)
Parents' browser ──/v/<VIEW_TOKEN>──▶ dashboard ──/api/status (30 s refresh)
Cron */10 min ──▶ retry transient WhatsApp failures
```

## Quick start

```bash
cd travelpulse
npm install
npx wrangler login
bash scripts/setup.sh        # creates D1, applies schema, generates + stores secrets, deploys
```

After that:

1. Put the Worker URL in `PUBLIC_BASE_URL` in `wrangler.toml`, then run `npx wrangler deploy`.
2. Set up WhatsApp with [docs/WHATSAPP.md](docs/WHATSAPP.md). Then set `WHATSAPP_MODE = "template"` and deploy again.
3. Build the iPhone Shortcuts and automations with [docs/SHORTCUTS.md](docs/SHORTCUTS.md).
4. Run the tests and the simulation described below, then **reset** the data.

## Configuration

| Where | What |
|-------|------|
| `trip.json` | Traveler name, places (airports, hotel, destinations: coordinates, radius, timezone), itinerary order, and rules (thresholds, cooldowns, hourly message cap). Edit it, then redeploy. |
| `wrangler.toml` `[vars]` | `WHATSAPP_MODE` (`dry_run` / `template` / `text`), API version, template name and language, `PUBLIC_BASE_URL` |
| Secrets (`wrangler secret put`) | `DEVICE_TOKEN`, `VIEW_TOKENS`, `ADMIN_TOKEN`, `RECIPIENTS`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and optionally `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` |
| `migrations/0001_init.sql` | Database schema |
| `public/` | Dashboard files. `scripts/build-assets.mjs` embeds them into the Worker (`src/assets.gen.ts`) automatically before every `wrangler dev` / `wrangler deploy`, so everything ships as one Worker. |

Recipient format: `RECIPIENTS="Mom:+9198XXXXXXXX,Dad:+9198XXXXXXXX"`. Phone numbers stay in this secret. The database and API responses only contain labels and the last 3 digits.

## What triggers a WhatsApp message

| Event | Rule | Cooldown |
|-------|------|----------|
| Airport arrival | Ping inside an airport geofence that the previous ping wasn't in | 4 h per airport |
| Airport departure | Previous ping inside the airport, new ping outside it but within 150 km (ground evidence). A take-off is **never** inferred from a ping far away. | 4 h |
| Hotel / destination arrival | Geofence entry | 6 h / 12 h |
| New country / new city | Country code changed, or city changed **and** moved ≥10 km (stops suburb-name flapping) | 12 h |
| Back online | More than 3 h since the previous ping | once per gap |
| Significant move | ≥50 km from the last notified spot, when nothing more specific applies | 2 h |
| Low battery | Below 15%. Fires once, then re-arms after charging above 25%. | 6 h |
| Manual check-in / SOS | Trigger `manual` / `emergency` | 2 min / 1 min |

Several events from one ping are merged into **one** message. Each event key is claimed atomically in D1 (`event_cooldowns`), so the same event can't be announced twice, even when two automations fire at the same moment. A global cap of 12 messages per hour applies to everything except SOS.

## Security

- **Device token.** Location submissions require `Authorization: Bearer DEVICE_TOKEN`. Tokens are compared in constant time.
- **Validation and replay protection:**
  - Coordinate ranges are enforced and null-island points are rejected.
  - Timestamps must include a timezone offset and be no more than 15 minutes old or 5 minutes in the future.
  - Each request carries a nonce with a unique constraint, so replays get `409`.
  - Implausible jumps faster than 1,300 km/h are stored but ignored for events.
- **Dashboard.** It is reachable only at `/v/<VIEW_TOKEN>`. The data API needs the same token. Pages are sent with `noindex`, `no-store` and `Referrer-Policy: strict-origin`, so the token isn't leaked to the tile servers.
  - **To revoke a link:** run `npx wrangler secret put VIEW_TOKENS` with a new value. The old link stops working immediately. You can keep several links comma-separated (for example one per parent) and remove one at a time.
- **Secrets.** All secrets are Cloudflare secrets, and none are in the repository.
- **Disabling tracking**, in any of these ways:
  - the `TravelPulse Pause` shortcut, which calls `POST /api/tracking {"enabled":false}`
  - `POST /api/admin/tracking`
  - setting `WHATSAPP_MODE=dry_run` to stop messages only

  While tracking is paused, pings are not stored. SOS still goes through.

## API

| Method & path | Auth | Purpose |
|---------------|------|---------|
| `POST /api/ping` | device | `{lat, lon, ts, battery?, accuracy?, trigger?, city?, country?, nonce?, note?, test?}` |
| `POST /api/tracking` | device | `{enabled: bool}` |
| `GET /v/<token>` | view | Dashboard |
| `GET /api/status` | view (`X-View-Token`) | Dashboard data |
| `GET /api/admin/health` | admin | Configuration check, last ping, outbox with delivery status and errors |
| `POST /api/admin/test-message` | admin | Sends a `[TEST]` message to all recipients |
| `POST /api/admin/tracking` | admin | `{enabled: bool}` |
| `POST /api/admin/reset` | admin | `{confirm:"RESET"}`: wipes pings, events, cooldowns and outbox |
| `GET/POST /webhooks/whatsapp` | Meta signature | Delivery receipts (optional) |

## Testing

```bash
npm test                 # unit tests: detection, validation, timezones, message format, WhatsApp client
npm run typecheck
```

**Local end-to-end run** (no real messages are sent):

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev                                       # terminal 1
DEVICE_TOKEN=dev-device-token-1234567890 npm run simulate -- --url http://localhost:8787   # terminal 2
open http://localhost:8787/v/dev-view-token-abcdefghij
```

The simulator replays this route with realistic timestamps:

1. Home
2. AMD, plus a duplicate automation that must be ignored
3. Doha
4. JFK
5. LAS
6. Treasure Island
7. Low battery

It also checks that a replayed request is rejected and that a wrong token is refused.

**Against production, before departure.** This sends real WhatsApp messages, each prefixed with `[TEST]`:

```bash
DEVICE_TOKEN=... npm run simulate -- --url https://travelpulse.<you>.workers.dev --live --arrivals-only
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"confirm":"RESET"}' https://travelpulse.<you>.workers.dev/api/admin/reset
```

## Honest limitations

- iOS gives no continuous background location to Shortcuts. Updates happen only when an automation fires or you tap check-in. Geofence automations can be late or missed after long flights, which is why *Airplane Mode → Off* and the manual tap are the backups.
- The dashboard never claims a flight has landed. Progress only advances on a confirmed ping inside a geofence. When data is older than 30 minutes, it shows a clear "last known location" warning.
- Weather is the temperature at the time of the last ping, not live.
- WhatsApp depends on Meta: template approval, the token, and on the test number a maximum of 5 verified recipients. See [docs/WHATSAPP.md](docs/WHATSAPP.md) for costs and the manual fallback.
- Cloudflare Workers Free plan limits: 100k requests a day, D1 5 GB, and cron triggers are included. They are far above what this needs.
