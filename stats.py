"""Owner-only usage stats: anonymous aggregate counts, no names."""
import datetime as dt
from collections import Counter, defaultdict

from sqlalchemy import func

from models import Event, Family, Kid, LedgerEntry, Parent, Passenger, Promise, Trip, db, utcnow

WEEKS = 5  # retention columns: week 0..4 after signup


def pct(a, b):
    return round(100 * a / b) if b else None


def compute_stats():
    now = utcnow()
    week_ago = now - dt.timedelta(days=7)
    month_ago = now - dt.timedelta(days=30)

    families = db.session.query(Family.id, Family.created_at).all()
    trips = db.session.query(Trip.family_id, Trip.created_at, Trip.distance_km).all()
    events = db.session.query(Event.kind, Event.ref, Event.family_id, Event.subject_id).all()

    trips_by_fam = defaultdict(list)
    for fid, at, _km in trips:
        trips_by_fam[fid].append(at)
    active7 = {fid for fid, at, _ in trips if at >= week_ago}

    receipts = db.session.query(func.count(Passenger.id)).scalar() or 0
    opened = len({e.subject_id for e in events if e.kind == "receipt_open" and e.subject_id})
    promises = db.session.query(func.count(Promise.id)).scalar() or 0
    kept = db.session.query(func.count(Promise.id)).filter(Promise.status == "done").scalar() or 0

    totals = {
        "families": len(families),
        "drivers": db.session.query(func.count(Parent.id)).scalar() or 0,
        "kids": db.session.query(func.count(Kid.id)).filter(Kid.active.is_(True)).scalar() or 0,
        "trips": len(trips),
        "km": round(sum(km or 0 for _, _, km in trips)),
        "receipts": receipts,
        "opened_pct": pct(opened, receipts),
        "promises": promises,
        "kept_pct": pct(kept, promises),
        "jobs_paid": db.session.query(func.count(LedgerEntry.id)).filter(LedgerEntry.kind == "payment").scalar() or 0,
        "trips_7d": sum(1 for _, at, _ in trips if at >= week_ago),
        "active_7d": len(active7),
        "families_with_trip_pct": pct(sum(1 for fid, _ in families if trips_by_fam[fid]), len(families)),
        "codrivers": sum(1 for e in events if e.kind == "join"),
    }

    # ---- where families come from (?ref=)
    signup_ref = {e.family_id: e.ref for e in events if e.kind == "signup"}
    visits = Counter(e.ref for e in events if e.kind == "visit")
    by_ref = defaultdict(lambda: {"visits": 0, "families": 0, "with_trip": 0, "active_7d": 0})
    for ref, n in visits.items():
        by_ref[ref]["visits"] = n
    for fid, _ in families:
        row = by_ref[signup_ref.get(fid, "untracked")]
        row["families"] += 1
        row["with_trip"] += 1 if trips_by_fam[fid] else 0
        row["active_7d"] += 1 if fid in active7 else 0
    sources = sorted(({"ref": k, **v, "conv_pct": pct(v["families"], v["visits"])} for k, v in by_ref.items()),
                     key=lambda r: (-r["families"], -r["visits"]))

    # ---- weekly signup cohorts: % of families that logged a trip in week N after signing up
    cohorts = defaultdict(list)
    for fid, created in families:
        monday = (created - dt.timedelta(days=created.weekday())).date()
        cohorts[monday].append((fid, created))
    cohort_rows = []
    for monday in sorted(cohorts, reverse=True)[:12]:
        members = cohorts[monday]
        cells = []
        for w in range(WEEKS):
            eligible = [(fid, c) for fid, c in members if now >= c + dt.timedelta(days=7 * w)]
            if not eligible:
                cells.append(None)
                continue
            hit = sum(1 for fid, c in eligible
                      if any(c + dt.timedelta(days=7 * w) <= t < c + dt.timedelta(days=7 * (w + 1)) for t in trips_by_fam[fid]))
            cells.append(pct(hit, len(eligible)))
        cohort_rows.append({"week": monday.strftime("%d %b"), "n": len(members), "cells": cells})

    # ---- trips per day, last 30 days
    day_counts = Counter(at.date() for _, at, _ in trips if at >= month_ago)
    days = [(now - dt.timedelta(days=i)).date() for i in range(29, -1, -1)]
    daily = [{"day": d.strftime("%d %b"), "n": day_counts.get(d, 0)} for d in days]

    return {"totals": totals, "sources": sources, "cohorts": cohort_rows, "weeks": WEEKS,
            "daily": daily, "daily_max": max([d["n"] for d in daily] + [1]),
            "generated": now.strftime("%d %b %Y %H:%M UTC")}
