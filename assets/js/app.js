/* html_bin — theme, search, tag filtering, views, selection, and editing.
 *
 * Two tag families live in the markdown front matter and never mix:
 *   tags: [...]  written by the capture pipeline (Gemini). Read-only here.
 *   bin:  [...]  the user's own. Everything editable on this page touches
 *                only this key.
 *
 * Editing commits to the repo through the GitHub contents API, authorised by
 * a normal GitHub sign-in brokered by n8n (the browser never sees a secret).
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
  var VIEW_KEY = "html_bin.view";

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

  /* ---------- tag colour ----------
   * 12 hues, spaced round the wheel and avoiding the muddy yellows. A tag
   * always lands on the same hue because the hash is stable, so colour is a
   * usable identity cue rather than decoration.
   */
  var HUES = [8, 30, 45, 92, 140, 165, 190, 212, 240, 275, 305, 335];

  // FNV-1a plus a murmur3 finaliser. A plain *31 hash clumps badly modulo 12
  // on short words — "marx", "dewey" and "funny" all landed on one hue — so the
  // avalanche step is doing real work here, not ceremony.
  function hueFor(tag) {
    var s = String(tag).toLowerCase(), h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= h >>> 16; h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return HUES[h % HUES.length];
  }

  function paintTags(root) {
    (root || document).querySelectorAll(".tag-bin, .chip-bin").forEach(function (el) {
      var t = el.dataset.tag || el.textContent.trim();
      el.style.setProperty("--h", hueFor(t));
    });
  }

  /* ---------- small helpers ---------- */

  function listOf(el, key) {
    return (el.dataset[key] || "").split("|").map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function uniqCI(arr) {
    var seen = {}, out = [];
    arr.forEach(function (t) {
      var k = t.toLowerCase();
      if (!seen[k]) { seen[k] = true; out.push(t); }
    });
    return out;
  }

  function parseTagInput(s) {
    return uniqCI(String(s || "").split(",").map(function (t) { return t.trim(); }).filter(Boolean));
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
      dialogStatus("Sign-in isn't configured: set github_client_id in _config.yml.", "err");
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

  var pendingNotice = "";

  function consumeCallback() {
    if (!location.hash || location.hash.indexOf("gh_") === -1) return;
    var p = new URLSearchParams(location.hash.slice(1));
    var token = p.get("gh_token"), error = p.get("gh_error"), state = p.get("gh_state");
    if (!token && !error) return;

    history.replaceState(null, "", location.pathname + location.search);

    if (error) { pendingNotice = "Sign-in failed: " + error; return; }

    var expected = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);
    if (expected && state !== expected) { pendingNotice = "Sign-in rejected: state mismatch."; return; }
    localStorage.setItem(TOKEN_KEY, token);
    pendingNotice = "";
  }

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

  function refreshIdentity() {
    if (!getToken()) return;
    fetch("https://api.github.com/user", { headers: ghHeaders() })
      .then(function (r) {
        if (r.status === 401) { signOut(); throw new Error("session expired"); }
        return r.json();
      })
      .then(function (j) { if (j && j.login) { localStorage.setItem(LOGIN_KEY, j.login); reflectAuth(); } })
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

  function contentsURL(path) {
    return "https://api.github.com/repos/" + REPO + "/contents/" +
      encodeURIComponent(path).replace(/%2F/g, "/");
  }

  // cache: no-store is load-bearing. GitHub returns Cache-Control: private,
  // max-age=60 on authenticated reads, so a second edit within a minute was
  // served the pre-write body — and its stale sha — which the API then rejected
  // with "<path> does not match <sha>".
  function ghGet(path) {
    return fetch(contentsURL(path) + "?ref=" + encodeURIComponent(BRANCH), {
      headers: ghHeaders(),
      cache: "no-store"
    }).then(function (r) {
      if (r.status === 401) { signOut(); throw new Error("signed out — sign in again"); }
      if (!r.ok) throw new Error("read failed (" + r.status + ")");
      return r.json();
    });
  }

  function ghPut(path, text, sha, message) {
    return fetch(contentsURL(path), {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, ghHeaders()),
      body: JSON.stringify({ message: message, content: b64encode(text), sha: sha, branch: BRANCH })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.message || ("write failed (" + r.status + ")"));
        return j;
      });
    });
  }

  function ghDelete(path, sha, message) {
    return fetch(contentsURL(path), {
      method: "DELETE",
      headers: Object.assign({ "Content-Type": "application/json" }, ghHeaders()),
      body: JSON.stringify({ message: message, sha: sha, branch: BRANCH })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.message || ("delete failed (" + r.status + ")"));
        return j;
      });
    });
  }

  /* ---------- front matter ----------
   * Only the `bin:` line is ever touched. title/permalink/tags and the whole
   * body are passed through byte-for-byte.
   */

  function splitFM(md) {
    var m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
    if (!m) return null;
    return { body: m[1], rest: md.slice(m[0].length) };
  }

  // A YAML flow sequence, tolerant of both quoted and bare entries. Splitting
  // on commas would corrupt any tag containing one, and treating a quote as a
  // delimiter mid-value would mangle a bare tag like: Video "essays".
  function parseFlowSeq(v) {
    v = String(v).trim();
    if (v.charAt(0) === "[") v = v.slice(1);
    if (v.charAt(v.length - 1) === "]") v = v.slice(0, -1);

    var out = [], i = 0;
    while (i < v.length) {
      while (i < v.length && /[\s,]/.test(v.charAt(i))) i++;
      if (i >= v.length) break;

      var c = v.charAt(i), val = "";
      if (c === '"' || c === "'") {
        var q = c; i++;
        while (i < v.length && v.charAt(i) !== q) {
          if (q === '"' && v.charAt(i) === "\\" && i + 1 < v.length) { val += v.charAt(i + 1); i += 2; }
          else { val += v.charAt(i); i++; }
        }
        i++;                                  // closing quote
      } else {
        while (i < v.length && v.charAt(i) !== ",") { val += v.charAt(i); i++; }
        val = val.trim();
      }
      if (val) out.push(val);
    }
    return out;
  }

  // Always emit quoted, so commas, colons, brackets and quotes in a tag are
  // never ambiguous to the YAML parser.
  function yamlTag(t) {
    return '"' + String(t).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }

  function getBin(md) {
    var fm = splitFM(md);
    if (!fm) return [];
    var m = /^bin\s*:\s*(.*)$/m.exec(fm.body);
    if (!m) return [];
    return parseFlowSeq(m[1]);
  }

  function setBin(md, tags) {
    var line = "bin: [" + tags.map(yamlTag).join(", ") + "]";
    var fm = splitFM(md);

    if (!fm) {
      // A page with no front matter (a scratch file). Adding tags creates one;
      // clearing tags leaves the file untouched rather than manufacturing an
      // empty block — which would also make this non-idempotent.
      if (!tags.length) return md;
      return "---\n" + line + "\n---\n\n" + md;
    }

    var lines = fm.body.split("\n");
    var idx = -1;
    for (var i = 0; i < lines.length; i++) {
      if (/^bin\s*:/.test(lines[i])) { idx = i; break; }
    }

    if (!tags.length) {
      if (idx !== -1) lines.splice(idx, 1);
    } else if (idx !== -1) {
      lines[idx] = line;
    } else {
      lines.push(line);
    }

    return "---\n" + lines.join("\n") + "\n---\n" + fm.rest;
  }

  /* ---------- archive flag ---------- */

  function getArchived(md) {
    var fm = splitFM(md);
    if (!fm) return false;
    var m = /^archived\s*:\s*(.*)$/m.exec(fm.body);
    return !!m && /^(true|yes|1)$/i.test(m[1].trim());
  }

  function setArchived(md, on) {
    var fm = splitFM(md);
    if (!fm) return on ? "---\narchived: true\n---\n\n" + md : md;

    var lines = fm.body.split("\n");
    var idx = -1;
    for (var i = 0; i < lines.length; i++) {
      if (/^archived\s*:/.test(lines[i])) { idx = i; break; }
    }

    if (!on) {
      if (idx !== -1) lines.splice(idx, 1);
    } else if (idx !== -1) {
      lines[idx] = "archived: true";
    } else {
      lines.push("archived: true");
    }

    return "---\n" + lines.join("\n") + "\n---\n" + fm.rest;
  }

  /* ---------- notes body ---------- */

  function replaceNotes(md, notes) {
    var m = /^##\s+Notes.*$/m.exec(md);
    var body = notes.trim();

    if (!m) {
      var fn = /\n---\s*\n\s*\[\^1\]:/.exec(md);
      if (fn) return md.slice(0, fn.index) + "\n\n## Notes [^1]\n\n" + body + "\n" + md.slice(fn.index);
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

  /* ---------- view mode ---------- */

  function setView(v) {
    var grid = document.getElementById("grid");
    if (!grid) return;
    grid.classList.toggle("view-cards", v !== "details");
    grid.classList.toggle("view-details", v === "details");
    document.querySelectorAll(".js-view").forEach(function (b) {
      b.classList.toggle("active", b.dataset.view === v);
    });
    localStorage.setItem(VIEW_KEY, v);
  }

  /* ---------- filtering ---------- */

  var activeAuto = [];
  var activeBin = [];
  var excludedBin = [];      // alt-clicked: hide anything carrying these
  var archiveMode = false;   // deliberately not persisted: leaving it on would
                             // make the whole library look empty on next visit

  function isArchived(it) { return it.dataset.archived === "true"; }

  function applyFilter() {
    var input = document.getElementById("search");
    var q = input ? input.value.trim().toLowerCase() : "";
    var items = document.querySelectorAll(".item");
    var shown = 0, eligible = 0;

    // A tag's chip is shown only while something in the current mode still
    // carries it, so archiving every page with a tag retires the tag too.
    var liveTags = {};
    items.forEach(function (it) {
      if (isArchived(it) !== archiveMode) return;
      eligible++;
      listOf(it, "bin").forEach(function (t) { liveTags[t.toLowerCase()] = true; });
    });

    document.querySelectorAll(".chip-bin").forEach(function (c) {
      var gone = !liveTags[(c.dataset.tag || "").toLowerCase()];
      c.hidden = gone;
      if (gone && c.classList.contains("on")) {           // drop a filter that no longer exists
        c.classList.remove("on");
        var i = activeBin.indexOf(c.dataset.tag);
        if (i !== -1) activeBin.splice(i, 1);
      }
      if (gone && c.classList.contains("chip-excluded")) {
        c.classList.remove("chip-excluded");
        var x = excludedBin.indexOf(c.dataset.tag);
        if (x !== -1) excludedBin.splice(x, 1);
      }
    });

    items.forEach(function (it) {
      var hit = isArchived(it) === archiveMode;
      if (hit) hit = !q || (it.dataset.search || "").indexOf(q) !== -1;

      // Chips narrow rather than widen: every selected tag must be present.
      if (hit && activeAuto.length) {
        var a = listOf(it, "auto").map(function (s) { return s.toLowerCase(); });
        hit = activeAuto.every(function (t) { return a.indexOf(t.toLowerCase()) !== -1; });
      }
      if (hit && activeBin.length) {
        var b = listOf(it, "bin").map(function (s) { return s.toLowerCase(); });
        hit = activeBin.every(function (t) { return b.indexOf(t.toLowerCase()) !== -1; });
      }

      // One excluded tag removes the item however well it matches otherwise,
      // so "everything tagged X, minus Y" is two clicks.
      if (hit && excludedBin.length) {
        var x = listOf(it, "bin").map(function (s) { return s.toLowerCase(); });
        hit = !excludedBin.some(function (t) { return x.indexOf(t.toLowerCase()) !== -1; });
      }

      it.hidden = !hit;
      if (hit) shown++;
    });

    var count = document.getElementById("count");
    if (count) count.textContent = (shown === eligible)
      ? eligible + (archiveMode ? " archived" : " pages")
      : shown + " of " + eligible;

    var none = document.getElementById("no-results");
    if (none) none.hidden = shown !== 0 || items.length === 0;

    var clear = document.getElementById("clear-filters");
    if (clear) clear.hidden = !(activeAuto.length || activeBin.length || excludedBin.length);
  }

  function toggleChip(btn) {
    var tag = btn.dataset.tag;
    var arr = btn.dataset.filter === "bin" ? activeBin : activeAuto;
    var i = arr.indexOf(tag);
    if (i === -1) arr.push(tag); else arr.splice(i, 1);
    btn.classList.toggle("on", i === -1);
    applyFilter();
  }

  // Alt-click. Deliberately not persisted, for the same reason archive mode is
  // not: a tag hidden in a previous session would silently shrink the library
  // with nothing on screen to explain it.
  function toggleExclude(btn) {
    var tag = btn.dataset.tag;
    var i = excludedBin.indexOf(tag);
    if (i === -1) {
      excludedBin.push(tag);
      var j = activeBin.indexOf(tag);            // cannot require and exclude the same tag
      if (j !== -1) { activeBin.splice(j, 1); btn.classList.remove("on"); }
    } else {
      excludedBin.splice(i, 1);
    }
    btn.classList.toggle("chip-excluded", i === -1);
    applyFilter();
  }

  function clearFilters() {
    activeAuto = [];
    activeBin = [];
    excludedBin = [];
    document.querySelectorAll(".chip.on").forEach(function (c) { c.classList.remove("on"); });
    document.querySelectorAll(".chip-excluded").forEach(function (c) {
      c.classList.remove("chip-excluded");
    });
    applyFilter();
  }

  /* ---------- selection ---------- */

  var selected = [];   // paths, in click order
  var lastIndex = -1;

  function visibleItems() {
    return Array.prototype.filter.call(document.querySelectorAll(".item"), function (it) {
      return !it.hidden;
    });
  }

  function isSelected(it) { return selected.indexOf(it.dataset.path) !== -1; }

  function setSelected(it, on) {
    var p = it.dataset.path, i = selected.indexOf(p);
    if (on && i === -1) selected.push(p);
    if (!on && i !== -1) selected.splice(i, 1);
    it.classList.toggle("selected", on);
  }

  function clearSelection() {
    document.querySelectorAll(".item.selected").forEach(function (it) { it.classList.remove("selected"); });
    selected = [];
    lastIndex = -1;
    reflectSelection();
  }

  function reflectSelection() {
    var bar = document.getElementById("selbar");
    var n = document.getElementById("sel-count");
    if (n) n.textContent = selected.length;
    if (bar) bar.hidden = selected.length === 0;
  }

  function onItemClick(e) {
    var it = e.target.closest(".item");
    if (!it) return;

    // Plain clicks stay ordinary so links and buttons keep working.
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) return;
    if (e.target.closest("a, button, textarea, video")) return;

    e.preventDefault();
    var items = visibleItems();
    var idx = items.indexOf(it);

    if (e.shiftKey && lastIndex !== -1) {
      var lo = Math.min(lastIndex, idx), hi = Math.max(lastIndex, idx);
      for (var i = lo; i <= hi; i++) setSelected(items[i], true);
    } else {
      setSelected(it, !isSelected(it));
      lastIndex = idx;
    }
    reflectSelection();
  }

  /* ---------- rendering tags back into the DOM ---------- */

  function renderBinTags(it, tags) {
    it.dataset.bin = tags.join("|");
    var row = it.querySelector(".item-bin");
    if (row) {
      row.innerHTML = "";
      tags.forEach(function (t) {
        var s = document.createElement("span");
        s.className = "tag tag-bin";
        s.textContent = t;
        s.style.setProperty("--h", hueFor(t));
        row.appendChild(s);
      });
    }
    // keep search in sync so a freshly added tag is findable immediately
    var base = (it.dataset.search || "").split("  ")[0];
    it.dataset.search = (it.querySelector(".item-title").textContent.trim().toLowerCase()) + " " +
      listOf(it, "auto").join(" ").toLowerCase() + " " + tags.join(" ").toLowerCase() +
      " " + base;
  }

  function ensureChip(tag, cat) {
    var exists = document.querySelector('.chip-bin[data-tag="' + CSS.escape(tag) + '"]');
    if (exists) return;
    cat = cat === "meta" ? "meta" : "content";
    var group = document.getElementById(cat === "meta" ? "group-meta" : "group-content");
    if (!group) group = document.querySelector(".filter-group");
    if (!group) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "chip chip-bin";
    b.draggable = true;
    b.dataset.filter = "bin";
    b.dataset.cat = cat;
    b.dataset.tag = tag;
    b.textContent = tag;
    b.style.setProperty("--h", hueFor(tag));
    group.appendChild(b);
    // A brand-new metadata tag has to be written to tag_meta.yml, or the next
    // build would render it back under Content.
    if (cat === "meta") {
      setTagCategory(tag, "meta").catch(function () { /* reported on the chip */ });
    }
  }

  /* ---------- tag picker ----------
   * Replaces window.prompt: a token field with live-filtered suggestions drawn
   * from the tags already in use, so the vocabulary converges instead of
   * sprouting near-duplicates from typos.
   *
   * Tab takes the highlighted suggestion, up/down (or left/right, since the
   * list scrolls sideways) moves the highlight, Enter or OK commits, Esc or
   * Cancel aborts. Resolves to an array of tags, or null if cancelled.
   */

  function allKnownTags() {
    var seen = {}, out = [];
    document.querySelectorAll(".item").forEach(function (it) {
      listOf(it, "bin").forEach(function (t) {
        var k = t.toLowerCase();
        if (!seen[k]) { seen[k] = true; out.push(t); }
      });
    });
    return out.sort(function (a, b) { return a.localeCompare(b); });
  }

  function openTagPicker(opts) {
    var dlg = document.getElementById("tag-dialog");
    if (!dlg) return Promise.resolve(null);

    var titleEl = document.getElementById("tag-title");
    var subEl = document.getElementById("tag-sub");
    var chipsEl = document.getElementById("token-chips");
    var input = document.getElementById("tag-input");
    var listEl = document.getElementById("tag-suggest");

    var chosen = (opts.initial || []).slice();
    var pool = opts.pool || [];
    var shown = [];
    var active = 0;

    // Only meaningful when the box holds a tag that does not exist yet.
    var newCatEl = document.getElementById("tag-newcat");
    var newCatSeg = document.getElementById("tag-newcat-seg");
    var newCat = "content";

    function isNew(t) {
      return !pool.some(function (p) { return p.toLowerCase() === t.toLowerCase(); });
    }

    function syncNewCat() {
      if (!newCatEl) return;
      newCatEl.hidden = !(opts.allowNewCategory && chosen.some(isNew));
    }

    if (newCatSeg && !newCatSeg.dataset.wired) {
      newCatSeg.dataset.wired = "1";
      newCatSeg.addEventListener("click", function (e) {
        var b = e.target.closest(".seg-opt");
        if (!b) return;
        e.preventDefault();
        newCat = b.dataset.cat;
        newCatSeg.querySelectorAll(".seg-opt").forEach(function (o) {
          var on = o === b;
          o.classList.toggle("on", on);
          o.setAttribute("aria-checked", on ? "true" : "false");
        });
      });
    }

    titleEl.textContent = opts.title || "Tags";
    subEl.textContent = opts.sub || "";
    input.value = "";

    newCat = "content";
    if (newCatSeg) {
      newCatSeg.querySelectorAll(".seg-opt").forEach(function (o) {
        var on = o.dataset.cat === "content";
        o.classList.toggle("on", on);
        o.setAttribute("aria-checked", on ? "true" : "false");
      });
    }

    function has(t) {
      return chosen.some(function (c) { return c.toLowerCase() === t.toLowerCase(); });
    }

    function renderChips() {
      syncNewCat();
      chipsEl.innerHTML = "";
      chosen.forEach(function (t, i) {
        var chip = document.createElement("span");
        chip.className = "token-chip";
        chip.style.setProperty("--h", hueFor(t));
        chip.appendChild(document.createTextNode(t));
        var x = document.createElement("button");
        x.type = "button";
        x.className = "token-x";
        x.setAttribute("aria-label", "Remove " + t);
        x.textContent = "×";
        x.addEventListener("click", function (e) {
          e.preventDefault();
          chosen.splice(i, 1);
          renderChips(); renderList();
          input.focus();
        });
        chip.appendChild(x);
        chipsEl.appendChild(chip);
      });
    }

    function renderList() {
      var q = input.value.trim().toLowerCase();
      shown = pool.filter(function (t) {
        return !has(t) && (!q || t.toLowerCase().indexOf(q) !== -1);
      });
      // Offer the typed text itself when it is not already an exact match.
      var raw = input.value.trim();
      if (raw && !pool.some(function (t) { return t.toLowerCase() === raw.toLowerCase(); }) && !has(raw)) {
        shown = [raw].concat(shown);
      }
      if (active >= shown.length) active = Math.max(0, shown.length - 1);

      listEl.innerHTML = "";
      if (!shown.length) {
        var none = document.createElement("span");
        none.className = "suggest-empty";
        none.textContent = pool.length ? "no matching tags" : "no tags yet — type to create one";
        listEl.appendChild(none);
        return;
      }
      shown.forEach(function (t, i) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "suggest-item" + (i === active ? " active" : "");
        b.setAttribute("role", "option");
        b.style.setProperty("--h", hueFor(t));
        b.textContent = t;
        if (i === 0 && t === input.value.trim() && !pool.some(function (p) {
          return p.toLowerCase() === t.toLowerCase();
        })) b.classList.add("is-new");
        b.addEventListener("click", function (e) { e.preventDefault(); add(t); });
        listEl.appendChild(b);
      });
      var act = listEl.querySelector(".suggest-item.active");
      if (act) act.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    function add(t) {
      t = String(t || "").trim();
      if (!t || has(t)) { input.value = ""; renderList(); return; }
      chosen.push(t);
      input.value = "";
      active = 0;
      renderChips(); renderList();
      input.focus();
    }

    function move(d) {
      if (!shown.length) return;
      active = (active + d + shown.length) % shown.length;
      renderList();
    }

    var settle;
    function finish(val) {
      input.removeEventListener("keydown", onKey);
      input.removeEventListener("input", onInput);
      dlg.removeEventListener("close", onClose);
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      if (dlg.open) dlg.close();
      settle(val);
    }

    function commit() {
      // Never silently drop half-typed text.
      var raw = input.value.trim();
      if (raw) add(shown.length && active < shown.length ? shown[active] : raw);
      var out = chosen.slice();
      out.newCat = newCat;          // read by bulkAddTags for tags it creates
      finish(out);
    }

    function onKey(e) {
      if (e.key === "Tab") {
        if (shown.length) { e.preventDefault(); add(shown[active]); }
      } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault(); move(1);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault(); move(-1);
      } else if (e.key === "Enter") {
        e.preventDefault(); commit();
      } else if (e.key === "Backspace" && !input.value && chosen.length) {
        e.preventDefault();
        chosen.pop(); renderChips(); renderList();
      }
    }

    function onInput() { active = 0; renderList(); }
    function onOk(e) { e.preventDefault(); commit(); }
    function onCancel(e) { e.preventDefault(); finish(null); }
    function onClose() { finish(null); }          // covers Esc

    var okBtn = document.getElementById("tag-ok");
    var cancelBtn = document.getElementById("tag-cancel");

    input.addEventListener("keydown", onKey);
    input.addEventListener("input", onInput);
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    dlg.addEventListener("close", onClose);

    renderChips();
    renderList();
    dlg.showModal();
    setTimeout(function () { input.focus(); }, 0);

    return new Promise(function (resolve) { settle = resolve; });
  }

  /* ---------- tag categories ----------
   * Chips sit in one of two rows: Content (what the item is about) and Metadata
   * (where it came from, what it is). The split lives in _data/tag_meta.yml,
   * which lists only the metadata tags — anything unlisted is content, so a new
   * tag needs no entry and the file cannot drift out of step with the capture
   * pipeline.
   *
   * Liquid renders the rows at build time. Editing one commits the yml through
   * the same contents API as everything else, but GitHub Pages takes a minute or
   * so to rebuild, so the move is also applied to the DOM immediately and
   * remembered briefly in localStorage — otherwise a reload inside that window
   * would snap the chip back and look like the save had failed.
   */

  var TAG_META_PATH = "_data/tag_meta.yml";
  var PENDING_KEY = "html_bin.tag_meta_pending";
  var PENDING_TTL = 20 * 60 * 1000;   // long enough for a Pages build, no longer

  function readPending() {
    try {
      var o = JSON.parse(localStorage.getItem(PENDING_KEY) || "{}");
      var now = Date.now(), out = {}, kept = false;
      Object.keys(o).forEach(function (k) {
        if (now - (o[k].at || 0) < PENDING_TTL) { out[k] = o[k]; kept = true; }
      });
      if (!kept) localStorage.removeItem(PENDING_KEY);
      return out;
    } catch (e) { return {}; }
  }

  function rememberPending(tag, cat) {
    var o = readPending();
    o[tag.toLowerCase()] = { cat: cat, at: Date.now() };
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(o)); } catch (e) { /* full or blocked */ }
  }

  // A YAML scalar as this file writes them: quoted, or bare.
  function unquoteScalar(s) {
    s = String(s).trim();
    var q = s.charAt(0);
    if ((q === '"' || q === "'") && s.charAt(s.length - 1) === q) {
      s = s.slice(1, -1);
      if (q === '"') s = s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    return s;
  }

  function parseMetaYaml(text) {
    var lines = String(text).split(/\r?\n/);
    var out = [], inList = false;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (/^meta\s*:/.test(ln)) { inList = true; continue; }
      if (!inList) continue;
      var m = /^\s*-\s*(.+?)\s*$/.exec(ln);
      if (m) { out.push(unquoteScalar(m[1])); continue; }
      if (/^\s*$/.test(ln) || /^\s*#/.test(ln)) continue;
      break;                                   // back at top level: list is over
    }
    return out;
  }

  // Everything above `meta:` is comment and is preserved verbatim; only the list
  // is rewritten, so the file keeps explaining itself.
  function serialiseMetaYaml(text, names) {
    var lines = String(text).split(/\r?\n/);
    var head = [], i = 0;
    for (; i < lines.length; i++) {
      if (/^meta\s*:/.test(lines[i])) break;
      head.push(lines[i]);
    }
    if (i === lines.length) head = lines.slice();   // no meta key yet
    while (head.length && /^\s*$/.test(head[head.length - 1])) head.pop();

    var body = ["meta:"];
    names.slice().sort(function (a, b) {
      return a.toLowerCase().localeCompare(b.toLowerCase());
    }).forEach(function (t) { body.push("  - " + yamlTag(t)); });

    return head.concat(head.length ? [""] : [], body, [""]).join("\n");
  }

  function categoryOf(tag) {
    var c = document.querySelector('.chip-bin[data-tag="' + CSS.escape(tag) + '"]');
    return (c && c.dataset.cat) || "content";
  }

  function moveChip(tag, cat) {
    var chip = document.querySelector('.chip-bin[data-tag="' + CSS.escape(tag) + '"]');
    var group = document.getElementById(cat === "meta" ? "group-meta" : "group-content");
    if (!chip || !group) return;
    chip.dataset.cat = cat;
    group.appendChild(chip);
  }

  function applyPendingCategories() {
    var pend = readPending();
    Object.keys(pend).forEach(function (k) {
      var chip = Array.prototype.find.call(
        document.querySelectorAll(".chip-bin"), function (c) {
          return (c.dataset.tag || "").toLowerCase() === k;
        });
      if (chip && chip.dataset.cat !== pend[k].cat) {
        moveChip(chip.dataset.tag, pend[k].cat);
      }
    });
  }

  /* Commit a category change. Resolves to the category actually stored. */
  function setTagCategory(tag, cat) {
    if (!getToken()) {
      return Promise.reject(new Error("sign in to change a tag's category"));
    }
    return ghGet(TAG_META_PATH).then(function (j) {
      return { text: b64decode(j.content), sha: j.sha };
    }, function (err) {
      // A repo without the file yet: start one rather than failing.
      if (/read failed \(404\)/.test(err.message)) return { text: "meta:\n", sha: null };
      throw err;
    }).then(function (cur) {
      var names = parseMetaYaml(cur.text);
      var lc = tag.toLowerCase();
      var without = names.filter(function (t) { return t.toLowerCase() !== lc; });
      if (cat === "meta") without.push(tag);

      var next = serialiseMetaYaml(cur.text, without);
      if (next === cur.text) return cat;          // already right: no empty commit

      return ghPut(TAG_META_PATH, next, cur.sha,
                   "tag_meta: " + tag + " -> " + (cat === "meta" ? "metadata" : "content"))
        .then(function () { return cat; });
    }).then(function (done) {
      moveChip(tag, done);
      rememberPending(tag, done);
      applyFilter();
      return done;
    });
  }

  /* ---------- category dialog (ctrl-click a chip) ---------- */

  function openCatDialog(tag, current) {
    var dlg = document.getElementById("cat-dialog");
    if (!dlg) return Promise.resolve(null);

    var sub = document.getElementById("cat-sub");
    var opts = dlg.querySelectorAll(".cat-opt");
    var okBtn = document.getElementById("cat-ok");
    var cancelBtn = document.getElementById("cat-cancel");
    var picked = current || "content";

    sub.textContent = 'Where should "' + tag + '" sit?';

    function paint() {
      opts.forEach(function (o) {
        var on = o.dataset.cat === picked;
        o.classList.toggle("on", on);
        o.setAttribute("aria-checked", on ? "true" : "false");
      });
    }

    var settle;
    function finish(v) {
      opts.forEach(function (o) { o.removeEventListener("click", onPick); });
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      dlg.removeEventListener("close", onClose);
      if (dlg.open) dlg.close();
      settle(v);
    }
    function onPick(e) { e.preventDefault(); picked = this.dataset.cat; paint(); }
    function onOk(e) { e.preventDefault(); finish(picked); }
    function onCancel(e) { e.preventDefault(); finish(null); }
    function onClose() { finish(null); }          // covers Esc

    opts.forEach(function (o) { o.addEventListener("click", onPick); });
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    dlg.addEventListener("close", onClose);

    paint();
    dlg.showModal();
    return new Promise(function (resolve) { settle = resolve; });
  }

  function chipStatus(chip, msg, kind) {
    chip.classList.remove("chip-busy", "chip-err");
    if (kind === "busy") chip.classList.add("chip-busy");
    if (kind === "err") {
      chip.classList.add("chip-err");
      chip.title = msg;
      setTimeout(function () { chip.classList.remove("chip-err"); chip.title = ""; }, 4000);
    }
  }

  function recategorise(chip, cat) {
    var tag = chip.dataset.tag;
    if (!cat || cat === chip.dataset.cat) return;
    var from = chip.dataset.cat;
    chipStatus(chip, "", "busy");
    setTagCategory(tag, cat).then(function () {
      chipStatus(chip, "", null);
    }, function (err) {
      moveChip(tag, from);                       // put it back; the write failed
      chipStatus(chip, err.message, "err");
    });
  }

  /* ---------- drag a chip between the rows ---------- */

  function wireChipDnD() {
    document.addEventListener("dragstart", function (e) {
      var chip = e.target.closest && e.target.closest(".chip-bin");
      if (!chip) return;
      e.dataTransfer.setData("text/plain", chip.dataset.tag);
      e.dataTransfer.effectAllowed = "move";
      chip.classList.add("chip-dragging");
      document.body.classList.add("dragging-chip");
    });

    document.addEventListener("dragend", function (e) {
      var chip = e.target.closest && e.target.closest(".chip-bin");
      if (chip) chip.classList.remove("chip-dragging");
      document.body.classList.remove("dragging-chip");
      document.querySelectorAll(".filter-group").forEach(function (g) {
        g.classList.remove("drop-over");
      });
    });

    document.querySelectorAll(".filter-group").forEach(function (group) {
      group.addEventListener("dragover", function (e) {
        if (!document.body.classList.contains("dragging-chip")) return;
        e.preventDefault();                      // required to allow a drop
        e.dataTransfer.dropEffect = "move";
        group.classList.add("drop-over");
      });
      group.addEventListener("dragleave", function () {
        group.classList.remove("drop-over");
      });
      group.addEventListener("drop", function (e) {
        e.preventDefault();
        group.classList.remove("drop-over");
        var tag = e.dataTransfer.getData("text/plain");
        if (!tag) return;
        var chip = document.querySelector('.chip-bin[data-tag="' + CSS.escape(tag) + '"]');
        if (chip) recategorise(chip, group.dataset.cat);
      });
    });
  }

  /* ---------- bulk operations ---------- */

  function selStatus(msg, kind) {
    var el = document.getElementById("sel-status");
    if (el) { el.textContent = msg || ""; el.className = "status" + (kind ? " " + kind : ""); }
  }

  function selectedItems() {
    return selected.map(function (p) {
      return document.querySelector('.item[data-path="' + CSS.escape(p) + '"]');
    }).filter(Boolean);
  }

  // Runs one file at a time: the contents API is per-file and needs a fresh
  // sha for each write, and serialising keeps the failure report legible.
  function runOver(items, label, fn, onDone) {
    if (!getToken()) { openDialog(); return; }
    if (!items.length) return;

    var done = 0, failed = [];
    setBusy(true);

    function step(i) {
      if (i >= items.length) {
        setBusy(false);
        selStatus(label + ": " + done + " ok" +
          (failed.length ? ", " + failed.length + " failed — " + failed[0] : "") +
          " — live in ~1 min", failed.length ? "err" : "ok");
        if (onDone) onDone();
        return;
      }
      selStatus(label + " " + (i + 1) + "/" + items.length + "…");
      fn(items[i])
        .then(function () { done++; })
        .catch(function (e) { failed.push(items[i].dataset.path + ": " + e.message); })
        .then(function () { step(i + 1); });
    }
    step(0);
  }

  function eachSelected(label, fn) {
    runOver(selectedItems(), label, fn);
  }

  function setBusy(on) {
    ["sel-tag", "sel-untag", "sel-archive", "sel-delete"].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.disabled = on;
    });
  }

  function bulkAddTags() {
    if (!getToken()) { openDialog(); return; }
    var n = selected.length;
    openTagPicker({
      title: "Add tags",
      sub: "Applied to " + n + " page" + (n === 1 ? "" : "s") + ".",
      pool: allKnownTags(),
      allowNewCategory: true
    }).then(function (add) {
      if (!add || !add.length) return;
      // newCat rides along on the resolved array; it applies only to tags that
      // did not already exist, since an existing tag already has a category and
      // re-filing it here would move it for every page at once.
      var newCat = add.newCat === "meta" ? "meta" : "content";
      add.forEach(function (t) { ensureChip(t, newCat); });
      doAddTags(add);
    });
  }

  function doAddTags(add) {
    eachSelected("Tagged", function (it) {
      return ghGet(it.dataset.path).then(function (j) {
        var md = b64decode(j.content);
        var merged = uniqCI(getBin(md).concat(add));
        return ghPut(it.dataset.path, setBin(md, merged), j.sha,
          "Add tags [" + add.join(", ") + "]: " + it.dataset.path)
          .then(function () { renderBinTags(it, merged); });
      });
    });
  }

  function bulkRemoveTags() {
    if (!getToken()) { openDialog(); return; }
    var n = selected.length;
    // Offer only what the selection actually carries — you cannot remove a tag
    // that is not there.
    var onSelection = {};
    selectedItems().forEach(function (it) {
      listOf(it, "bin").forEach(function (t) { onSelection[t.toLowerCase()] = t; });
    });
    var pool = Object.keys(onSelection).map(function (k) { return onSelection[k]; }).sort();

    openTagPicker({
      title: "Remove tags",
      sub: "Removed from " + n + " page" + (n === 1 ? "" : "s") + ".",
      pool: pool
    }).then(function (picked) {
      if (!picked || !picked.length) return;
      doRemoveTags(picked.map(function (t) { return t.toLowerCase(); }));
    });
  }

  function doRemoveTags(drop) {
    eachSelected("Untagged", function (it) {
      return ghGet(it.dataset.path).then(function (j) {
        var md = b64decode(j.content);
        var kept = getBin(md).filter(function (t) { return drop.indexOf(t.toLowerCase()) === -1; });
        return ghPut(it.dataset.path, setBin(md, kept), j.sha,
          "Remove tags: " + it.dataset.path)
          .then(function () { renderBinTags(it, kept); });
      });
    });
  }

  /* ---------- archive ----------
   * With tag chips active this deliberately acts on every page carrying those
   * tags, not just the selected ones — archiving a tag should retire the whole
   * tag, and the chip then disappears on its own because no live page has it.
   */

  function archiveTargets() {
    if (activeBin.length || activeAuto.length) {
      return Array.prototype.filter.call(document.querySelectorAll(".item"), function (it) {
        return !it.hidden;
      });
    }
    return selectedItems();
  }

  function bulkArchive(on) {
    var items = archiveTargets();
    if (!items.length) return;

    var byTag = activeBin.length ? ' carrying [' + activeBin.join(", ") + ']' : "";
    var verb = on ? "Archive" : "Restore";
    if (!confirm(verb + " " + items.length + " page(s)" + byTag + "?\n\n" +
                 (on ? "They stay in the repo and keep working URLs, but drop out of the "
                     + "main view — and any tag left with no live pages disappears with them."
                     : "They return to the main view."))) return;

    // eachSelected walks the selection; archive may act on a filtered set, so
    // drive the same machinery over an explicit list instead.
    runOver(items, on ? "Archived" : "Restored", function (it) {
      return ghGet(it.dataset.path).then(function (j) {
        var md = b64decode(j.content);
        return ghPut(it.dataset.path, setArchived(md, on), j.sha,
          (on ? "Archive: " : "Restore: ") + it.dataset.path)
          .then(function () {
            it.dataset.archived = on ? "true" : "false";
          });
      });
    }, function () {
      clearSelection();
      applyFilter();
    });
  }

  function bulkDelete() {
    var n = selected.length;
    var titles = selectedItems().slice(0, 5).map(function (it) {
      return "• " + it.querySelector(".item-title").textContent.trim();
    }).join("\n");
    if (!confirm("Delete " + n + " page(s) from the repo?\n\n" + titles +
                 (n > 5 ? "\n…and " + (n - 5) + " more" : "") +
                 "\n\nThis removes the markdown file. Git history keeps a copy, " +
                 "but the hosted media is not touched.")) return;

    eachSelected("Deleted", function (it) {
      return ghGet(it.dataset.path).then(function (j) {
        return ghDelete(it.dataset.path, j.sha, "Delete page: " + it.dataset.path)
          .then(function () { it.remove(); });
      });
    });
  }

  /* ---------- notes editor ---------- */

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
    if (!editor || !editBtn) return;
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
      }).catch(function (e) { setStatus(status, e.message, "err"); });
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
      // Re-read immediately before writing so a stale sha cannot clobber an
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
      }).then(function () { saveBtn.disabled = false; });
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

      var clr = dlg.querySelector("#token-clear");
      if (clr) clr.addEventListener("click", function (e) {
        e.preventDefault();
        signOut();
        dlg.querySelector("#token-input").value = "";
        dlg.close();
      });
    }

    reflectAuth();
    refreshIdentity();
    if (pendingNotice) openDialog();

    paintTags();

    document.querySelectorAll(".js-view").forEach(function (b) {
      b.addEventListener("click", function () { setView(b.dataset.view); });
    });
    setView(localStorage.getItem(VIEW_KEY) === "details" ? "details" : "cards");

    // Ctrl/Cmd-click edits the chip's category instead of filtering by it —
    // the same modifier that selects a card, rather than a new gesture to learn.
    document.querySelectorAll(".chip").forEach(function (c) {
      if (c.classList.contains("chip-bin")) {
        c.title = "Click to filter · Alt-click to hide · Ctrl-click to change category";
      }
      c.addEventListener("click", function (e) {
        if (e.altKey && c.classList.contains("chip-bin")) {
          e.preventDefault();
          e.stopPropagation();
          toggleExclude(c);
          return;
        }
        if ((e.ctrlKey || e.metaKey) && c.classList.contains("chip-bin")) {
          e.preventDefault();
          e.stopPropagation();
          if (!getToken()) { openDialog(); return; }
          openCatDialog(c.dataset.tag, c.dataset.cat).then(function (cat) {
            if (cat) recategorise(c, cat);
          });
          return;
        }
        toggleChip(c);
      });
    });

    applyPendingCategories();
    wireChipDnD();

    // Tags listed under hidden_by_default in _data/tag_meta.yml start excluded,
    // as though they had been alt-clicked: a working queue like "To Respond"
    // would otherwise crowd out everything else on arrival. The chip still shows
    // in its excluded style and Clear filters is offered from the start, so the
    // shorter library explains itself rather than looking like pages went
    // missing. Clearing brings them back for the session; a reload re-applies it.
    document.querySelectorAll('.chip-bin[data-hide-default="true"]').forEach(function (c) {
      if (excludedBin.indexOf(c.dataset.tag) === -1) {
        excludedBin.push(c.dataset.tag);
        c.classList.add("chip-excluded");
      }
    });
    var cf = document.getElementById("clear-filters");
    if (cf) cf.addEventListener("click", clearFilters);

    var search = document.getElementById("search");
    if (search) search.addEventListener("input", applyFilter);

    var grid = document.getElementById("grid");
    if (grid) grid.addEventListener("click", onItemClick);

    var at = document.getElementById("archive-toggle");
    if (at) at.addEventListener("click", function () {
      archiveMode = !archiveMode;
      document.body.classList.toggle("archive-mode", archiveMode);
      at.textContent = archiveMode ? "Leave archive" : "Archive";
      at.classList.toggle("active", archiveMode);
      var sa = document.getElementById("sel-archive");
      if (sa) sa.textContent = archiveMode ? "Restore…" : "Archive…";
      clearSelection();
      applyFilter();
    });

    var m = { "sel-tag": bulkAddTags, "sel-untag": bulkRemoveTags,
              "sel-archive": function () { bulkArchive(!archiveMode); },
              "sel-delete": bulkDelete, "sel-clear": clearSelection };
    Object.keys(m).forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.addEventListener("click", m[id]);
    });

    document.querySelectorAll("[data-path]").forEach(wireEditor);
    applyFilter();
  });
})();
