"""Data model for Taxi of Mum & Dad.

KISS: one family = one taxi firm. Parents log in (cookie session), kids never do.
Balances are never stored - they are the sum of a kid's ledger entries
(positive = fares owed, negative = paid off with jobs).
We never store GPS positions, only the trip's total distance and time.
"""
import datetime as dt
import secrets

from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O/1/I/L confusion


def utcnow():
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)


def new_invite_code():
    return "TAXI-" + "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))


def new_token():
    return secrets.token_urlsafe(12)


# Fun surcharges a driver can tick at the end of a trip (credits added to the whole trip).
EXTRAS = {
    # live=True -> big tap-to-charge buttons on the meter while driving (keep to 5)
    "guest": {"label": "👫 Surprise extra passenger", "short": "Surprise guest", "emoji": "👫", "credits": 3, "live": True},
    "directions": {"label": "🗺️ Bad directions", "short": "Bad directions", "emoji": "🗺️", "credits": 2, "live": True},
    "dj": {"label": "🎵 Took over the music", "short": "Music takeover", "emoji": "🎵", "credits": 2, "live": True},
    "backseat": {"label": "🙄 Told the driver how to drive", "short": "Backseat driver", "emoji": "🙄", "credits": 3, "live": True},
    "drive_thru": {"label": "🍟 Drive-thru detour", "short": "Drive-thru", "emoji": "🍟", "credits": 3, "live": True},
    "late": {"label": "🌙 Late-night pickup", "credits": 5},
    "early": {"label": "🌅 Crack-of-dawn run", "credits": 4},
    "waiting": {"label": "⏳ Kept the driver waiting", "credits": 2},
    "forgot": {"label": "🧦 Forgot something - turned back", "credits": 3},
    "rain": {"label": "🌧️ Door-to-door in the rain", "credits": 2},
}
MAX_PER_EXTRA = 10  # a tap-happy co-pilot can't charge more than 10x of one surcharge per trip

PASSENGER_TAGS = ["💬 Great chat", "📵 Phone-free", "🎶 Top DJ", "🙏 Said thanks",
                  "😴 Slept", "🍪 Crumbs!", "🙄 Eye-rolls", "🎒 Left stuff behind"]

FIVE_STAR_DISCOUNT = 0.10  # 5-star passengers get 10% off their share

DEFAULT_TASKS = [
    ("🍽️", "Do the dishes", 5),
    ("🛏️", "Clean your room", 10),
    ("🚗", "Wash the car", 15),
    ("🍳", "Help cook dinner", 8),
    ("🌳", "Outdoor afternoon instead of games", 15),
    ("👵", "Visit Granny / Grandad in the home", 25),
    ("📞", "Ring a relative for a proper chat", 8),
    ("🏡", "Visit a relative", 20),
    ("🐕", "Walk the dog", 6),
    ("🧺", "Sort the laundry", 6),
    # --- the long game
    ("🏚️", "Commit to one visit a month when we're in Shady Pines Old Folks Home", 30),
    ("🧓", "Agree, in writing, that Mum was right", 50),
    ("🏠", "Move out, eventually", 1000),
    # --- car crimes
    ("🥤", "Clear the crisp packets out of the back seat", 5),
    ("🧽", "Hoover the car - yes, under the seats", 10),
    ("🤐", "One full journey without 'are we there yet?'", 4),
    ("🎵", "Driver picks the music for a whole week", 8),
    # --- around the house
    ("🧦", "Reunite 10 odd socks with their partners", 4),
    ("☕", "Return every mug & glass from your bedroom", 6),
    ("🗑️", "Bins out on the right night, unprompted", 5),
    ("🔍", "Room passes a surprise inspection", 15),
    ("🍝", "Cook the family dinner (must be edible)", 20),
    # --- fresh air & no screens
    ("📵", "Phone in the drawer at dinner for a week", 10),
    ("🥾", "Walk with a parent - talking is mandatory", 12),
    ("⛰️", "Climb a real hill (Minecraft doesn't count)", 20),
    # --- family
    ("🙋", "Answer 'how was school?' with more than one word", 3),
    ("🤣", "Laugh convincingly at one of Dad's jokes", 2),
    ("📸", "Family photo with a normal face", 5),
    ("👴", "Teach Grandad something on his phone, patiently", 12),
    ("✉️", "Write a thank-you card to a relative", 8),
    ("🎂", "Remember a relative's birthday unprompted", 10),
]


class Family(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False)
    invite_code = db.Column(db.String(16), unique=True, nullable=False, index=True, default=new_invite_code)
    currency = db.Column(db.String(30), nullable=False, default="Taxi Tokens")
    flag_fall = db.Column(db.Float, nullable=False, default=3.0)
    per_km = db.Column(db.Float, nullable=False, default=0.5)
    per_min = db.Column(db.Float, nullable=False, default=0.2)
    created_at = db.Column(db.DateTime, default=utcnow)


class Parent(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    family_id = db.Column(db.Integer, db.ForeignKey("family.id"), nullable=False, index=True)
    name = db.Column(db.String(40), nullable=False)
    emoji = db.Column(db.String(8), nullable=False, default="🧑")
    created_at = db.Column(db.DateTime, default=utcnow)


class Kid(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    family_id = db.Column(db.Integer, db.ForeignKey("family.id"), nullable=False, index=True)
    name = db.Column(db.String(40), nullable=False)
    emoji = db.Column(db.String(8), nullable=False, default="🧒")
    phone = db.Column(db.String(20))  # digits only, international, optional
    active = db.Column(db.Boolean, nullable=False, default=True)


class Task(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    family_id = db.Column(db.Integer, db.ForeignKey("family.id"), nullable=False, index=True)
    name = db.Column(db.String(80), nullable=False)
    emoji = db.Column(db.String(8), nullable=False, default="⭐")
    credits = db.Column(db.Integer, nullable=False)
    active = db.Column(db.Boolean, nullable=False, default=True)


class Trip(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    family_id = db.Column(db.Integer, db.ForeignKey("family.id"), nullable=False, index=True)
    driver_id = db.Column(db.Integer, db.ForeignKey("parent.id"), nullable=False)
    note = db.Column(db.String(80))
    distance_km = db.Column(db.Float, nullable=False, default=0)
    minutes = db.Column(db.Float, nullable=False, default=0)
    extras = db.Column(db.JSON, nullable=False, default=list)
    total_fare = db.Column(db.Integer, nullable=False)  # before splits/discounts
    breakdown = db.Column(db.JSON, nullable=False, default=dict)  # frozen at issue time
    created_at = db.Column(db.DateTime, default=utcnow)

    driver = db.relationship("Parent")
    passengers = db.relationship("Passenger", backref="trip", cascade="all, delete-orphan")


class Passenger(db.Model):
    """One kid on one trip - gets their own receipt link and ratings."""
    id = db.Column(db.Integer, primary_key=True)
    trip_id = db.Column(db.Integer, db.ForeignKey("trip.id"), nullable=False, index=True)
    kid_id = db.Column(db.Integer, db.ForeignKey("kid.id"), nullable=False, index=True)
    fare = db.Column(db.Integer, nullable=False)
    discount = db.Column(db.Integer, nullable=False, default=0)
    token = db.Column(db.String(24), unique=True, nullable=False, index=True, default=new_token)
    passenger_stars = db.Column(db.Integer)  # parent rates kid
    passenger_tags = db.Column(db.JSON, nullable=False, default=list)
    driver_stars = db.Column(db.Integer)  # kid rates parent (via receipt link)
    journey_stars = db.Column(db.Integer)
    kid_comment = db.Column(db.String(200))
    rated_at = db.Column(db.DateTime)

    kid = db.relationship("Kid")


class LedgerEntry(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    family_id = db.Column(db.Integer, db.ForeignKey("family.id"), nullable=False, index=True)
    kid_id = db.Column(db.Integer, db.ForeignKey("kid.id"), nullable=False, index=True)
    credits = db.Column(db.Integer, nullable=False)  # + owed (fare), - paid (job)
    kind = db.Column(db.String(10), nullable=False)  # fare | payment
    label = db.Column(db.String(100), nullable=False)
    emoji = db.Column(db.String(8))
    passenger_id = db.Column(db.Integer, db.ForeignKey("passenger.id"))
    parent_id = db.Column(db.Integer, db.ForeignKey("parent.id"))
    created_at = db.Column(db.DateTime, default=utcnow)


class Promise(db.Model):
    """A kid signs up (from a receipt link, no login) to do a job by a date.
    Credits only come off when a parent confirms it's done."""
    id = db.Column(db.Integer, primary_key=True)
    family_id = db.Column(db.Integer, db.ForeignKey("family.id"), nullable=False, index=True)
    kid_id = db.Column(db.Integer, db.ForeignKey("kid.id"), nullable=False, index=True)
    passenger_id = db.Column(db.Integer, db.ForeignKey("passenger.id"))  # receipt it was signed on
    task_id = db.Column(db.Integer, db.ForeignKey("task.id"))
    label = db.Column(db.String(100), nullable=False)  # snapshot, in case the job is edited later
    emoji = db.Column(db.String(8))
    credits = db.Column(db.Integer, nullable=False)
    due_on = db.Column(db.Date, nullable=False)
    signature = db.Column(db.Text)  # small PNG data URL drawn with a finger
    status = db.Column(db.String(10), nullable=False, default="promised")  # promised | done | dropped
    ledger_entry_id = db.Column(db.Integer, db.ForeignKey("ledger_entry.id"))
    created_at = db.Column(db.DateTime, default=utcnow)
    resolved_at = db.Column(db.DateTime)

    kid = db.relationship("Kid")


class Event(db.Model):
    """Anonymous product analytics: no names, no positions - just counts.
    kind: visit (landing page, with ?ref=), signup (new family), join (co-driver), receipt_open."""
    id = db.Column(db.Integer, primary_key=True)
    kind = db.Column(db.String(16), nullable=False, index=True)
    ref = db.Column(db.String(24), index=True)
    family_id = db.Column(db.Integer, index=True)
    subject_id = db.Column(db.Integer)  # e.g. passenger id for receipt_open
    created_at = db.Column(db.DateTime, default=utcnow, index=True)
