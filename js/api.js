/* Silent Sign - small helper for calling the local server's JSON API.
 *
 * - Adds the X-Silent-Sign header the server requires on every change
 *   (this is what blocks cross-site request forgery).
 * - Sends to the login page when the user is no longer logged in.
 * - Rejects with an Error that carries .status, .field and .body.
 */
(function () {
  "use strict";

  var TIMEOUT_MS = 10000;

  function loginUrl() {
    return "/login?next=" + encodeURIComponent(location.pathname);
  }

  function request(method, url, body, options) {
    options = options || {};
    var init = { method: method, headers: {}, credentials: "same-origin", cache: "no-store" };
    if (method !== "GET") init.headers["X-Silent-Sign"] = "1";
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (options.keepalive) init.keepalive = true;

    var controller = "AbortController" in window ? new AbortController() : null;
    var timer = null;
    if (controller) {
      init.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, options.timeout || TIMEOUT_MS);
    }

    return fetch(url, init).then(function (res) {
      clearTimeout(timer);
      return res.json().catch(function () { return null; }).then(function (data) {
        if (res.status === 401 && !options.allow401) {
          location.href = loginUrl();
        }
        if (!res.ok || !data || data.ok === false) {
          var err = new Error((data && data.error) || ("Request failed (HTTP " + res.status + ")"));
          err.status = res.status;
          err.field = data && data.field;
          err.body = data;
          throw err;
        }
        return data;
      });
    }, function (e) {
      clearTimeout(timer);
      var err = new Error("Can't reach the Silent Sign server. Check that backend\\app.py is still running.");
      err.status = 0;
      err.cause = e;
      throw err;
    });
  }

  window.SilentSignApi = {
    get: function (url, o) { return request("GET", url, undefined, o); },
    post: function (url, body, o) { return request("POST", url, body, o); },
    put: function (url, body, o) { return request("PUT", url, body, o); },
    del: function (url, body, o) { return request("DELETE", url, body, o); },
    logout: function () {
      return request("POST", "/api/auth/logout", undefined, { allow401: true })
        .catch(function () { /* go to login anyway */ })
        .then(function () { location.href = "/login"; });
    },
    loginUrl: loginUrl
  };
})();
