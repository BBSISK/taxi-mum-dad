"""County Collector: spot Irish number plates and fill the family's county passport.

A self-contained game module (blueprint + tables), like Car Bingo. Front end: static/county.js.
- Each family has a passport per season. The first time a county is spotted in a season it counts
  as NEW and scores double; later spots still score base points (once per county per trip).
- Collect all 26 counties and the season is complete: the next spot starts a fresh passport (season + 1).
- The 26 counties of the Republic only (index marks since 2014). Northern Ireland plates don't show a county.
- Only "who spotted which plate" reaches the server; voice is handled on the phone.
"""
from flask import Blueprint, abort, jsonify, request, session
from sqlalchemy import func

from models import Kid, Parent, db, utcnow

from .plates import ALL, COUNTY_CODES

county_bp = Blueprint("county", __name__, url_prefix="/api/county")


class CountyProfile(db.Model):
    __tablename__ = "county_profile"
    family_id = db.Column(db.Integer, db.ForeignKey("family.id"), primary_key=True)
    season = db.Column(db.Integer, nullable=False, default=1)
    completed_seasons = db.Column(db.Integer, nullable=False, default=0)


class CountySpot(db.Model):
    __tablename__ = "county_spot"
    id = db.Column(db.Integer, primary_key=True)
    family_id = db.Column(db.Integer, db.ForeignKey("family.id"), nullable=False, index=True)
    season = db.Column(db.Integer, nullable=False)
    code = db.Column(db.String(4), nullable=False)
    kid_id = db.Column(db.Integer, db.ForeignKey("kid.id"), index=True)
    parent_id = db.Column(db.Integer, db.ForeignKey("parent.id"), index=True)
    trip_key = db.Column(db.String(32), nullable=False)
    is_new = db.Column(db.Boolean, nullable=False, default=False)
    points = db.Column(db.Integer, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow)


def current_parent():
    parent = db.session.get(Parent, session.get("parent_id") or 0)
    if not parent:
        abort(401)
    return parent


def profile_for(family_id):
    prof = db.session.get(CountyProfile, family_id)
    if not prof:
        prof = CountyProfile(family_id=family_id, season=1, completed_seasons=0)
        db.session.add(prof)
        db.session.flush()
    return prof


def who(spot):
    p = db.session.get(Kid, spot.kid_id) if spot.kid_id else db.session.get(Parent, spot.parent_id)
    return {"type": "kid" if spot.kid_id else "parent", "id": p.id, "name": p.name, "emoji": p.emoji} if p else None


def passport(family_id):
    prof = db.session.get(CountyProfile, family_id)
    season = prof.season if prof else 1
    spots = (CountySpot.query.filter_by(family_id=family_id, season=season)
             .order_by(CountySpot.created_at, CountySpot.id).all())
    collected = {}
    for s in spots:
        if s.code not in collected:
            collected[s.code] = {"by": who(s), "at": s.created_at.isoformat() + "Z"}
    rows = (db.session.query(CountySpot.kid_id, CountySpot.parent_id, func.sum(CountySpot.points), func.count(CountySpot.id))
            .filter(CountySpot.family_id == family_id, CountySpot.season == season)
            .group_by(CountySpot.kid_id, CountySpot.parent_id).all())
    board = []
    for kid_id, parent_id, pts, n in rows:
        p = db.session.get(Kid, kid_id) if kid_id else db.session.get(Parent, parent_id)
        if p:
            board.append({"type": "kid" if kid_id else "parent", "id": p.id, "name": p.name, "emoji": p.emoji,
                          "points": int(pts or 0), "spots": int(n)})
    board.sort(key=lambda r: -r["points"])
    got = [c for c in COUNTY_CODES if c in collected]
    return {"season": season, "completed_seasons": prof.completed_seasons if prof else 0,
            "collected": collected, "counties_collected": len(got), "counties_total": len(COUNTY_CODES),
            "leaderboard": board}


def county_summary(family_id):
    p = passport(family_id)
    return {k: p[k] for k in ("season", "counties_collected", "counties_total", "completed_seasons")} | {"leaderboard": p["leaderboard"][:3]}


def purge_county_kids(kid_ids):
    if kid_ids:
        CountySpot.query.filter(CountySpot.kid_id.in_(kid_ids)).delete(synchronize_session=False)


def purge_county_family(family_id):
    CountySpot.query.filter_by(family_id=family_id).delete(synchronize_session=False)
    CountyProfile.query.filter_by(family_id=family_id).delete(synchronize_session=False)


def export_county(family_id, row_dict):
    prof = db.session.get(CountyProfile, family_id)
    return {"profile": row_dict(prof) if prof else None,
            "spots": [row_dict(s) for s in CountySpot.query.filter_by(family_id=family_id)]}


@county_bp.get("/passport")
def get_passport():
    me = current_parent()
    return jsonify(**passport(me.family_id), plates=list(ALL.values()))


@county_bp.post("/spot")
def spot():
    """Body: {code, player: {type, id}, trip_key}"""
    me = current_parent()
    data = request.get_json(silent=True) or {}
    plate = ALL.get(str(data.get("code") or "").upper())
    player = data.get("player") or {}
    trip_key = str(data.get("trip_key") or "")[:32] or "no-trip"
    if not plate:
        return jsonify(error="Unknown plate"), 400
    kid_id = parent_id = None
    if player.get("type") == "kid":
        kid = db.session.get(Kid, int(player.get("id") or 0))
        if not kid or kid.family_id != me.family_id:
            abort(404)
        kid_id = kid.id
    elif player.get("type") == "parent":
        par = db.session.get(Parent, int(player.get("id") or 0))
        if not par or par.family_id != me.family_id:
            abort(404)
        parent_id = par.id
    else:
        return jsonify(error="Who spotted it?"), 400

    prof = profile_for(me.family_id)
    # A completed passport rolls over to a fresh season on the next spot.
    if all(CountySpot.query.filter_by(family_id=me.family_id, season=prof.season, code=c).first() for c in COUNTY_CODES):
        prof.season += 1
        prof.completed_seasons += 1
    already_this_trip = CountySpot.query.filter_by(family_id=me.family_id, season=prof.season, code=plate["code"],
                                                   trip_key=trip_key).first()
    if already_this_trip:
        db.session.commit()
        return jsonify(duplicate=True, by=who(already_this_trip), **passport(me.family_id))
    is_new = not CountySpot.query.filter_by(family_id=me.family_id, season=prof.season, code=plate["code"]).first()
    points = plate["points"] * (2 if is_new and not plate["bonus"] else 1)
    s = CountySpot(family_id=me.family_id, season=prof.season, code=plate["code"], kid_id=kid_id, parent_id=parent_id,
                   trip_key=trip_key, is_new=is_new, points=points)
    db.session.add(s)
    db.session.commit()
    p = passport(me.family_id)
    complete = p["counties_collected"] == p["counties_total"] and is_new and not plate["bonus"]
    return jsonify(spot_id=s.id, is_new=is_new, points=points, complete=complete, **p)


@county_bp.delete("/spot/<int:spot_id>")
def undo_spot(spot_id):
    me = current_parent()
    s = db.session.get(CountySpot, spot_id)
    if not s or s.family_id != me.family_id:
        abort(404)
    db.session.delete(s)
    db.session.commit()
    return jsonify(ok=True, **passport(me.family_id))
