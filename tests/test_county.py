import pytest

from county.plates import ALL, COUNTY_CODES, TIER_POINTS
from tests.test_app import add_kid, state  # noqa: F401  (shared helpers)
from tests.test_app import app  # noqa: F401  (same fixture: SQLite, or Postgres via TEST_DATABASE_URL)


@pytest.fixture()
def mum(app):
    c = app.test_client()
    c.post("/api/family", json={"family_name": "Sisk Cabs", "parent_name": "Mum"})
    return c


def spot(client, code, kid, trip="trip-1"):
    return client.post("/api/county/spot", json={"code": code, "player": {"type": "kid", "id": kid}, "trip_key": trip})


def test_plate_list_is_the_26_republic_counties():
    assert len(COUNTY_CODES) == len(ALL) == 26
    assert {"D", "C", "G", "KY", "L", "T", "W", "LS", "OY", "LM"} <= set(COUNTY_CODES)
    assert not {"LK", "TN", "TS", "WD"} & set(COUNTY_CODES)  # pre-2014 codes are gone
    assert all(p["points"] == TIER_POINTS[p["tier"]] and p["keywords"] is not None for p in ALL.values())
    assert {p["province"] for p in ALL.values()} == {"Leinster", "Munster", "Connacht", "Ulster"}


def test_passport_needs_login(app):
    assert app.test_client().get("/api/county/passport").status_code == 401


def test_new_county_doubles_then_repeats_score_base_once_per_trip(mum):
    k = add_kid(mum, "Jack")
    r = spot(mum, "ky", k).get_json()
    assert r["is_new"] and r["points"] == ALL["KY"]["points"] * 2 and r["counties_collected"] == 1
    dup = spot(mum, "KY", k).get_json()
    assert dup["duplicate"] and dup["by"]["name"] == "Jack"
    again = spot(mum, "KY", k, trip="trip-2").get_json()
    assert not again["is_new"] and again["points"] == ALL["KY"]["points"]
    p = mum.get("/api/county/passport").get_json()
    assert p["collected"]["KY"]["by"]["name"] == "Jack" and len(p["plates"]) == 26
    assert p["leaderboard"][0]["points"] == ALL["KY"]["points"] * 3


def test_undo_removes_the_spot(mum):
    k = add_kid(mum, "Aoife")
    r = spot(mum, "LM", k).get_json()
    u = mum.delete(f"/api/county/spot/{r['spot_id']}").get_json()
    assert u["counties_collected"] == 0 and "LM" not in u["collected"]
    assert spot(mum, "LM", k).get_json()["is_new"]  # still new after undo


def test_full_passport_completes_and_rolls_over(mum):
    k = add_kid(mum, "Aoife")
    for i, code in enumerate(COUNTY_CODES):
        r = spot(mum, code, k, trip=f"t{i}").get_json()
    assert r["complete"] and r["counties_collected"] == 26
    nxt = spot(mum, "D", k, trip="new-trip").get_json()
    assert nxt["season"] == 2 and nxt["is_new"] and nxt["counties_collected"] == 1
    assert state(mum)["county"]["completed_seasons"] == 1


def test_bad_plates_players_and_other_families_are_rejected(app, mum):
    k = add_kid(mum, "Jack")
    assert spot(mum, "ZZ", k).status_code == 400
    assert mum.post("/api/county/spot", json={"code": "D"}).status_code == 400
    other = app.test_client()
    other.post("/api/family", json={"family_name": "Other", "parent_name": "Dad"})
    assert spot(other, "D", k).status_code == 404
    r = spot(mum, "D", k).get_json()
    assert other.delete(f"/api/county/spot/{r['spot_id']}").status_code == 404
    assert other.get("/api/county/passport").get_json()["counties_collected"] == 0


def test_county_data_in_export_and_deleted_with_child_or_family(app, mum):
    from county import CountyProfile, CountySpot
    k1, k2 = add_kid(mum, "Aoife"), add_kid(mum, "Jack")
    spot(mum, "D", k1)
    spot(mum, "C", k2)
    data = mum.get("/api/export").get_json()["county_collector"]
    assert len(data["spots"]) == 2 and data["profile"]
    mum.post(f"/api/kids/{k1}/delete", json={"confirm": "DELETE"})
    with app.app_context():
        assert CountySpot.query.count() == 1
    mum.post("/api/family/delete", json={"confirm": "DELETE"})
    with app.app_context():
        assert CountySpot.query.count() == CountyProfile.query.count() == 0
