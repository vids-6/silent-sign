/* Silent Sign - dashboard: totals, charts, sessions, settings and account. */
(function () {
  "use strict";

  var api = window.SilentSignApi;
  var $ = function (id) { return document.getElementById(id); };
  var PAGE_SIZE = 10;
  var sessionLimit = PAGE_SIZE;

  var fmtDay = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
  var fmtDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" });
  var fmtTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  var fmtShortDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

  function pct(x) { return x == null ? "–" : Math.round(x * 100) + "%"; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function compact(n) { return n >= 10000 ? (n / 1000).toFixed(0) + "K" : n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n); }

  function toast(text) {
    $("toast-text").textContent = text;
    $("toast").hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { $("toast").hidden = true; }, 2400);
  }

  function showLoadError(err) {
    var b = $("load-error");
    b.textContent = err.message;
    b.hidden = false;
  }

  // ------------------------------------------------------------ chart helpers
  function niceMax(v) {
    if (v <= 4) return 4;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * p >= v) return steps[i] * p;
    return 10 * p;
  }

  var tip = $("tip");
  function showTip(target, html, atBaseline) {
    tip.innerHTML = html;
    tip.hidden = false;
    var r = target.getBoundingClientRect();
    if (atBaseline) r = { left: r.left, width: r.width, top: r.bottom - 4, bottom: r.bottom };
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), window.innerWidth - tw - 8);
    var top = r.top - th - 10;
    if (top < 8) top = r.bottom + 10;
    tip.style.left = left + window.scrollX + "px";
    tip.style.top = top + window.scrollY + "px";
  }
  function hideTip() { tip.hidden = true; }

  /* Column chart. columns: [{label, sub, segments:[{value, cls}], tip, aria}]
     One y-axis, hairline grid at 0 / half / max, 2px gap between stacked
     segments, rounded data-end only on the top segment. */
  function columnChart(container, columns, options) {
    options = options || {};
    var totals = columns.map(function (c) { return c.segments.reduce(function (s, x) { return s + x.value; }, 0); });
    var max = niceMax(Math.max.apply(null, totals.concat([1])));
    var labelIndex = options.labelMax ? totals.indexOf(Math.max.apply(null, totals)) : -1;

    container.innerHTML = "";
    var plot = document.createElement("div");
    plot.className = "plot";
    [1, 0.5, 0].forEach(function (f) {
      var g = document.createElement("div");
      g.className = "grid" + (f === 0 ? " grid-base" : "");
      g.style.bottom = (f * 100) + "%";
      var t = document.createElement("span");
      t.className = "tick";
      t.textContent = compact(Math.round(max * f));
      g.appendChild(t);
      plot.appendChild(g);
    });

    var cols = document.createElement("div");
    cols.className = "cols";
    columns.forEach(function (c, i) {
      var col = document.createElement("div");
      col.className = "col";
      col.tabIndex = 0;
      col.setAttribute("role", "img");
      col.setAttribute("aria-label", c.aria);
      var stack = document.createElement("div");
      stack.className = "stack";
      var visible = c.segments.filter(function (s) { return s.value > 0; });
      visible.forEach(function (s, j) {
        var seg = document.createElement("div");
        seg.className = "seg " + s.cls + (j === visible.length - 1 ? " seg-top" : "");
        seg.style.height = (s.value / max * 100) + "%";
        stack.appendChild(seg);
      });
      if (i === labelIndex && totals[i] > 0) {
        var v = document.createElement("span");
        v.className = "cap-label";
        v.textContent = totals[i];
        v.style.bottom = (totals[i] / max * 100) + "%";
        stack.appendChild(v);
      }
      col.appendChild(stack);
      // Anchor the tooltip just above the bar, not the top of the whole column.
      var on = function () {
        col.classList.add("hover");
        var top = stack.querySelector(".seg-top");
        showTip(top || stack, c.tip, !top);   // empty column: tooltip sits on the baseline
      };
      var off = function () { col.classList.remove("hover"); hideTip(); };
      col.addEventListener("mouseenter", on);
      col.addEventListener("mouseleave", off);
      col.addEventListener("focus", on);
      col.addEventListener("blur", off);
      cols.appendChild(col);
    });
    plot.appendChild(cols);
    container.appendChild(plot);

    var axis = document.createElement("div");
    axis.className = "x-axis";
    columns.forEach(function (c, i) {
      var l = document.createElement("span");
      l.innerHTML = "<b></b>" + (c.sub ? "<small></small>" : "");
      l.querySelector("b").textContent = c.label;
      if (c.sub) l.querySelector("small").textContent = c.sub;
      if (options.thinLabels && (columns.length - 1 - i) % 2 === 1) l.className = "thin";  // keep today
      axis.appendChild(l);
    });
    container.appendChild(axis);
  }

  // ------------------------------------------------------------ render: stats
  function renderStats(stats) {
    var t = stats.totals;
    var hasData = t.sessions > 0;
    $("empty").hidden = hasData;
    $("content").hidden = !hasData;
    if (t.first_activity) {
      $("since").textContent = "Signing since " + fmtDate.format(new Date(t.first_activity * 1000)) +
        " · active on " + plural(t.active_days, "day", "days");
    }
    if (!hasData) return;

    $("t-letters").textContent = t.letters_added.toLocaleString();
    $("t-sessions").textContent = t.sessions.toLocaleString();
    $("t-kept").textContent = t.correction_rate == null ? "–" : pct(1 - t.correction_rate);
    $("t-conf").textContent = pct(t.avg_confidence);
    $("t-sugg").textContent = t.suggestions_used.toLocaleString();

    // daily
    var daily = stats.daily.map(function (d) {
      var date = new Date(d.date + "T00:00:00");
      var label = fmtDay.format(date);
      return {
        label: String(date.getDate()),
        sub: label.split(/[ ,]/)[0],
        segments: [{ value: d.letters, cls: "seg-kept" }],
        tip: "<b>" + label + "</b><br>" + plural(d.letters, "letter", "letters") + " signed",
        aria: label + ": " + plural(d.letters, "letter", "letters"),
        full: label, value: d.letters
      };
    });
    columnChart($("daily-chart"), daily, { labelMax: true, thinLabels: true });
    var week = stats.daily.slice(-7).reduce(function (s, d) { return s + d.letters; }, 0);
    $("daily-summary").textContent = week + " letters signed in the last 7 days.";
    var tb = $("daily-table").tBodies[0];
    tb.innerHTML = "";
    daily.forEach(function (d) {
      var tr = tb.insertRow();
      tr.insertCell().textContent = d.full;
      tr.insertCell().textContent = d.value;
    });

    // per letter
    var letters = stats.per_letter.map(function (l) {
      var kept = l.added - Math.min(l.corrected, l.added);
      var corrected = Math.min(l.corrected, l.added);
      return {
        label: l.letter,
        segments: [{ value: kept, cls: "seg-kept" }, { value: corrected, cls: "seg-corrected" }],
        tip: "<b>" + l.letter + "</b><br>Signed " + plural(l.added, "time", "times") +
          "<br>Corrected " + l.corrected + (l.avg_confidence != null ? "<br>Avg. confidence " + pct(l.avg_confidence) : ""),
        aria: l.letter + ": signed " + l.added + ", corrected " + l.corrected,
        raw: l
      };
    });
    columnChart($("letter-chart"), letters, {});
    var lt = $("letter-table").tBodies[0];
    lt.innerHTML = "";
    stats.per_letter.forEach(function (l) {
      var tr = lt.insertRow();
      tr.insertCell().textContent = l.letter;
      tr.insertCell().textContent = l.added;
      tr.insertCell().textContent = l.corrected;
      tr.insertCell().textContent = pct(l.avg_confidence);
    });

    var practice = stats.per_letter
      .filter(function (l) { return l.added >= 3 && l.corrected > 0; })
      .sort(function (a, b) { return b.corrected / b.added - a.corrected / a.added || b.added - a.added; })
      .slice(0, 3);
    var p = $("practice");
    if (practice.length) {
      p.innerHTML = "<b>Needs practice:</b> " + practice.map(function (l) {
        return l.letter + " (" + l.corrected + " of " + l.added + " corrected)";
      }).join(", ") + ". Try better light and keep your palm facing the camera for these.";
    } else if (t.letters_added < 20) {
      p.textContent = "Sign each letter a few times and the letters you need to practise will show here.";
    } else {
      p.textContent = "No letter has needed repeated corrections. Nice signing.";
    }
  }

  // ------------------------------------------------------------ render: sessions
  function relativeDay(ts) {
    var d = new Date(ts * 1000);
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var day = new Date(d); day.setHours(0, 0, 0, 0);
    var diff = Math.round((today - day) / 86400000);
    var when = diff === 0 ? "Today" : diff === 1 ? "Yesterday" : fmtShortDate.format(d);
    return when + ", " + fmtTime.format(d);
  }

  function duration(s) {
    if (s < 60) return "under a minute";
    var m = Math.round(s / 60);
    return m < 60 ? plural(m, "minute", "minutes") : Math.floor(m / 60) + " h " + (m % 60) + " min";
  }

  function renderSessions(data) {
    var list = $("sessions");
    list.innerHTML = "";
    $("sessions-sub").textContent = data.total === 0 ? "" :
      "Showing " + data.sessions.length + " of " + plural(data.total, "session", "sessions") + ", newest first";
    data.sessions.forEach(function (s) {
      var li = document.createElement("li");
      li.className = "session";

      var head = document.createElement("div");
      head.className = "session-head";
      var when = document.createElement("h3");
      when.textContent = relativeDay(s.started_at);
      var meta = document.createElement("p");
      meta.className = "session-meta";
      meta.textContent = [duration(s.duration_s), plural(s.letters_added, "letter", "letters"),
        plural(s.corrections, "correction", "corrections")]
        .concat(s.suggestions_used ? [plural(s.suggestions_used, "suggestion", "suggestions")] : []).join(" · ");
      head.appendChild(when);
      head.appendChild(meta);

      var caps = document.createElement("div");
      caps.className = "session-captions";
      if (s.lines.length) {
        s.lines.slice(0, 3).forEach(function (line) {
          var p = document.createElement("p");
          p.textContent = line;
          caps.appendChild(p);
        });
        if (s.lines.length > 3) {
          var more = document.createElement("p");
          more.className = "more-lines";
          more.textContent = "+ " + plural(s.lines.length - 3, "more caption", "more captions") + " in the transcript";
          caps.appendChild(more);
        }
      } else {
        var none = document.createElement("p");
        none.className = "no-caption";
        none.textContent = "No caption text was kept in this session.";
        caps.appendChild(none);
      }

      var actions = document.createElement("div");
      actions.className = "session-actions";
      var dl = document.createElement("a");
      dl.className = "btn btn-small";
      dl.href = "/api/sessions/" + s.id + "/transcript";
      dl.setAttribute("download", "");
      dl.textContent = "Download transcript";
      var del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-small btn-quiet";
      del.textContent = "Delete";
      del.setAttribute("aria-label", "Delete session from " + relativeDay(s.started_at));
      del.addEventListener("click", function () {
        if (del.dataset.confirm !== "true") {
          del.dataset.confirm = "true";
          del.textContent = "Confirm delete";
          del.classList.add("btn-danger");
          setTimeout(function () {
            if (del.isConnected) { del.dataset.confirm = "false"; del.textContent = "Delete"; del.classList.remove("btn-danger"); }
          }, 4000);
          return;
        }
        del.disabled = true;
        api.del("/api/sessions/" + s.id).then(function () {
          toast("Session deleted");
          refresh();
        }).catch(function (e) { del.disabled = false; toast(e.message); });
      });
      actions.appendChild(dl);
      actions.appendChild(del);

      li.appendChild(head);
      li.appendChild(caps);
      li.appendChild(actions);
      list.appendChild(li);
    });
    $("more").hidden = data.sessions.length >= data.total;
  }

  $("more").addEventListener("click", function () {
    sessionLimit += 20;
    api.get("/api/sessions?limit=" + sessionLimit).then(renderSessions).catch(showLoadError);
  });

  // ------------------------------------------------------------ settings
  var form = $("settings-form");
  var saveTimer = null;
  function fillSettings(s) {
    form.leftHand.checked = !!s.leftHand;
    form.suggestions.checked = s.suggestions !== false;
    form.landmarks.checked = s.landmarks !== false;
    form.holdSeconds.value = s.holdSeconds;
    $("hold-out").textContent = Number(s.holdSeconds).toFixed(1) + " s";
  }
  function saveSettings() {
    var state = $("settings-state");
    state.textContent = "Saving…";
    api.put("/api/settings", {
      leftHand: form.leftHand.checked,
      suggestions: form.suggestions.checked,
      landmarks: form.landmarks.checked,
      holdSeconds: parseFloat(form.holdSeconds.value)
    }).then(function () {
      state.textContent = "Saved";
    }).catch(function (e) { state.textContent = "Not saved: " + e.message; });
  }
  form.addEventListener("change", function () { clearTimeout(saveTimer); saveSettings(); });
  form.holdSeconds.addEventListener("input", function () {
    $("hold-out").textContent = parseFloat(form.holdSeconds.value).toFixed(1) + " s";
  });
  form.addEventListener("submit", function (e) { e.preventDefault(); });

  // ------------------------------------------------------------ account
  $("password-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var msg = $("password-msg");
    var cur = $("pw-current").value, next = $("pw-new").value;
    msg.dataset.kind = "error";
    if (!cur || !next) { msg.textContent = "Fill in both passwords."; return; }
    if (next.length < 8) { msg.textContent = "New password must be at least 8 characters."; $("pw-new").focus(); return; }
    api.post("/api/auth/password", { current: cur, new: next }).then(function () {
      msg.dataset.kind = "ok";
      msg.textContent = "Password changed.";
      $("pw-current").value = ""; $("pw-new").value = "";
    }).catch(function (err) { msg.textContent = err.message; });
  });

  $("btn-clear-history").addEventListener("click", function () {
    var btn = this, msg = $("history-msg");
    if (btn.dataset.confirm !== "true") {
      btn.dataset.confirm = "true";
      btn.textContent = "Yes, delete everything";
      msg.dataset.kind = "error";
      msg.textContent = "Select again to confirm. This cannot be undone.";
      return;
    }
    btn.disabled = true;
    api.del("/api/sessions").then(function (r) {
      msg.dataset.kind = "ok";
      msg.textContent = "Deleted " + plural(r.deleted, "session", "sessions") + ".";
      btn.dataset.confirm = "false";
      btn.textContent = "Delete all history";
      btn.disabled = false;
      refresh();
    }).catch(function (err) { btn.disabled = false; msg.textContent = err.message; });
  });

  $("delete-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var msg = $("delete-msg");
    msg.dataset.kind = "error";
    var pw = $("del-password").value;
    if (!pw) { msg.textContent = "Enter your password to confirm."; $("del-password").focus(); return; }
    api.del("/api/auth/account", { password: pw }).then(function () {
      location.href = "/login";
    }).catch(function (err) { msg.textContent = err.message; });
  });

  $("btn-logout").addEventListener("click", function () { api.logout(); });

  // ------------------------------------------------------------ load
  function refresh() {
    return Promise.all([api.get("/api/stats"), api.get("/api/sessions?limit=" + sessionLimit)])
      .then(function (r) {
        $("load-error").hidden = true;
        renderStats(r[0]);
        renderSessions(r[1]);
      })
      .catch(showLoadError);
  }

  api.get("/api/auth/me").then(function (me) {
    $("user-name").textContent = me.username;
    $("greeting").textContent = "Hi, " + me.username;
  }).catch(showLoadError);
  api.get("/api/settings").then(function (r) { fillSettings(r.settings); }).catch(showLoadError);
  refresh();

  window.addEventListener("scroll", hideTip, { passive: true });
  window.__silentSignDashboard = { refresh: refresh };
})();
