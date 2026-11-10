# 🚕 Taxi of Mum & Dad

**A fun family web app: every lift goes on the kids' tab, and they pay it off with jobs.**

A parent starts the meter when they drive the kids somewhere. The app times the trip and measures the distance, and the
front-seat passenger can tap cheeky surcharges along the way ("Backseat driver +3"). At the end the app prints a receipt
that goes to the kid on WhatsApp or by QR code. The fare lands on the kid's tab, and they pay it off with jobs: dishes, a
tidy room, an outdoor afternoon instead of games, or visiting Granny.

- **Live (EU-hosted):** https://taxi-mum-dad-eu.onrender.com
- **Principles:** minimal friction, KISS, fun, privacy by design
- **Status:** live and in early testing with families (November 2026)

## Who uses it

| Who | What they do |
|---|---|
| **Parents** (two drivers share one family) | Run the meter, add surcharges, rate passengers, send receipts, tick off jobs, set fares |
| **Kids** (no app, no login) | Open their receipt link, see their tab, rate the driver and journey, sign up to pay it off with a job |

There's no login for kids by design. Their secret receipt link is their only way in, so the app needs no child accounts,
passwords or emails.

## Features

- **Trip meter:** GPS distance with jitter and "teleport" filtering, plus a clock. Fare = flag fall + per km + per minute
  + surcharges. Meter state lives on the phone, so a refresh or a dead zone never loses a trip. The Screen Wake Lock API
  keeps the screen on while driving.
- **Live surcharges while driving:** five big tap buttons (surprise guest, bad directions, music takeover, backseat driver,
  drive-thru) with counters, haptic feedback and undo. The driving screen fits one phone screen and nudges the
  front-seat passenger to do the tapping.
- **Receipts:** a thermal-receipt style page with the fare breakdown, splits between siblings, a 5-star passenger discount,
  the running tab, a WhatsApp send button (pre-filled message, straight to the kid's chat if a number is saved) and a
  QR code for showing it in the car.
- **Ratings:** the parent rates the passenger; the kid rates the driver and the journey. A "Driver of the month" league
  settles Mum vs Dad.
- **Promises:** from the receipt, a kid picks a job, says when (today, tomorrow, by the weekend) and signs with a
  finger on a canvas. Credits only come off when a parent confirms, so a forwarded link can't clear a tab.
- **Ledger:** balance = sum of entries (fares +, jobs −). Jobs can be undone; deleting a trip removes its fares.
- **Installable PWA:** web app manifest, service worker (app shell offline, API always live), maskable icons, and an
  install button that uses the native prompt on Android and shows step-by-step help on iPhone and inside WhatsApp's browser.
- **Built-in sharing:** branded WhatsApp receipt footer, a "know a parent who's a taxi too?" share card, and Open Graph
  preview images for link cards.

## Car Bingo (in-car I-spy, hands-free)

A separate module (`bingo/` Flask blueprint + `static/bingo.js`) that pops up from the running meter.

- **Memorise, then hide:** players get 4–10 things to spot from an Irish car window (56 items, from "red car" to
  "round tower"), have 15–40 seconds to memorise them, then the list hides. Points: everyday 1, common 2, lucky 3,
  rare 5, plus +1 for every item spotted from memory. Peeking at the list costs the memory bonus.
- **Hands-free by voice:** players shout "*name, thing!*" ("Jack, red door!"). The Web Speech API turns speech into
  text on the phone. The app tries every alternative the recogniser offers and fuzzy-matches player names and item
  keywords (plurals, near-misses). It asks "who spotted it?" when no name was heard, and announces each spot with
  speech synthesis. Voice commands: "peek", "undo". "Teach my name" stores how the phone hears hard-to-recognise
  names (e.g. Irish names) on the device only.
- **Fallbacks:** big tap buttons when voice isn't supported, the mic is refused or the speech service keeps failing.
  Results are queued offline and sent when signal returns.
- **Adaptive difficulty:** clear the card in 10 minutes and the next card is bigger and rarer (level up). Time out
  and the family drops back one level, never to the start.
- **Separate scoring:** a "Spotter of the month" leaderboard that never touches the Taxi Tokens tab.
- **Privacy:** no audio or transcripts ever reach the server, only "who spotted which item". Bingo data is
  included in the family's data export and deleted along with a child or the whole family.

## County Collector (spot the plates)

A second in-car game (`county/` blueprint + `static/county.js`), opened from the running meter next to Car Bingo.

- **Fill the family passport:** spot Irish number plates and collect all 26 counties of the Republic, shown as tiles
  grouped by province. Northern Ireland plates are left out because they don't show a county.
- **Scoring:** common counties (Dublin, Cork) 1 point, rarer ones up to 5 (Leitrim, Longford, Carlow). A county
  nobody in the family has collected yet scores double. Each county counts once per trip, so passing a car park full
  of Dublin plates doesn't run up the score. Collect all 26 and a new passport starts.
- **Hands-free:** shout "*name, county*" ("Jack, Kerry!") or the plate letters ("Jack, K Y!"). Letter names
  ("kay why", "oh why") are joined into plate codes, and common mishearings ("carry" for Kerry, "leash" for Laois)
  are matched. It asks "who spotted it?" when no name is heard, and says "undo" to take one back.
- **Shared voice core:** `static/games-core.js` holds the speech listener, announcer and fuzzy name matching for both
  games. Names taught in one game work in the other.
- **Radio-friendly listening:** on Android, browser speech recognition stops after a few seconds of silence, and each
  restart reopens the microphone. Cars (including Android Auto) treat that like a call and cut the radio every 10–15
  seconds. Where the browser supports `SpeechRecognition.start(track)`, the games open the phone's own mic once and
  feed that stream to the recogniser, so restarts never touch the car's audio. Other phones get push to talk. Spoken
  feedback defaults to "only when it needs an answer" ("Leitrim! Who spotted it?"); everything else is a buzz and the
  screen. During a phone call the games release the mic, pause (Car Bingo stops its clock) and resume afterwards.
  A live check guards the radio-friendly mode: if the recogniser never receives audio from the open mic within four
  seconds (some phones accept the API but don't use it), the game remembers that and switches to push to talk. A
  "Voice check" panel shows the mic level and a log of recogniser events, with a copy button for bug reports.
- **Privacy:** only "who spotted which county" reaches the server. No number plates, audio or transcripts are stored.

## Architecture

```
Phone (PWA: vanilla JS, service worker, Geolocation + Wake Lock)
   │  JSON API (cookie session for parents)        receipt links (/r/<token>) for kids
   ▼
Flask app factory on Render (Frankfurt) ── gunicorn
   │  Flask-SQLAlchemy
   ▼
PostgreSQL on Neon (AWS eu-central-1, Frankfurt)
```

- **Backend:** Flask app factory, Flask-SQLAlchemy models (family, parent, kid, task, trip, passenger, promise,
  ledger entry, event), server-side fare calculation (the client preview mirrors it, including half-up rounding).
- **Frontend:** single-page vanilla JavaScript with no build step, delegated event handling, localStorage for the
  running meter and an offline-first cached state.
- **QR codes:** generated server-side as SVG with segno.
- **Security:** unguessable tokens for receipts and invites, family scoping on every query, input clamping and
  validation, HttpOnly + SameSite cookies, ProxyFix for HTTPS behind Render, no secrets in the repo.

## Privacy by design (GDPR)

The app handles children's first names, so it was designed to collect as little as possible and to follow the Irish
Data Protection Commission's "Children's Fundamentals".

- **EU hosting:** app and database both in Frankfurt. The original US-hosted service now only redirects, so old links still work.
- **Data minimisation:** no GPS positions stored (only total km and minutes), no emails, passwords or payment data.
  Promise signatures are deleted as soon as a promise closes.
- **No tracking:** no analytics cookies, no third-party scripts, fonts self-hosted (no requests to Google).
  Link sources (`?ref=`) are counted on the server and never stored on the device.
- **User rights built in:** download all of a family's data as JSON, delete a single child, or delete the whole family
  (hard delete in foreign-key-safe order).
- **Retention:** receipt links expire after 6 months, and families inactive for 12 months are deleted automatically by a
  daily housekeeping job.
- **Transparency:** a plain-English privacy notice with a section written for kids, terms of use (including "never use
  it while driving"), and a short privacy note on every receipt.

## Product analytics

A private `/stats` page (protected by a key) shows anonymous counts only:

- families, active families this week and trips per day (an SVG bar chart)
- receipt open rate and promises kept
- a **source funnel** for each `?ref=` link: visits → new families → logged a trip → active this week
- **weekly cohort retention** (the share of each week's new families still logging trips in weeks 0–4)

## Testing

- **pytest:** 36 tests (including Car Bingo levels and County Collector scoring, season roll-over, family isolation and GDPR clean-up) covering fare maths, splits and discounts, ledger and undo, surcharge caps, promises and
  their limits, access control between families, ref tracking, the stats page, data export, deleting a child or family,
  receipt expiry, retention clean-up and the EU redirect.
- **Both databases:** the suite runs against SQLite with foreign keys enforced, and against real PostgreSQL via
  `TEST_DATABASE_URL`.
- **End-to-end:** Playwright runs on a mobile viewport with mocked GPS cover the full trip, the live surcharges, the
  receipt, a kid signing a promise, a parent confirming it, and data export and delete. Both games are also tested with
  simulated speech recognition (names, aliases, letter codes, mishearings, undo and tap mode).

## Tech stack

Python 3.12 · Flask 3 · Flask-SQLAlchemy / SQLAlchemy 2 · PostgreSQL (Neon) · psycopg 3 · gunicorn · Render ·
vanilla JavaScript PWA (service worker, Geolocation, Screen Wake Lock, Web Speech API, Web Share, Canvas) · segno (QR) · pytest ·
Playwright · Pillow (icons and share images) · ffmpeg (30-second explainer video)

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
flask --app app run --debug          # http://127.0.0.1:5000 (SQLite file taxi.db)
pytest                               # or: TEST_DATABASE_URL=postgresql+psycopg://... pytest
```

GPS needs HTTPS on a real phone, so test the meter on the deployed URL, or use "enter the trip by hand" locally.

## Deployment

- Render web service `taxi-mum-dad-eu` (Frankfurt) builds from `main` on every push:
  `pip install -r requirements.txt`, then `gunicorn "app:create_app()" --workers 1 --threads 4`.
- Database: Neon project `taxi-mum-dad` (AWS eu-central-1). Tables are created on first boot (`db.create_all()`);
  there are no migrations yet.
- `render.yaml` describes the original US blueprint and is kept for reference.

| Environment variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (`postgres://` is rewritten for psycopg 3) |
| `SECRET_KEY` | Session signing; required in production |
| `TZ_NAME` | Timezone for receipts (default `Europe/Dublin`) |
| `STATS_KEY` | Enables the private `/stats` page |
| `CONTACT_EMAIL` | Contact shown on the privacy notice and terms |
| `REDIRECT_TO` | Set only on the old US service, to forward every request to the EU app |

## How it was built

I set the product direction, made the feature and privacy decisions, tested on my own phone and handled the deployment
(GitHub → Render, Neon). I wrote the code with Claude as an AI pair-programmer.

## Roadmap

- Validate with test families: track week-4 retention and which share link brings in families
- Co-parent "two households, one tab" support
- Offline queue for issuing receipts in dead zones
- Optional Pro tier and brand sponsorship (contextual only, with no personal data shared with sponsors)
