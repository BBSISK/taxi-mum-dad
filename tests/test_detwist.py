import datetime as dt

import pytest

import detwist
from detwist import boards, rules
from tests.test_app import add_kid, state as state_of  # noqa: F401  (shared helpers)
from tests.test_app import app  # noqa: F401  (same fixture: SQLite, or Postgres via TEST_DATABASE_URL)

DAY = dt.date(2026, 11, 12)

# Six pins, two crossing bands: (0,2) and (1,3). Sliding band 1's end 1 round to pin 4 frees it, then band 0 is free too.
FLAT = {"n": 2, "P": 6, "step": 3, "par": 1, "name": "Easy", "pins": [[0, 2], [1, 3]], "rel": None}
SOLUTION = [{"id": 1, "end": "a", "to": 4}]


@pytest.fixture(autouse=True)
def one_board(monkeypatch):
    monkeypatch.setattr(boards, "BOARDS", {DAY.isoformat(): FLAT})
    monkeypatch.setattr(detwist, "today", lambda: DAY)


@pytest.fixture()
def mum(app):
    c = app.test_client()
    c.post("/api/family", json={"family_name": "Sisk Cabs", "parent_name": "Mum"})
    return c


def play(client, kid, moves=SOLUTION, **extra):
    body = {"day": DAY.isoformat(), "player": {"type": "kid", "id": kid}, "moves": moves, "secs": 30, "hints": 0}
    return client.post("/api/detwist/result", json=body | extra)


# ---------------------------------------------------------------- rules

def bands(*pairs):
    return [{"id": i, "a": a, "b": b} for i, (a, b) in enumerate(pairs)]


def test_crossing_bands_are_stuck_and_uncrossed_ones_are_free():
    assert rules.free_ids(bands((0, 2), (1, 3)), None) == set()
    assert rules.free_ids(bands((0, 2), (3, 4)), None) == {0, 1}
    assert rules.free_ids(bands((0, 3), (1, 2)), None) == {0, 1}  # nested, not crossing


def test_woven_band_pops_only_when_over_everything_it_crosses():
    two = bands((0, 2), (1, 3))
    over_first = rules.decode_rel(2, "1")  # band 0 over band 1
    assert rules.free_ids(two, over_first) == {0}
    # three bands: 0 over 1, 1 over 2, 2 over 0 in a cycle, all three crossing: nothing can pop
    tri = bands((0, 3), (2, 5), (4, 1))
    cycle = rules.decode_rel(3, "101")  # pairs (0,1)=1, (0,2)=0, (1,2)=1
    assert rules.free_ids(tri, cycle) == set()


def test_settle_removes_freed_bands_in_waves():
    chain = bands((0, 2), (1, 3))
    rel = rules.decode_rel(2, "1")
    assert rules.settle(chain, rel) == []  # band 0 pops, then band 1 crosses nothing


def test_replay_accepts_a_real_solution():
    assert rules.replay(FLAT, SOLUTION) == (True, "")


@pytest.mark.parametrize("moves, why", [
    ([], "no moves"),
    ([{"id": 1, "end": "a", "to": 2}], "that pin is taken"),
    ([{"id": 1, "end": "a", "to": 9}], "no such pin"),
    ([{"id": 7, "end": "a", "to": 4}], "that band is already free"),
    ([{"id": 1, "end": "c", "to": 4}], "bad move"),
    ([{"id": 1, "end": "a", "to": "4"}], "bad move"),
    (SOLUTION + [{"id": 0, "end": "a", "to": 5}], "moves after the board was clear"),
    ([{"id": 1, "end": "b", "to": 4}], "board not cleared"),  # a legal one-pin slide that still leaves the bands crossing
])
def test_replay_rejects_illegal_or_unfinished_games(moves, why):
    assert rules.replay(FLAT, moves) == (False, why)


def test_reach_limit_is_enforced_round_the_rim():
    tight = dict(FLAT, step=1)
    assert rules.replay(tight, SOLUTION) == (False, "too far")  # 1 -> 4 is 3 pins away
    assert rules.circ(0, 5, 6) == 1  # the rim wraps


def test_stars_follow_par_and_a_hint_caps_at_two():
    assert [rules.stars_for(m, 10, 0) for m in (9, 10, 11, 13, 14)] == [3, 3, 2, 2, 1]
    assert rules.stars_for(10, 10, 1) == 2
    assert rules.stars_for(5, 5, 0) == 3 and rules.stars_for(7, 5, 0) == 2 and rules.stars_for(8, 5, 0) == 1


# ---------------------------------------------------------------- api

def test_today_needs_login(app):
    assert app.test_client().get("/api/detwist/today").status_code == 401


def test_today_serves_the_days_board(mum):
    r = mum.get("/api/detwist/today").get_json()
    assert r["day"] == DAY.isoformat() and r["board"]["pins"] == FLAT["pins"] and r["board"]["layers"] is False
    assert r["board"]["number"] == 4 and r["played"] == {} and r["everyone"]["total"] == 0
    assert r["ends_at"].startswith("2026-11-13T00:00:00")


def test_no_boards_at_all_is_reported(mum, monkeypatch):
    monkeypatch.setattr(boards, "BOARDS", {})
    assert mum.get("/api/detwist/today").status_code == 503


def test_missing_date_reuses_a_board_from_the_same_weekday(monkeypatch):
    monkeypatch.setattr(boards, "BOARDS", {"2026-11-05": FLAT})  # a Thursday, like DAY
    b = boards.board_for(DAY)
    assert b["pins"] == FLAT["pins"] and b["day"] == DAY.isoformat()


def test_finishing_saves_the_result_and_ranks_it(mum):
    k = add_kid(mum, "Jack")
    r = play(mum, k, hints=0).get_json()
    assert not r["duplicate"] and r["result"] == {"moves": 1, "par": 1, "hints": 0, "secs": 30, "stars": 3}
    assert r["family"][0]["name"] == "Jack" and r["everyone"]["rank"] == 1 and r["everyone"]["total"] == 1
    assert r["streaks"]["k%d" % k] == 1
    assert mum.get("/api/detwist/today").get_json()["played"]["k%d" % k]["stars"] == 3


def test_only_the_first_game_of_the_day_counts(mum):
    k = add_kid(mum, "Jack")
    play(mum, k)
    again = play(mum, k, secs=5, hints=2).get_json()
    assert again["duplicate"] and again["result"]["secs"] == 30 and again["result"]["hints"] == 0


def test_a_made_up_score_is_rejected(mum):
    k = add_kid(mum, "Jack")
    r = play(mum, k, moves=[{"id": 0, "end": "a", "to": 5}])
    assert r.status_code == 422 and r.get_json()["error"] == "invalid_game"
    assert mum.get("/api/detwist/leaderboard").get_json()["family"] == []


def test_other_families_players_and_stale_days_are_refused(mum, app):
    other = app.test_client()
    other.post("/api/family", json={"family_name": "Not Us", "parent_name": "Dad"})
    theirs = add_kid(other, "Stranger")
    assert play(mum, theirs).status_code == 404
    k = add_kid(mum, "Jack")
    assert play(mum, k, day=(DAY - dt.timedelta(days=5)).isoformat()).status_code == 410
    assert play(mum, k, day=(DAY + dt.timedelta(days=1)).isoformat()).status_code == 410
    assert play(mum, k, day="not-a-date").status_code == 400


def test_a_result_saved_offline_can_arrive_a_day_late(mum):
    k = add_kid(mum, "Jack")
    yesterday = DAY - dt.timedelta(days=1)
    boards.BOARDS[yesterday.isoformat()] = FLAT
    assert play(mum, k, day=yesterday.isoformat()).status_code == 200


def test_family_board_ranks_by_moves_then_hints_then_time(mum):
    jack, mia = add_kid(mum, "Jack"), add_kid(mum, "Mia")
    play(mum, jack, secs=50)
    r = play(mum, mia, secs=20).get_json()  # same moves, faster
    assert [p["name"] for p in r["family"]] == ["Mia", "Jack"] and r["everyone"]["rank"] == 1
    assert play(mum, jack).get_json()["family"][0]["name"] == "Mia"


def test_everyone_view_is_numbers_only(mum, app):
    other = app.test_client()
    other.post("/api/family", json={"family_name": "Not Us", "parent_name": "Dad"})
    theirs = add_kid(other, "Stranger")
    play(other, theirs, secs=10)
    k = add_kid(mum, "Jack")
    r = play(mum, k, secs=40).get_json()
    assert r["everyone"]["total"] == 2 and r["everyone"]["rank"] == 2 and r["everyone"]["beat_pct"] == 0
    assert "Stranger" not in str(mum.get("/api/detwist/leaderboard").get_json())
    assert all(set(t) == {"moves", "hints", "secs"} for t in r["everyone"]["top"])


def test_streak_counts_days_in_a_row(mum):
    k = add_kid(mum, "Jack")
    for back in (2, 1):
        d = DAY - dt.timedelta(days=back)
        boards.BOARDS[d.isoformat()] = FLAT
        play(mum, k, day=d.isoformat())
    assert play(mum, k).get_json()["streaks"]["k%d" % k] == 3


def test_home_summary_export_and_erasure(app, mum):
    k = add_kid(mum, "Jack")
    play(mum, k)
    home = state_of(mum)["detwist"]
    assert home["played"] == 1 and home["best"]["name"] == "Jack" and home["streak"] == 1
    export = mum.get("/api/export").get_json()["detwist"]
    assert len(export["results"]) == 1 and export["results"][0]["moves"] == 1
    assert mum.post(f"/api/kids/{k}/delete", json={"confirm": "DELETE"}).status_code == 200
    with app.app_context():
        assert detwist.DetwistResult.query.count() == 0


def test_deleting_the_family_removes_every_result(app, mum):
    k = add_kid(mum, "Jack")
    play(mum, k)
    assert mum.post("/api/family/delete", json={"confirm": "delete"}).status_code == 200
    with app.app_context():
        assert detwist.DetwistResult.query.count() == 0
