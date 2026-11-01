# 🚕 Taxi of Mum & Dad

A fun family PWA. Start the meter when you drive the kids somewhere, and it times the trip and tracks the
distance. At the end you add cheeky surcharges, rate your passenger and print a receipt. Send it on
WhatsApp or show a QR code. The fare goes on the kid's tab, and they pay it off with jobs: dishes, a tidy
room, visiting Granny in the home, an outdoor afternoon instead of games…

**Principles:** minimal friction, KISS, fun.

## How it works

| Who | What they do |
|---|---|
| **Parents** (Mum *and* Dad, one shared family) | Run the meter, rate passengers, send receipts, tick off jobs, tweak fares |
| **Kids** (no app, no login) | Open the receipt link, see their running tab and the ways to pay, rate the driver & journey |

- **Meter**: GPS distance (with jitter/teleport filtering) + clock. Fare = flag fall + per-km + per-minute + extras.
  The meter state lives on the phone, so a refresh or a dead zone never loses a trip. The screen stays awake while it runs.
- **Surcharges**: drive-thru detour, DJ rights, plus-one friend, late night (auto-ticked after 10pm), kept the driver waiting…
- **Ratings**: the parent rates the passenger (5★ = 10% off). The kid rates the driver + journey from the receipt.
  The home screen shows a **Driver of the month** league, so Mum vs Dad is settled by data.
- **Ledger**: balance = sum of entries. Fares are +, jobs are −. Undo a job with one tap; delete a trip to remove its fares.
- **Privacy**: no GPS positions are stored, only total km and minutes. Receipt links are unguessable tokens and are `noindex`.
- **Joining**: the second parent joins via invite code, a WhatsApp link (`/?join=CODE`) or a QR code.

## Stack

Flask · Flask-SQLAlchemy · Postgres (SQLite locally) · vanilla JS PWA (no build step) · segno for QR codes · gunicorn on Render.

```
app.py              routes + fare logic (app factory)
models.py           tables, default jobs, surcharges
templates/          index.html (PWA shell), receipt.html (kid-facing receipt)
static/             app.js, style.css, sw.js, manifest, icons
tests/test_app.py   pytest suite
render.yaml         Render blueprint (web service + Postgres)
```

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
flask --app app run --debug          # http://127.0.0.1:5000 (SQLite file taxi.db)
pytest
```

GPS needs HTTPS on a real phone, so test the meter on the Render URL (or use the "enter trip by hand" link locally).

## Deploy to Render

1. Push this folder to a new GitHub repo.
2. In Render: **New → Blueprint** and pick the repo. `render.yaml` creates the web service and a Postgres DB,
   generates `SECRET_KEY` and wires `DATABASE_URL`.
3. Open the URL on your phone and choose **Add to Home Screen**.

> Render's free Postgres expires after a set period. For keeps, either upgrade the DB or point `DATABASE_URL`
> at a free Neon database (delete the `databases:` block and the `fromDatabase` entry, then set `DATABASE_URL` by hand).

Tables are created automatically on first boot (`db.create_all()`). There are no migrations yet. If you change a
model later, add Flask-Migrate.

## Where it runs (EU)

- App: Render web service `taxi-mum-dad-eu` in **Frankfurt**: https://taxi-mum-dad-eu.onrender.com
- Database: Neon project `taxi-mum-dad` in **AWS eu-central-1 (Frankfurt)**
- The original US service `taxi-mum-dad` (Oregon) only redirects to the EU app (`REDIRECT_TO`), so old links and QR codes keep working.

## Privacy & GDPR

- `/privacy` and `/terms` (drafts, pending professional review). Kids get a plain-language version on receipts and at `/privacy#kids`.
- Settings → Your data: download everything (JSON), delete a child, or delete the whole family (hard delete).
- No GPS stored, no tracking cookies, fonts self-hosted (no Google calls). `?ref=` is counted server-side only.
- Retention: signatures deleted when a promise closes, receipt links expire after 6 months, families inactive for 12 months are deleted (runs daily via `/healthz`).
- `TEST_DATABASE_URL=postgresql+psycopg://... pytest` runs the suite against real Postgres.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `sqlite:///taxi.db` | `postgres://` URLs are rewritten for psycopg 3 |
| `SECRET_KEY` | dev value | **required** on Render (the app refuses to start without it) |
| `TZ_NAME` | `Europe/Dublin` | receipt timestamps |
| `STATS_KEY` | (none) | enables `/stats?key=...` |
| `CONTACT_EMAIL` | (none) | shown on the privacy notice and terms |
| `REDIRECT_TO` | (none) | set only on the old US service: forwards every request to the EU app |

## Ideas for v2

- Push notification to the other parent when a review comes in
- Monthly "statement" receipt for each kid
- Offline queue for issuing receipts in dead zones
- Badges: 10 phone-free trips, first granny visit, all square for a month…
