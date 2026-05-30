/**
 * Inline CSS + JS payloads for the HTML report. Kept as plain strings
 * rather than a template engine so the renderer remains zero-dependency
 * and `report.html` is fully self-contained (no external assets, no
 * remote fonts, no CDN). The CSP meta tag in {@link renderHtmlReport}
 * pins `default-src 'none'` and only allows inline style/script, which
 * proves the file cannot reach the network at view time.
 */

export const CSS_INLINE = `
:root {
  --bg: #fafafa;
  --bg-elev: #ffffff;
  --bg-soft: #f1f3f5;
  --fg: #1a1a1a;
  --fg-muted: #5a5f66;
  --fg-subtle: #8a8f96;
  --border: #e1e4e8;
  --border-strong: #c2c8cf;
  --accent: #0b5fff;
  --accent-soft: #e7efff;
  --prio-high: #d23a3a;
  --prio-medium: #d2962e;
  --prio-low: #8a8a8a;
  --conf-high: #2e7d4f;
  --conf-medium: #d2962e;
  --conf-low: #8a8a8a;
  --hyp-border: #5a6fd2;
  --fact-border: #c2c8cf;
  --dropped: #c0392b;
  --code-bg: #f1f3f5;
  --shadow: 0 1px 2px rgba(0,0,0,0.04);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15171a;
    --bg-elev: #1c1f23;
    --bg-soft: #23272d;
    --fg: #e8ebef;
    --fg-muted: #a8aeb6;
    --fg-subtle: #777d85;
    --border: #2c3138;
    --border-strong: #3a4049;
    --accent: #4d8aff;
    --accent-soft: #1a2742;
    --prio-high: #e25757;
    --prio-medium: #e0a64a;
    --prio-low: #9a9da3;
    --conf-high: #4cae75;
    --conf-medium: #e0a64a;
    --conf-low: #9a9da3;
    --hyp-border: #7c8bd9;
    --fact-border: #3a4049;
    --dropped: #e25757;
    --code-bg: #23272d;
    --shadow: 0 1px 2px rgba(0,0,0,0.25);
  }
}

html[data-theme="light"] {
  --bg: #fafafa;
  --bg-elev: #ffffff;
  --bg-soft: #f1f3f5;
  --fg: #1a1a1a;
  --fg-muted: #5a5f66;
  --fg-subtle: #8a8f96;
  --border: #e1e4e8;
  --border-strong: #c2c8cf;
  --accent: #0b5fff;
  --accent-soft: #e7efff;
  --prio-high: #d23a3a;
  --prio-medium: #d2962e;
  --prio-low: #8a8a8a;
  --conf-high: #2e7d4f;
  --conf-medium: #d2962e;
  --conf-low: #8a8a8a;
  --hyp-border: #5a6fd2;
  --fact-border: #c2c8cf;
  --dropped: #c0392b;
  --code-bg: #f1f3f5;
  --shadow: 0 1px 2px rgba(0,0,0,0.04);
}

html[data-theme="dark"] {
  --bg: #15171a;
  --bg-elev: #1c1f23;
  --bg-soft: #23272d;
  --fg: #e8ebef;
  --fg-muted: #a8aeb6;
  --fg-subtle: #777d85;
  --border: #2c3138;
  --border-strong: #3a4049;
  --accent: #4d8aff;
  --accent-soft: #1a2742;
  --prio-high: #e25757;
  --prio-medium: #e0a64a;
  --prio-low: #9a9da3;
  --conf-high: #4cae75;
  --conf-medium: #e0a64a;
  --conf-low: #9a9da3;
  --hyp-border: #7c8bd9;
  --fact-border: #3a4049;
  --dropped: #e25757;
  --code-bg: #23272d;
  --shadow: 0 1px 2px rgba(0,0,0,0.25);
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Helvetica Neue", sans-serif;
  font-size: 15px;
  line-height: 1.55;
}

code, kbd, samp, pre, .mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.92em;
}

code {
  background: var(--code-bg);
  border-radius: 3px;
  padding: 1px 5px;
}

.layout {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  max-width: 1320px;
  margin: 0 auto;
  gap: 32px;
  padding: 24px;
}

.toc {
  position: sticky;
  top: 24px;
  align-self: start;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  padding: 16px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
}

.toc h2 {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--fg-subtle);
  margin: 0 0 10px 0;
}

.toc ol {
  list-style: none;
  margin: 0;
  padding: 0;
}

.toc li { margin: 4px 0; }

.toc a {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--fg);
  text-decoration: none;
  padding: 4px 6px;
  border-radius: 4px;
}

.toc a:hover { background: var(--bg-soft); color: var(--accent); }

.toc .count {
  color: var(--fg-subtle);
  font-variant-numeric: tabular-nums;
}

.main {
  max-width: 1040px;
  min-width: 0;
}

.toolbar {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 100;
  display: flex;
  gap: 8px;
}

.btn {
  background: var(--bg-elev);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 5px 10px;
  font-size: 13px;
  cursor: pointer;
  box-shadow: var(--shadow);
}

.btn:hover { border-color: var(--accent); color: var(--accent); }

h1 {
  font-size: 26px;
  font-weight: 600;
  margin: 0 0 8px 0;
}

h2 {
  font-size: 18px;
  font-weight: 600;
  margin: 28px 0 12px 0;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
  letter-spacing: 0.01em;
}

h3 {
  font-size: 15px;
  font-weight: 600;
  margin: 14px 0 8px 0;
}

p { margin: 8px 0; }

.scope-grid {
  display: grid;
  grid-template-columns: minmax(160px, 200px) 1fr;
  gap: 6px 16px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 14px 16px;
  font-size: 14px;
}

.scope-grid .k {
  color: var(--fg-muted);
  font-weight: 600;
}
.scope-grid .v { word-break: break-word; }

.note {
  color: var(--fg-muted);
  font-style: italic;
  font-size: 14px;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
  margin: 10px 0;
}

.stat {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 14px;
  box-shadow: var(--shadow);
}
.stat .label {
  font-size: 11px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--fg-subtle);
}
.stat .value {
  font-size: 22px;
  font-weight: 600;
  margin-top: 2px;
}
.stat .value-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  margin-top: 4px;
  color: var(--fg-muted);
  word-break: break-all;
}

.bars {
  list-style: none;
  padding: 0;
  margin: 8px 0;
}
.bar {
  display: grid;
  grid-template-columns: minmax(180px, 240px) 1fr auto;
  gap: 12px;
  align-items: center;
  padding: 4px 0;
}
.bar__label {
  color: var(--fg);
  font-size: 13px;
  word-break: break-word;
}
.bar__bar {
  position: relative;
  height: 10px;
  background: var(--bg-soft);
  border-radius: 5px;
  overflow: hidden;
}
.bar__bar::before {
  content: "";
  position: absolute;
  inset: 0;
  width: var(--w, 0%);
  background: var(--accent);
  opacity: 0.85;
  border-radius: 5px;
}
.bar__value {
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--fg-muted);
}

.badge {
  display: inline-block;
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 10px;
  font-weight: 600;
  vertical-align: middle;
}
.badge--prio-high { background: var(--prio-high); color: #fff; }
.badge--prio-medium { background: var(--prio-medium); color: #fff; }
.badge--prio-low { background: var(--prio-low); color: #fff; }
.badge--conf-high { background: var(--conf-high); color: #fff; }
.badge--conf-medium { background: var(--conf-medium); color: #fff; }
.badge--conf-low { background: var(--conf-low); color: #fff; }
.badge--dropped { background: var(--dropped); color: #fff; }
.badge--impact {
  background: var(--bg-soft);
  color: var(--fg-muted);
  text-transform: none;
  letter-spacing: 0.02em;
}

.rec, .hyp, .fact, .dq {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-left: 4px solid var(--border-strong);
  border-radius: 4px;
  padding: 14px 16px;
  margin: 12px 0;
  box-shadow: var(--shadow);
}

.rec:target, .hyp:target, .fact:target, .dq:target {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  transition: outline 0.2s;
}

.rec--high { border-left-color: var(--prio-high); }
.rec--medium { border-left-color: var(--prio-medium); }
.rec--low { border-left-color: var(--prio-low); }

.hyp--high { border-left-color: var(--hyp-border); }
.hyp--medium { border-left-color: var(--hyp-border); opacity: 0.95; }
.hyp--low { border-left-color: var(--hyp-border); opacity: 0.85; }

.fact { border-left-color: var(--fact-border); }

.card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.card-head .title {
  font-weight: 600;
  font-size: 14px;
}
.card-head .sig {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  color: var(--fg-subtle);
}

.statement {
  font-size: 15px;
  line-height: 1.5;
  margin: 6px 0 12px 0;
}

.dims {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin: 8px 0;
}
.dim {
  background: var(--bg-soft);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 12px;
}
.dim .dim-label {
  font-size: 10.5px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--fg-subtle);
}
.dim .dim-value { font-weight: 600; }
.dim--strong { background: rgba(46, 125, 79, 0.13); }
.dim--mixed  { background: rgba(210, 150, 46, 0.15); }
.dim--weak   { background: rgba(210, 58, 58, 0.12); }

.subsec {
  margin: 10px 0 4px 0;
}
.subsec h4 {
  font-size: 12px;
  font-weight: 600;
  margin: 8px 0 4px 0;
  color: var(--fg-muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.subsec ul {
  margin: 4px 0;
  padding-left: 20px;
}
.subsec li { margin: 2px 0; }

.evidence-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 4px 0;
}
.evidence-chip {
  background: var(--bg-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  padding: 2px 6px;
  border-radius: 3px;
  color: var(--fg-muted);
}

.backlinks {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
  font-size: 12px;
  color: var(--fg-muted);
}
.backlinks a {
  color: var(--fg-muted);
  text-decoration: none;
  border-bottom: 1px dotted var(--fg-subtle);
}
.backlinks a:hover { color: var(--accent); border-bottom-color: var(--accent); }

a.citation {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px dotted var(--accent);
}
a.citation:hover { background: var(--accent-soft); }

.copy-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--fg-subtle);
  border-radius: 3px;
  padding: 0 5px;
  font-size: 10px;
  cursor: pointer;
  margin-left: 4px;
}
.copy-btn:hover { color: var(--accent); border-color: var(--accent); }

.filter-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 0 14px 0;
}
.filter-row input {
  flex: 1;
  background: var(--bg-elev);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 13px;
  font-family: inherit;
}
.filter-row input:focus { outline: none; border-color: var(--accent); }
.filter-row .match-count { font-size: 12px; color: var(--fg-muted); }

.dropped {
  opacity: 0.65;
  border-left-style: dotted !important;
  border-left-color: var(--dropped) !important;
}
.dropped .statement { font-style: italic; }

.cleanup-group {
  margin: 10px 0;
}
.cleanup-group summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--fg-muted);
  padding: 6px 0;
}

.sparkline {
  display: block;
  margin: 12px 0;
  max-width: 100%;
  height: auto;
}
.sparkline path { fill: none; stroke: var(--accent); stroke-width: 1.5; }

.mobile-toc {
  display: none;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 12px;
}
.mobile-toc summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
}
.mobile-toc ol {
  list-style: none;
  padding: 6px 0 0 0;
  margin: 0;
}
.mobile-toc a {
  color: var(--fg);
  text-decoration: none;
  display: block;
  padding: 3px 0;
}

@media (max-width: 800px) {
  .layout { grid-template-columns: 1fr; padding: 16px; }
  .toc { display: none; }
  .mobile-toc { display: block; }
  .dims { grid-template-columns: 1fr; }
  .bar { grid-template-columns: minmax(120px, 160px) 1fr auto; }
  h1 { font-size: 22px; }
}

.copied-flash { color: var(--conf-high) !important; }
`;

export const JS_INLINE = `
(function () {
  // Theme toggle with localStorage persistence. Defaults to the prefers-
  // color-scheme media query when no preference has been stored.
  var STORAGE_KEY = "azpixiu-theme";
  var root = document.documentElement;
  var stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch (e) {}
  if (stored === "light" || stored === "dark") {
    root.setAttribute("data-theme", stored);
  }
  var toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var current = root.getAttribute("data-theme");
      if (!current) {
        var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
        current = prefersDark ? "dark" : "light";
      }
      var next = current === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
      toggle.textContent = next === "dark" ? "☀️ Light" : "🌙 Dark";
    });
  }

  // Click-to-copy on every .copy-btn — falls back to the textContent of the
  // preceding sibling. navigator.clipboard is unavailable on file:// in
  // some browsers; selection-based copy works there.
  function flash(btn) {
    var original = btn.textContent;
    btn.textContent = "copied";
    btn.classList.add("copied-flash");
    setTimeout(function () {
      btn.textContent = original;
      btn.classList.remove("copied-flash");
    }, 900);
  }
  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var target = btn.previousElementSibling;
      var text = btn.getAttribute("data-copy") || (target && target.textContent) || "";
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { flash(btn); }, function () { flash(btn); });
      } else {
        try {
          var ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          flash(btn);
        } catch (e) {}
      }
    });
  });

  // Recommendation filter — case-insensitive substring on statement / id / signature.
  var input = document.getElementById("rec-filter");
  var counter = document.getElementById("rec-match-count");
  if (input) {
    input.addEventListener("input", function () {
      var q = input.value.trim().toLowerCase();
      var cards = document.querySelectorAll("article.rec");
      var matched = 0;
      cards.forEach(function (card) {
        if (!q) {
          card.style.display = "";
          matched++;
          return;
        }
        var hay = (card.getAttribute("data-search") || "").toLowerCase();
        if (hay.indexOf(q) !== -1) {
          card.style.display = "";
          matched++;
        } else {
          card.style.display = "none";
        }
      });
      if (counter) counter.textContent = q ? matched + " match(es)" : "";
    });
  }
})();
`;
