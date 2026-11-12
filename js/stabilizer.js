/* Silent Sign - prediction stabiliser.
 *
 * Turns a noisy stream of per-frame predictions into deliberate letter
 * commits, using a sliding window of the last `holdMs` of frames:
 *   - A letter is added only when one confident label has dominated the
 *     window (>= minAgreement of frames, >= minFrames frames) continuously
 *     for `holdMs`.
 *   - The same letter is never added twice from one continuous hold. To
 *     repeat a letter the signer lowers their hands (no hands for
 *     `releaseMs`) or signs a different letter in between.
 *   - Uncertain frames (below the model's confidence threshold) never add a
 *     letter; they only dilute the window.
 *
 * Pure logic, no DOM, so it can be unit-tested in Node (tests/stabilizer.test.js).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SilentSignStabilizer = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function Stabilizer(options) {
    options = options || {};
    this.holdMs = options.holdMs || 800;
    this.releaseMs = options.releaseMs || 450;
    this.minAgreement = options.minAgreement || 0.7;
    this.minFrames = options.minFrames || 4;
    this.reset();
  }

  Stabilizer.prototype.reset = function () {
    this.window = [];           // [{ t, label|null }]
    this.candidate = null;      // label currently dominating the window
    this.since = null;          // when it started dominating
    this.locked = null;         // last committed label, blocked until release
    this.noHandSince = null;
  };

  Stabilizer.prototype.setHoldMs = function (ms) {
    this.holdMs = ms;
  };

  /* frame: { hands: number, label: string|null, accepted: bool }
   * now  : timestamp in ms
   * returns { phase, label, progress, agreement, committed } where phase is
   *   "no-hands" | "uncertain" | "holding" | "locked"
   */
  Stabilizer.prototype.update = function (frame, now) {
    if (!frame || !frame.hands) {
      if (this.noHandSince === null) this.noHandSince = now;
      if (now - this.noHandSince >= this.releaseMs) this.locked = null;
      this.window = [];
      this.candidate = null;
      this.since = null;
      return { phase: "no-hands", label: null, progress: 0, agreement: 0, committed: null };
    }
    this.noHandSince = null;

    this.window.push({ t: now, label: frame.accepted ? frame.label : null });
    var cutoff = now - this.holdMs;
    while (this.window.length && this.window[0].t < cutoff) this.window.shift();

    var counts = {};
    var best = null;
    for (var i = 0; i < this.window.length; i++) {
      var l = this.window[i].label;
      if (l === null) continue;
      counts[l] = (counts[l] || 0) + 1;
      if (best === null || counts[l] > counts[best]) best = l;
    }
    var agreement = best === null ? 0 : counts[best] / this.window.length;
    var dominant = best !== null && agreement >= this.minAgreement ? best : null;

    if (dominant !== this.candidate) {
      this.candidate = dominant;
      this.since = dominant === null ? null : now;
    }

    if (dominant === null) {
      return { phase: "uncertain", label: best, progress: 0, agreement: agreement, committed: null };
    }
    if (dominant === this.locked) {
      return { phase: "locked", label: dominant, progress: 1, agreement: agreement, committed: null };
    }

    var progress = Math.min(1, (now - this.since) / this.holdMs);
    if (progress >= 1 && counts[dominant] >= this.minFrames) {
      this.locked = dominant;
      return { phase: "locked", label: dominant, progress: 1, agreement: agreement, committed: dominant };
    }
    return { phase: "holding", label: dominant, progress: progress, agreement: agreement, committed: null };
  };

  return Stabilizer;
});
