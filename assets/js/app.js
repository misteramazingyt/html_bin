/* html_bin — theme toggle, search, and in-page notes editing.
 *
 * Notes are stored in the markdown source, so saving means committing to the
 * repo. That needs a GitHub token, which lives only in this browser's
 * localStorage and is sent only to api.github.com. Use a fine-grained token
 * scoped to this one repository with Contents: read and write.
 */
(function () {
  "use strict";

  var REPO = document.documentElement.dataset.repo || "misteramazingyt/html_bin";
  var BRANCH = document.documentElement.dataset.branch || "main";
  var TOKEN_KEY = "html_bin.gh_token";
  var THEME_KEY = "html_bin.theme";

  /* ---------- theme ---------- */

  var savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;

  function toggleTheme() {
    var cur = document.documentElement.dataset.theme;
    if (!cur) {
      cur = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    var next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
  }

  /* ---------- token ---------- */

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }

  function openTokenDialog() {
    var dlg = document.getElementById("token-dialog");
    if (!dlg) return;
    var input = dlg.querySelector("#token-input");
    input.value = getToken();
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
   * Pages look like:
   *   ---\n front matter \n---\n\n# Title\n\n<media>\n\n## Notes [^1]\n\n<notes>\n\n---\n\n[^1]: url
   * Replace only the block between the Notes heading and the footnote rule,
   * leaving front matter, media and the source footnote untouched.
   */
  function replaceNotes(md, notes) {
    var m = /^##\s+Notes.*$/m.exec(md);
    var body = notes.trim();

    if (!m) {
      // No Notes section yet — append one before any trailing footnote block.
      var fn = /\n---\s*\n\s*\[\^1\]:/.exec(md);
      if (fn) {
        return md.slice(0, fn.index) + "\n\n## Notes [^1]\n\n" + body + "\n" + md.slice(fn.index);
      }
      return md.replace(/\s*$/, "") + "\n\n## Notes\n\n" + body + "\n";
    }

    var headingStart = m.index;
    var afterHeading = md.indexOf("\n", headingStart);
    if (afterHeading === -1) afterHeading = md.length;

    var head = md.slice(0, afterHeading + 1);
    var rest = md.slice(afterHeading + 1);

    // Everything from the horizontal rule that precedes the footnote is tail.
    var sep = /\n?---\s*\n/.exec(rest);
    var tail = sep ? rest.slice(sep.index) : "";

    return head + "\n" + body + "\n" + (tail || "\n");
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
    var sha = null;

    editBtn.addEventListener("click", function () {
      if (!getToken()) { openTokenDialog(); return; }
      editor.classList.add("open");
      editBtn.style.display = "none";
      setStatus(status, "loading…");
      ghGet(path).then(function (j) {
        sha = j.sha;
        var md = b64decode(j.content);
        var m = /^##\s+Notes.*$/m.exec(md);
        var current = "";
        if (m) {
          var after = md.slice(md.indexOf("\n", m.index) + 1);
          var sep = /\n?---\s*\n/.exec(after);
          current = (sep ? after.slice(0, sep.index) : after).trim();
        }
        textarea.value = current;
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
      if (sha === null) { setStatus(status, "not loaded yet", "err"); return; }
      saveBtn.disabled = true;
      setStatus(status, "saving…");
      ghGet(path).then(function (j) {
        // Re-read immediately before writing so a stale sha can't clobber an
        // edit made elsewhere since this editor was opened.
        var md = b64decode(j.content);
        return ghPut(path, replaceNotes(md, textarea.value), j.sha,
          "Update notes: " + path);
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

  document.addEventListener("DOMContentLoaded", function () {
    var t = document.getElementById("theme-toggle");
    if (t) t.addEventListener("click", toggleTheme);

    var k = document.getElementById("token-btn");
    if (k) k.addEventListener("click", openTokenDialog);

    var dlg = document.getElementById("token-dialog");
    if (dlg) {
      dlg.querySelector("#token-save").addEventListener("click", function (e) {
        e.preventDefault();
        var v = dlg.querySelector("#token-input").value.trim();
        if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY);
        dlg.close();
      });
      dlg.querySelector("#token-clear").addEventListener("click", function (e) {
        e.preventDefault();
        localStorage.removeItem(TOKEN_KEY);
        dlg.querySelector("#token-input").value = "";
        dlg.close();
      });
    }

    document.querySelectorAll("[data-path]").forEach(wireEditor);
    wireSearch();
  });
})();
