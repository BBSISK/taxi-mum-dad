import random

import pytest

from bingo import MAX_LEVEL, deal_card, level_config
from bingo.items import BY_ID, ITEMS
from models import db
from tests.test_app import add_kid, state  # noqa: F401  (shared helpers)


from tests.test_app import app  # noqa: F401,E402  (same fixture: SQLite, or Postgres via TEST_DATABASE_URL)


@pytest.fixture()
def mum(app):
    c = app.test_client()
    c.post("/api/family", json={"family_name": "Sisk Cabs", "parent_name": "Mum"})
    return c


def finish(client, outcome, found, total=None):
    return client.post("/api/bingo/round", json={"outcome": outcome, "items_total": total or len(found) or 4,
                                                 "found": found}).get_json()


def test_catalogue_and_levels_get_harder():
    assert len(BY_ID) == len(ITEMS) >= 50
    assert all(i["keywords"] for i in BY_ID.values())
    sizes = [level_config(lv)["n_items"] for lv in range(1, MAX_LEVEL + 1)]
    assert sizes == sorted(sizes) and sizes[0] == 4 and sizes[-1] == 10
    rng = random.Random(1)
    easy = sum(i["tier"] for _ in range(50) for i in deal_card(1, rng)[1]) / (50 * 4)
    hard = sum(i["tier"] for _ in range(50) for i in deal_card(10, rng)[1]) / (50 * 10)
    assert hard > easy + 1  # rarer things at higher levels
    cfg, items = deal_card(5, rng)
    assert len({i["id"] for i in items}) == cfg["n_items"]  # no duplicates on a card


def test_card_needs_login(app):
    assert app.test_client().get("/api/bingo/card").status_code == 401


def test_level_up_on_clear_and_back_one_on_timeout(app, mum):
    k = add_kid(mum, "Aoife")
    me = state(mum)["me"]["id"]
    card = mum.get("/api/bingo/card").get_json()
    assert card["config"]["level"] == 1 and len(card["items"]) == 4
    found = [{"item_id": it["id"], "player": {"type": "kid", "id": k}, "recalled": True} for it in card["items"][:3]]
    found.append({"item_id": card["items"][3]["id"], "player": {"type": "parent", "id": me}, "recalled": False})
    r = finish(mum, "cleared", found, total=4)
    assert (r["old_level"], r["level"]) == (1, 2)
    pts = {p["name"]: p["points"] for p in r["spotters"]}
    expected_kid = sum(BY_ID[f["item_id"]]["points"] + 1 for f in found[:3])
    assert pts["Aoife"] == expected_kid and pts["Mum"] == BY_ID[found[3]["item_id"]]["points"]

    for _ in range(3):  # climb to level 5
        finish(mum, "cleared", [{"item_id": i, "player": {"type": "kid", "id": k}} for i in list(BY_ID)[:1]], total=1)
    assert mum.get("/api/bingo/card").get_json()["config"]["level"] == 5
    r = finish(mum, "timeout", [], total=8)
    assert (r["old_level"], r["level"]) == (5, 4)  # one step back, not to the start
    for _ in range(6):
        finish(mum, "timeout", [], total=4)
    assert mum.get("/api/bingo/card").get_json()["config"]["level"] == 1  # never below 1
    assert state(mum)["bingo"]["best_level"] == 5


def test_claimed_clear_without_all_items_does_not_level_up(mum):
    k = add_kid(mum, "Jack")
    r = finish(mum, "cleared", [{"item_id": "red_car", "player": {"type": "kid", "id": k}}], total=4)
    assert r["level"] == 1


def test_bad_items_players_and_other_families_are_ignored(app, mum):
    k = add_kid(mum, "Aoife")
    other = app.test_client()
    other.post("/api/family", json={"parent_name": "Stranger"})
    r = finish(other, "quit", [{"item_id": "red_car", "player": {"type": "kid", "id": k}},
                               {"item_id": "not_an_item", "player": {"type": "kid", "id": k}}], total=4)
    assert r["awarded"] == [] and r["spotters"] == []
    r = finish(mum, "quit", [{"item_id": "red_car", "player": {"type": "kid", "id": k}},
                             {"item_id": "red_car", "player": {"type": "kid", "id": k}}], total=4)
    assert len(r["awarded"]) == 1  # the same item can't score twice in a round


def test_bingo_data_in_export_and_deleted_with_family_or_child(app, mum):
    from bingo import BingoProfile, BingoRound, BingoSpot
    k1, k2 = add_kid(mum, "Aoife"), add_kid(mum, "Jack")
    finish(mum, "quit", [{"item_id": "red_car", "player": {"type": "kid", "id": k1}},
                         {"item_id": "dog", "player": {"type": "kid", "id": k2}}], total=4)
    data = mum.get("/api/export").get_json()["car_bingo"]
    assert len(data["spots"]) == 2 and len(data["rounds"]) == 1
    mum.post(f"/api/kids/{k1}/delete", json={"confirm": "DELETE"})
    with app.app_context():
        assert BingoSpot.query.count() == 1
    mum.post("/api/family/delete", json={"confirm": "DELETE"})
    with app.app_context():
        assert BingoSpot.query.count() == BingoRound.query.count() == BingoProfile.query.count() == 0
