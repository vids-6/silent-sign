/* Silent Sign - saves caption activity to the user's history.
 *
 * Events are queued and sent in order, one request at a time. A signing
 * session is created on the server only when the first event happens, so
 * opening the page without signing leaves no empty session behind.
 * If the server is unreachable the queue is kept and retried with backoff;
 * captioning itself never waits for this.
 *
 * onState(state, detail) is called with "saving" | "saved" | "offline" | "error".
 */
(function () {
  "use strict";

  var MAX_BATCH = 100;

  function SessionLog(api, onState) {
    this.api = api;
    this.onState = onState || function () {};
    this.queue = [];
    this.sessionId = null;
    this.inFlight = false;
    this.failures = 0;
    this.retryTimer = null;
  }

  SessionLog.prototype.log = function (event) {
    this.queue.push(event);
    this.flush();
  };

  /* Start a new session for the next events (e.g. after the camera restarts). */
  SessionLog.prototype.newSession = function () {
    if (!this.queue.length && !this.inFlight) this.sessionId = null;
    else this._newAfterFlush = true;
  };

  SessionLog.prototype._ensureSession = function () {
    var self = this;
    if (self.sessionId) return Promise.resolve(self.sessionId);
    return self.api.post("/api/sessions").then(function (r) {
      self.sessionId = r.id;
      return r.id;
    });
  };

  SessionLog.prototype.flush = function () {
    var self = this;
    if (self.inFlight) return;
    clearTimeout(self.retryTimer);
    if (!self.queue.length) {
      if (self._newAfterFlush) { self.sessionId = null; self._newAfterFlush = false; }
      return;
    }
    self.inFlight = true;
    self.onState("saving");
    var batch = self.queue.slice(0, MAX_BATCH);
    self._ensureSession().then(function (sid) {
      return self.api.post("/api/sessions/" + sid + "/events", { events: batch }, { keepalive: true });
    }).then(function () {
      self.queue.splice(0, batch.length);
      self.failures = 0;
      self.inFlight = false;
      if (self.queue.length) self.flush();
      else {
        if (self._newAfterFlush) { self.sessionId = null; self._newAfterFlush = false; }
        self.onState("saved");
      }
    }).catch(function (err) {
      self.inFlight = false;
      if (err.status === 404) {          // session was deleted (e.g. from the dashboard)
        self.sessionId = null;
        self.flush();
        return;
      }
      if (err.status === 400) {          // the server rejected this data: drop it, don't loop
        self.queue.splice(0, batch.length);
        self.onState("error", err.message);
        if (self.queue.length) self.flush();
        return;
      }
      if (err.status === 401) return;    // api.js is already redirecting to the login page
      self.failures += 1;
      self.onState("offline");
      var delay = Math.min(30000, 1000 * Math.pow(2, Math.min(self.failures, 5)));
      self.retryTimer = setTimeout(function () { self.flush(); }, delay);
    });
  };

  window.SilentSignSessionLog = SessionLog;
})();
