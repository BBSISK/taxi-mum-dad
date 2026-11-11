"""DeTwist: one untangling puzzle a day for the passengers.

A self-contained game module (blueprint + table), like Car Bingo and County Collector. Front end: static/detwist.js.
- The server decides which day it is (Europe/Dublin) and hands out that day's board, so changing a phone's clock
  can't unlock tomorrow's puzzle. Boards come from boards.json (see boards.py).
- A result is the list of moves the player made. The server replays it with the real rules (rules.py) before
  saving, so a fake score is rejected without needing accounts.
- The first finished game per player per day counts. Playing again is just practice and never reaches the server.
- Family leaderboard shows names. Everyone-leaderboard is numbers only: rank, how many played, scores of the top few.
  No names, families or ids from other families are ever returned.
- Not hands-free: it's for passengers.
"""
import datetime as dt
import json
import os
from zoneinfo import ZoneInfo

from flask import Blueprint, abort, jsonify, request, session
from sqlalchemy import and_, or_
from sqlalchemy.exc import IntegrityError

from models import Kid, Parent, db, utcnow

from . import boards, rules

detwist_bp = Blueprint("detwist", __name__, url_prefix="/api/detwist")
LOCAL_TZ = ZoneInfo(os.environ.get("TZ_NAME", "Europe/Dublin"))
LATE_DAYS = 2  # a result saved offline may arrive up to this many days late


class DetwistResult(db.Model):
    __tablename__ = "detwist_result"
    __table_args__ = (db.UniqueConstraint("family_id", "day", "player_key", name="uq_detwist_player_day"),)
    id = db.Column(db.Integer, primary_key=True)
    family_id = db.Column(db.Integer, db.ForeignKey("family.id"), nullable=False, index=True)
    day = db.Column(db.Date, nullable=False, index=True)
    player_key = db.Column(db.String(12), nullable=False)  # "k5" kid 5, "p2" parent 2
    kid_id = db.Column(db.Integer, db.ForeignKey("kid.id"), index=True)
    parent_id = db.Column(db.Integer, db.ForeignKey("parent.id"), index=True)
    moves = db.Column(db.Integer, nullable=False)
    par = db.Column(db.Integer, nullable=False)
    hints = db.Column(db.Integer, nullable=False, default=0)
    secs = db.Column(db.Integer, nullable=False, default=0)
    stars = db.Column(db.Integer, nullable=False)
    move_log = db.Column(db.Text, nullable=False)  # JSON, kept so a score can be re-checked
    created_at = db.Column(db.DateTime, default=utcnow)


def today():
    return dt.datetime.now(LOCAL_TZ).date()


def next_midnight_iso():
    return dt.datetime.combine(today() + dt.timedelta(days=1), dt.time(0, 0), tzinfo=LOCAL_TZ).isoformat()


def current_parent():
    parent = db.session.get(Parent, session.get("parent_id") or 0)
    if not parent:
        abort(401)
    return parent


def player_of(row):
    p = db.session.get(Kid, row.kid_id) if row.kid_id else db.session.get(Parent, row.parent_id)
    if not p:
        return None
    return {"type": "kid" if row.kid_id else "parent", "id": p.id, "name": p.name, "emoji": p.emoji}


def result_json(row):
    return {"moves": row.moves, "par": row.par, "hints": row.hints, "secs": row.secs, "stars": row.stars}


def sort_key(row):
    return (row.moves, row.hints, row.secs, row.id)


def family_board(family_id, day):
    rows = sorted(DetwistResult.query.filter_by(family_id=family_id, day=day).all(), key=sort_key)
    out = []
    for r in rows:
        who = player_of(r)
        if who:
            out.append({**who, **result_json(r), "key": r.player_key})
    return out


def streaks(family_id, day):
    """Days in a row each player has finished, counting back from today (or yesterday if they haven't played yet)."""
    by_player = {}
    for r in DetwistResult.query.filter_by(family_id=family_id).filter(DetwistResult.day <= day):
        by_player.setdefault(r.player_key, set()).add(r.day)
    out = {}
    for key, days in by_player.items():
        d = day if day in days else day - dt.timedelta(days=1)
        n = 0
        while d in days:
            n += 1
            d -= dt.timedelta(days=1)
        out[key] = n
    return out


def everyone(day, mine=None):
    """Numbers-only view of everybody's results for a day."""
    base = DetwistResult.query.filter_by(day=day)
    total = base.count()
    top = [{"moves": r.moves, "hints": r.hints, "secs": r.secs}
           for r in base.order_by(DetwistResult.moves, DetwistResult.hints, DetwistResult.secs, DetwistResult.id).limit(5)]
    out = {"total": total, "top": top}
    if mine is not None:
        better = base.filter(or_(DetwistResult.moves < mine.moves,
                                 and_(DetwistResult.moves == mine.moves, DetwistResult.hints < mine.hints),
                                 and_(DetwistResult.moves == mine.moves, DetwistResult.hints == mine.hints,
                                      DetwistResult.secs < mine.secs))).count()
        out["rank"] = better + 1
        out["beat_pct"] = round(100 * (total - better - 1) / (total - 1)) if total > 1 else None
    return out


def detwist_summary(family_id):
    """For the Home screen."""
    day = today()
    rows = family_board(family_id, day)
    best_streaks = sorted(streaks(family_id, day).items(), key=lambda kv: -kv[1])[:1]
    return {"day": day.isoformat(), "played": len(rows), "best": rows[0] if rows else None,
            "streak": best_streaks[0][1] if best_streaks else 0}


def purge_detwist_kids(kid_ids):
    if kid_ids:
        DetwistResult.query.filter(DetwistResult.kid_id.in_(kid_ids)).delete(synchronize_session=False)


def purge_detwist_family(family_id):
    DetwistResult.query.filter_by(family_id=family_id).delete(synchronize_session=False)


def export_detwist(family_id, row_dict):
    return {"results": [row_dict(r) for r in DetwistResult.query.filter_by(family_id=family_id)]}


@detwist_bp.get("/today")
def get_today():
    me = current_parent()
    day = today()
    board = boards.board_for(day)
    if not board:
        return jsonify(error="no_board"), 503
    mine = {r.player_key: result_json(r) for r in DetwistResult.query.filter_by(family_id=me.family_id, day=day)}
    return jsonify(day=day.isoformat(), board=board, ends_at=next_midnight_iso(), played=mine,
                   family=family_board(me.family_id, day), streaks=streaks(me.family_id, day),
                   everyone=everyone(day))


@detwist_bp.get("/leaderboard")
def get_leaderboard():
    me = current_parent()
    day = today()
    return jsonify(day=day.isoformat(), family=family_board(me.family_id, day), everyone=everyone(day),
                   streaks=streaks(me.family_id, day))


@detwist_bp.post("/result")
def post_result():
    """Body: {day, player: {type, id}, moves: [{id, end, to}], secs, hints}"""
    me = current_parent()
    data = request.get_json(silent=True) or {}
    try:
        day = dt.date.fromisoformat(str(data.get("day") or today().isoformat()))
    except ValueError:
        return jsonify(error="bad_day"), 400
    if not today() - dt.timedelta(days=LATE_DAYS) <= day <= today():
        return jsonify(error="too_late"), 410
    board = boards.board_for(day)
    if not board:
        return jsonify(error="no_board"), 503

    player = data.get("player") or {}
    kid_id = parent_id = None
    if player.get("type") == "kid":
        kid = db.session.get(Kid, int(player.get("id") or 0))
        if not kid or kid.family_id != me.family_id:
            abort(404)
        kid_id, key = kid.id, f"k{kid.id}"
    elif player.get("type") == "parent":
        par = db.session.get(Parent, int(player.get("id") or 0))
        if not par or par.family_id != me.family_id:
            abort(404)
        parent_id, key = par.id, f"p{par.id}"
    else:
        return jsonify(error="Who is playing?"), 400

    existing = DetwistResult.query.filter_by(family_id=me.family_id, day=day, player_key=key).first()
    if existing:
        return jsonify(duplicate=True, result=result_json(existing), **reply(me.family_id, day, existing))

    moves = data.get("moves")
    ok, why = rules.replay(board, moves)
    if not ok:
        return jsonify(error="invalid_game", why=why), 422
    try:
        secs = max(0, min(int(data.get("secs") or 0), 86400))
        hints = max(0, min(int(data.get("hints") or 0), 99))
    except (TypeError, ValueError):
        return jsonify(error="bad_numbers"), 400
    row = DetwistResult(family_id=me.family_id, day=day, player_key=key, kid_id=kid_id, parent_id=parent_id,
                        moves=len(moves), par=int(board["par"]), hints=hints, secs=secs,
                        stars=rules.stars_for(len(moves), int(board["par"]), hints),
                        move_log=json.dumps(moves, separators=(",", ":")))
    db.session.add(row)
    try:
        db.session.commit()
    except IntegrityError:  # two phones finished at once: the first one wins
        db.session.rollback()
        existing = DetwistResult.query.filter_by(family_id=me.family_id, day=day, player_key=key).first()
        return jsonify(duplicate=True, result=result_json(existing), **reply(me.family_id, day, existing))
    return jsonify(duplicate=False, result=result_json(row), **reply(me.family_id, day, row))


def reply(family_id, day, row):
    return {"family": family_board(family_id, day), "everyone": everyone(day, row),
            "streaks": streaks(family_id, day), "key": row.player_key}
