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

import segno
from flask import (Flask, Response, abort, jsonify, redirect, render_template,
                   request, send_from_directory, session, url_for)
from sqlalchemy import func
from werkzeug.middleware.proxy_fix import ProxyFix

from models import (DEFAULT_TASKS, EXTRAS, FIVE_STAR_DISCOUNT, PASSENGER_TAGS,
                    Family, Kid, LedgerEntry, Parent, Passenger, Task, Trip, db,
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
    extras = [{"key": k, **EXTRAS[k]} for k in extra_keys if k in EXTRAS]
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


def avg(values):
    values = [v for v in values if v]
    return round(sum(values) / len(values), 1) if values else None


# ---------------------------------------------------------------- app factory
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
        db.create_all()

    register_routes(app)
    return app


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        parent = db.session.get(Parent, session.get("parent_id") or 0)
        if not parent:
            return jsonify(error="not_logged_in"), 401
        return view(parent, *args, **kwargs)
    return wrapper


def register_routes(app):
    # ------------------------------------------------------------ shell / PWA
    @app.get("/")
    def index():
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

    @app.get("/healthz")
    def healthz():
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
        extra_keys = [k for k in (data.get("extras") or []) if k in EXTRAS]
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

    @app.delete("/api/ledger/<int:entry_id>")
    @login_required
    def delete_entry(me, entry_id):
        entry = db.session.get(LedgerEntry, entry_id)
        if not entry or entry.family_id != me.family_id or entry.kind != "payment":
            abort(404)
        db.session.delete(entry)
        db.session.commit()
        return jsonify(ok=True)

    # ------------------------------------------------------------ public receipt (kid side, no login)
    def get_passenger(token):
        pax = Passenger.query.filter_by(token=token).first()
        if not pax:
            abort(404)
        return pax

    @app.get("/r/<token>")
    def receipt(token):
        pax = get_passenger(token)
        trip = pax.trip
        fam = db.session.get(Family, trip.family_id)
        tasks = (Task.query.filter_by(family_id=fam.id, active=True).order_by(Task.credits).all())
        resp = Response(render_template(
            "receipt.html", pax=pax, trip=trip, fam=fam, kid=pax.kid, driver=trip.driver,
            when=local_time(trip.created_at), balance=kid_balance(pax.kid_id), tasks=tasks,
            thanks=request.args.get("thanks") == "1"))
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

    @app.get("/r/<token>/qr.svg")
    def receipt_qr(token):
        get_passenger(token)
        qr = segno.make(url_for("receipt", token=token, _external=True), error="m")
        svg = qr.svg_inline(scale=8, dark="#111", light="#fff", border=2)
        return Response(svg, mimetype="image/svg+xml")
