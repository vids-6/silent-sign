"""
Silent Sign account, history, statistics and export tests.

Run from the project root:
    python -m unittest discover -s tests -v
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="silent-sign-tests-")
os.environ.setdefault("SILENT_SIGN_DB", os.path.join(_TMP, "test.db"))
os.environ.setdefault("SILENT_SIGN_SECRET_KEY", "test-secret-key")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import accounts  # noqa: E402
import app as server  # noqa: E402

HDR = {"X-Silent-Sign": "1"}
_counter = [0]


def new_client(password="correct-horse-1"):
    """A browser-like client signed up as a brand-new user."""
    _counter[0] += 1
    name = f"user_{os.getpid()}_{_counter[0]}"
    c = server.app.test_client()
    r = c.post("/api/auth/signup", headers=HDR, json={"username": name, "password": password})
    assert r.status_code == 201, r.get_json()
    return c, name


def send(c, sid, *events):
    return c.post(f"/api/sessions/{sid}/events", headers=HDR, json={"events": list(events)})


class AuthTests(unittest.TestCase):
    def setUp(self):
        accounts.reset_throttle()

    def test_signup_login_logout_flow(self):
        c, name = new_client()
        me = c.get("/api/auth/me").get_json()
        self.assertEqual(me["username"], name)
        self.assertEqual(c.get("/").status_code, 200)
        self.assertEqual(c.get("/dashboard").status_code, 200)
        self.assertEqual(c.get("/login").status_code, 302)        # already logged in

        self.assertEqual(c.post("/api/auth/logout", headers=HDR).status_code, 200)
        self.assertEqual(c.get("/api/auth/me").status_code, 401)
        self.assertEqual(c.get("/").status_code, 302)
        self.assertEqual(c.get("/dashboard").headers["Location"], "/login?next=/dashboard")

        r = c.post("/api/auth/login", headers=HDR,
                   json={"username": name.upper(), "password": "correct-horse-1"})
        self.assertEqual(r.status_code, 200, "usernames are case-insensitive")
        self.assertEqual(c.get("/api/auth/me").status_code, 200)

    def test_password_is_hashed(self):
        c, name = new_client("my-secret-pass")
        with server.app.app_context():
            from db import get_db
            row = get_db().execute("SELECT password_hash FROM users WHERE username = ?", (name,)).fetchone()
        self.assertNotIn("my-secret-pass", row["password_hash"])
        self.assertTrue(row["password_hash"].startswith(("scrypt:", "pbkdf2:")))

    def test_signup_validation(self):
        c = server.app.test_client()
        bad = [
            ({"username": "ab", "password": "longenough"}, "username"),
            ({"username": "has space", "password": "longenough"}, "username"),
            ({"username": "<script>", "password": "longenough"}, "username"),
            ({"username": "okname", "password": "short"}, "password"),
        ]
        for body, field in bad:
            r = c.post("/api/auth/signup", headers=HDR, json=body)
            self.assertEqual(r.status_code, 400, body)
            self.assertEqual(r.get_json()["field"], field)
        _, name = new_client()
        r = c.post("/api/auth/signup", headers=HDR, json={"username": name.upper(), "password": "longenough"})
        self.assertEqual(r.status_code, 409)

    def test_wrong_password_and_lockout(self):
        _, name = new_client()
        c = server.app.test_client()
        for _ in range(accounts.LOCK_AFTER_FAILURES):
            r = c.post("/api/auth/login", headers=HDR, json={"username": name, "password": "wrong-pass"})
            self.assertEqual(r.status_code, 401)
        r = c.post("/api/auth/login", headers=HDR, json={"username": name, "password": "correct-horse-1"})
        self.assertEqual(r.status_code, 429, "locked even with the right password")
        self.assertIn("retry_after", r.get_json())

    def test_unknown_user_same_message(self):
        c = server.app.test_client()
        r1 = c.post("/api/auth/login", headers=HDR, json={"username": "nobody_here", "password": "whatever1"})
        _, name = new_client()
        r2 = c.post("/api/auth/login", headers=HDR, json={"username": name, "password": "whatever1"})
        self.assertEqual(r1.get_json()["error"], r2.get_json()["error"])

    def test_csrf_header_required(self):
        c = server.app.test_client()
        r = c.post("/api/auth/login", json={"username": "x", "password": "y"})
        self.assertEqual(r.status_code, 403)

    def test_change_password(self):
        c, name = new_client()
        r = c.post("/api/auth/password", headers=HDR, json={"current": "nope-nope", "new": "brand-new-pass"})
        self.assertEqual(r.status_code, 403)
        r = c.post("/api/auth/password", headers=HDR, json={"current": "correct-horse-1", "new": "brand-new-pass"})
        self.assertEqual(r.status_code, 200)
        c2 = server.app.test_client()
        self.assertEqual(c2.post("/api/auth/login", headers=HDR,
                                 json={"username": name, "password": "brand-new-pass"}).status_code, 200)

    def test_delete_account_removes_data(self):
        c, name = new_client()
        sid = c.post("/api/sessions", headers=HDR).get_json()["id"]
        send(c, sid, {"type": "add", "ch": "A", "confidence": 0.9, "caption": "A"})
        r = c.delete("/api/auth/account", headers=HDR, json={"password": "wrong-one"})
        self.assertEqual(r.status_code, 403)
        r = c.delete("/api/auth/account", headers=HDR, json={"password": "correct-horse-1"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(c.get("/api/auth/me").status_code, 401)
        with server.app.app_context():
            from db import get_db
            self.assertEqual(get_db().execute("SELECT COUNT(*) FROM sessions WHERE id = ?", (sid,)).fetchone()[0], 0)
            self.assertEqual(get_db().execute("SELECT COUNT(*) FROM events WHERE session_id = ?", (sid,)).fetchone()[0], 0)

    def test_instance_folder_not_served(self):
        c, _ = new_client()
        self.assertEqual(c.get("/instance/silent_sign.db").status_code, 404)
        self.assertEqual(c.get("/assets/../instance/secret_key").status_code, 404)


class HistoryTests(unittest.TestCase):
    def test_settings_roundtrip_and_validation(self):
        c, _ = new_client()
        s = c.get("/api/settings").get_json()["settings"]
        self.assertEqual(s, accounts.DEFAULT_SETTINGS)
        r = c.put("/api/settings", headers=HDR, json={"leftHand": True, "holdSeconds": 1.2, "suggestions": False})
        self.assertEqual(r.get_json()["settings"]["holdSeconds"], 1.2)
        self.assertTrue(c.get("/api/settings").get_json()["settings"]["leftHand"])
        for bad in ({"holdSeconds": 5}, {"leftHand": "yes"}, {"holdSeconds": "x"}):
            self.assertEqual(c.put("/api/settings", headers=HDR, json=bad).status_code, 400, bad)

    def test_events_stats_and_transcript(self):
        c, name = new_client()
        sid = c.post("/api/sessions", headers=HDR).get_json()["id"]
        r = send(c, sid,
                 {"type": "add", "ch": "H", "confidence": 0.9, "caption": "H"},
                 {"type": "add", "ch": "B", "confidence": 0.6, "caption": "HB"},
                 {"type": "delete", "ch": "B", "source": "sign", "caption": "H"},     # a correction
                 {"type": "add", "ch": "E", "confidence": 0.8, "caption": "HE"},
                 {"type": "suggest", "text": "HELLO", "caption": "HELLO "},
                 {"type": "delete", "ch": " ", "source": "suggestion", "caption": "HELLO"},
                 {"type": "clear", "text": "HELLO", "caption": ""},
                 {"type": "add", "ch": "V", "confidence": 1.0, "caption": "V"})
        self.assertEqual(r.status_code, 200, r.get_json())

        st = c.get("/api/stats").get_json()
        t = st["totals"]
        self.assertEqual(t["sessions"], 1)
        self.assertEqual(t["letters_added"], 4)
        self.assertEqual(t["corrections"], 1, "only deleting a signed letter counts as a correction")
        self.assertEqual(t["suggestions_used"], 1)
        self.assertAlmostEqual(t["avg_confidence"], (0.9 + 0.6 + 0.8 + 1.0) / 4, places=3)
        b = next(x for x in st["per_letter"] if x["letter"] == "B")
        self.assertEqual((b["added"], b["corrected"]), (1, 1))
        self.assertEqual(len(st["daily"]), 14)
        self.assertEqual(st["daily"][-1]["letters"], 4)

        lst = c.get("/api/sessions").get_json()["sessions"]
        self.assertEqual(lst[0]["lines"], ["HELLO", "V"])
        self.assertEqual(lst[0]["caption"], "V")

        tr = c.get(f"/api/sessions/{sid}/transcript")
        self.assertEqual(tr.status_code, 200)
        self.assertIn("attachment", tr.headers["Content-Disposition"])
        text = tr.get_data(as_text=True)
        self.assertIn(f"User:            {name}", text)
        self.assertIn("1. HELLO", text)
        self.assertIn("2. V", text)
        self.assertIn("deleted    B   (correction)", text)

    def test_undo_clear_restores_line(self):
        c, _ = new_client()
        sid = c.post("/api/sessions", headers=HDR).get_json()["id"]
        send(c, sid,
             {"type": "add", "ch": "A", "confidence": 0.9, "caption": "A"},
             {"type": "clear", "text": "A", "caption": ""},
             {"type": "undo_clear", "text": "A", "caption": "A"})
        self.assertEqual(c.get("/api/sessions").get_json()["sessions"][0]["lines"], ["A"])

    def test_users_cannot_see_each_others_sessions(self):
        alice, _ = new_client()
        bob, _ = new_client()
        sid = alice.post("/api/sessions", headers=HDR).get_json()["id"]
        send(alice, sid, {"type": "add", "ch": "A", "confidence": 0.9, "caption": "A"})
        self.assertEqual(bob.get(f"/api/sessions/{sid}/transcript").status_code, 404)
        self.assertEqual(send(bob, sid, {"type": "space", "caption": "A "}).status_code, 404)
        self.assertEqual(bob.delete(f"/api/sessions/{sid}", headers=HDR).status_code, 404)
        self.assertEqual(bob.get("/api/sessions").get_json()["sessions"], [])
        self.assertEqual(alice.get("/api/sessions").get_json()["total"], 1)

    def test_event_validation(self):
        c, _ = new_client()
        sid = c.post("/api/sessions", headers=HDR).get_json()["id"]
        bad = [
            {"type": "explode"},
            {"type": "add", "ch": "a", "confidence": 0.5},
            {"type": "add", "ch": "AB", "confidence": 0.5},
            {"type": "add", "ch": "A", "confidence": 3},
            {"type": "delete", "ch": "A", "source": "magic"},
            {"type": "suggest", "text": "hello world"},
            {"type": "space", "caption": "<b>hi</b>"},
        ]
        for e in bad:
            self.assertEqual(send(c, sid, e).status_code, 400, e)
        self.assertEqual(c.post(f"/api/sessions/{sid}/events", headers=HDR, json={"events": []}).status_code, 400)
        too_many = [{"type": "space"}] * (accounts.MAX_EVENTS_PER_REQUEST + 1)
        self.assertEqual(c.post(f"/api/sessions/{sid}/events", headers=HDR,
                                json={"events": too_many}).status_code, 400)

    def test_delete_session_and_all(self):
        c, _ = new_client()
        ids = [c.post("/api/sessions", headers=HDR).get_json()["id"] for _ in range(3)]
        self.assertEqual(c.delete(f"/api/sessions/{ids[0]}", headers=HDR).status_code, 200)
        self.assertEqual(c.get("/api/sessions").get_json()["total"], 2)
        self.assertEqual(c.delete("/api/sessions", headers=HDR).get_json()["deleted"], 2)
        self.assertEqual(c.get("/api/sessions").get_json()["total"], 0)

    def test_history_requires_login(self):
        anon = server.app.test_client()
        for method, url in [("get", "/api/sessions"), ("get", "/api/stats"), ("get", "/api/settings"),
                            ("post", "/api/sessions")]:
            r = getattr(anon, method)(url, headers=HDR)
            self.assertEqual(r.status_code, 401, url)


if __name__ == "__main__":
    unittest.main()
