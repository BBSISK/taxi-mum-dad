"""Car Bingo: an I-spy + bingo game that pops up while the taxi meter runs.

A self-contained module (Flask blueprint + its own tables) so it can be developed, tested
and switched off separately from the taxi app. The front end is static/bingo.js.

- A family has a bingo level (1-10). Clearing a card in time moves up one level; running out
  of time drops back ONE level (never all the way to the start, never below 1).
- Points live on their own leaderboard ("Spotter of the month"); they never touch Taxi Tokens.
- Audio never reaches the server: speech is turned into words by the phone, matched on the
  phone, and only "who spotted which item" is sent here.
"""
import datetime as dt
import random

from flask import Blueprint, abort, jsonify, request, session
from sqlalchemy import func

from models import Kid, Parent, db, utcnow

from .items import BY_ID, ITEMS

bingo_bp = Blueprint("bingo", __name__, url_prefix="/api/bingo")

MAX_LEVEL = 10
ROUND_SECONDS = 10 * 60
RECALL_BONUS = 1  # extra point for spotting an item without peeking at the hidden list

# Tier mix per level: weights for tiers 1-4. Higher levels = more, rarer items.
TIER_WEIGHTS = {
    1: (8, 2, 0, 0), 2: (6, 4, 0, 0), 3: (5, 4, 1, 0), 4: (4, 4, 2, 0), 5: (3, 4, 2, 1),
    6: (3, 3, 3, 1), 7: (2, 3, 3, 2), 8: (2, 3, 3, 2), 9: (1, 2, 4, 3), 10: (1, 2, 4, 3),
}


def level_config(level):
    level = max(1, min(MAX_LEVEL, int(level)))
    n_items = min(3 + level, 10)  # level 1 = 4 things to find, level 7+ = 10
    return {
        "level": level,
        "n_items": n_items,
        "memorise_seconds": 12 + 3 * n_items,  # time to study the list before it hides
        "round_seconds": ROUND_SECONDS,
        "tier_weights": TIER_WEIGHTS[level],
    }


# ---------------------------------------------------------------- tables
class BingoProfile(db.Model):
    __tablename__ = "bingo_profile"
    family_id = db.Column(db.Integer, db.ForeignKey("family.id"), primary_key=True)
    level = db.Column(db.Integer, nullable=False, default=1)
    best_level = db.Column(db.Integer, nullable=False, default=1)
    rounds = db.Column(db.Integer, nullable=False, default=0)


class BingoRound(db.Model):
    __tablename__ = "bingo_round"
    id = db.Column(db.Integer, primary_key=True)
    family_id = db.Column(db.Integer, db.ForeignKey("family.id"), nullable=False, index=True)
    level = db.Column(db.Integer, nullable=False)
    items_total = db.Column(db.Integer, nullable=False)
    items_found = db.Column(db.Integer, nullable=False)
    outcome = db.Column(db.String(10), nullable=False)  # cleared | timeout | quit
    created_at = db.Column(db.DateTime, default=utcnow)


class BingoSpot(db.Model):
    __tablename__ = "bingo_spot"
    id = db.Column(db.Integer, primary_key=True)
    round_id = db.Column(db.Integer, db.ForeignKey("bingo_round.id"), nullable=False, index=True)
    family_id = db.Column(db.Integer, db.ForeignKey("family.id"), nullable=False, index=True)
    kid_id = db.Column(db.Integer, db.ForeignKey("kid.id"), index=True)        # one of kid_id / parent_id
    parent_id = db.Column(db.Integer, db.ForeignKey("parent.id"), index=True)
    item_id = db.Column(db.String(40), nullable=False)
    points = db.Column(db.Integer, nullable=False)
    recalled = db.Column(db.Boolean, nullable=False, default=False)
    created_at = db.Column(db.DateTime, default=utcnow)


# ---------------------------------------------------------------- helpers
def current_parent():
    parent = db.session.get(Parent, session.get("parent_id") or 0)
    if not parent:
        abort(401)
    return parent


def profile_for(family_id):
    prof = db.session.get(BingoProfile, family_id)
    if not prof:
        prof = BingoProfile(family_id=family_id, level=1, best_level=1, rounds=0)
        db.session.add(prof)
        db.session.flush()
    return prof


def deal_card(level, rng=random):
    cfg = level_config(level)
    pools = {t: [i for i in ITEMS if i[3] == t] for t in (1, 2, 3, 4)}
    chosen = []
    weights = cfg["tier_weights"]
    while len(chosen) < cfg["n_items"]:
        tier = rng.choices((1, 2, 3, 4), weights=weights)[0]
        options = [i for i in pools[tier] if i[0] not in chosen]
        if options:
            chosen.append(rng.choice(options)[0])
    return cfg, [BY_ID[i] for i in chosen]


def leaderboard(family_id, since=None):
    since = since or (utcnow() - dt.timedelta(days=30))
    rows = (db.session.query(BingoSpot.kid_id, BingoSpot.parent_id, func.sum(BingoSpot.points), func.count(BingoSpot.id))
            .filter(BingoSpot.family_id == family_id, BingoSpot.created_at >= since)
            .group_by(BingoSpot.kid_id, BingoSpot.parent_id).all())
    out = []
    for kid_id, parent_id, pts, n in rows:
        who = db.session.get(Kid, kid_id) if kid_id else db.session.get(Parent, parent_id)
        if who:
            out.append({"type": "kid" if kid_id else "parent", "id": who.id, "name": who.name, "emoji": who.emoji,
                        "points": int(pts or 0), "spots": int(n)})
    return sorted(out, key=lambda r: -r["points"])


def bingo_summary(family_id):
    prof = db.session.get(BingoProfile, family_id)
    return {"level": prof.level if prof else 1, "best_level": prof.best_level if prof else 1,
            "spotters": leaderboard(family_id)}


# ---------------------------------------------------------------- GDPR hooks (called by the taxi app)
def purge_bingo_kids(kid_ids):
    if kid_ids:
        BingoSpot.query.filter(BingoSpot.kid_id.in_(kid_ids)).delete(synchronize_session=False)


def purge_bingo_family(family_id):
    BingoSpot.query.filter_by(family_id=family_id).delete(synchronize_session=False)
    BingoRound.query.filter_by(family_id=family_id).delete(synchronize_session=False)
    BingoProfile.query.filter_by(family_id=family_id).delete(synchronize_session=False)


def export_bingo(family_id, row_dict):
    prof = db.session.get(BingoProfile, family_id)
    return {
        "profile": row_dict(prof) if prof else None,
        "rounds": [row_dict(r) for r in BingoRound.query.filter_by(family_id=family_id)],
        "spots": [row_dict(s) for s in BingoSpot.query.filter_by(family_id=family_id)],
    }


# ---------------------------------------------------------------- routes
@bingo_bp.get("/card")
def card():
    me = current_parent()
    prof = profile_for(me.family_id)
    db.session.commit()
    cfg, items = deal_card(prof.level)
    return jsonify(config=cfg, items=items, best_level=prof.best_level, recall_bonus=RECALL_BONUS)


@bingo_bp.post("/round")
def finish_round():
    """Body: {level, outcome: cleared|timeout|quit, items_total, found: [{item_id, player: {type, id}, recalled}]}"""
    me = current_parent()
    data = request.get_json(silent=True) or {}
    outcome = data.get("outcome") if data.get("outcome") in ("cleared", "timeout", "quit") else "quit"
    prof = profile_for(me.family_id)
    try:
        items_total = max(1, min(10, int(data.get("items_total") or 1)))
    except (TypeError, ValueError):
        items_total = 1

    rnd = BingoRound(family_id=me.family_id, level=prof.level, items_total=items_total, items_found=0, outcome=outcome)
    db.session.add(rnd)
    db.session.flush()

    seen = set()
    awarded = []
    for f in (data.get("found") or [])[:10]:
        item = BY_ID.get(str(f.get("item_id")))
        player = f.get("player") or {}
        if not item or item["id"] in seen:
            continue
        kid_id = parent_id = None
        if player.get("type") == "kid":
            kid = db.session.get(Kid, int(player.get("id") or 0))
            if not kid or kid.family_id != me.family_id:
                continue
            kid_id = kid.id
        elif player.get("type") == "parent":
            par = db.session.get(Parent, int(player.get("id") or 0))
            if not par or par.family_id != me.family_id:
                continue
            parent_id = par.id
        else:
            continue
        recalled = bool(f.get("recalled"))
        points = item["points"] + (RECALL_BONUS if recalled else 0)
        seen.add(item["id"])
        db.session.add(BingoSpot(round_id=rnd.id, family_id=me.family_id, kid_id=kid_id, parent_id=parent_id,
                                 item_id=item["id"], points=points, recalled=recalled))
        awarded.append({"item_id": item["id"], "points": points})
    rnd.items_found = len(seen)

    old = prof.level
    if outcome == "cleared" and len(seen) >= items_total:
        prof.level = min(MAX_LEVEL, prof.level + 1)
    elif outcome == "timeout":
        prof.level = max(1, prof.level - 1)  # step back one level, never to the start
    prof.best_level = max(prof.best_level, prof.level)
    prof.rounds += 1
    db.session.commit()
    return jsonify(old_level=old, level=prof.level, awarded=awarded, spotters=leaderboard(me.family_id))


@bingo_bp.get("/leaderboard")
def get_leaderboard():
    me = current_parent()
    return jsonify(bingo_summary(me.family_id))
