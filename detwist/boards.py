"""Daily DeTwist boards.

`boards.json` is built ahead of time by tools/make_detwist_boards.js (it needs a few seconds of solver
time per board, too slow to do per request). It maps an ISO date to a board:
  {"n": bands, "P": pins, "step": reach, "par": fewest moves found by the solver, "name": "Easy",
   "pins": [[a, b], ...] one pair of pins per band, "rel": over/under bits or null on flat days}
A date with no entry reuses an earlier board from the same weekday, so the game never goes blank.
"""
import datetime as dt
import json
import os

FIRST_DAY = dt.date(2026, 11, 9)  # puzzle number 1
_PATH = os.path.join(os.path.dirname(__file__), "boards.json")

try:
    with open(_PATH, encoding="utf-8") as f:
        BOARDS = json.load(f)
except FileNotFoundError:
    BOARDS = {}


def number_for(day):
    return (day - FIRST_DAY).days + 1


def board_for(day):
    """The board for this date as a dict, or None when there are no boards at all."""
    entry = BOARDS.get(day.isoformat())
    if entry is None:
        same_weekday = sorted(k for k in BOARDS if dt.date.fromisoformat(k).weekday() == day.weekday())
        if not same_weekday:
            return None
        entry = BOARDS[same_weekday[day.toordinal() % len(same_weekday)]]
    return dict(entry, day=day.isoformat(), number=number_for(day), layers=bool(entry.get("rel")))
