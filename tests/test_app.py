import os

import pytest

from app import create_app, normalise_phone
from models import db


@pytest.fixture()
def app():
    # TEST_DATABASE_URL=postgresql://... runs the suite against real Postgres (foreign keys and all)
    url = os.environ.get("TEST_DATABASE_URL", "sqlite://")
    application = create_app({"TESTING": True, "SQLALCHEMY_DATABASE_URI": url})
    if url != "sqlite://":
        with application.app_context():
            db.drop_all()
            db.create_all()
    yield application
    if url != "sqlite://":
        with application.app_context():
            db.session.remove()
            db.drop_all()


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


SIG = "data:image/png;base64,iVBORw0KGgo="


def test_kid_promises_from_receipt_and_parent_confirms(app, mum):
    k = add_kid(mum, "Keelah")
    pax = mum.post("/api/trips", json={"kid_ids": [k], "distance_km": 20, "minutes": 30}).get_json()["trip"]["passengers"][0]  # 19
    dishes = next(t for t in state(mum)["tasks"] if t["name"] == "Do the dishes")
    kid = app.test_client()  # no login
    r = kid.post(f"/r/{pax['token']}/promise", data={"task_id": dishes["id"], "due": "weekend", "signature": SIG})
    assert r.status_code == 302 and "signed=1" in r.location
    kid.post(f"/r/{pax['token']}/promise", data={"task_id": dishes["id"], "due": "today"})  # duplicate ignored
    page = kid.get(f"/r/{pax['token']}?signed=1").get_data(as_text=True)
    assert "CONTRACT SIGNED" in page and "Do the dishes" in page and "✓ promised" in page

    promises = state(mum)["promises"]
    assert len(promises) == 1 and promises[0]["signature"] == SIG and promises[0]["overdue"] is False
    assert state(mum)["kids"][0]["balance"] == 19  # nothing off until a parent confirms
    assert mum.post(f"/api/promises/{promises[0]['id']}/done").get_json()["balance"] == 14
    assert state(mum)["promises"] == []
    assert mum.post(f"/api/promises/{promises[0]['id']}/done").status_code == 404  # can't double-count


def test_promise_drop_and_limits(app, mum):
    k = add_kid(mum, "Sam")
    pax = mum.post("/api/trips", json={"kid_ids": [k], "distance_km": 50, "minutes": 60}).get_json()["trip"]["passengers"][0]
    kid = app.test_client()
    for t in state(mum)["tasks"][:12]:
        kid.post(f"/r/{pax['token']}/promise", data={"task_id": t["id"], "due": "tomorrow", "signature": "javascript:alert(1)"})
    promises = state(mum)["promises"]
    assert len(promises) == 8  # capped
    assert all(p["signature"] == "" for p in promises)  # junk signatures rejected
    assert mum.post(f"/api/promises/{promises[0]['id']}/drop").status_code == 200
    assert len(state(mum)["promises"]) == 7 and state(mum)["kids"][0]["balance"] > 0
    other = app.test_client(); other.post("/api/family", json={"parent_name": "Stranger"})
    assert other.post(f"/api/promises/{promises[1]['id']}/done").status_code == 404


def test_live_surcharges_count_and_cap(mum):
    k = add_kid(mum, "Keelah")
    # 3 flag + 0 + 0 + guest 3x2 + directions 2 + backseat capped at 10 x 3 = 41
    extras = ["guest", "guest", "directions"] + ["backseat"] * 15
    trip = mum.post("/api/trips", json={"kid_ids": [k], "distance_km": 0, "minutes": 0, "extras": extras}).get_json()["trip"]
    assert trip["total_fare"] == 41
    page = mum.get(f"/r/{trip['passengers'][0]['token']}").get_data(as_text=True)
    assert "Surprise extra passenger ×2" in page and "×10" in page
    assert "Know a parent" in page and "og.png" in page
    live = [e for e in state(mum)["extras"] if e.get("live")]
    assert len(live) == 5


def test_ref_tracking_and_stats_page(app):
    app.config["STATS_KEY"] = "s3cret"
    visitor = app.test_client()
    visitor.get("/?ref=video", headers={"User-Agent": "Mozilla/5.0 (iPhone)"})
    visitor.get("/?ref=video", headers={"User-Agent": "Mozilla/5.0 (iPhone)"})  # no cookie, so counted again
    app.test_client().get("/?ref=video", headers={"User-Agent": "WhatsApp/2.23"})  # link preview bot: ignored
    visitor.post("/api/family", json={"parent_name": "Mum", "ref": "video"})
    k = visitor.post("/api/kids", json={"name": "Keelah"}).get_json()["id"]
    pax = visitor.post("/api/trips", json={"kid_ids": [k], "distance_km": 5, "minutes": 10}).get_json()["trip"]["passengers"][0]
    visitor.get(f"/r/{pax['token']}")  # parent checking: not counted as a kid open
    app.test_client().get(f"/r/{pax['token']}", headers={"User-Agent": "Mozilla/5.0 (iPhone)"})

    assert app.test_client().get("/stats").status_code == 404
    assert app.test_client().get("/stats?key=wrong").status_code == 404
    page = app.test_client().get("/stats?key=s3cret").get_data(as_text=True)
    assert "<td>video</td><td>2</td><td>1</td><td>50%</td><td>1</td><td>1</td>" in page.replace("\n", "").replace("    ", "")
    assert "seen_ref" not in str(visitor.get("/?ref=video").headers)
    assert "100%</b><span>receipts opened" in page
    assert "Keelah" not in page and "Mum" not in page.split("Taxi of Mum")[1].split("</header>")[1]


# ---------------------------------------------------------------- GDPR
import datetime as dt
from models import Event, Family, Kid, LedgerEntry, Passenger, Promise, Task, Trip, db, utcnow


def _family_with_history(app, client, name=None):
    if name:  # a new client: open a new family; otherwise reuse the client's family
        client.post("/api/family", json={"family_name": name + " Cabs", "parent_name": name})
    k1 = client.post("/api/kids", json={"name": "Keelah", "phone": "087 123 4567"}).get_json()["id"]
    k2 = client.post("/api/kids", json={"name": "Sam"}).get_json()["id"]
    trip = client.post("/api/trips", json={"kid_ids": [k1, k2], "distance_km": 9, "minutes": 20}).get_json()["trip"]
    solo = client.post("/api/trips", json={"kid_ids": [k1], "distance_km": 2, "minutes": 5}).get_json()["trip"]
    tok = trip["passengers"][0]["token"]
    task = state(client)["tasks"][0]
    app.test_client().post(f"/r/{tok}/promise", data={"task_id": task["id"], "due": "today", "signature": "data:image/png;base64,AAAA"})
    client.post("/api/payments", json={"kid_id": k1, "task_id": task["id"]})
    return k1, k2, trip, solo


def test_export_contains_everything(app, mum):
    other = app.test_client()
    k1, k2, trip, solo = _family_with_history(app, other, "Dad")
    r = other.get("/api/export")
    assert "attachment" in r.headers["Content-Disposition"]
    data = r.get_json()
    assert {p["name"] for p in data["passengers"]} == {"Keelah", "Sam"}
    assert len(data["trips"]) == 2 and len(data["receipts"]) == 3 and len(data["promises"]) == 1
    assert data["family"]["name"] == "Dad Cabs" and "Sisk Cabs" not in str(data)  # nothing from another family
    assert app.test_client().get("/api/export").status_code == 401


def test_delete_family_removes_all_rows(app, mum):
    _family_with_history(app, mum)
    other = app.test_client()
    _family_with_history(app, other, "Dad")
    assert mum.post("/api/family/delete", json={"confirm": "nope"}).status_code == 400
    assert mum.post("/api/family/delete", json={"confirm": "delete"}).status_code == 200
    assert mum.get("/api/state").status_code == 401  # signed out
    with app.app_context():
        assert Family.query.count() == 1 and Kid.query.count() == 2 and Trip.query.count() == 2
        assert Promise.query.count() == 1 and Passenger.query.count() == 3
        fid = Family.query.first().id
        for model in (Kid, Trip, Task, LedgerEntry, Promise):
            assert all(x.family_id == fid for x in model.query.all())
        assert all(e.family_id in (None, fid) for e in Event.query.all())
    assert state(other)["kids"]  # the other family is untouched


def test_delete_one_child(app, mum):
    k1, k2, trip, solo = _family_with_history(app, mum)
    assert mum.post(f"/api/kids/{k1}/delete", json={"confirm": "DELETE"}).status_code == 200
    s = state(mum)
    assert [k["name"] for k in s["kids"]] == ["Sam"]
    assert [t["id"] for t in s["trips"]] == [trip["id"]]  # Keelah's solo trip is gone, the shared one stays for Sam
    assert [p["name"] for p in s["trips"][0]["passengers"]] == ["Sam"]
    assert s["promises"] == []
    assert mum.get(f"/r/{solo['passengers'][0]['token']}").status_code == 404


def test_signature_deleted_when_promise_closed(app, mum):
    _family_with_history(app, mum)
    pid = state(mum)["promises"][0]["id"]
    mum.post(f"/api/promises/{pid}/done")
    with app.app_context():
        assert db.session.get(Promise, pid).signature is None


def test_receipt_expires_and_inactive_families_are_deleted(app, mum):
    from app import retention_cleanup
    k1, k2, trip, solo = _family_with_history(app, mum)
    tok = trip["passengers"][0]["token"]
    with app.app_context():
        old = utcnow() - dt.timedelta(days=400)
        for t in Trip.query.all():
            t.created_at = old
        for e in LedgerEntry.query.all():
            e.created_at = old
        Family.query.first().created_at = old
        db.session.commit()
    assert app.test_client().get(f"/r/{tok}").status_code == 410
    with app.app_context():
        assert retention_cleanup(force=True) == 1
        assert Family.query.count() == 0 and Kid.query.count() == 0 and Trip.query.count() == 0


def test_privacy_pages_and_no_third_party_fonts(app):
    c = app.test_client()
    for path in ("/privacy", "/terms"):
        assert c.get(path).status_code == 200
    assert "For kids" in c.get("/privacy").get_data(as_text=True)
    assert "googleapis" not in c.get("/").get_data(as_text=True)


def test_old_host_redirects(monkeypatch):
    from app import create_app
    monkeypatch.setenv("REDIRECT_TO", "https://taxi-mum-dad-eu.onrender.com/")
    old = create_app({"TESTING": True, "SQLALCHEMY_DATABASE_URI": "sqlite://"}).test_client()
    r = old.get("/r/abc?x=1")
    assert r.status_code == 301 and r.location == "https://taxi-mum-dad-eu.onrender.com/r/abc?x=1"
    assert old.get("/healthz").status_code == 200


def test_friendly_not_found_pages(app):
    c = app.test_client()
    r = c.get("/r/old-test-receipt")
    assert r.status_code == 404 and "isn't on the meter" in r.get_data(as_text=True)
    r = c.get("/nowhere")
    assert r.status_code == 404 and "Wrong turn" in r.get_data(as_text=True)
    assert c.get("/api/nothing").get_json() == {"error": "not_found"}


def test_old_default_job_names_are_renamed(app):
    from app import rename_old_defaults
    from models import Family, Task
    with app.app_context():
        f = Family(name="Old")
        db.session.add(f); db.session.flush()
        db.session.add(Task(family_id=f.id, name="Visit Granny / Grandad in the home", emoji="👵", credits=25))
        db.session.commit()
        rename_old_defaults()
        assert Task.query.filter_by(family_id=f.id).one().name == "Visit Granny / Grandad and make them smile"


def test_undo_confirmed_promise_reopens_it(app, mum):
    k = add_kid(mum, "Keelah")
    pax = mum.post("/api/trips", json={"kid_ids": [k], "distance_km": 20, "minutes": 30}).get_json()["trip"]["passengers"][0]
    task = state(mum)["tasks"][0]
    app.test_client().post(f"/r/{pax['token']}/promise", data={"task_id": task["id"], "due": "today"})
    pid = state(mum)["promises"][0]["id"]
    mum.post(f"/api/promises/{pid}/done")
    entry = next(e for e in mum.get(f"/api/kids/{k}/ledger").get_json()["entries"] if e["kind"] == "payment")
    r = mum.delete(f"/api/ledger/{entry['id']}")
    assert r.status_code == 200 and r.get_json()["promise_reopened"] is True
    assert [p["id"] for p in state(mum)["promises"]] == [pid]
    assert state(mum)["kids"][0]["balance"] == 19
