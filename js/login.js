/* Silent Sign - login and sign-up page. */
(function () {
  "use strict";

  var api = window.SilentSignApi;
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    tabLogin: $("tab-login"), tabSignup: $("tab-signup"), form: $("auth-form"),
    title: $("form-title"), formError: $("form-error"),
    username: $("username"), usernameMsg: $("username-msg"),
    password: $("password"), passwordMsg: $("password-msg"), reveal: $("reveal"),
    confirmField: $("confirm-field"), confirm: $("confirm"), confirmMsg: $("confirm-msg"),
    remember: $("remember"), rememberRow: $("remember-row"),
    submit: $("submit"), switchHint: $("switch-hint"), switchBtn: $("switch")
  };

  var mode = "login";
  var busy = false;

  // Only same-site paths are allowed as a redirect target (no open redirects).
  function nextUrl() {
    var next = new URLSearchParams(location.search).get("next") || "/";
    return /^\/(?!\/)[A-Za-z0-9/_-]*$/.test(next) ? next : "/";
  }

  function setMode(m, focus) {
    mode = m;
    var signup = m === "signup";
    el.tabLogin.setAttribute("aria-selected", String(!signup));
    el.tabSignup.setAttribute("aria-selected", String(signup));
    el.tabLogin.tabIndex = signup ? -1 : 0;
    el.tabSignup.tabIndex = signup ? 0 : -1;
    el.form.setAttribute("aria-labelledby", signup ? "tab-signup" : "tab-login");
    el.title.textContent = signup ? "Create account" : "Log in";
    el.confirmField.hidden = !signup;
    el.rememberRow.hidden = signup;
    el.password.autocomplete = signup ? "new-password" : "current-password";
    el.submit.textContent = signup ? "Create account" : "Log in";
    el.switchHint.firstChild.textContent = signup ? "Already have an account? " : "New here? ";
    el.switchBtn.textContent = signup ? "Log in instead" : "Create an account";
    el.passwordMsg.textContent = signup ? "At least 8 characters." : "";
    el.usernameMsg.textContent = signup ? "3-32 characters: letters, numbers, dot, dash or underscore." : "";
    clearErrors(true);
    if (focus) el.username.focus();
  }

  function clearErrors(keepHints) {
    el.formError.hidden = true;
    el.formError.textContent = "";
    [el.username, el.password, el.confirm].forEach(function (i) { i.removeAttribute("aria-invalid"); });
    if (!keepHints) setMode(mode, false);
  }

  function fieldError(input, msgEl, text) {
    input.setAttribute("aria-invalid", "true");
    msgEl.textContent = text;
    msgEl.dataset.error = "true";
  }

  function resetMsgState() {
    [el.usernameMsg, el.passwordMsg, el.confirmMsg].forEach(function (m) { m.dataset.error = "false"; });
    el.confirmMsg.textContent = "";
  }

  function validate() {
    resetMsgState();
    clearErrors(true);
    var u = el.username.value.trim();
    var p = el.password.value;
    var first = null;
    if (!u) { fieldError(el.username, el.usernameMsg, "Enter a username."); first = first || el.username; }
    else if (mode === "signup" && !/^[A-Za-z0-9_.-]{3,32}$/.test(u)) {
      fieldError(el.username, el.usernameMsg, "Use 3-32 letters, numbers, dots, dashes or underscores.");
      first = first || el.username;
    }
    if (!p) { fieldError(el.password, el.passwordMsg, "Enter a password."); first = first || el.password; }
    else if (mode === "signup" && p.length < 8) {
      fieldError(el.password, el.passwordMsg, "Use at least 8 characters.");
      first = first || el.password;
    }
    if (mode === "signup" && p && el.confirm.value !== p) {
      fieldError(el.confirm, el.confirmMsg, "Passwords don't match.");
      first = first || el.confirm;
    }
    if (first) first.focus();
    return !first;
  }

  el.form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (busy || !validate()) return;
    busy = true;
    el.submit.disabled = true;
    el.submit.textContent = mode === "signup" ? "Creating account…" : "Logging in…";
    var body = {
      username: el.username.value.trim(),
      password: el.password.value,
      remember: mode === "signup" ? true : el.remember.checked
    };
    api.post(mode === "signup" ? "/api/auth/signup" : "/api/auth/login", body, { allow401: true })
      .then(function () {
        location.href = nextUrl();
      })
      .catch(function (err) {
        busy = false;
        el.submit.disabled = false;
        el.submit.textContent = mode === "signup" ? "Create account" : "Log in";
        if (err.field === "username") {
          fieldError(el.username, el.usernameMsg, err.message);
          el.username.focus();
        } else if (err.field === "password" && mode === "signup") {
          fieldError(el.password, el.passwordMsg, err.message);
          el.password.focus();
        } else {
          el.formError.textContent = err.message;
          el.formError.hidden = false;
          if (err.status === 401) { el.password.select(); el.password.focus(); }
        }
      });
  });

  el.reveal.addEventListener("click", function () {
    var show = el.password.type === "password";
    el.password.type = show ? "text" : "password";
    el.confirm.type = show ? "text" : "password";
    el.reveal.textContent = show ? "Hide" : "Show";
    el.reveal.setAttribute("aria-pressed", String(show));
    el.reveal.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });

  el.tabLogin.addEventListener("click", function () { setMode("login", true); });
  el.tabSignup.addEventListener("click", function () { setMode("signup", true); });
  el.switchBtn.addEventListener("click", function () { setMode(mode === "login" ? "signup" : "login", true); });
  [el.tabLogin, el.tabSignup].forEach(function (tab) {
    tab.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        var other = tab === el.tabLogin ? el.tabSignup : el.tabLogin;
        other.click();
        other.focus();
        e.preventDefault();
      }
    });
  });

  setMode(new URLSearchParams(location.search).get("mode") === "signup" ? "signup" : "login", false);
  el.username.focus();
})();
