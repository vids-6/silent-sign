"""
Silent Sign - accounts, settings, signing history, statistics and export.

All routes are JSON under /api/ and are registered on the Flask app by
register(app). Pages call them with the X-Silent-Sign header (see app.py).

Accounts are local to this computer. Passwords are stored only as salted
hashes (Werkzeug). Repeated wrong passwords lock that username for a minute.
"""

import json
import re
import threading
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from functools import wraps

from flask import Response, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from db import get_db, now

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
PASSWORD_MIN, PASSWORD_MAX = 8, 128
CAPTION_RE = re.compile(r"^[A-Z ]{0,2000}$")
WORD_RE = re.compile(r"^[A-Z]{1,30}$")
EVENT_TYPES = {"add", "space", "delete", "suggest", "clear", "undo_clear"}
SOURCES = {"sign", "suggestion", "space"}
MAX_EVENTS_PER_REQUEST = 100

DEFAULT_SETTINGS = {"leftHand": False, "holdSeconds": 0.8, "landmarks": True, "suggestions": True}

LOCK_AFTER_FAILURES = 5
FAILURE_WINDOW_S = 10 * 60
LOCK_SECONDS = 60
_failures = defaultdict(list)
_failures_lock = threading.Lock()
# Used so that a login for a username that does not exist takes as long as a
# wrong password, and does not reveal which usernames exist.
_DUMMY_HASH = generate_password_hash("silent-sign-timing-equaliser")


def error(message, status, **extra):
    return jsonify({"ok": False, "error": message, **extra}), status


def current_user_id():
    return session.get("user_id")


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        uid = current_user_id()
        if uid is None:
            return error("Log in to use Silent Sign.", 401, auth=False)
        row = get_db().execute("SELECT id FROM users WHERE id = ?", (uid,)).fetchone()
        if row is None:  # account was deleted while the cookie still existed
            session.clear()
            return error("Your account no longer exists. Log in again.", 401, auth=False)
        return view(*args, **kwargs)
    return wrapped


def json_body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else None


# ------------------------------------------------------------------ throttle
def _throttle_key(username):
    return (request.remote_addr or "?", username.lower())


def _locked_for(username):
    key = _throttle_key(username)
    t = time.time()
    with _failures_lock:
        recent = [x for x in _failures[key] if t - x < FAILURE_WINDOW_S]
        _failures[key] = recent
        if len(recent) >= LOCK_AFTER_FAILURES:
            remaining = LOCK_SECONDS - (t - recent[-1])
            if remaining > 0:
                return int(remaining) + 1
    return 0


def _record_failure(username):
    with _failures_lock:
        _failures[_throttle_key(username)].append(time.time())


def _clear_failures(username):
    with _failures_lock:
        _failures.pop(_throttle_key(username), None)


def reset_throttle():
    """For tests."""
    with _failures_lock:
        _failures.clear()


# ------------------------------------------------------------------ helpers
def _start_login(user_row, remember):
    session.clear()
    session["user_id"] = user_row["id"]
    session.permanent = bool(remember)


def _validate_new_password(password):
    if not isinstance(password, str) or len(password) < PASSWORD_MIN:
        return f"Password must be at least {PASSWORD_MIN} characters."
    if len(password) > PASSWORD_MAX:
        return f"Password must be at most {PASSWORD_MAX} characters."
    return None


def _settings_for(uid):
    row = get_db().execute("SELECT settings FROM users WHERE id = ?", (uid,)).fetchone()
    stored = {}
    try:
        stored = json.loads(row["settings"]) if row else {}
    except ValueError:
        stored = {}
    merged = dict(DEFAULT_SETTINGS)
    merged.update({k: v for k, v in stored.items() if k in DEFAULT_SETTINGS})
    return merged


def _owned_session(sid):
    return get_db().execute(
        "SELECT * FROM sessions WHERE id = ? AND user_id = ?", (sid, current_user_id())
    ).fetchone()


def _fmt_time(ts, fmt="%d %b %Y, %H:%M"):
    return datetime.fromtimestamp(ts).strftime(fmt)


def _transcript_lines(events, final_caption):
    """Captions in order: every caption that was cleared, then the last one."""
    lines = []
    for e in events:
        if e["type"] == "clear" and (e["text"] or "").strip():
            lines.append(e["text"].strip())
        elif e["type"] == "undo_clear" and lines:
            lines.pop()
    if final_caption.strip():
        lines.append(final_caption.strip())
    return lines


def _session_summary(row, events):
    added = sum(1 for e in events if e["type"] == "add")
    corrected = sum(1 for e in events if e["type"] == "delete" and e["source"] == "sign")
    lines = _transcript_lines(events, row["caption"])
    return {
        "id": row["id"],
        "started_at": row["started_at"],
        "updated_at": row["updated_at"],
        "duration_s": round(row["updated_at"] - row["started_at"]),
        "caption": row["caption"],
        "lines": lines,
        "letters_added": added,
        "corrections": corrected,
        "suggestions_used": sum(1 for e in events if e["type"] == "suggest"),
    }


# ------------------------------------------------------------------ routes
def register(app, model_classes_provider):
    """model_classes_provider() -> list of letters the model knows (for stats)."""

    # ---------------------------------------------------------- auth
    @app.post("/api/auth/signup")
    def signup():
        data = json_body()
        if data is None:
            return error("Send username and password as JSON.", 400)
        username = str(data.get("username", "")).strip()
        password = data.get("password", "")
        if not USERNAME_RE.match(username):
            return error("Username must be 3-32 characters: letters, numbers, dot, dash or underscore.", 400,
                         field="username")
        problem = _validate_new_password(password)
        if problem:
            return error(problem, 400, field="password")
        db = get_db()
        if db.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            return error("That username is taken. Choose another, or log in.", 409, field="username")
        cur = db.execute(
            "INSERT INTO users (username, password_hash, created_at, settings) VALUES (?, ?, ?, ?)",
            (username, generate_password_hash(password), now(), json.dumps(DEFAULT_SETTINGS)),
        )
        db.commit()
        user = db.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
        _start_login(user, data.get("remember", True))
        return jsonify({"ok": True, "username": user["username"]}), 201

    @app.post("/api/auth/login")
    def login():
        data = json_body()
        if data is None:
            return error("Send username and password as JSON.", 400)
        username = str(data.get("username", "")).strip()
        password = data.get("password", "")
        if not username or not isinstance(password, str) or not password:
            return error("Enter your username and password.", 400)
        wait = _locked_for(username)
        if wait:
            return error(f"Too many wrong passwords. Try again in {wait} seconds.", 429, retry_after=wait)
        user = get_db().execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if user is None:
            check_password_hash(_DUMMY_HASH, password)
            ok = False
        else:
            ok = check_password_hash(user["password_hash"], password)
        if not ok:
            _record_failure(username)
            return error("Username or password is incorrect.", 401, field="password")
        _clear_failures(username)
        _start_login(user, data.get("remember", False))
        return jsonify({"ok": True, "username": user["username"]})

    @app.post("/api/auth/logout")
    def logout():
        session.clear()
        return jsonify({"ok": True})

    @app.get("/api/auth/me")
    @login_required
    def me():
        user = get_db().execute("SELECT username, created_at FROM users WHERE id = ?",
                                (current_user_id(),)).fetchone()
        return jsonify({"ok": True, "username": user["username"], "created_at": user["created_at"]})

    @app.post("/api/auth/password")
    @login_required
    def change_password():
        data = json_body() or {}
        user = get_db().execute("SELECT * FROM users WHERE id = ?", (current_user_id(),)).fetchone()
        if not check_password_hash(user["password_hash"], str(data.get("current", ""))):
            return error("Current password is incorrect.", 403, field="current")
        problem = _validate_new_password(data.get("new", ""))
        if problem:
            return error(problem, 400, field="new")
        db = get_db()
        db.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                   (generate_password_hash(data["new"]), user["id"]))
        db.commit()
        return jsonify({"ok": True})

    @app.delete("/api/auth/account")
    @login_required
    def delete_account():
        data = json_body() or {}
        db = get_db()
        user = db.execute("SELECT * FROM users WHERE id = ?", (current_user_id(),)).fetchone()
        if not check_password_hash(user["password_hash"], str(data.get("password", ""))):
            return error("Password is incorrect.", 403, field="password")
        db.execute("DELETE FROM users WHERE id = ?", (user["id"],))
        db.commit()
        session.clear()
        return jsonify({"ok": True})

    # ---------------------------------------------------------- settings
    @app.get("/api/settings")
    @login_required
    def get_settings():
        return jsonify({"ok": True, "settings": _settings_for(current_user_id())})

    @app.put("/api/settings")
    @login_required
    def put_settings():
        data = json_body()
        if data is None:
            return error("Send settings as JSON.", 400)
        settings = _settings_for(current_user_id())
        for key in ("leftHand", "landmarks", "suggestions"):
            if key in data:
                if not isinstance(data[key], bool):
                    return error(f"{key} must be true or false.", 400)
                settings[key] = data[key]
        if "holdSeconds" in data:
            try:
                hold = float(data["holdSeconds"])
            except (TypeError, ValueError):
                return error("holdSeconds must be a number.", 400)
            if not 0.4 <= hold <= 2.0:
                return error("holdSeconds must be between 0.4 and 2.0.", 400)
            settings["holdSeconds"] = round(hold, 1)
        db = get_db()
        db.execute("UPDATE users SET settings = ? WHERE id = ?", (json.dumps(settings), current_user_id()))
        db.commit()
        return jsonify({"ok": True, "settings": settings})

    # ---------------------------------------------------------- history
    @app.post("/api/sessions")
    @login_required
    def create_session():
        t = now()
        db = get_db()
        cur = db.execute("INSERT INTO sessions (user_id, started_at, updated_at) VALUES (?, ?, ?)",
                         (current_user_id(), t, t))
        db.commit()
        return jsonify({"ok": True, "id": cur.lastrowid}), 201

    @app.post("/api/sessions/<int:sid>/events")
    @login_required
    def add_events(sid):
        row = _owned_session(sid)
        if row is None:
            return error("Session not found.", 404)
        data = json_body()
        events = data.get("events") if data else None
        if not isinstance(events, list) or not events:
            return error("Send a non-empty list of events.", 400)
        if len(events) > MAX_EVENTS_PER_REQUEST:
            return error(f"At most {MAX_EVENTS_PER_REQUEST} events per request.", 400)

        clean, caption = [], None
        for i, e in enumerate(events):
            if not isinstance(e, dict) or e.get("type") not in EVENT_TYPES:
                return error(f"Event {i}: unknown type.", 400)
            typ = e["type"]
            ch, conf, source, text = None, None, None, None
            if typ == "add":
                ch = e.get("ch")
                conf = e.get("confidence")
                if not (isinstance(ch, str) and len(ch) == 1 and "A" <= ch <= "Z"):
                    return error(f"Event {i}: 'add' needs a letter A-Z.", 400)
                if not isinstance(conf, (int, float)) or not 0 <= conf <= 1:
                    return error(f"Event {i}: confidence must be between 0 and 1.", 400)
                source = "sign"
            elif typ == "space":
                ch, source = " ", "space"
            elif typ == "delete":
                ch, source = e.get("ch"), e.get("source")
                if not (isinstance(ch, str) and len(ch) == 1 and (ch == " " or "A" <= ch <= "Z")):
                    return error(f"Event {i}: 'delete' needs the removed character.", 400)
                if source not in SOURCES:
                    return error(f"Event {i}: unknown source.", 400)
            elif typ == "suggest":
                text = e.get("text")
                if not (isinstance(text, str) and WORD_RE.match(text)):
                    return error(f"Event {i}: 'suggest' needs the accepted word.", 400)
            else:  # clear / undo_clear
                text = e.get("text", "")
                if not (isinstance(text, str) and CAPTION_RE.match(text)):
                    return error(f"Event {i}: invalid caption text.", 400)
            if "caption" in e:
                if not (isinstance(e["caption"], str) and CAPTION_RE.match(e["caption"])):
                    return error(f"Event {i}: invalid caption.", 400)
                caption = e["caption"]
            clean.append((sid, now(), typ, ch, None if conf is None else float(conf), source, text))

        db = get_db()
        db.executemany(
            "INSERT INTO events (session_id, at, type, ch, confidence, source, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
            clean)
        if caption is not None:
            db.execute("UPDATE sessions SET caption = ?, updated_at = ? WHERE id = ?", (caption, now(), sid))
        else:
            db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now(), sid))
        db.commit()
        return jsonify({"ok": True, "stored": len(clean)})

    @app.get("/api/sessions")
    @login_required
    def list_sessions():
        try:
            limit = max(1, min(100, int(request.args.get("limit", 20))))
        except ValueError:
            limit = 20
        db = get_db()
        rows = db.execute(
            "SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?",
            (current_user_id(), limit)).fetchall()
        out = []
        for r in rows:
            events = db.execute("SELECT * FROM events WHERE session_id = ? ORDER BY id", (r["id"],)).fetchall()
            out.append(_session_summary(r, events))
        total = db.execute("SELECT COUNT(*) FROM sessions WHERE user_id = ?", (current_user_id(),)).fetchone()[0]
        return jsonify({"ok": True, "sessions": out, "total": total})

    @app.delete("/api/sessions/<int:sid>")
    @login_required
    def delete_session(sid):
        if _owned_session(sid) is None:
            return error("Session not found.", 404)
        db = get_db()
        db.execute("DELETE FROM sessions WHERE id = ?", (sid,))
        db.commit()
        return jsonify({"ok": True})

    @app.delete("/api/sessions")
    @login_required
    def delete_all_sessions():
        db = get_db()
        cur = db.execute("DELETE FROM sessions WHERE user_id = ?", (current_user_id(),))
        db.commit()
        return jsonify({"ok": True, "deleted": cur.rowcount})

    @app.get("/api/sessions/<int:sid>/transcript")
    @login_required
    def transcript(sid):
        row = _owned_session(sid)
        if row is None:
            return error("Session not found.", 404)
        db = get_db()
        events = db.execute("SELECT * FROM events WHERE session_id = ? ORDER BY id", (sid,)).fetchall()
        user = db.execute("SELECT username FROM users WHERE id = ?", (current_user_id(),)).fetchone()
        s = _session_summary(row, events)
        out = [
            "Silent Sign - session transcript",
            "=" * 40,
            f"User:            {user['username']}",
            f"Started:         {_fmt_time(row['started_at'])}",
            f"Last activity:   {_fmt_time(row['updated_at'])}",
            f"Letters signed:  {s['letters_added']}",
            f"Corrections:     {s['corrections']}",
            f"Words completed with suggestions: {s['suggestions_used']}",
            "",
            "Captions",
            "-" * 40,
        ]
        out += [f"{i}. {line}" for i, line in enumerate(s["lines"], 1)] or ["(no caption text)"]
        out += ["", "Activity log", "-" * 40]
        for e in events:
            t = _fmt_time(e["at"], "%H:%M:%S")
            if e["type"] == "add":
                out.append(f"{t}  signed     {e['ch']}   ({round(e['confidence'] * 100)}% confidence)")
            elif e["type"] == "space":
                out.append(f"{t}  space")
            elif e["type"] == "delete":
                what = "space" if e["ch"] == " " else e["ch"]
                out.append(f"{t}  deleted    {what}" + ("   (correction)" if e["source"] == "sign" else ""))
            elif e["type"] == "suggest":
                out.append(f"{t}  suggestion {e['text']}")
            elif e["type"] == "clear":
                out.append(f"{t}  caption cleared")
            elif e["type"] == "undo_clear":
                out.append(f"{t}  caption restored")
        out += ["", "Silent Sign recognises static ISL alphabet handshapes. Letters may contain recognition errors."]
        body = "\r\n".join(out) + "\r\n"
        name = f"silent-sign-{datetime.fromtimestamp(row['started_at']).strftime('%Y%m%d-%H%M')}.txt"
        return Response(body, mimetype="text/plain; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})

    # ---------------------------------------------------------- stats
    @app.get("/api/stats")
    @login_required
    def stats():
        db = get_db()
        uid = current_user_id()
        sessions = db.execute("SELECT * FROM sessions WHERE user_id = ?", (uid,)).fetchall()
        events = db.execute(
            "SELECT e.* FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.user_id = ? ORDER BY e.id",
            (uid,)).fetchall()

        adds = [e for e in events if e["type"] == "add"]
        corrections = [e for e in events if e["type"] == "delete" and e["source"] == "sign"]
        added_by = Counter(e["ch"] for e in adds)
        corrected_by = Counter(e["ch"] for e in corrections)
        conf_by = defaultdict(list)
        for e in adds:
            conf_by[e["ch"]].append(e["confidence"])

        letters = list(model_classes_provider() or [])
        for ch in added_by:  # in case the model changed since
            if ch not in letters:
                letters.append(ch)
        per_letter = [{
            "letter": ch,
            "added": added_by.get(ch, 0),
            "corrected": corrected_by.get(ch, 0),
            "avg_confidence": round(sum(conf_by[ch]) / len(conf_by[ch]), 4) if conf_by[ch] else None,
        } for ch in sorted(letters)]

        today = datetime.now().date()
        days = [today - timedelta(days=i) for i in range(13, -1, -1)]
        per_day = Counter(datetime.fromtimestamp(e["at"]).date() for e in adds)
        daily = [{"date": d.isoformat(), "letters": per_day.get(d, 0)} for d in days]

        n_added = len(adds)
        return jsonify({
            "ok": True,
            "totals": {
                "sessions": len(sessions),
                "letters_added": n_added,
                "corrections": len(corrections),
                "correction_rate": round(len(corrections) / n_added, 4) if n_added else None,
                "avg_confidence": round(sum(e["confidence"] for e in adds) / n_added, 4) if n_added else None,
                "suggestions_used": sum(1 for e in events if e["type"] == "suggest"),
                "active_days": len({datetime.fromtimestamp(e["at"]).date() for e in events}),
                "first_activity": min((s["started_at"] for s in sessions), default=None),
            },
            "per_letter": per_letter,
            "daily": daily,
        })
