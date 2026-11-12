/* Silent Sign - frontend.
 *
 * Captures webcam frames, sends them to the local Python server
 * (backend/app.py) for hand-landmark recognition, stabilises the stream of
 * predictions (js/stabilizer.js) and builds a caption from committed letters.
 *
 * Nothing here fabricates predictions: every letter added to the caption
 * came from the model via /api/predict and passed the stabiliser.
 */
(function () {
  "use strict";

  var FRAME_INTERVAL_MS = 120;     // ~8 frames per second at most
  var CAPTURE_WIDTH = 640;
  var REQUEST_TIMEOUT_MS = 5000;
  var OFFLINE_AFTER_FAILURES = 3;
  var HEALTH_RETRY_MS = 3000;
  var HISTORY_LENGTH = 12;

  // MediaPipe hand skeleton (pairs of landmark indices)
  var HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]
  ];

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    banner: $("banner"), bannerText: $("banner-text"), bannerAction: $("banner-action"),
    serverPill: $("server-pill"), cameraPill: $("camera-pill"), recogPill: $("recog-pill"),
    frame: $("video-frame"), video: $("video"), overlay: $("overlay"),
    empty: $("video-empty"), message: $("video-message"),
    messageTitle: $("video-message-title"), messageBody: $("video-message-body"),
    messageAction: $("video-message-action"), handChip: $("hand-chip"),
    btnCamera: $("btn-camera"), btnPause: $("btn-pause"),
    cameraSelectWrap: $("camera-select-wrap"), cameraSelect: $("camera-select"),
    optLeft: $("opt-lefthand"), optHold: $("opt-hold"), holdOut: $("hold-out"),
    optLandmarks: $("opt-landmarks"),
    ring: $("ring"), nowLetter: $("now-letter"), nowState: $("now-state"),
    meterFill: $("meter-fill"), meterMark: $("meter-mark"),
    confText: $("conf-text"), thrText: $("thr-text"), alts: $("alts"),
    history: $("history"), historyEmpty: $("history-empty"),
    captionContent: $("caption-content"), captionPlaceholder: $("caption-placeholder"),
    captionCount: $("caption-count"),
    btnSpace: $("btn-space"), btnBack: $("btn-back"), btnClear: $("btn-clear"),
    btnSpeak: $("btn-speak"), btnCopy: $("btn-copy"), btnDownload: $("btn-download"),
    optSuggestions: $("opt-suggestions"), settingsSaved: $("settings-saved"),
    saveState: $("save-state"), suggestions: $("suggestions"), suggestionButtons: $("suggestion-buttons"),
    userName: $("user-name"), btnLogout: $("btn-logout"),
    letterGrid: $("letter-grid"),
    statAcc: $("stat-acc"), statAccThr: $("stat-acc-thr"), statCov: $("stat-cov"),
    aboutFine: $("about-fine"),
    announcer: $("announcer"), toast: $("toast"), toastText: $("toast-text"),
    toastAction: $("toast-action")
  };

  var state = {
    server: "checking",          // checking | ok | offline | model-error | wrong-origin
    camera: "off",               // off | requesting | live | error
    recognizing: false,          // user wants recognition running
    stream: null,
    inFlight: false,
    loopTimer: null,
    failures: 0,
    healthTimer: null,
    info: null,
    threshold: 0.5,
    caption: [],
    lines: [],
    username: "",
    history: [],
    lastAddedIndex: -1,
    lastFrameTime: 0,
    flashTimer: null,
    toastTimer: null
  };

  var stabilizer = new window.SilentSignStabilizer({ holdMs: 800 });
  var captureCanvas = document.createElement("canvas");
  var captureCtx = captureCanvas.getContext("2d");
  var overlayCtx = el.overlay.getContext("2d");

  // ------------------------------------------------------------ settings
  // Settings belong to the account (GET/PUT /api/settings). A local copy is
  // used only so the page starts with the right values before the server answers.
  var api = window.SilentSignApi;
  var settings = { leftHand: false, holdSeconds: 0.8, landmarks: true, suggestions: true };
  var settingsTimer = null;
  var uiReady = false;   // set once the caption and suggestion code below is initialised

  function applySettings(s) {
    if (!s || typeof s !== "object") return;
    settings.leftHand = !!s.leftHand;
    if (s.holdSeconds >= 0.4 && s.holdSeconds <= 2) settings.holdSeconds = Number(s.holdSeconds);
    settings.landmarks = s.landmarks !== false;
    settings.suggestions = s.suggestions !== false;
    el.optLeft.checked = settings.leftHand;
    el.optHold.value = String(settings.holdSeconds);
    el.optLandmarks.checked = settings.landmarks;
    el.optSuggestions.checked = settings.suggestions;
    el.holdOut.textContent = settings.holdSeconds.toFixed(1) + " s";
    stabilizer.setHoldMs(settings.holdSeconds * 1000);
    if (uiReady) renderSuggestions();
  }

  try { applySettings(JSON.parse(localStorage.getItem("silent-sign-settings") || "null")); } catch (e) { /* defaults */ }

  function saveSettings() {
    try { localStorage.setItem("silent-sign-settings", JSON.stringify(settings)); } catch (e) { /* ignore */ }
    clearTimeout(settingsTimer);
    el.settingsSaved.textContent = "saving…";
    settingsTimer = setTimeout(function () {
      api.put("/api/settings", settings).then(function () {
        el.settingsSaved.textContent = "saved to your account";
      }).catch(function () {
        el.settingsSaved.textContent = "not saved: server unreachable";
      });
    }, 400);
  }

  el.optLeft.addEventListener("change", function () {
    settings.leftHand = el.optLeft.checked; saveSettings();
    stabilizer.reset();
    postReset();
  });
  el.optHold.addEventListener("input", function () {
    settings.holdSeconds = parseFloat(el.optHold.value);
    el.holdOut.textContent = settings.holdSeconds.toFixed(1) + " s";
    stabilizer.setHoldMs(settings.holdSeconds * 1000);
    saveSettings();
  });
  el.optLandmarks.addEventListener("change", function () {
    settings.landmarks = el.optLandmarks.checked; saveSettings();
    if (!settings.landmarks) clearOverlay();
  });
  el.optSuggestions.addEventListener("change", function () {
    settings.suggestions = el.optSuggestions.checked; saveSettings();
    renderSuggestions();
  });

  // ------------------------------------------------------------ helpers
  function setPill(pill, pillState, text) {
    pill.dataset.state = pillState;
    pill.querySelector(".status-text").textContent = text;
  }

  function showBanner(text, actionLabel, action) {
    el.bannerText.textContent = text;
    el.banner.hidden = false;
    if (actionLabel) {
      el.bannerAction.textContent = actionLabel;
      el.bannerAction.hidden = false;
      el.bannerAction.onclick = action;
    } else {
      el.bannerAction.hidden = true;
      el.bannerAction.onclick = null;
    }
  }
  function hideBanner() { el.banner.hidden = true; }

  function announce(text) {
    el.announcer.textContent = "";
    window.setTimeout(function () { el.announcer.textContent = text; }, 30);
  }

  function toast(text, actionLabel, action) {
    window.clearTimeout(state.toastTimer);
    el.toastText.textContent = text;
    el.toast.hidden = false;
    if (actionLabel) {
      el.toastAction.textContent = actionLabel;
      el.toastAction.hidden = false;
      el.toastAction.onclick = function () { action(); el.toast.hidden = true; };
    } else {
      el.toastAction.hidden = true;
    }
    state.toastTimer = window.setTimeout(function () { el.toast.hidden = true; }, actionLabel ? 6000 : 2200);
  }

  function pct(x) { return Math.round(x * 100) + "%"; }

  // ------------------------------------------------------------ server
  function checkHealth() {
    if (location.protocol === "file:") {
      state.server = "wrong-origin";
      setPill(el.serverPill, "error", "Opened as a file");
      showBanner("This page was opened directly from disk, so it cannot reach the recognizer or the camera. " +
        "Start the server with  python backend/app.py  and open http://127.0.0.1:5000 instead.");
      updateControls();
      return Promise.resolve(false);
    }
    return fetchWithTimeout("/api/health", { cache: "no-store" })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          if (res.status === 404 || !body) {
            state.server = "wrong-origin";
            setPill(el.serverPill, "error", "Wrong address");
            showBanner("This page is being served by something other than the Silent Sign server (for example VS Code Live Server). " +
              "Start  python backend/app.py  and open http://127.0.0.1:5000 instead.");
            return false;
          }
          if (!body.model_loaded) {
            state.server = "model-error";
            setPill(el.serverPill, "error", "Model not loaded");
            showBanner("The server is running but the model did not load: " + (body.error || "unknown error") +
              ". See the terminal running backend/app.py.", "Check again", checkHealth);
            return false;
          }
          var wasOffline = state.server === "offline";
          state.server = "ok";
          state.failures = 0;
          applyModelInfo(body);
          setPill(el.serverPill, "ok", "Recognizer ready");
          hideBanner();
          if (wasOffline) {
            toast("Reconnected to the recognizer");
            stabilizer.reset();
            scheduleNext(0);
          }
          return true;
        });
      })
      .catch(function () {
        goOffline();
        return false;
      })
      .then(function (ok) { updateControls(); return ok; });
  }

  function goOffline() {
    state.server = "offline";
    setPill(el.serverPill, "error", "Server offline");
    showBanner("Can't reach the Silent Sign server at " + location.origin +
      ". Check that  python backend/app.py  is still running in the VS Code terminal. Retrying automatically.",
      "Retry now", checkHealth);
    window.clearTimeout(state.healthTimer);
    state.healthTimer = window.setTimeout(function poll() {
      if (state.server !== "offline") return;
      checkHealth().then(function (ok) {
        if (!ok && state.server === "offline") state.healthTimer = window.setTimeout(poll, HEALTH_RETRY_MS);
      });
    }, HEALTH_RETRY_MS);
    updateRecognitionPill();
  }

  function fetchWithTimeout(url, options) {
    var controller = "AbortController" in window ? new AbortController() : null;
    var timer = null;
    options = options || {};
    if (controller) {
      options.signal = controller.signal;
      timer = window.setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    }
    return fetch(url, options).finally(function () { window.clearTimeout(timer); });
  }

  function postReset() {
    if (state.server !== "ok") return;
    fetchWithTimeout("/api/reset", { method: "POST", headers: { "X-Silent-Sign": "1" } }).catch(function () { /* non-critical */ });
  }

  function applyModelInfo(info) {
    state.info = info;
    state.threshold = info.threshold;
    el.thrText.textContent = Math.round(info.threshold * 100);
    el.meterMark.style.left = (info.threshold * 100) + "%";

    var m = info.metrics || {};
    var d = info.data || {};
    el.statAcc.textContent = m.test_accuracy != null ? pct(m.test_accuracy) : "–";
    el.statAccThr.textContent = m.test_accuracy_at_threshold != null ? pct(m.test_accuracy_at_threshold) : "–";
    el.statCov.textContent = m.test_coverage_at_threshold != null ? pct(m.test_coverage_at_threshold) : "–";
    if (d.test) {
      el.aboutFine.textContent = "Measured on " + d.test + " held-out dataset images; no copy or near-copy of them was used in training. " +
        "Accuracy on your camera depends on lighting, framing and signing style.";
    }
    renderLetterGrid(info);
  }

  function renderLetterGrid(info) {
    var known = {};
    info.classes.forEach(function (c) { known[c] = true; });
    var perClass = info.per_class_test || {};
    el.letterGrid.innerHTML = "";
    for (var code = 65; code <= 90; code++) {
      var letter = String.fromCharCode(code);
      var li = document.createElement("li");
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = letter;
      li.appendChild(b);
      li.dataset.letter = letter;
      if (!known[letter]) {
        li.dataset.status = "missing";
        li.title = letter + ": not in the training data, cannot be recognized";
        b.setAttribute("aria-label", letter + ", not supported. Show reference");
      } else {
        var pc = perClass[letter];
        if (pc && pc.support > 0 && pc.recall < 0.5) {
          li.dataset.status = "weak";
          li.title = letter + ": recognized " + pct(pc.recall) + " of the time in testing (" + pc.support + " images)";
          b.setAttribute("aria-label", letter + ", supported but often confused. Show its sign");
        } else {
          li.dataset.status = "ok";
          li.title = pc ? letter + ": recognized " + pct(pc.recall) + " of the time in testing (" + pc.support + " images)" : letter;
          b.setAttribute("aria-label", letter + ", supported. Show its sign");
        }
      }
      b.addEventListener("click", (function (l) {
        return function () { if (window.SilentSignReference) window.SilentSignReference.showLetter(l); };
      })(letter));
      el.letterGrid.appendChild(li);
    }
  }

  // ------------------------------------------------------------ camera
  function cameraErrorMessage(err) {
    var name = err && err.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      return ["Camera access is blocked",
        "Select the camera icon at the right end of the address bar, choose Allow, then select Try again. " +
        "On Windows also check Settings, Privacy & security, Camera, and make sure camera access is on for your browser."];
    }
    if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
      return ["No camera found", "Connect a webcam or enable the built-in one, then select Try again."];
    }
    if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
      return ["The camera is busy",
        "Another app such as Zoom, Teams or the Windows Camera app is probably using it. Close that app, then select Try again."];
    }
    return ["The camera could not start", (err && err.message) || "Unknown camera error. Select Try again."];
  }

  function showVideoMessage(title, body, actionLabel, action) {
    el.messageTitle.textContent = title;
    el.messageBody.textContent = body;
    el.messageAction.textContent = actionLabel || "Try again";
    el.messageAction.onclick = action || startCamera;
    el.message.hidden = false;
    el.empty.hidden = true;
  }

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      state.camera = "error";
      setPill(el.cameraPill, "error", "Camera unavailable");
      showVideoMessage("This page can't use the camera",
        "Browsers only allow the camera on secure addresses. Open http://127.0.0.1:5000 in Chrome or Edge.",
        "Check again", startCamera);
      updateControls();
      return;
    }
    stopStream();
    state.camera = "requesting";
    setPill(el.cameraPill, "requesting", "Waiting for permission…");
    el.frame.dataset.state = "requesting";
    el.message.hidden = true;
    updateControls();

    var deviceId = el.cameraSelect.value;
    var constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
        : { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }
    };

    navigator.mediaDevices.getUserMedia(constraints)
      .then(function (stream) {
        state.stream = stream;
        el.video.srcObject = stream;
        stream.getVideoTracks().forEach(function (track) {
          track.addEventListener("ended", function () {
            if (state.stream !== stream) return;
            stopCamera(true);
            showVideoMessage("The camera disconnected", "The camera stopped sending video. Reconnect it, then select Try again.");
            state.camera = "error";
            setPill(el.cameraPill, "error", "Camera disconnected");
            updateControls();
          });
        });
        return el.video.play();
      })
      .then(function () {
        state.camera = "live";
        el.frame.dataset.state = "live";
        el.empty.hidden = true;
        el.handChip.hidden = false;
        setPill(el.cameraPill, "live", "Camera on");
        populateCameraList();
        stabilizer.reset();
        postReset();
        state.recognizing = true;
        updateControls();
        scheduleNext(300);
        announce("Camera on. Recognition running.");
      })
      .catch(function (err) {
        stopStream();
        state.camera = "error";
        el.frame.dataset.state = "error";
        var msg = cameraErrorMessage(err);
        setPill(el.cameraPill, "error", msg[0]);
        showVideoMessage(msg[0], msg[1]);
        updateControls();
        announce(msg[0]);
      });
  }

  function populateCameraList() {
    if (!navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (devices) {
      var cams = devices.filter(function (d) { return d.kind === "videoinput"; });
      var activeId = state.stream && state.stream.getVideoTracks()[0] &&
        state.stream.getVideoTracks()[0].getSettings().deviceId;
      el.cameraSelect.innerHTML = "";
      cams.forEach(function (cam, i) {
        var opt = document.createElement("option");
        opt.value = cam.deviceId;
        opt.textContent = cam.label || ("Camera " + (i + 1));
        if (cam.deviceId === activeId) opt.selected = true;
        el.cameraSelect.appendChild(opt);
      });
      el.cameraSelectWrap.hidden = cams.length < 2;
    }).catch(function () { el.cameraSelectWrap.hidden = true; });
  }
  el.cameraSelect.addEventListener("change", function () {
    if (state.camera === "live") startCamera();
  });

  function stopStream() {
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { t.stop(); });
    }
    state.stream = null;
    el.video.srcObject = null;
  }

  function stopCamera(silent) {
    state.recognizing = false;
    window.clearTimeout(state.loopTimer);
    stopStream();
    state.camera = "off";
    el.frame.dataset.state = "off";
    el.handChip.hidden = true;
    el.message.hidden = true;
    el.empty.hidden = false;
    clearOverlay();
    stabilizer.reset();
    resetReading("Start the camera to begin.");
    setPill(el.cameraPill, "off", "Camera off");
    updateControls();
    if (!silent) announce("Camera off. The camera light should now be off.");
  }

  el.btnCamera.addEventListener("click", function () {
    if (state.camera === "live" || state.camera === "requesting") stopCamera(false);
    else startCamera();
  });

  function togglePause() {
    if (state.camera !== "live") return;
    state.recognizing = !state.recognizing;
    if (state.recognizing) {
      stabilizer.reset();
      scheduleNext(0);
      announce("Recognition resumed");
    } else {
      window.clearTimeout(state.loopTimer);
      clearOverlay();
      resetReading("Paused. Your camera is still on; nothing is being recognized.");
      el.handChip.hidden = true;
      announce("Recognition paused");
    }
    updateControls();
  }
  el.btnPause.addEventListener("click", togglePause);

  // ------------------------------------------------------------ recognition loop
  function scheduleNext(delay) {
    window.clearTimeout(state.loopTimer);
    state.loopTimer = window.setTimeout(tick, delay);
  }

  function tick() {
    if (!state.recognizing || state.camera !== "live") return;
    if (state.server !== "ok") return;  // resumes from checkHealth when back
    if (document.hidden || state.inFlight || !el.video.videoWidth) {
      scheduleNext(FRAME_INTERVAL_MS);
      return;
    }
    var started = performance.now();
    captureFrame().then(function (blob) {
      if (!blob) throw new Error("capture failed");
      state.inFlight = true;
      var url = "/api/predict" + (settings.leftHand ? "?mirror=1" : "");
      return fetchWithTimeout(url, { method: "POST", headers: { "Content-Type": "image/jpeg", "X-Silent-Sign": "1" }, body: blob })
        .then(function (res) {
          return res.json().catch(function () { return null; }).then(function (body) {
            if (!res.ok || !body || !body.ok) {
              var err = new Error((body && body.error) || ("HTTP " + res.status));
              err.http = res.status;
              throw err;
            }
            return body;
          });
        });
    }).then(function (result) {
      state.failures = 0;
      if (state.recognizing && state.camera === "live") handleResult(result);
    }).catch(function (err) {
      state.failures += 1;
      if (err.http === 503) { checkHealth(); return; }
      if (err.http === 401) { stopCamera(true); location.href = api.loginUrl(); return; }
      if (err.http) {
        // The server answered but rejected or failed this frame: skip it.
        if (state.failures >= OFFLINE_AFTER_FAILURES) {
          showBanner("Recognition is failing on the server: " + err.message +
            ". Details are in the terminal running backend/app.py.", "Dismiss", hideBanner);
        }
      } else if (state.failures >= OFFLINE_AFTER_FAILURES) {
        goOffline();
      }
    }).then(function () {
      state.inFlight = false;
      var elapsed = performance.now() - started;
      if (state.recognizing && state.server === "ok") scheduleNext(Math.max(0, FRAME_INTERVAL_MS - elapsed));
    });
  }

  function captureFrame() {
    var vw = el.video.videoWidth, vh = el.video.videoHeight;
    var scale = Math.min(1, CAPTURE_WIDTH / vw);
    captureCanvas.width = Math.round(vw * scale);
    captureCanvas.height = Math.round(vh * scale);
    // Frames are sent un-mirrored: the camera's real view, like the dataset photos.
    captureCtx.drawImage(el.video, 0, 0, captureCanvas.width, captureCanvas.height);
    return new Promise(function (resolve) {
      captureCanvas.toBlob(resolve, "image/jpeg", 0.85);
    });
  }

  function handleResult(r) {
    var now = performance.now();
    drawOverlay(r.landmarks || []);

    el.handChip.hidden = false;
    el.handChip.dataset.hands = String(r.hands_detected);
    el.handChip.textContent = r.hands_detected === 0 ? "No hands in view"
      : r.hands_detected === 1 ? "1 hand tracked" : "2 hands tracked";

    var p = r.prediction;
    var out = stabilizer.update({
      hands: r.hands_detected,
      label: p ? p.label : null,
      accepted: !!r.accepted
    }, now);

    // confidence meter reflects the raw model output for this frame
    var conf = p ? p.confidence : 0;
    el.meterFill.style.width = (conf * 100).toFixed(1) + "%";
    el.meterFill.dataset.ok = r.accepted ? "true" : "false";
    el.confText.textContent = p ? "Confidence " + pct(conf) : "Confidence –";
    el.alts.textContent = r.top && r.top.length > 1
      ? "Also possible: " + r.top.slice(1).map(function (t) { return t.label + " " + pct(t.confidence); }).join(", ")
      : "";

    el.ring.style.setProperty("--p", out.progress.toFixed(3));
    el.ring.dataset.locked = out.phase === "locked" ? "true" : "false";

    if (out.phase === "no-hands") {
      setNow("–", "none", "Show a letter with your hands inside the frame.");
    } else if (out.phase === "uncertain") {
      if (p && !r.accepted) {
        setNow(p.label + "?", "uncertain", "Not sure. Best guess " + p.label + " at " + pct(p.confidence) +
          ". Hold the sign steady, face your palm to the camera, and check the lighting.");
      } else {
        setNow("?", "uncertain", "Seeing mixed letters. Hold one sign still.");
      }
    } else if (out.phase === "holding") {
      setNow(out.label, "confident", "Hold steady to add " + out.label + "…");
    } else if (out.phase === "locked") {
      if (out.committed) {
        commitLetter(out.committed, p ? p.confidence : 0);
      }
      setNow(out.label, "committed", "Added " + out.label +
        ". Sign the next letter, or lower your hands to repeat it.");
    }
  }

  function setNow(text, kind, message) {
    el.nowLetter.textContent = text;
    el.nowLetter.dataset.kind = kind;
    el.nowState.textContent = message;
  }

  function resetReading(message) {
    setNow("–", "none", message);
    el.ring.style.setProperty("--p", "0");
    el.ring.dataset.locked = "false";
    el.meterFill.style.width = "0";
    el.confText.textContent = "Confidence –";
    el.alts.textContent = "";
  }

  // ------------------------------------------------------------ overlay
  function clearOverlay() {
    overlayCtx.clearRect(0, 0, el.overlay.width, el.overlay.height);
  }

  function drawOverlay(hands) {
    var w = el.video.videoWidth, h = el.video.videoHeight;
    if (el.overlay.width !== w || el.overlay.height !== h) {
      el.overlay.width = w; el.overlay.height = h;
    }
    clearOverlay();
    if (!settings.landmarks || !hands.length) return;
    var lw = Math.max(2, w / 220);
    overlayCtx.lineWidth = lw;
    overlayCtx.lineCap = "round";
    overlayCtx.strokeStyle = "rgba(124, 242, 201, 0.9)";
    overlayCtx.fillStyle = "#7CF2C9";
    hands.forEach(function (pts) {
      overlayCtx.beginPath();
      HAND_CONNECTIONS.forEach(function (c) {
        overlayCtx.moveTo(pts[c[0]][0] * w, pts[c[0]][1] * h);
        overlayCtx.lineTo(pts[c[1]][0] * w, pts[c[1]][1] * h);
      });
      overlayCtx.stroke();
      pts.forEach(function (pt) {
        overlayCtx.beginPath();
        overlayCtx.arc(pt[0] * w, pt[1] * h, lw * 1.4, 0, Math.PI * 2);
        overlayCtx.fill();
      });
    });
  }

  // ------------------------------------------------------------ caption
  // state.caption is a list of { ch, src } where src is "sign" (recognized),
  // "suggestion" (filled in from a word suggestion) or "space". Deleting a
  // "sign" letter is counted as a correction in the user's statistics.
  var WORDS = window.SILENT_SIGN_WORDS || [];
  var Suggest = window.SilentSignSuggest;
  var currentSuggestions = [];

  var sessionLog = new window.SilentSignSessionLog(api, function (st, detail) {
    var text = { saving: "Saving to history…", saved: "Saved to your history",
                 offline: "Not saved yet: server unreachable, will retry", error: "Some activity could not be saved" }[st];
    el.saveState.textContent = text || "";
    el.saveState.dataset.state = st;
    if (st === "error" && detail) console.warn("History:", detail);
  });

  function captionText() {
    return state.caption.map(function (c) { return c.ch; }).join("");
  }

  function logEvent(e) {
    e.caption = captionText();
    sessionLog.log(e);
  }

  function commitLetter(letter, confidence) {
    state.caption.push({ ch: letter, src: "sign" });
    state.lastAddedIndex = state.caption.length - 1;
    state.history.unshift({ letter: letter, confidence: confidence, at: new Date() });
    state.history = state.history.slice(0, HISTORY_LENGTH);
    renderCaption();
    renderHistory();
    flashLetter(letter);
    announce("Added " + letter);
    logEvent({ type: "add", ch: letter, confidence: Math.round(confidence * 10000) / 10000 });
  }

  function flashLetter(letter) {
    var li = el.letterGrid.querySelector('[data-letter="' + letter + '"]');
    if (!li) return;
    li.dataset.flash = "true";
    window.setTimeout(function () { li.dataset.flash = "false"; }, 700);
  }

  function renderCaption() {
    var text = captionText();
    el.captionContent.textContent = "";
    if (state.lastAddedIndex === state.caption.length - 1 && text.length) {
      el.captionContent.appendChild(document.createTextNode(text.slice(0, -1)));
      var span = document.createElement("span");
      span.className = "new";
      span.textContent = text.slice(-1);
      el.captionContent.appendChild(span);
    } else {
      el.captionContent.textContent = text;
    }
    el.captionPlaceholder.hidden = text.length > 0;
    var n = text.length;
    el.captionCount.textContent = n + (n === 1 ? " character" : " characters");
    renderSuggestions();
    updateControls();
  }

  // ------------------------------------------------------------ suggestions
  function renderSuggestions() {
    var prefix = settings.suggestions ? Suggest.partialWord(captionText()) : "";
    var words = prefix ? Suggest.suggest(WORDS, prefix, 3) : [];
    var same = words.join() === currentSuggestions.join();
    currentSuggestions = words;
    el.suggestions.hidden = !words.length;
    if (same) return;
    el.suggestionButtons.innerHTML = "";
    words.forEach(function (w, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "suggestion";
      b.setAttribute("aria-keyshortcuts", String(i + 1));
      b.setAttribute("aria-label", "Use " + w + " (key " + (i + 1) + ")");
      var k = document.createElement("kbd");
      k.textContent = String(i + 1);
      var strong = document.createElement("span");
      strong.className = "typed";
      strong.textContent = w.slice(0, prefix.length);
      var rest = document.createElement("span");
      rest.textContent = w.slice(prefix.length);
      var word = document.createElement("span");   // one unit, so no gap inside the word
      word.appendChild(strong);
      word.appendChild(rest);
      b.appendChild(k);
      b.appendChild(word);
      b.addEventListener("click", function () { acceptSuggestion(i); });
      el.suggestionButtons.appendChild(b);
    });
  }

  function acceptSuggestion(i) {
    var word = currentSuggestions[i];
    if (!word) return;
    var prefix = Suggest.partialWord(captionText());
    // keep the letters the user signed; fill in the rest of the word + a space
    word.slice(prefix.length).split("").forEach(function (ch) {
      state.caption.push({ ch: ch, src: "suggestion" });
    });
    state.caption.push({ ch: " ", src: "space" });
    state.lastAddedIndex = -1;
    // the stabilizer keeps the last letter locked, so holding the same sign
    // does not immediately add it again after the word is finished
    renderCaption();
    announce("Added word " + word);
    logEvent({ type: "suggest", text: word });
  }

  function renderHistory() {
    el.history.innerHTML = "";
    state.history.forEach(function (h) {
      var li = document.createElement("li");
      var b = document.createElement("b");
      b.textContent = h.letter;
      var small = document.createElement("small");
      small.textContent = pct(h.confidence);
      li.appendChild(b);
      li.appendChild(small);
      li.title = h.letter + " added at " + h.at.toLocaleTimeString() + " with " + pct(h.confidence) + " confidence";
      el.history.appendChild(li);
    });
    el.historyEmpty.hidden = state.history.length > 0;
  }

  function lastChar() {
    return state.caption.length ? state.caption[state.caption.length - 1].ch : "";
  }

  function addSpace() {
    if (!state.caption.length || lastChar() === " ") return;
    state.caption.push({ ch: " ", src: "space" });
    state.lastAddedIndex = -1;
    renderCaption();
    announce("Space");
    logEvent({ type: "space" });
  }

  function deleteLast() {
    if (!state.caption.length) return;
    var removed = state.caption.pop();
    state.lastAddedIndex = -1;
    renderCaption();
    announce(removed.ch === " " ? "Deleted space" : "Deleted " + removed.ch);
    logEvent({ type: "delete", ch: removed.ch, source: removed.src });
  }

  function clearCaption() {
    if (!state.caption.length) return;
    var backup = state.caption.slice();
    var oldText = captionText();
    state.lines.push(oldText);
    state.caption = [];
    state.lastAddedIndex = -1;
    renderCaption();
    announce("Caption cleared");
    logEvent({ type: "clear", text: oldText });
    toast("Caption cleared", "Undo", function () {
      state.caption = backup;
      state.lines.pop();
      renderCaption();
      announce("Caption restored");
      logEvent({ type: "undo_clear", text: captionText() });
    });
  }

  function copyCaption() {
    var text = captionText().trim();
    if (!text) return;
    var done = function () { toast("Copied to clipboard"); announce("Caption copied"); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text) ? done() : toast("Copy failed. Select the caption and press Ctrl+C."); });
    } else if (legacyCopy(text)) {
      done();
    } else {
      toast("Copy failed. Select the caption and press Ctrl+C.");
    }
  }

  // Download this page session's captions (cleared ones too) as a text file.
  function downloadTranscript() {
    var lines = state.lines.filter(function (l) { return l.trim(); });
    if (captionText().trim()) lines = lines.concat([captionText().trim()]);
    if (!lines.length) return;
    var now = new Date();
    var pad = function (n) { return String(n).padStart(2, "0"); };
    var body = [
      "Silent Sign - captions",
      "User:  " + (state.username || ""),
      "Saved: " + now.toLocaleString(),
      "",
    ].concat(lines.map(function (l, i) { return (i + 1) + ". " + l; }))
     .concat(["", "Silent Sign recognises static ISL alphabet handshapes. Letters may contain recognition errors."])
     .join("\r\n") + "\r\n";
    var blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "silent-sign-" + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
      "-" + pad(now.getHours()) + pad(now.getMinutes()) + ".txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast("Transcript downloaded");
  }

  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  var canSpeak = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  function toggleSpeak() {
    if (!canSpeak) return;
    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      el.btnSpeak.textContent = "Read aloud";
      return;
    }
    var text = captionText().trim();
    if (!text) return;
    var u = new SpeechSynthesisUtterance(text.toLowerCase());
    u.onend = u.onerror = function () { el.btnSpeak.textContent = "Read aloud"; };
    el.btnSpeak.textContent = "Stop reading";
    window.speechSynthesis.speak(u);
  }

  el.btnSpace.addEventListener("click", addSpace);
  el.btnBack.addEventListener("click", deleteLast);
  el.btnClear.addEventListener("click", clearCaption);
  el.btnCopy.addEventListener("click", copyCaption);
  el.btnSpeak.addEventListener("click", toggleSpeak);
  el.btnDownload.addEventListener("click", downloadTranscript);
  el.btnLogout.addEventListener("click", function () {
    stopCamera(true);
    sessionLog.flush();
    api.logout();
  });

  // ------------------------------------------------------------ controls state
  function updateRecognitionPill() {
    if (state.camera !== "live") setPill(el.recogPill, "idle", "Recognition idle");
    else if (!state.recognizing) setPill(el.recogPill, "paused", "Recognition paused");
    else if (state.server !== "ok") setPill(el.recogPill, "error", "Waiting for server");
    else setPill(el.recogPill, "running", "Recognizing");
  }

  function updateControls() {
    var live = state.camera === "live";
    var busy = state.camera === "requesting";
    el.btnCamera.textContent = live ? "Stop camera" : busy ? "Cancel" : state.camera === "error" ? "Retry camera" : "Start camera";
    el.btnCamera.dataset.variant = live || busy ? "stop" : "start";
    el.btnCamera.disabled = state.server === "wrong-origin";
    el.btnCamera.title = state.server === "wrong-origin" ? "Open http://127.0.0.1:5000 to use the camera" : "";

    el.btnPause.disabled = !live;
    el.btnPause.textContent = live && !state.recognizing ? "Resume recognition" : "Pause recognition";
    el.btnPause.setAttribute("aria-pressed", live && !state.recognizing ? "true" : "false");
    el.btnPause.title = live ? "" : "Start the camera first";

    var hasText = captionText().trim().length > 0;
    el.btnBack.disabled = state.caption.length === 0;
    el.btnSpace.disabled = state.caption.length === 0 || lastChar() === " ";
    el.btnDownload.disabled = !hasText && !state.lines.some(function (l) { return l.trim(); });
    el.btnClear.disabled = state.caption.length === 0;
    el.btnCopy.disabled = !hasText;
    el.btnSpeak.disabled = !canSpeak || !hasText;
    el.btnSpeak.title = canSpeak ? "" : "Your browser does not support speech output";

    updateRecognitionPill();
  }

  // ------------------------------------------------------------ keyboard
  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    var key = e.key.toLowerCase();
    if (key === "p") { togglePause(); e.preventDefault(); }
    else if (key === "s") { addSpace(); e.preventDefault(); }
    else if (key === "backspace") { deleteLast(); e.preventDefault(); }
    else if (key === "c") { copyCaption(); e.preventDefault(); }
    else if (/^[1-3]$/.test(key) && currentSuggestions.length >= Number(key)) { acceptSuggestion(Number(key) - 1); e.preventDefault(); }
  });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.recognizing) scheduleNext(0);
  });
  window.addEventListener("pagehide", function () { stopStream(); sessionLog.flush(); });

  // ------------------------------------------------------------ start
  uiReady = true;
  renderCaption();
  renderHistory();
  updateControls();
  checkHealth();
  api.get("/api/auth/me").then(function (me) {
    state.username = me.username;
    el.userName.textContent = me.username;
  }).catch(function () { /* api.js redirects to login when needed */ });
  api.get("/api/settings").then(function (r) {
    applySettings(r.settings);
    try { localStorage.setItem("silent-sign-settings", JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }).catch(function () { /* keep local copy */ });

  // expose a tiny read-only hook for automated browser tests
  window.__silentSign = {
    caption: function () { return captionText(); },
    state: function () { return { server: state.server, camera: state.camera, recognizing: state.recognizing }; }
  };
})();
