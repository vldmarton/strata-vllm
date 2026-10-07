/* Strata for vLLM — frontend. Polls /api/metrics every second. No framework. */
"use strict";

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 1000;
const SPARK_W = 200, SPARK_H = 32;

/* ---------------------------------------------------------- formatting */
/* European style: 50,4 · 17.183 (comma decimal, dot thousands) */
function fmt(v, dec = 0) {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  const s = v.toLocaleString("sk-SK", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return s.replace(/'/g, "");
}
function fmtGB(bytes) { return bytes ? (bytes / 2 ** 30) : null; }
function fmtDur(s) {
  if (s === null || s === undefined) return "–";
  return s >= 60 ? fmt(s, 1) + " s" : fmt(s, 1) + " s";
}

/* ------------------------------------------------------------- theme */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("strata-theme", t); } catch {}
  $("theme-icon").setAttribute("href", "sprite.svg#" + (t === "dark" ? "i-sun" : "i-moon"));
}
applyTheme((() => { try { return localStorage.getItem("strata-theme") || "dark"; } catch { return "dark"; } })());
$("theme-btn").addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

/* --------------------------------------------------------------- tabs */
document.querySelectorAll(".st-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".st-tab").forEach((t) => t.setAttribute("aria-selected", "false"));
    tab.setAttribute("aria-selected", "true");
    const v = tab.dataset.view;
    $("view-monitor").hidden = v !== "monitor";
    $("view-about").hidden = v !== "about";
  });
});

/* ------------------------------------------------------------- toasts */
function toast(kind, title, body) {
  const icon = { info: "i-info", success: "i-check", warn: "i-warning", error: "i-error" }[kind] || "i-info";
  const el = document.createElement("div");
  el.className = `st-toast st-toast--${kind}`;
  el.innerHTML = `<svg class="st-icon"><use href="sprite.svg#${icon}"/></svg>
    <div><div class="st-toast__title">${title}</div>${body ? `<div class="muted small">${body}</div>` : ""}</div>`;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/* ----------------------------------------------------------- sparklines */
function sparkline(el, values, { max, tone } = {}) {
  const pts = (values || []).filter((v) => v !== null && v !== undefined);
  if (pts.length < 2) { el.innerHTML = ""; return; }
  const hi = max !== undefined ? max : Math.max(...pts);
  const lo = 0;
  const range = hi - lo || 1;
  const n = (values || []).length;
  const step = SPARK_W / Math.max(n - 1, 1);
  let d = "";
  (values || []).forEach((v, i) => {
    if (v === null || v === undefined) return;
    const x = (i * step).toFixed(1);
    const y = (SPARK_H - 2 - ((v - lo) / range) * (SPARK_H - 6)).toFixed(1);
    d += (d ? " L" : "M") + x + " " + y;
  });
  if (!d) { el.innerHTML = ""; return; }
  const area = d + ` L${SPARK_W} ${SPARK_H} L0 ${SPARK_H} Z`;
  el.innerHTML = `<svg class="st-metric__spark" data-tone="${tone || ""}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none">
    <path d="${area}" fill="currentColor" opacity="0.12"></path>
    <path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"></path>
  </svg>`;
}

/* -------------------------------------------------------------- gauge */
function gauge(el, pct) {
  if (pct === null || pct === undefined) { pct = 0; }
  pct = Math.max(0, Math.min(1, pct));
  const R = 56, C = 2 * Math.PI * R;
  el.innerHTML = `<svg class="st-gauge" viewBox="0 0 130 130">
    <circle class="st-gauge__track" cx="65" cy="65" r="${R}" fill="none" stroke-width="10"></circle>
    <circle class="st-gauge__fill" cx="65" cy="65" r="${R}" fill="none" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="${(C * pct).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 65 65)"></circle>
  </svg>`;
}

/* ---------------------------------------------------------- state UI */
const STATE_LABEL = {
  idle: "Idle", reading: "Reading prompt", generating: "Generating", queued: "Queued", error: "Error",
};
function renderState(d) {
  const st = d.state || "idle";
  $("pill").dataset.state = st;
  $("pill-text").textContent = STATE_LABEL[st] || st;
  document.querySelectorAll("#state-badges .st-badge").forEach((b) =>
    b.classList.toggle("on", b.dataset.state === st));
  $("state-label").textContent = STATE_LABEL[st] || st;
  $("state-detail").textContent = d.detail || "—";
  $("state-nums").textContent = "";
  const bar = $("state-bar");
  if (st === "reading" && d.kv !== null && d.kv !== undefined && d.model && d.model.max_ctx) {
    bar.hidden = false;
    const used = d.ctx_used || 0;
    $("state-bar-fill").style.width = Math.min(100, (used / d.model.max_ctx) * 100) + "%";
    $("state-nums").textContent = `${fmt(used)} / ${fmt(d.model.max_ctx)} tokens · ${Math.round((used / d.model.max_ctx) * 100)}%`;
  } else {
    bar.hidden = true;
  }
}

/* ----------------------------------------------------------- metrics */
function renderMetrics(d) {
  const g = d.gpu || {}, h = d.host || {};

  $("m-speed").innerHTML = fmt(d.speed, 1) + `<span class="st-metric__unit">tok/s</span>`;
  $("m-speed-sub").textContent = d.speed_kind === "prefill" ? "prefill" : d.speed_kind === "decode" ? "decode" : "last request";

  $("m-gpu").innerHTML = fmt(g.util) + `<span class="st-metric__unit">%</span>`;
  $("m-gpu-sub").textContent = (g.name || "no GPU") + (g.count > 1 ? ` · ${g.count} GPUs` : "");

  const vramUsed = fmtGB(g.mem_used), vramTot = fmtGB(g.mem_total);
  $("m-vram").innerHTML = fmt(vramUsed, 1) + (vramTot ? `<span class="st-metric__unit">/ ${fmt(vramTot, 0)} GB</span>` : "");
  $("m-vram-sub").textContent = d.prefix && d.prefix.queries ? `${fmt(d.prefix.hits)} prefix hits` : "—";
  if (vramUsed && vramTot) $("m-vram-bar").style.width = Math.min(100, (vramUsed / vramTot) * 100) + "%";

  $("m-temp").innerHTML = fmt(g.temp) + `<span class="st-metric__unit">°C</span>`;
  $("m-power").innerHTML = fmt(g.power) + `<span class="st-metric__unit">W</span>`;
  $("m-power-sub").textContent = g.power_limit ? `of ${fmt(g.power_limit, 0)} W limit` : "—";

  const gen = g.pcie_gen ? "Gen" + g.pcie_gen : "–";
  $("m-pcie").innerHTML = gen + (g.pcie_width ? `<span class="st-metric__unit">x${g.pcie_width}</span>` : "");
  $("m-pcie-sub").textContent = g.pcie_mb !== null && g.pcie_mb !== undefined ? `to GPU ${fmt(g.pcie_mb, 2)} MB/s` : "—";

  $("m-cpu").innerHTML = fmt(h.cpu) + `<span class="st-metric__unit">%</span>`;
  $("m-cpu-sub").textContent = h.cores ? `${h.cores} cores · ${h.threads} threads` : "—";

  $("m-disk").innerHTML = fmt(h.disk_read, 1) + `<span class="st-metric__unit">MB/s</span>`;
  $("m-disk-sub").textContent = h.disk_write !== null && h.disk_write !== undefined ? `write ${fmt(h.disk_write, 1)} MB/s` : "—";

  /* sparklines (60 s of 1 Hz samples) */
  const H = d.history || {};
  sparkline($("s-speed"), H.tok_s, {});
  sparkline($("s-gpu"), H.gpu, { max: 100 });
  sparkline($("s-temp"), H.temp, {});
  sparkline($("s-power"), H.power, {});
  sparkline($("s-pcie"), H.pcie, {});
  sparkline($("s-cpu"), H.cpu, { max: 100 });
  sparkline($("s-disk"), H.disk, {});

  /* context panel */
  const kv = d.kv, ctx = d.model && d.model.max_ctx;
  gauge($("ctx-gauge"), kv);
  $("ctx-pct").textContent = kv === null || kv === undefined ? "–" : Math.round(kv * 100) + "%";
  $("ctx-range").textContent = ctx ? `${fmt(Math.round((d.ctx_used || 0) / 1000))}k / ${fmt(Math.round(ctx / 1000))}K` : "";

  const ramU = fmtGB(h.ram_used), ramT = fmtGB(h.ram_total);
  $("ctx-ram-nums").textContent = ramU ? `${fmt(ramU, 1)} / ${fmt(ramT, 0)} GB` : "–";
  if (ramU && ramT) $("ctx-ram-bar").style.width = Math.min(100, (ramU / ramT) * 100) + "%";

  $("ctx-temp-nums").textContent = g.temp !== undefined ? `${fmt(g.temp)} °C` : "–";
  if (g.temp !== undefined) $("ctx-temp-bar").style.width = Math.min(100, (g.temp / 100) * 100) + "%";

  const pr = d.prefix && d.prefix.rate;
  $("ctx-pfx-nums").textContent = pr === null || pr === undefined ? "–" : `${fmt(pr * 100, 0)}% reuse`;
  if (pr !== null && pr !== undefined) $("ctx-pfx-bar").style.width = Math.min(100, pr * 100) + "%";

  /* requests table */
  const rows = d.requests || [];
  const tbody = $("req-rows");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">Waiting for requests…</td></tr>`;
    $("req-totals").textContent = "";
  } else {
    tbody.innerHTML = rows.map((r) => {
      const t = new Date(r.time * 1000);
      const hh = String(t.getHours()).padStart(2, "0");
      const mm = String(t.getMinutes()).padStart(2, "0");
      const ss = String(t.getSeconds()).padStart(2, "0");
      return `<tr>
        <td>${hh}:${mm}:${ss}</td>
        <td><span class="st-badge">Done</span></td>
        <td class="num">${fmt(r.prompt)}</td>
        <td class="num">${r.reused ? fmt(r.reused) : "0"}</td>
        <td class="num">${fmt(r.output)}</td>
        <td class="num">${r.tok_s ? fmt(r.tok_s, 1) : "–"}</td>
        <td class="num">${fmt(r.duration, 1)} s</td>
      </tr>`;
    }).join("");
    const totOut = rows.reduce((a, r) => a + r.output, 0);
    $("req-totals").textContent = `${rows.length} shown · ${fmt(totOut)} tokens`;
  }

  /* about tab facts */
  $("about-model").textContent = (d.model && d.model.id) || "—";
  $("about-version").textContent = (d.model && d.model.version) || "—";
}

/* ------------------------------------------------------------- polling */
async function poll() {
  let d;
  try {
    const r = await fetch("/api/metrics", { cache: "no-store" });
    d = await r.json();
  } catch {
    $("pill").dataset.state = "error";
    $("pill-text").textContent = "Offline";
    return;
  }
  if (d.state === "no_backend") {
    $("no-backend").hidden = false;
    $("metrics").style.display = "none";
    document.querySelector(".monitor-row").style.display = "none";
    $("state-detail").textContent = "No backend configured yet.";
    return;
  }
  $("no-backend").hidden = true;
  $("metrics").style.display = "";
  document.querySelector(".monitor-row").style.display = "";
  if (d.state === "error") {
    $("pill").dataset.state = "error";
    $("pill-text").textContent = "Error";
    renderState({ state: "error", detail: d.error || "backend unreachable" });
    return;
  }
  renderState(d);
  renderMetrics(d);
}
setInterval(poll, REFRESH_MS);
poll();

/* ----------------------------------------------------------- settings */
function openDrawer(open) {
  $("drawer").dataset.open = open ? "true" : "false";
  $("scrim").hidden = !open;
  if (open) {
    fetch("/api/settings").then((r) => r.json()).then((s) => {
      $("set-backend").value = s.backend || "";
      $("set-key").value = "";
      $("set-key").placeholder = s.has_key ? "saved — leave blank to keep" : "sent as Bearer token";
      $("set-backend").focus();
    });
  }
}
$("settings-btn").addEventListener("click", () => openDrawer(true));
$("no-backend-btn").addEventListener("click", () => openDrawer(true));
$("drawer-close").addEventListener("click", () => openDrawer(false));
$("scrim").addEventListener("click", () => openDrawer(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") openDrawer(false); });

$("set-save").addEventListener("click", async () => {
  const backend = $("set-backend").value.trim();
  const key = $("set-key").value;
  const body = { backend };
  if (key) body.key = key;
  try {
    const r = await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("save failed");
    openDrawer(false);
    toast("success", "Backend saved", backend || "cleared");
    poll();
  } catch (e) {
    toast("error", "Could not save settings", String(e));
  }
});

$("set-clear").addEventListener("click", async () => {
  await fetch("/api/settings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend: "", key: "" }),
  });
  $("set-backend").value = "";
  $("set-key").value = "";
  openDrawer(false);
  toast("info", "Backend cleared");
  poll();
});
