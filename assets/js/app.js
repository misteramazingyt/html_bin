/* html_bin — theme, search, GitHub sign-in, and in-page notes editing.
 *
 * Notes live in the markdown source, so saving means committing to the repo.
 * Auth is a normal GitHub OAuth sign-in: the browser never sees the client
 * secret. The code->token exchange happens in the n8n workflow
 * "GitHub OAuth (html_bin)", which also refuses to hand a token back to any
 * account other than the repo owner. The token arrives in a URL fragment
 * (never sent to a server), is stripped from the address bar immediately, and
 * is kept in localStorage thereafter.
 */
(function () {
  "use strict";

  var d = document.documentElement.dataset;
  var REPO = d.repo || "misteramazingyt/html_bin";
  var BRANCH = d.branch || "main";
  var CLIENT_ID = d.clientId || "";
  var BROKER = d.broker || "";

  var TOKEN_KEY = "html_bin.gh_token";
  var LOGIN_KEY = "html_bin.gh_login";
  var STATE_KEY = "html_bin.oauth_state";
  var THEME_KEY = "html_bin.theme";

  /* ---------- theme ---------- */

  var savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;

  function toggleTheme() {
    var cur = document.documentElement.dataset.theme;
    if (!cur) cur = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    var next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
  }

  /* ---------- auth ---------- */

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }
  function getLogin() { return localStorage.getItem(LOGIN_KEY) || ""; }

  function randomState() {
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) {
      return ("0" + b.toString(16)).slice(-2);
    }).join("");
  }

  function signIn() {
    if (!CLIENT_ID || !BROKER) {
      dialogStatus("Sign-in isn't configured yet: set github_client_id in _config.yml.", "err");
      return;
    }
    var state = randomState();
    sessionStorage.setItem(STATE_KEY, state);
    location.href = "https://github.com/login/oauth/authorize" +
      "?client_id=" + encodeURIComponent(CLIENT_ID) +
      "&redirect_uri=" + encodeURIComponent(BROKER) +
      "&scope=public_repo" +
      "&state=" + encodeURIComponent(state);
  }

  function signOut() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(LOGIN_KEY);
    reflectAuth();
  }

  // Consume #gh_token / #gh_error handed back by the broker.
  function consumeCallback() {
    if (!location.hash || location.hash.indexOf("gh_") === -1) return;
    var p = new URLSearchParams(location.hash.slice(1));
    var token = p.get("gh_token");
    var error = p.get("gh_error");
    var state = p.get("gh_state");
    if (!token && !error) return;

    // Strip the fragment before anything else can read it.
    history.replaceState(null, "", location.pathname + location.search);

    if (error) { pendingNotice = "Sign-in failed: " + error; return; }

    var expected = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);
    if (expected && state !== expected) {
      pendingNotice = "Sign-in rejected: state mismatch.";
      return;
    }
    localStorage.setItem(TOKEN_KEY, token);
    pendingNotice = "";
  }

  var pendingNotice = "";

  function reflectAuth() {
    var signedIn = !!getToken();
    var who = document.getElementById("whoami");
    var inBtn = document.getElementById("signin-btn");
    var outBtn = document.getElementById("signout-btn");
    if (inBtn) inBtn.hidden = signedIn;
    if (outBtn) outBtn.hidden = !signedIn;
    if (who) {
      who.hidden = !signedIn || !getLogin();
      who.textContent = getLogin() ? "@" + getLogin() : "";
    }
  }

  // Confirm the token works and remember who it belongs to.
  function refreshIdentity() {
    if (!getToken()) return;
    fetch("https://api.github.com/user", { headers: ghHeaders() })
      .then(function (r) {
        if (r.status === 401) { signOut(); throw new Error("session expired"); }
        return r.json();
      })
      .then(function (j) {
        if (j && j.login) { localStorage.setItem(LOGIN_KEY, j.login); reflectAuth(); }
      })
      .catch(function () { /* offline is not a reason to sign out */ });
  }

  /* ---------- dialog ---------- */

  function dialogStatus(msg, kind) {
    var el = document.getElementById("token-status");
    if (el) { el.textContent = msg || ""; el.className = "status" + (kind ? " " + kind : ""); }
  }

  function openDialog() {
    var dlg = document.getElementById("token-dialog");
    if (!dlg) return;
    var input = dlg.querySelector("#token-input");
    if (input) input.value = getToken();
    dialogStatus(pendingNotice, pendingNotice ? "err" : "");
    dlg.showModal();
  }

  /* ---------- base64 that survives non-ASCII ---------- */

  function b64encode(str) {
    var bytes = new TextEncoder().encode(str), bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ---------- GitHub contents API ---------- */

  function ghHeaders() {
    return {
      "Authorization": "Bearer " + getToken(),
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
  }

  function ghGet(path) {
    var url = "https://api.github.com/repos/" + REPO + "/contents/" +
      encodeURIComponent(path).replace(/%2F/g, "/") + "?ref=" + encodeURIComponent(BRANCH);
    return fetch(url, { headers: ghHeaders() }).then(function (r) {
      if (r.status === 401) { signOut(); throw new Error("signed out — sign in again"); }
      if (!r.ok) throw new Error("read failed (" + r.status + ")");
      return r.json();
    });
  }

  function ghPut(path, text, sha, message) {
    var url = "https://api.github.com/repos/" + REPO + "/contents/" +
      encodeURIComponent(path).replace(/%2F/g, "/");
    return fetch(url, {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, ghHeaders()),
      body: JSON.stringify({
        message: message, content: b64encode(text), sha: sha, branch: BRANCH
      })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.message || ("write failed (" + r.status + ")"));
        return j;
      });
    });
  }

  /* ---------- markdown surgery ----------
   * Replace only the block between the Notes heading and the footnote rule,
   * leaving front matter, media and the source footnote untouched.
   */
  function replaceNotes(md, notes) {
    var m = /^##\s+Notes.*$/m.exec(md);
    var body = notes.trim();

    if (!m) {
      var fn = /\n---\s*\n\s*\[\^1\]:/.exec(md);
      if (fn) {
        return md.slice(0, fn.index) + "\n\n## Notes [^1]\n\n" + body + "\n" + md.slice(fn.index);
      }
      return md.replace(/\s*$/, "") + "\n\n## Notes\n\n" + body + "\n";
    }

    var afterHeading = md.indexOf("\n", m.index);
    if (afterHeading === -1) afterHeading = md.length;

    var head = md.slice(0, afterHeading + 1);
    var rest = md.slice(afterHeading + 1);
    var sep = /\n?---\s*\n/.exec(rest);
    var tail = sep ? rest.slice(sep.index) : "";

    return head + "\n" + body + "\n" + (tail || "\n");
  }

  function currentNotes(md) {
    var m = /^##\s+Notes.*$/m.exec(md);
    if (!m) return "";
    var after = md.slice(md.indexOf("\n", m.index) + 1);
    var sep = /\n?---\s*\n/.exec(after);
    return (sep ? after.slice(0, sep.index) : after).trim();
  }

  /* ---------- editor wiring ---------- */

  function setStatus(el, msg, kind) {
    if (!el) return;
    el.textContent = msg || "";
    el.className = "status" + (kind ? " " + kind : "");
  }

  function wireEditor(root) {
    var path = root.dataset.path;
    var editor = root.querySelector(".editor");
    var textarea = root.querySelector("textarea");
    var display = root.querySelector(".notes");
    var status = root.querySelector(".status");
    var editBtn = root.querySelector(".js-edit");
    var saveBtn = root.querySelector(".js-save");
    var cancelBtn = root.querySelector(".js-cancel");
    var loaded = false;

    editBtn.addEventListener("click", function () {
      if (!getToken()) { openDialog(); return; }
      editor.classList.add("open");
      editBtn.style.display = "none";
      setStatus(status, "loading…");
      ghGet(path).then(function (j) {
        loaded = true;
        textarea.value = currentNotes(b64decode(j.content));
        setStatus(status, "");
        textarea.focus();
      }).catch(function (e) {
        setStatus(status, e.message, "err");
      });
    });

    cancelBtn.addEventListener("click", function () {
      editor.classList.remove("open");
      editBtn.style.display = "";
      setStatus(status, "");
    });

    saveBtn.addEventListener("click", function () {
      if (!loaded) { setStatus(status, "not loaded yet", "err"); return; }
      saveBtn.disabled = true;
      setStatus(status, "saving…");
      // Re-read immediately before writing so a stale sha can't clobber an
      // edit made elsewhere since this editor was opened.
      ghGet(path).then(function (j) {
        var md = b64decode(j.content);
        return ghPut(path, replaceNotes(md, textarea.value), j.sha, "Update notes: " + path);
      }).then(function () {
        setStatus(status, "saved — live in ~1 min", "ok");
        if (display) display.textContent = textarea.value.trim();
        editor.classList.remove("open");
        editBtn.style.display = "";
      }).catch(function (e) {
        setStatus(status, e.message, "err");
      }).then(function () {
        saveBtn.disabled = false;
      });
    });
  }

  /* ---------- search ---------- */

  function wireSearch() {
    var input = document.getElementById("search");
    if (!input) return;
    var cards = Array.prototype.slice.call(document.querySelectorAll("[data-search]"));
    var count = document.getElementById("count");
    var total = cards.length;

    input.addEventListener("input", function () {
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      cards.forEach(function (c) {
        var hit = !q || c.dataset.search.indexOf(q) !== -1;
        c.style.display = hit ? "" : "none";
        if (hit) shown++;
      });
      if (count) count.textContent = shown === total ? total + " pages" : shown + " of " + total;
    });
  }

  /* ---------- boot ---------- */

  consumeCallback();

  document.addEventListener("DOMContentLoaded", function () {
    var t = document.getElementById("theme-toggle");
    if (t) t.addEventListener("click", toggleTheme);

    var inBtn = document.getElementById("signin-btn");
    if (inBtn) inBtn.addEventListener("click", function () { openDialog(); });

    var outBtn = document.getElementById("signout-btn");
    if (outBtn) outBtn.addEventListener("click", signOut);

    var dlg = document.getElementById("token-dialog");
    if (dlg) {
      var go = dlg.querySelector("#signin-go");
      if (go) go.addEventListener("click", function (e) { e.preventDefault(); signIn(); });

      var save = dlg.querySelector("#token-save");
      if (save) save.addEventListener("click", function (e) {
        e.preventDefault();
        var v = dlg.querySelector("#token-input").value.trim();
        if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY);
        dlg.close();
        reflectAuth();
        refreshIdentity();
      });

      var clear = dlg.querySelector("#token-clear");
      if (clear) clear.addEventListener("click", function (e) {
        e.preventDefault();
        signOut();
        dlg.querySelector("#token-input").value = "";
        dlg.close();
      });
    }

    reflectAuth();
    refreshIdentity();
    if (pendingNotice) openDialog();

    document.querySelectorAll("[data-path]").forEach(wireEditor);
    wireSearch();
  });
})();
