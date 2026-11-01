import pytest

from app import create_app, normalise_phone


@pytest.fixture()
def app():
    return create_app({"TESTING": True, "SQLALCHEMY_DATABASE_URI": "sqlite://"})


@pytest.fixture()
def mum(app):
    c = app.test_client()
    assert c.post("/api/family", json={"family_name": "Sisk Cabs", "parent_name": "Mum", "emoji": "👩"}).status_code == 200
    return c


def state(c):
    r = c.get("/api/state")
    assert r.status_code == 200
    return r.get_json()


def add_kid(c, name, phone=None):
    return c.post("/api/kids", json={"name": name, "emoji": "🧒", "phone": phone}).get_json()["id"]


def test_requires_login(app):
    assert app.test_client().get("/api/state").status_code == 401


def test_family_created_with_default_jobs(mum):
    s = state(mum)
    assert s["family"]["name"] == "Sisk Cabs"
    assert s["family"]["invite_code"].startswith("TAXI-")
    assert len(s["tasks"]) >= 8


def test_second_parent_joins_same_family(app, mum):
    code = state(mum)["family"]["invite_code"]
    dad = app.test_client()
    assert dad.post("/api/join", json={"code": code.replace("TAXI-", "").lower(), "parent_name": "Dad"}).status_code == 200
    assert [p["name"] for p in state(dad)["parents"]] == ["Mum", "Dad"]
    assert app.test_client().post("/api/join", json={"code": "TAXI-NOPE99", "parent_name": "X"}).status_code == 404


def test_trip_fare_split_discount_and_balance(mum):
    a, b = add_kid(mum, "Keelah"), add_kid(mum, "Sam")
    # defaults: flag 3 + 10km*0.5 + 20min*0.2 + dj 2 = 14 -> split 2 = 7 each; 5-star gets 10% off (1)
    r = mum.post("/api/trips", json={"kid_ids": [a, b], "distance_km": 10, "minutes": 20, "extras": ["dj", "bogus"],
                                     "ratings": {str(a): {"stars": 5, "tags": ["💬 Great chat", "hack"]}, str(b): {"stars": 3}}})
    trip = r.get_json()["trip"]
    assert trip["total_fare"] == 14
    fares = {p["kid_id"]: p for p in trip["passengers"]}
    assert fares[a]["fare"] == 6 and fares[a]["discount"] == 1
    assert fares[b]["fare"] == 7
    kids = {k["id"]: k for k in state(mum)["kids"]}
    assert kids[a]["balance"] == 6 and kids[b]["balance"] == 7


def test_pay_off_with_job_and_undo(mum):
    k = add_kid(mum, "Keelah")
    mum.post("/api/trips", json={"kid_ids": [k], "distance_km": 20, "minutes": 30})  # 3+10+6 = 19
    task = next(t for t in state(mum)["tasks"] if t["name"] == "Do the dishes")
    assert mum.post("/api/payments", json={"kid_id": k, "task_id": task["id"]}).get_json()["balance"] == 14
    assert mum.post("/api/payments", json={"kid_id": k, "label": "Granny visit", "credits": 20}).get_json()["balance"] == -6
    ledger = mum.get(f"/api/kids/{k}/ledger").get_json()
    pay = next(e for e in ledger["entries"] if e["label"] == "Granny visit")
    assert mum.delete(f"/api/ledger/{pay['id']}").status_code == 200
    fare = next(e for e in ledger["entries"] if e["kind"] == "fare")
    assert mum.delete(f"/api/ledger/{fare['id']}").status_code == 404  # fares undo via trip delete
    assert mum.get(f"/api/kids/{k}/ledger").get_json()["balance"] == 14


def test_delete_trip_removes_fare(mum):
    k = add_kid(mum, "Keelah")
    trip = mum.post("/api/trips", json={"kid_ids": [k], "distance_km": 1, "minutes": 1}).get_json()["trip"]
    assert mum.delete(f"/api/trips/{trip['id']}").status_code == 200
    assert state(mum)["kids"][0]["balance"] == 0


def test_receipt_rating_and_qr(app, mum):
    k = add_kid(mum, "Keelah")
    me = state(mum)["me"]["id"]
    pax = mum.post("/api/trips", json={"kid_ids": [k], "distance_km": 4, "minutes": 12, "note": "Drama class"}).get_json()["trip"]["passengers"][0]
    kid_browser = app.test_client()  # no login
    page = kid_browser.get(f"/r/{pax['token']}")
    assert page.status_code == 200 and "Drama class" in page.get_data(as_text=True)
    r = kid_browser.post(f"/r/{pax['token']}/rate", data={"driver_stars": "4", "journey_stars": "5", "comment": "Music was mid"})
    assert r.status_code == 302
    kid_browser.post(f"/r/{pax['token']}/rate", data={"driver_stars": "1", "journey_stars": "1"})  # locked after first
    drivers = {d["id"]: d for d in state(mum)["drivers"]}
    assert drivers[me]["driver_stars"] == 4.0
    assert kid_browser.get(f"/r/{pax['token']}/qr.svg").mimetype == "image/svg+xml"
    assert kid_browser.get("/r/not-a-token").status_code == 404


def test_other_family_cannot_touch_my_kids(app, mum):
    k = add_kid(mum, "Keelah")
    other = app.test_client()
    other.post("/api/family", json={"parent_name": "Stranger"})
    assert other.post("/api/payments", json={"kid_id": k, "label": "x", "credits": 5}).status_code == 404
    assert other.post("/api/trips", json={"kid_ids": [k], "distance_km": 1}).status_code == 400


def test_phone_normalising():
    assert normalise_phone("087 123 4567") == "353871234567"
    assert normalise_phone("+353 87 1234567") == "353871234567"
    assert normalise_phone("0044 7700 900123") == "447700900123"
    assert normalise_phone("") is None
