"""Taxi of Mum & Dad - Flask app factory.

Run locally:   flask --app app run --debug
Render:        gunicorn "app:create_app()"
"""
import datetime as dt
import math
import os
import re
from functools import wraps
from zoneinfo import ZoneInfo

import secrets

import segno
from flask import (Flask, Response, abort, jsonify, redirect, render_template,
                   request, send_from_directory, session, url_for)
from sqlalchemy import func
from werkzeug.middleware.proxy_fix import ProxyFix

from bingo import bingo_bp, bingo_summary, export_bingo, purge_bingo_family, purge_bingo_kids
from county import county_bp, county_summary, export_county, purge_county_family, purge_county_kids
from detwist import detwist_bp, detwist_summary, export_detwist, purge_detwist_family, purge_detwist_kids

from models import (DEFAULT_TASKS, EXTRAS, FIVE_STAR_DISCOUNT, MAX_PER_EXTRA, PASSENGER_TAGS,
                    Event, Family, Kid, LedgerEntry, Parent, Passenger, Promise, Task, Trip, db,
                    new_invite_code, utcnow)

LOCAL_TZ = ZoneInfo(os.environ.get("TZ_NAME", "Europe/Dublin"))
EMOJI_OK = re.compile(r"^.{1,8}$")


# ---------------------------------------------------------------- helpers
def clean_str(value, max_len, default=""):
    value = (value or "").strip()
    return value[:max_len] if value else default


def clean_emoji(value, default):
    value = (value or "").strip()
    return value if value and EMOJI_OK.match(value) else default


def clamp_num(value, lo, hi, default=0.0):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return default
    if value != value:  # NaN
        return default
    return max(lo, min(hi, value))


def normalise_phone(raw):
    """Return digits-only international number for wa.me links. Assumes Ireland for 0-prefixed numbers."""
    digits = re.sub(r"\D", "", raw or "")
    if not digits:
        return None
    if digits.startswith("00"):
        digits = digits[2:]
    elif digits.startswith("0"):
        digits = "353" + digits[1:]
    return digits[:15] if len(digits) >= 8 else None


def local_time(value):
    if not value:
        return ""
    return value.replace(tzinfo=dt.timezone.utc).astimezone(LOCAL_TZ)


def rnd(x):
    """Round half up (matches JavaScript Math.round, unlike Python's banker's rounding)."""
    return int(math.floor(x + 0.5))


def compute_fare(family, km, minutes, extra_keys, stars_by_kid, kid_ids):
    """Return (total, breakdown, shares) where shares = {kid_id: (fare, discount)}."""
    counts = {}
    for k in extra_keys:
        if k in EXTRAS and counts.get(k, 0) < MAX_PER_EXTRA:
            counts[k] = counts.get(k, 0) + 1
    extras = [{"key": k, "count": n, "label": EXTRAS[k]["label"] + (f" ×{n}" if n > 1 else ""),
               "credits": EXTRAS[k]["credits"] * n} for k, n in counts.items()]
    breakdown = {
        "flag_fall": round(family.flag_fall, 2),
        "distance": round(km * family.per_km, 2),
        "time": round(minutes * family.per_min, 2),
        "extras": [{"label": e["label"], "credits": e["credits"]} for e in extras],
        "split": len(kid_ids),
    }
    raw = breakdown["flag_fall"] + breakdown["distance"] + breakdown["time"] + sum(e["credits"] for e in extras)
    total = max(1, rnd(raw))
    shares = {}
    for kid_id in kid_ids:
        share = max(1, rnd(total / len(kid_ids)))
        discount = rnd(share * FIVE_STAR_DISCOUNT) if stars_by_kid.get(kid_id) == 5 else 0
        if stars_by_kid.get(kid_id) == 5 and discount == 0 and share > 1:
            discount = 1
        shares[kid_id] = (share - discount, discount)
    return total, breakdown, shares


def balances(family_id):
    rows = (db.session.query(LedgerEntry.kid_id, func.coalesce(func.sum(LedgerEntry.credits), 0))
            .filter_by(family_id=family_id).group_by(LedgerEntry.kid_id).all())
    return {kid_id: int(total) for kid_id, total in rows}


def kid_balance(kid_id):
    return int(db.session.query(func.coalesce(func.sum(LedgerEntry.credits), 0)).filter_by(kid_id=kid_id).scalar())


MAX_OPEN_PROMISES = 8
SIGNATURE_MAX = 60_000
DUE_CHOICES = {"today": "Today", "tomorrow": "Tomorrow", "weekend": "By the weekend"}


def local_today():
    return dt.datetime.now(LOCAL_TZ).date()


def due_date(choice):
    today = local_today()
    if choice == "tomorrow":
        return today + dt.timedelta(days=1)
    if choice == "weekend":
        return today + dt.timedelta(days=(6 - today.weekday()) or 7)  # this Sunday (next Sunday if today is Sunday)
    return today


def due_label(day):
    today = local_today()
    if day < today:
        return "OVERDUE"
    if day == today:
        return "today"
    if day == today + dt.timedelta(days=1):
        return "tomorrow"
    return "by " + day.strftime("%a %d %b")


def promise_json(p):
    return {"id": p.id, "kid_id": p.kid_id, "kid": p.kid.name, "kid_emoji": p.kid.emoji,
            "label": p.label, "emoji": p.emoji or "⭐", "credits": p.credits,
            "due": due_label(p.due_on), "overdue": p.due_on < local_today(), "signature": p.signature or ""}


BOT_UA = re.compile(r"bot|crawl|spider|preview|facebookexternalhit|whatsapp|slack|telegram|discord|twitter|curl|python|headless", re.I)
REF_OK = re.compile(r"^[a-z0-9_-]{1,24}$")


def clean_ref(raw):
    raw = (raw or "").strip().lower()
    return raw if REF_OK.match(raw) else None


def is_bot():
    return bool(BOT_UA.search(request.headers.get("User-Agent", "")))


def track(kind, ref=None, family_id=None, subject_id=None):
    """Best-effort: analytics must never break the app."""
    try:
        db.session.add(Event(kind=kind, ref=ref, family_id=family_id, subject_id=subject_id))
        db.session.commit()
    except Exception:  # noqa: BLE001
        db.session.rollback()


def avg(values):
    values = [v for v in values if v]
    return round(sum(values) / len(values), 1) if values else None


# ---------------------------------------------------------------- app factory
RENAMED_DEFAULTS = {  # old default job name -> new one (applied once at start-up, idempotent)
    "Visit Granny / Grandad in the home": "Visit Granny / Grandad and make them smile",
}


def rename_old_defaults():
    try:
        for old, new in RENAMED_DEFAULTS.items():
            Task.query.filter_by(name=old).update({"name": new}, synchronize_session=False)
        db.session.commit()
    except Exception:  # noqa: BLE001 - never block start-up over a cosmetic rename
        db.session.rollback()


def create_app(test_config=None):
    app = Flask(__name__)
    app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

    db_url = os.environ.get("DATABASE_URL", "sqlite:///taxi.db")
    if db_url.startswith("postgres://"):
        db_url = "postgresql+psycopg://" + db_url[len("postgres://"):]
    elif db_url.startswith("postgresql://"):
        db_url = "postgresql+psycopg://" + db_url[len("postgresql://"):]

    secret = os.environ.get("SECRET_KEY")
    if not secret and os.environ.get("RENDER"):
        raise RuntimeError("SECRET_KEY must be set in production")

    app.config.update(
        SECRET_KEY=secret or "dev-only-not-secret",
        SQLALCHEMY_DATABASE_URI=db_url,
        SQLALCHEMY_ENGINE_OPTIONS={"pool_pre_ping": True},
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=bool(os.environ.get("RENDER")),
        PERMANENT_SESSION_LIFETIME=dt.timedelta(days=400),
        MAX_CONTENT_LENGTH=64 * 1024,
    )
    if test_config:
        app.config.update(test_config)

    db.init_app(app)
    with app.app_context():
        if db.engine.dialect.name == "sqlite":  # enforce foreign keys locally, like Postgres does in production
            from sqlalchemy import event

            @event.listens_for(db.engine, "connect")
            def _fk_on(dbapi_conn, _record):
                dbapi_conn.execute("PRAGMA foreign_keys=ON")
            db.engine.dispose()
        db.create_all()
        rename_old_defaults()

    register_routes(app)
    app.register_blueprint(bingo_bp)
    app.register_blueprint(county_bp)
    app.register_blueprint(detwist_bp)
    return app


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        parent = db.session.get(Parent, session.get("parent_id") or 0)
        if not parent:
            return jsonify(error="not_logged_in"), 401
        return view(parent, *args, **kwargs)
    return wrapper


def row_dict(obj):
    out = {}
    for col in obj.__table__.columns:
        v = getattr(obj, col.name)
        out[col.name] = v.isoformat() if hasattr(v, "isoformat") else v
    return out


def purge_kids(family_id, kid_ids):
    """Hard-delete these children and everything about them (right to erasure)."""
    if not kid_ids:
        return
    pax = Passenger.query.filter(Passenger.kid_id.in_(kid_ids)).all()
    pax_ids = [p.id for p in pax]
    trip_ids = {p.trip_id for p in pax}
    Promise.query.filter(Promise.kid_id.in_(kid_ids)).delete(synchronize_session=False)
    LedgerEntry.query.filter(LedgerEntry.kid_id.in_(kid_ids)).delete(synchronize_session=False)
    purge_bingo_kids(kid_ids)
    purge_county_kids(kid_ids)
    purge_detwist_kids(kid_ids)
    if pax_ids:
        Event.query.filter(Event.kind == "receipt_open", Event.subject_id.in_(pax_ids)).delete(synchronize_session=False)
        Passenger.query.filter(Passenger.id.in_(pax_ids)).delete(synchronize_session=False)
    for tid in trip_ids:  # a trip with no passengers left has nothing to keep
        if not Passenger.query.filter_by(trip_id=tid).count():
            Trip.query.filter_by(id=tid).delete(synchronize_session=False)
    Kid.query.filter(Kid.id.in_(kid_ids), Kid.family_id == family_id).delete(synchronize_session=False)


def purge_family(family_id):
    """Hard-delete a whole family. Order matters for Postgres foreign keys."""
    purge_bingo_family(family_id)
    purge_county_family(family_id)
    purge_detwist_family(family_id)
    purge_kids(family_id, [k.id for k in Kid.query.filter_by(family_id=family_id).all()])
    Promise.query.filter_by(family_id=family_id).delete(synchronize_session=False)
    LedgerEntry.query.filter_by(family_id=family_id).delete(synchronize_session=False)
    trip_ids = [t.id for t in Trip.query.filter_by(family_id=family_id).all()]
    if trip_ids:
        Passenger.query.filter(Passenger.trip_id.in_(trip_ids)).delete(synchronize_session=False)
    Trip.query.filter_by(family_id=family_id).delete(synchronize_session=False)
    Task.query.filter_by(family_id=family_id).delete(synchronize_session=False)
    Event.query.filter_by(family_id=family_id).delete(synchronize_session=False)
    Parent.query.filter_by(family_id=family_id).delete(synchronize_session=False)
    Family.query.filter_by(id=family_id).delete(synchronize_session=False)


RECEIPT_LIFETIME = dt.timedelta(days=183)   # receipt links stop working after ~6 months
INACTIVE_FAMILY = dt.timedelta(days=365)    # families with no activity for 12 months are deleted
_cleanup = {"last": None}


def retention_cleanup(force=False):
    """Delete families with no activity for 12 months. Runs at most once a day (piggybacks on health checks)."""
    now = utcnow()
    if not force and _cleanup["last"] and now - _cleanup["last"] < dt.timedelta(hours=24):
        return 0
    _cleanup["last"] = now
    cutoff = now - INACTIVE_FAMILY
    removed = 0
    try:
        for fam in Family.query.filter(Family.created_at < cutoff).all():
            last_trip = db.session.query(func.max(Trip.created_at)).filter_by(family_id=fam.id).scalar()
            last_ledger = db.session.query(func.max(LedgerEntry.created_at)).filter_by(family_id=fam.id).scalar()
            if max(d for d in (fam.created_at, last_trip, last_ledger) if d) < cutoff:
                purge_family(fam.id)
                removed += 1
        db.session.commit()
    except Exception:  # noqa: BLE001 - never let housekeeping break a health check
        db.session.rollback()
    return removed


def register_routes(app):
    redirect_to = os.environ.get("REDIRECT_TO", "").rstrip("/")

    @app.before_request
    def moved_to_eu():
        # The old US-hosted copy forwards everything (old links, QR codes) to the EU-hosted app.
        if redirect_to and request.path != "/healthz":
            return redirect(redirect_to + request.full_path.rstrip("?"), code=301)

    @app.context_processor
    def legal_context():
        return {"contact_email": os.environ.get("CONTACT_EMAIL", ""), "policy_date": "1 November 2026"}

    @app.errorhandler(404)
    def not_found(_err):
        if request.path.startswith("/api/"):
            return jsonify(error="not_found"), 404
        return render_template("not_found.html", receipt=request.path.startswith("/r/")), 404

    @app.get("/privacy")
    def privacy():
        return render_template("privacy.html")

    @app.get("/terms")
    def terms():
        return render_template("terms.html")

    # ------------------------------------------------------------ shell / PWA
    @app.get("/")
    def index():
        ref = clean_ref(request.args.get("ref"))
        if ref and not is_bot():  # no cookie, no device storage: just a count (ePrivacy-friendly)
            track("visit", ref=ref)
        return render_template("index.html")

    @app.get("/sw.js")
    def service_worker():
        resp = send_from_directory(app.static_folder, "sw.js", mimetype="application/javascript")
        resp.headers["Cache-Control"] = "no-cache"
        resp.headers["Service-Worker-Allowed"] = "/"
        return resp

    @app.get("/manifest.webmanifest")
    def manifest():
        return send_from_directory(app.static_folder, "manifest.webmanifest",
                                   mimetype="application/manifest+json")

    @app.get("/stats")
    def stats_page():
        from stats import compute_stats
        key = os.environ.get("STATS_KEY") or app.config.get("STATS_KEY")
        if not key or not secrets.compare_digest(request.args.get("key", ""), key):
            abort(404)
        resp = Response(render_template("stats.html", s=compute_stats(), key=key))
        resp.headers["X-Robots-Tag"] = "noindex"
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["Referrer-Policy"] = "no-referrer"
        return resp

    @app.get("/healthz")
    def healthz():
        if not redirect_to:
            retention_cleanup()
        return "ok"

    # ------------------------------------------------------------ auth
    def start_session(parent):
        session.clear()
        session.permanent = True
        session["parent_id"] = parent.id

    @app.post("/api/family")
    def create_family():
        data = request.get_json(silent=True) or {}
        parent_name = clean_str(data.get("parent_name"), 40)
        if not parent_name:
            return jsonify(error="Tell us your driver name"), 400
        family = Family(name=clean_str(data.get("family_name"), 80, "The Family Taxi Co."))
        db.session.add(family)
        db.session.flush()
        parent = Parent(family_id=family.id, name=parent_name, emoji=clean_emoji(data.get("emoji"), "🧑"))
        db.session.add(parent)
        for emoji, name, credits in DEFAULT_TASKS:
            db.session.add(Task(family_id=family.id, name=name, emoji=emoji, credits=credits))
        db.session.commit()
        track("signup", ref=clean_ref(data.get("ref")) or "direct", family_id=family.id)
        start_session(parent)
        return jsonify(ok=True)

    @app.post("/api/join")
    def join_family():
        data = request.get_json(silent=True) or {}
        code = clean_str(data.get("code"), 16).upper().replace(" ", "")
        if code and not code.startswith("TAXI-"):
            code = "TAXI-" + code
        family = Family.query.filter_by(invite_code=code).first() if code else None
        if not family:
            return jsonify(error="That invite code didn't work"), 404
        parent_name = clean_str(data.get("parent_name"), 40)
        if not parent_name:
            return jsonify(error="Tell us your driver name"), 400
        parent = Parent(family_id=family.id, name=parent_name, emoji=clean_emoji(data.get("emoji"), "🧑"))
        db.session.add(parent)
        db.session.commit()
        track("join", ref="invite", family_id=family.id)
        start_session(parent)
        return jsonify(ok=True)

    @app.post("/api/logout")
    def logout():
        session.clear()
        return jsonify(ok=True)

    # ------------------------------------------------------------ state
    @app.get("/api/state")
    @login_required
    def state(me):
        fam = db.session.get(Family, me.family_id)
        bal = balances(fam.id)
        parents = Parent.query.filter_by(family_id=fam.id).order_by(Parent.id).all()
        kids = Kid.query.filter_by(family_id=fam.id, active=True).order_by(Kid.id).all()
        tasks = Task.query.filter_by(family_id=fam.id, active=True).order_by(Task.credits, Task.id).all()

        month_ago = utcnow() - dt.timedelta(days=30)
        recent_pax = (Passenger.query.join(Trip).filter(Trip.family_id == fam.id, Trip.created_at >= month_ago).all())

        drivers = []
        for p in parents:
            mine = [x for x in recent_pax if x.trip.driver_id == p.id]
            drivers.append({"id": p.id, "name": p.name, "emoji": p.emoji,
                            "trips": len({x.trip_id for x in mine}),
                            "driver_stars": avg([x.driver_stars for x in mine]),
                            "journey_stars": avg([x.journey_stars for x in mine])})

        kid_rows = []
        for k in kids:
            mine = [x for x in recent_pax if x.kid_id == k.id]
            kid_rows.append({"id": k.id, "name": k.name, "emoji": k.emoji, "phone": k.phone or "",
                             "balance": bal.get(k.id, 0), "trips": len(mine),
                             "passenger_stars": avg([x.passenger_stars for x in mine])})

        trips = (Trip.query.filter_by(family_id=fam.id).order_by(Trip.created_at.desc()).limit(15).all())
        return jsonify(
            me={"id": me.id, "name": me.name, "emoji": me.emoji},
            family={"name": fam.name, "invite_code": fam.invite_code, "currency": fam.currency,
                    "flag_fall": fam.flag_fall, "per_km": fam.per_km, "per_min": fam.per_min},
            parents=[{"id": p.id, "name": p.name, "emoji": p.emoji} for p in parents],
            kids=kid_rows,
            tasks=[{"id": t.id, "name": t.name, "emoji": t.emoji, "credits": t.credits} for t in tasks],
            extras=[{"key": k, **v} for k, v in EXTRAS.items()],
            passenger_tags=PASSENGER_TAGS,
            five_star_discount=FIVE_STAR_DISCOUNT,
            drivers=drivers,
            trips=[trip_json(t) for t in trips],
            bingo=bingo_summary(fam.id),
            county=county_summary(fam.id),
            detwist=detwist_summary(fam.id),
            promises=[promise_json(p) for p in Promise.query.filter_by(family_id=fam.id, status="promised")
                      .order_by(Promise.due_on, Promise.id).all()],
        )

    def trip_json(t):
        return {
            "id": t.id, "driver": t.driver.name, "driver_emoji": t.driver.emoji, "note": t.note or "",
            "distance_km": round(t.distance_km, 1), "minutes": round(t.minutes),
            "total_fare": t.total_fare, "when": local_time(t.created_at).strftime("%a %d %b, %H:%M"),
            "passengers": [{
                "kid_id": p.kid_id, "name": p.kid.name, "emoji": p.kid.emoji, "phone": p.kid.phone or "",
                "fare": p.fare, "discount": p.discount, "token": p.token,
                "receipt_url": url_for("receipt", token=p.token, _external=True),
                "passenger_stars": p.passenger_stars, "driver_stars": p.driver_stars,
                "journey_stars": p.journey_stars, "kid_comment": p.kid_comment or "",
            } for p in t.passengers],
        }

    # ------------------------------------------------------------ family settings
    @app.patch("/api/family")
    @login_required
    def update_family(me):
        fam = db.session.get(Family, me.family_id)
        data = request.get_json(silent=True) or {}
        if "name" in data:
            fam.name = clean_str(data["name"], 80, fam.name)
        if "currency" in data:
            fam.currency = clean_str(data["currency"], 30, fam.currency)
        for field, hi in (("flag_fall", 100), ("per_km", 50), ("per_min", 50)):
            if field in data:
                setattr(fam, field, clamp_num(data[field], 0, hi, getattr(fam, field)))
        db.session.commit()
        return jsonify(ok=True)

    @app.get("/api/export")
    @login_required
    def export_data(me):
        fid = me.family_id
        kid_ids = [k.id for k in Kid.query.filter_by(family_id=fid).all()]
        trip_ids = [t.id for t in Trip.query.filter_by(family_id=fid).all()]
        data = {
            "exported_at": utcnow().isoformat() + "Z",
            "about": "Everything Taxi of Mum & Dad stores about your family. GPS positions are never stored.",
            "family": row_dict(db.session.get(Family, fid)),
            "drivers": [row_dict(x) for x in Parent.query.filter_by(family_id=fid)],
            "passengers": [row_dict(x) for x in Kid.query.filter_by(family_id=fid)],
            "jobs": [row_dict(x) for x in Task.query.filter_by(family_id=fid)],
            "trips": [row_dict(x) for x in Trip.query.filter_by(family_id=fid)],
            "receipts": [row_dict(x) for x in Passenger.query.filter(Passenger.trip_id.in_(trip_ids))] if trip_ids else [],
            "promises": [row_dict(x) for x in Promise.query.filter_by(family_id=fid)],
            "ledger": [row_dict(x) for x in LedgerEntry.query.filter_by(family_id=fid)],
            "car_bingo": export_bingo(fid, row_dict),
            "county_collector": export_county(fid, row_dict),
            "detwist": export_detwist(fid, row_dict),
        }
        resp = jsonify(data)
        resp.headers["Content-Disposition"] = f'attachment; filename="taxi-of-mum-and-dad-data-{utcnow():%Y-%m-%d}.json"'
        return resp

    @app.post("/api/family/delete")
    @login_required
    def delete_family(me):
        data = request.get_json(silent=True) or {}
        if (data.get("confirm") or "").strip().upper() != "DELETE":
            return jsonify(error="Type DELETE to confirm"), 400
        purge_family(me.family_id)
        db.session.commit()
        session.clear()
        return jsonify(ok=True)

    @app.post("/api/family/new-code")
    @login_required
    def new_code(me):
        fam = db.session.get(Family, me.family_id)
        fam.invite_code = new_invite_code()
        db.session.commit()
        return jsonify(invite_code=fam.invite_code)

    @app.get("/api/family/invite-qr.svg")
    @login_required
    def invite_qr(me):
        fam = db.session.get(Family, me.family_id)
        link = url_for("index", _external=True) + "?join=" + fam.invite_code
        svg = segno.make(link, error="m").svg_inline(scale=8, dark="#111", light="#fff", border=2)
        return Response(svg, mimetype="image/svg+xml", headers={"Cache-Control": "no-store"})

    @app.patch("/api/me")
    @login_required
    def update_me(me):
        data = request.get_json(silent=True) or {}
        me.name = clean_str(data.get("name"), 40, me.name)
        me.emoji = clean_emoji(data.get("emoji"), me.emoji)
        db.session.commit()
        return jsonify(ok=True)

    # ------------------------------------------------------------ kids
    def get_kid(me, kid_id):
        kid = db.session.get(Kid, kid_id)
        if not kid or kid.family_id != me.family_id:
            abort(404)
        return kid

    @app.post("/api/kids")
    @login_required
    def add_kid(me):
        data = request.get_json(silent=True) or {}
        name = clean_str(data.get("name"), 40)
        if not name:
            return jsonify(error="Passenger needs a name"), 400
        kid = Kid(family_id=me.family_id, name=name, emoji=clean_emoji(data.get("emoji"), "🧒"),
                  phone=normalise_phone(data.get("phone")))
        db.session.add(kid)
        db.session.commit()
        return jsonify(id=kid.id)

    @app.patch("/api/kids/<int:kid_id>")
    @login_required
    def edit_kid(me, kid_id):
        kid = get_kid(me, kid_id)
        data = request.get_json(silent=True) or {}
        if "name" in data:
            kid.name = clean_str(data["name"], 40, kid.name)
        if "emoji" in data:
            kid.emoji = clean_emoji(data["emoji"], kid.emoji)
        if "phone" in data:
            kid.phone = normalise_phone(data["phone"])
        if data.get("archive"):
            kid.active = False
        db.session.commit()
        return jsonify(ok=True)

    @app.post("/api/kids/<int:kid_id>/delete")
    @login_required
    def delete_kid(me, kid_id):
        kid = get_kid(me, kid_id)
        data = request.get_json(silent=True) or {}
        if (data.get("confirm") or "").strip().upper() != "DELETE":
            return jsonify(error="Type DELETE to confirm"), 400
        purge_kids(me.family_id, [kid.id])
        db.session.commit()
        return jsonify(ok=True)

    @app.get("/api/kids/<int:kid_id>/ledger")
    @login_required
    def kid_ledger(me, kid_id):
        kid = get_kid(me, kid_id)
        rows = (LedgerEntry.query.filter_by(kid_id=kid.id)
                .order_by(LedgerEntry.created_at.desc(), LedgerEntry.id.desc()).limit(100).all())
        return jsonify(balance=kid_balance(kid.id), entries=[{
            "id": e.id, "credits": e.credits, "kind": e.kind, "label": e.label, "emoji": e.emoji or "",
            "when": local_time(e.created_at).strftime("%d %b"),
        } for e in rows])

    # ------------------------------------------------------------ tasks (ways to pay)
    @app.post("/api/tasks")
    @login_required
    def add_task(me):
        data = request.get_json(silent=True) or {}
        name = clean_str(data.get("name"), 80)
        if not name:
            return jsonify(error="Job needs a name"), 400
        task = Task(family_id=me.family_id, name=name, emoji=clean_emoji(data.get("emoji"), "⭐"),
                    credits=int(clamp_num(data.get("credits"), 1, 1000, 5)))
        db.session.add(task)
        db.session.commit()
        return jsonify(id=task.id)

    @app.patch("/api/tasks/<int:task_id>")
    @login_required
    def edit_task(me, task_id):
        task = db.session.get(Task, task_id)
        if not task or task.family_id != me.family_id:
            abort(404)
        data = request.get_json(silent=True) or {}
        if "name" in data:
            task.name = clean_str(data["name"], 80, task.name)
        if "emoji" in data:
            task.emoji = clean_emoji(data["emoji"], task.emoji)
        if "credits" in data:
            task.credits = int(clamp_num(data["credits"], 1, 1000, task.credits))
        if data.get("archive"):
            task.active = False
        db.session.commit()
        return jsonify(ok=True)

    # ------------------------------------------------------------ trips
    @app.post("/api/trips")
    @login_required
    def issue_trip(me):
        fam = db.session.get(Family, me.family_id)
        data = request.get_json(silent=True) or {}
        kid_ids = []
        for raw in data.get("kid_ids") or []:
            kid = db.session.get(Kid, int(raw)) if str(raw).isdigit() else None
            if kid and kid.family_id == fam.id and kid.active and kid.id not in kid_ids:
                kid_ids.append(kid.id)
        if not kid_ids:
            return jsonify(error="Pick at least one passenger"), 400

        km = clamp_num(data.get("distance_km"), 0, 2000)
        minutes = clamp_num(data.get("minutes"), 0, 24 * 60)
        extra_keys = [k for k in (data.get("extras") or [])[:100] if k in EXTRAS]
        ratings = data.get("ratings") or {}
        stars = {}
        tags = {}
        for kid_id in kid_ids:
            r = ratings.get(str(kid_id)) or {}
            s = int(clamp_num(r.get("stars"), 0, 5, 0))
            stars[kid_id] = s or None
            tags[kid_id] = [t for t in (r.get("tags") or []) if t in PASSENGER_TAGS]

        total, breakdown, shares = compute_fare(fam, km, minutes, extra_keys, stars, kid_ids)
        trip = Trip(family_id=fam.id, driver_id=me.id, note=clean_str(data.get("note"), 80) or None,
                    distance_km=km, minutes=minutes, extras=extra_keys, total_fare=total, breakdown=breakdown)
        db.session.add(trip)
        db.session.flush()
        for kid_id in kid_ids:
            fare, discount = shares[kid_id]
            pax = Passenger(trip_id=trip.id, kid_id=kid_id, fare=fare, discount=discount,
                            passenger_stars=stars[kid_id], passenger_tags=tags[kid_id])
            db.session.add(pax)
            db.session.flush()
            db.session.add(LedgerEntry(family_id=fam.id, kid_id=kid_id, credits=fare, kind="fare",
                                       label=f"Ride with {me.name}" + (f" - {trip.note}" if trip.note else ""),
                                       emoji="🚕", passenger_id=pax.id, parent_id=me.id))
        db.session.commit()
        return jsonify(trip=trip_json(trip))

    @app.delete("/api/trips/<int:trip_id>")
    @login_required
    def delete_trip(me, trip_id):
        trip = db.session.get(Trip, trip_id)
        if not trip or trip.family_id != me.family_id:
            abort(404)
        pax_ids = [p.id for p in trip.passengers]
        LedgerEntry.query.filter(LedgerEntry.passenger_id.in_(pax_ids)).delete(synchronize_session=False)
        db.session.delete(trip)
        db.session.commit()
        return jsonify(ok=True)

    # ------------------------------------------------------------ payments (jobs done)
    @app.post("/api/payments")
    @login_required
    def add_payment(me):
        data = request.get_json(silent=True) or {}
        kid = get_kid(me, int(clamp_num(data.get("kid_id"), 0, 10**9)))
        task = None
        if data.get("task_id"):
            task = db.session.get(Task, int(clamp_num(data["task_id"], 0, 10**9)))
            if not task or task.family_id != me.family_id:
                abort(404)
            label, emoji, credits = task.name, task.emoji, task.credits
        else:
            label = clean_str(data.get("label"), 100)
            credits = int(clamp_num(data.get("credits"), 1, 1000, 0))
            emoji = "⭐"
            if not label or not credits:
                return jsonify(error="Job needs a name and a value"), 400
        entry = LedgerEntry(family_id=me.family_id, kid_id=kid.id, credits=-credits, kind="payment",
                            label=label, emoji=emoji, parent_id=me.id)
        db.session.add(entry)
        db.session.commit()
        return jsonify(balance=kid_balance(kid.id), entry_id=entry.id)

    # ------------------------------------------------------------ promises (signed on a receipt)
    def get_promise(me, promise_id):
        p = db.session.get(Promise, promise_id)
        if not p or p.family_id != me.family_id or p.status != "promised":
            abort(404)
        return p

    @app.post("/api/promises/<int:promise_id>/done")
    @login_required
    def promise_done(me, promise_id):
        p = get_promise(me, promise_id)
        entry = LedgerEntry(family_id=me.family_id, kid_id=p.kid_id, credits=-p.credits, kind="payment",
                            label=p.label + " 🤝", emoji=p.emoji, parent_id=me.id)
        db.session.add(entry)
        db.session.flush()
        p.status, p.resolved_at, p.ledger_entry_id = "done", utcnow(), entry.id
        p.signature = None  # data minimisation: the signature has done its job
        db.session.commit()
        return jsonify(balance=kid_balance(p.kid_id))

    @app.post("/api/promises/<int:promise_id>/drop")
    @login_required
    def promise_drop(me, promise_id):
        p = get_promise(me, promise_id)
        p.status, p.resolved_at = "dropped", utcnow()
        p.signature = None
        db.session.commit()
        return jsonify(ok=True)

    @app.delete("/api/ledger/<int:entry_id>")
    @login_required
    def delete_entry(me, entry_id):
        entry = db.session.get(LedgerEntry, entry_id)
        if not entry or entry.family_id != me.family_id or entry.kind != "payment":
            abort(404)
        # Undoing a confirmed promise reopens it (the kid still owes the job) instead of failing on the link.
        reopened = Promise.query.filter_by(ledger_entry_id=entry.id).first()
        if reopened:
            reopened.status, reopened.resolved_at, reopened.ledger_entry_id = "promised", None, None
        db.session.delete(entry)
        db.session.commit()
        return jsonify(ok=True, promise_reopened=bool(reopened))

    # ------------------------------------------------------------ public receipt (kid side, no login)
    def get_passenger(token):
        pax = Passenger.query.filter_by(token=token).first()
        if not pax:
            abort(404)
        if pax.trip.created_at < utcnow() - RECEIPT_LIFETIME:
            abort(Response("<!doctype html><meta name=viewport content='width=device-width'><body style='font-family:system-ui;"
                           "text-align:center;padding:40px;background:#fff8e6'><h1>🚕 This receipt has expired</h1>"
                           "<p>Old receipts stop working after 6 months to keep your info private.<br>"
                           "Ask Mum or Dad to check your tab in the app.</p></body>", status=410))
        return pax

    @app.get("/r/<token>")
    def receipt(token):
        pax = get_passenger(token)
        trip = pax.trip
        fam = db.session.get(Family, trip.family_id)
        if not is_bot() and session.get("parent_id") is None:  # count kids opening it, not parents checking
            track("receipt_open", family_id=fam.id, subject_id=pax.id)
        tasks = (Task.query.filter_by(family_id=fam.id, active=True).order_by(Task.credits).all())
        promises = (Promise.query.filter_by(kid_id=pax.kid_id, status="promised")
                    .order_by(Promise.due_on, Promise.id).all())
        resp = Response(render_template(
            "receipt.html", pax=pax, trip=trip, fam=fam, kid=pax.kid, driver=trip.driver,
            when=local_time(trip.created_at), balance=kid_balance(pax.kid_id), tasks=tasks,
            promises=[promise_json(p) for p in promises], due_choices=DUE_CHOICES,
            can_promise=len(promises) < MAX_OPEN_PROMISES,
            promised_task_ids={p.task_id for p in promises},
            thanks=request.args.get("thanks") == "1", signed=request.args.get("signed") == "1"))
        resp.headers["X-Robots-Tag"] = "noindex"
        resp.headers["Referrer-Policy"] = "no-referrer"
        return resp

    @app.post("/r/<token>/rate")
    def rate_driver(token):
        pax = get_passenger(token)
        if pax.rated_at is None:
            pax.driver_stars = int(clamp_num(request.form.get("driver_stars"), 1, 5, 5))
            pax.journey_stars = int(clamp_num(request.form.get("journey_stars"), 1, 5, 5))
            pax.kid_comment = clean_str(request.form.get("comment"), 200) or None
            pax.rated_at = utcnow()
            db.session.commit()
        return redirect(url_for("receipt", token=token, thanks=1))

    @app.post("/r/<token>/promise")
    def make_promise(token):
        pax = get_passenger(token)
        task = db.session.get(Task, int(clamp_num(request.form.get("task_id"), 0, 10**9)))
        open_promises = Promise.query.filter_by(kid_id=pax.kid_id, status="promised").all()
        if (not task or task.family_id != pax.trip.family_id or not task.active
                or len(open_promises) >= MAX_OPEN_PROMISES
                or any(p.task_id == task.id for p in open_promises)):
            return redirect(url_for("receipt", token=token) + "#promise")
        sig = request.form.get("signature") or ""
        if not sig.startswith("data:image/png;base64,") or len(sig) > SIGNATURE_MAX:
            sig = None
        db.session.add(Promise(family_id=pax.trip.family_id, kid_id=pax.kid_id, passenger_id=pax.id,
                               task_id=task.id, label=task.name, emoji=task.emoji, credits=task.credits,
                               due_on=due_date(request.form.get("due")), signature=sig))
        db.session.commit()
        return redirect(url_for("receipt", token=token, signed=1) + "#promises")

    @app.get("/r/<token>/qr.svg")
    def receipt_qr(token):
        get_passenger(token)
        qr = segno.make(url_for("receipt", token=token, _external=True), error="m")
        svg = qr.svg_inline(scale=8, dark="#111", light="#fff", border=2)
        return Response(svg, mimetype="image/svg+xml")
