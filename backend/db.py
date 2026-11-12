"""
Silent Sign - local SQLite storage for accounts and signing history.

The database lives in instance/silent_sign.db next to the project and never
leaves this computer. No video or images are stored: only the letters that were
added to a caption, their confidence, and the caption text.

Tables
  users     one row per account; password stored as a salted hash
  sessions  one signing session (one visit to the recognizer page with activity)
  events    what happened in a session: letter added, space, delete,
            word suggestion accepted, caption cleared / restored
"""

import os
import sqlite3
import time
from pathlib import Path

from flask import current_app, g

PROJECT_ROOT = Path(__file__).resolve().parent.parent
INSTANCE_DIR = PROJECT_ROOT / "instance"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    created_at    REAL    NOT NULL,
    settings      TEXT    NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at  REAL    NOT NULL,
    updated_at  REAL    NOT NULL,
    caption     TEXT    NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY,
    session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    at          REAL    NOT NULL,
    type        TEXT    NOT NULL,
    ch          TEXT,
    confidence  REAL,
    source      TEXT,
    text        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
"""


def database_path():
    configured = current_app.config.get("DATABASE")
    if configured:
        return Path(configured)
    return INSTANCE_DIR / "silent_sign.db"


def connect(path):
    conn = sqlite3.connect(str(path), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def get_db():
    if "db" not in g:
        g.db = connect(database_path())
    return g.db


def close_db(_exc=None):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db(app):
    """Create the instance folder, the database file and the tables."""
    with app.app_context():
        path = database_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = connect(path)
        conn.executescript(SCHEMA)
        conn.commit()
        conn.close()
    app.teardown_appcontext(close_db)


def load_secret_key():
    """A random key that signs login cookies, created once per installation."""
    env = os.environ.get("SILENT_SIGN_SECRET_KEY")
    if env:
        return env
    INSTANCE_DIR.mkdir(parents=True, exist_ok=True)
    key_file = INSTANCE_DIR / "secret_key"
    if not key_file.exists():
        import secrets
        key_file.write_text(secrets.token_hex(32), encoding="utf-8")
    return key_file.read_text(encoding="utf-8").strip()


def now():
    return time.time()
