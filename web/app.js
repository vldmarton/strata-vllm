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
const VIEWS = ["chat", "monitor", "about"];
document.querySelectorAll(".st-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".st-tab").forEach((t) => t.setAttribute("aria-selected", "false"));
    tab.setAttribute("aria-selected", "true");
    const v = tab.dataset.view;
    for (const name of VIEWS) $("view-" + name).hidden = v !== name;
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
  if ((st === "generating" || st === "reading") && d.kv !== null && d.kv !== undefined && d.model && d.model.max_ctx) {
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
  const gs = d.gpus || [];
  const multi = gs.length > 1;
  const per = (f) => gs.map((x) => `GPU ${x.index} ${f(x)}`).join(" · ");

  $("m-speed").innerHTML = fmt(d.speed, 1) + `<span class="st-metric__unit">tok/s</span>`;
  $("m-speed-sub").textContent = d.speed_kind === "prefill" ? "prefill" : d.speed_kind === "decode" ? "decode" : "last request";

  $("m-gpu").innerHTML = fmt(g.util) + `<span class="st-metric__unit">%</span>`;
  $("m-gpu-sub").textContent = multi
    ? per((x) => (x.util == null ? "–" : `${fmt(x.util)}%`))
    : (g.name || "no GPU");

  const vramUsed = fmtGB(g.mem_used), vramTot = fmtGB(g.mem_total);
  $("m-vram").innerHTML = fmt(vramUsed, 1) + (vramTot ? `<span class="st-metric__unit">/ ${fmt(vramTot, 0)} GB</span>` : "");
  const pfx = d.prefix;
  $("m-vram-sub").textContent = multi
    ? per((x) => (x.mem_used == null ? "–" : `${fmt(fmtGB(x.mem_used), 1)} GB`))
    : ((pfx && pfx.rate !== null && pfx.rate !== undefined) ? `${fmt(pfx.rate * 100, 0)}% prefix cache reuse` : "—");
  if (vramUsed && vramTot) $("m-vram-bar").style.width = Math.min(100, (vramUsed / vramTot) * 100) + "%";

  $("m-temp").innerHTML = fmt(g.temp) + `<span class="st-metric__unit">°C</span>`;
  $("m-temp-sub").textContent = multi ? per((x) => (x.temp == null ? "–" : `${fmt(x.temp)}°C`)) : "";
  $("m-power").innerHTML = fmt(g.power) + `<span class="st-metric__unit">W</span>`;
  $("m-power-sub").textContent = multi
    ? per((x) => (x.power == null ? "–" : `${fmt(x.power)} W`))
    : (g.power_limit ? `of ${fmt(g.power_limit, 0)} W limit` : "—");

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

/* ================================================================ chat */
const CHAT_KEY = "strata-chat";
const SAMPLE_KEY = "strata-sampling";
const SAMPLE_DEFAULTS = { temperature: 0.6, top_p: 0.95, max_tokens: "" };
let sampling = { ...SAMPLE_DEFAULTS, ...storeGet(SAMPLE_KEY) };
let messages = storeGet(CHAT_KEY, []);
let busy = null;                 // {controller, msg}

function storeGet(k, d) {
  try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; }
}
function storeSet(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ------------------------------------------------------- markdown (mini) */
function mdInline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code class="inline">${esc(codes[+i])}</code>`);
}
function mdBlock(lang, code) {
  return `<div class="st-code"><div class="st-code__head"><span>${esc(lang || "code")}</span>` +
    `<button class="st-btn st-btn--icon" data-code-copy aria-label="Copy code">` +
    `<svg class="st-icon st-icon--sm"><use href="sprite.svg#i-copy"/></svg></button></div>` +
    `<pre><code>${esc(code)}</code></pre></div>`;
}
function mdBlocks(text) {
  const out = [], lines = text.split("\n");
  let para = [], list = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(mdInline).join("<br>")}</p>`); para = []; } };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${mdInline(i)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (!l.trim()) { flushPara(); flushList(); continue; }
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara(); flushList();
      const t = m[1].length <= 2 ? "h3" : "h4";
      out.push(`<${t}>${mdInline(m[2])}</${t}>`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { flushPara(); flushList(); out.push("<hr>"); continue; }
    if ((m = l.match(/^>\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${mdInline(m[1])}</blockquote>`); continue; }
    if ((m = l.match(/^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/))) {
      flushPara();
      const tag = m[1] ? "ol" : "ul";
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(l)) { list.items[list.items.length - 1] += " " + l.trim(); continue; }
    flushList();
    para.push(l);
  }
  flushPara(); flushList();
  return out.join("");
}
function markdown(text) {
  let html = "", rest = text;
  for (;;) {
    const m = rest.match(/(^|\n)```([^\n`]*)\n/);
    if (!m) { html += mdBlocks(rest); break; }
    html += mdBlocks(rest.slice(0, m.index));
    rest = rest.slice(m.index + m[0].length);
    const end = rest.match(/(^|\n)```\s*(\n|$)/);
    if (!end) { html += mdBlock(m[2].trim(), rest); break; }      // still streaming
    html += mdBlock(m[2].trim(), rest.slice(0, end.index));
    rest = rest.slice(end.index + end[0].length);
  }
  return html;
}

/* ------------------------------------------------------------ messages */
function msgEl(m) {
  const el = document.createElement("div");
  el.className = `st-msg st-msg--${m.role}`;
  if (m.role === "user") {
    const b = document.createElement("div");
    b.className = "st-bubble";
    b.textContent = m.text;
    el.appendChild(b);
  } else {
    el.innerHTML = `<details class="st-collapse think" hidden>
        <summary><svg class="st-icon st-icon--sm"><use href="sprite.svg#i-thinking"/></svg>
        <span class="think-title"></span>
        <svg class="st-icon st-icon--sm st-chev"><use href="sprite.svg#i-chevron"/></svg></summary>
        <div class="st-collapse__body thinking"></div></details>
      <div class="st-bubble"></div>
      <div class="st-msg__meta"><span class="meta-text"></span>
        <button class="st-btn st-btn--icon" data-msg-copy aria-label="Copy the answer" title="Copy">
        <svg class="st-icon st-icon--sm"><use href="sprite.svg#i-copy"/></svg></button></div>`;
    updateAssistant(el, m, false);
  }
  return el;
}
function updateAssistant(el, m, streaming) {
  const det = el.querySelector("details.think");
  if (m.reasoning) {
    det.hidden = false;
    el.querySelector(".think-title").textContent =
      streaming && !m.text ? "Thinking…" : (m.thinkSecs != null ? `Thought for ${fmt(m.thinkSecs, 1)} s` : "Thoughts");
    const body = el.querySelector(".thinking");
    if (det.open) body.textContent = m.reasoning;
  }
  const bubble = el.querySelector(".st-bubble");
  if (m.error) {
    bubble.innerHTML = `<div class="msg-error"></div>`;
    bubble.firstChild.textContent = m.error;
  } else if (!m.text && streaming && !m.reasoning) {
    bubble.innerHTML = `<span class="cursor"></span>`;
  } else {
    bubble.innerHTML = markdown(m.text || "");
    bubble.classList.toggle("cursor", streaming);
  }
  el.querySelector(".meta-text").textContent = m.meta || (streaming ? "" : m.stopped ? "Stopped" : "");
  el.querySelector("[data-msg-copy]").hidden = streaming || !m.text;
}
function renderChat() {
  const chat = $("chat");
  chat.querySelectorAll(".st-msg").forEach((e) => e.remove());
  $("chat-empty").hidden = messages.length > 0;
  messages.forEach((m) => chat.appendChild(msgEl(m)));
  scrollDown(true);
}
function nearBottom() {
  const s = $("chat-scroll");
  return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
}
function scrollDown(force) {
  const s = $("chat-scroll");
  if (force || nearBottom()) s.scrollTop = s.scrollHeight;
}
$("chat").addEventListener("click", (e) => {
  const cc = e.target.closest("[data-code-copy]");
  if (cc) { copyText(cc.closest(".st-code").querySelector("pre").textContent, cc); return; }
  const mc = e.target.closest("[data-msg-copy]");
  if (mc) {
    const i = [...$("chat").querySelectorAll(".st-msg")].indexOf(mc.closest(".st-msg"));
    copyText(messages[i] && messages[i].text, mc);
  }
});
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.innerHTML;
    btn.innerHTML = `<svg class="st-icon st-icon--sm"><use href="sprite.svg#i-check"/></svg>`;
    setTimeout(() => { btn.innerHTML = old; }, 1200);
  } catch { toast("warn", "Copy failed", "Clipboard is not available here."); }
}

/* ------------------------------------------------------------- send/stop */
function setBusy(on) {
  $("stop-btn").hidden = !on;
  $("send-btn").disabled = on;
  $("composer-hint").textContent = on ? "" : "Shift+Enter: new line";
}
async function send() {
  const text = $("input").value.trim();
  if (!text || busy) return;
  messages.push({ role: "user", text, time: Date.now() });
  $("input").value = "";
  autosize();
  const m = { role: "assistant", text: "", reasoning: "", time: Date.now() };
  messages.push(m);
  renderChat();
  const el = $("chat").lastElementChild;
  const controller = new AbortController();
  busy = { controller, msg: m };
  setBusy(true);

  const body = {
    messages: messages.filter((x) => x.role === "user" || !x.error).map((x) => ({ role: x.role, content: x.text })),
    temperature: +sampling.temperature,
    top_p: +sampling.top_p,
  };
  if (sampling.max_tokens) body.max_tokens = +sampling.max_tokens;

  let firstAt = null, thinkStart = null, usage = null, frame = 0;
  const paint = () => { frame = 0; updateAssistant(el, m, true); scrollDown(); };
  try {
    const r = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal,
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = (await r.json()).error.message || msg; } catch {}
      throw new Error(msg);
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.error) throw new Error(j.error.message || "the engine reported an error");
        if (j.usage) usage = j.usage;
        const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
        if (d.reasoning_content || d.reasoning) {
          if (!firstAt) firstAt = performance.now();
          if (!thinkStart) thinkStart = performance.now();
          m.reasoning += (d.reasoning_content || d.reasoning || "");
        }
        if (d.content) {
          if (!firstAt) firstAt = performance.now();
          if (thinkStart && m.thinkSecs == null) m.thinkSecs = (performance.now() - thinkStart) / 1000;
          m.text += d.content;
        }
        if (!frame) frame = requestAnimationFrame(paint);
      }
    }
  } catch (e) {
    if (e.name === "AbortError") m.stopped = true;
    else { m.error = e.message || String(e); toast("error", "The request failed", m.error, 6000); }
  }
  if (thinkStart && m.thinkSecs == null) m.thinkSecs = (performance.now() - thinkStart) / 1000;
  const n = usage ? usage.completion_tokens : null;
  if (n && firstAt) {
    const secs = (performance.now() - firstAt) / 1000;
    m.meta = `${fmt(n)} tokens${secs > 0.25 ? ` · ${fmt(n / secs, 1)} tok/s` : ""}${m.stopped ? " · stopped" : ""}`;
  } else if (m.stopped) {
    m.meta = "Stopped";
  }
  busy = null;
  setBusy(false);
  if (frame) cancelAnimationFrame(frame);
  updateAssistant(el, m, false);
  storeSet(CHAT_KEY, messages);
  scrollDown();
}
$("composer").onsubmit = (e) => { e.preventDefault(); send(); };
$("stop-btn").onclick = () => { if (busy) busy.controller.abort(); };
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
function autosize() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, innerHeight * 0.4)}px`;
}
$("input").addEventListener("input", autosize);

$("new-btn").onclick = () => {
  if (busy) { toast("warn", "Still writing", "Stop the answer first."); return; }
  if (!messages.length) return;
  messages = [];
  storeSet(CHAT_KEY, messages);
  renderChat();
  toast("info", "New chat", "Cleared.");
};

/* -------------------------------------------------------- sampling drawer */
function openSampling(open) {
  $("s-drawer").dataset.open = open ? "true" : "false";
  $("scrim").hidden = !open;
  if (open) {
    $("s-temp").value = sampling.temperature;
    $("s-topp").value = sampling.top_p;
    $("s-max").value = sampling.max_tokens;
    $("o-temp").textContent = sampling.temperature;
    $("o-topp").textContent = sampling.top_p;
  }
}
$("sampling-btn").addEventListener("click", () => openSampling(true));
$("s-drawer-close").addEventListener("click", () => openSampling(false));
$("s-temp").addEventListener("input", () => { $("o-temp").textContent = $("s-temp").value; });
$("s-topp").addEventListener("input", () => { $("o-topp").textContent = $("s-topp").value; });
$("s-reset").addEventListener("click", () => {
  sampling = { ...SAMPLE_DEFAULTS };
  storeSet(SAMPLE_KEY, sampling);
  openSampling(true);
});
$("s-apply").addEventListener("click", () => {
  sampling = {
    temperature: +$("s-temp").value,
    top_p: +$("s-topp").value,
    max_tokens: $("s-max").value,
  };
  storeSet(SAMPLE_KEY, sampling);
  openSampling(false);
  toast("success", "Sampling saved");
});

renderChat();
