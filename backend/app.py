"""
Silent Sign - local web server.

Serves the pages (login, recognizer, dashboard) and a JSON API from the same
origin, so the browser needs no CORS setup and webcam access works on
http://127.0.0.1 (browsers treat localhost as a secure context).

Pages
    GET  /login              log in or create an account
    GET  /                   the recognizer (requires login)
    GET  /dashboard          history, statistics, settings (requires login)

Recognition API
    GET  /api/health         model + server status (public)
    POST /api/predict        body = one JPEG/PNG frame  (?mirror=1 optional)
    POST /api/reset          reset hand tracking (after camera restart)

Accounts and history API: see backend/accounts.py

Every POST/PUT/DELETE to /api/ must carry the header  X-Silent-Sign: 1.
Browsers do not let other websites add custom headers to cross-site requests
without permission, so this blocks cross-site request forgery.

Run from the project root:
    python backend/app.py
"""

import argparse
import logging
import os
import sys
from datetime import timedelta
from pathlib import Path

os.environ.setdefault("GLOG_minloglevel", "2")        # quieter MediaPipe logs
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import cv2
import numpy as np
from flask import Flask, jsonify, redirect, request, send_from_directory, session

sys.path.insert(0, str(Path(__file__).resolve().parent))
import accounts  # noqa: E402
from db import init_db, load_secret_key  # noqa: E402
from inference import PROJECT_ROOT, ModelNotReady, Recognizer  # noqa: E402

MAX_UPLOAD_BYTES = 3 * 1024 * 1024
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "application/octet-stream"}
CSRF_HEADER = "X-Silent-Sign"

log = logging.getLogger("silent-sign")

app = Flask(__name__, static_folder=None)
app.config.update(
    MAX_CONTENT_LENGTH=MAX_UPLOAD_BYTES,
    SECRET_KEY=load_secret_key(),
    SESSION_COOKIE_NAME="silent_sign_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Strict",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),   # only with "Keep me logged in"
    DATABASE=os.environ.get("SILENT_SIGN_DB"),       # tests use a temporary database
)
init_db(app)

recognizer = None
startup_error = None


def load_recognizer():
    global recognizer, startup_error
    try:
        recognizer = Recognizer(static_images=False)
        startup_error = None
        log.info("Model loaded: %d classes, threshold %.2f",
                 len(recognizer.classes), recognizer.threshold)
    except Exception as exc:  # keep serving the UI so it can show the error
        recognizer = None
        startup_error = f"{type(exc).__name__}: {exc}"
        log.error("Model failed to load: %s", startup_error)


def error(message, status, **extra):
    return jsonify({"ok": False, "error": message, **extra}), status


accounts.register(app, lambda: recognizer.classes if recognizer else [])


@app.before_request
def require_csrf_header():
    if request.path.startswith("/api/") and request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        if request.headers.get(CSRF_HEADER) != "1":
            return error("Request blocked: missing X-Silent-Sign header.", 403)
    return None


@app.after_request
def security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    if request.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    return resp


# ---------------------------------------------------------------- pages
def _logged_in():
    return session.get("user_id") is not None


def _page(name):
    resp = send_from_directory(PROJECT_ROOT, name)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/")
def index():
    if not _logged_in():
        return redirect("/login")
    return _page("index.html")


@app.get("/dashboard")
def dashboard():
    if not _logged_in():
        return redirect("/login?next=/dashboard")
    return _page("dashboard.html")


@app.get("/login")
def login_page():
    if _logged_in():
        return redirect("/")
    return _page("login.html")


@app.get("/css/<path:name>")
def css(name):
    return send_from_directory(PROJECT_ROOT / "css", name)


@app.get("/js/<path:name>")
def js(name):
    return send_from_directory(PROJECT_ROOT / "js", name)


@app.get("/assets/<path:name>")
def assets(name):
    return send_from_directory(PROJECT_ROOT / "assets", name)


# --------------------------------------------------------------------- API
@app.get("/api/health")
def health():
    if recognizer is None:
        return jsonify({"ok": False, "model_loaded": False, "error": startup_error}), 503
    return jsonify({"ok": True, "model_loaded": True, **recognizer.info()})


@app.post("/api/predict")
@accounts.login_required
def predict():
    if recognizer is None:
        return error(f"Model not loaded: {startup_error}", 503)

    content_type = (request.mimetype or "").lower()
    if content_type not in ALLOWED_TYPES:
        return error(f"Unsupported content type '{content_type}'. Send a JPEG or PNG frame.", 415)
    data = request.get_data(cache=False)
    if not data:
        return error("Empty request body: expected one image frame.", 400)

    frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        return error("Could not decode the image data.", 400)
    if min(frame.shape[:2]) < 32:
        return error("Frame is too small (minimum 32x32 pixels).", 400)

    mirror = request.args.get("mirror", "0") in {"1", "true", "yes"}
    try:
        result = recognizer.predict_frame(frame, mirror=mirror)
    except Exception as exc:
        log.exception("Inference failed")
        return error(f"Inference failed: {type(exc).__name__}: {exc}", 500)
    return jsonify({"ok": True, **result})


@app.post("/api/reset")
@accounts.login_required
def reset():
    if recognizer is None:
        return error(f"Model not loaded: {startup_error}", 503)
    recognizer.reset()
    return jsonify({"ok": True})


@app.errorhandler(413)
def too_large(_):
    return error(f"Request larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.", 413)


@app.errorhandler(404)
def not_found(_):
    return error("Not found.", 404)


@app.errorhandler(405)
def not_allowed(_):
    return error("Method not allowed.", 405)


def main():
    parser = argparse.ArgumentParser(description="Silent Sign local server")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--host", default="127.0.0.1",
                        help="Keep 127.0.0.1 so the server is not exposed to your network.")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
    load_recognizer()
    url = f"http://127.0.0.1:{args.port}"
    print("\n  Silent Sign is running.")
    print(f"  Open {url} in Chrome or Edge.   Press Ctrl+C to stop.\n")
    app.run(host=args.host, port=args.port, debug=False, threaded=True, use_reloader=False)


# Allow `flask --app backend/app.py run` too.
if recognizer is None and startup_error is None and __name__ != "__main__":
    load_recognizer()

if __name__ == "__main__":
    main()
