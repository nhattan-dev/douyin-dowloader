// Xưởng dịch — front-end một file, không build. Dữ liệu từ /api (đọc đĩa), việc nền qua SSE /api/events.

// ---------- tiện ích ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(String(s));
const val = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join("") : v === null || v === undefined || v === false ? "" : esc(v));
const html = (strings, ...vals) => raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? val(vals[i]) : ""), ""));
const enc = encodeURIComponent;

async function api(url, { method = "GET", body } = {}) {
  const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `lỗi ${r.status}`);
  return j;
}

const money = (n) => (n ? `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}` : "");
const mb = (n) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const dur = (ms) => (ms < 1000 ? `${ms}ms` : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`);
function ago(iso) {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "vừa xong";
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return new Date(iso).toLocaleDateString("vi-VN");
}
const elapsed = (j) => (j.startedAt ? dur((j.endedAt ? new Date(j.endedAt) : Date.now()) - new Date(j.startedAt)) : "");
const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const spk = (name) => html`<span class="spk" style="background:hsl(${hue(name)} 70% 50% / .16);color:hsl(${hue(name)} 60% 42%)">${name}</span>`;

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "err" ? 7000 : 3800);
}

function btn(label, o = {}) {
  const a = {
    "data-act": o.act || "post", "data-url": o.url, "data-body": o.body ? JSON.stringify(o.body) : null,
    "data-confirm": o.confirm, "data-ok": o.ok, "data-go": o.go, "data-path": o.path, title: o.title,
  };
  const attrs = Object.entries(a).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}="${esc(v)}"`).join(" ");
  return raw(`<button class="btn ${esc(o.cls || "")}" ${attrs}${o.disabled ? " disabled" : ""}>${esc(label)}</button>`);
}
const link = (label, href, cls = "") => html`<a class="btn ${cls}" href="${href}">${label}</a>`;
const openBtn = (p, label = "Mở thư mục") => (p ? btn(label, { act: "open", path: p, cls: "ghost sm" }) : "");
/**
 * Thêm MỘT video vào series. Hai đường khác hẳn nhau, nên phải phân biệt theo trạng thái bible:
 * chưa duyệt bible thì chỉ ghi `series.json`, lượt dựng bible sau gồm luôn nó; đã duyệt rồi thì
 * đi `/episodes` — đánh số nối đuôi rồi ghi thẳng một hàng vào bible. KHÔNG dựng lại bible: dựng
 * lại là gieo lại dàn nhân vật (đo: 10 vs 9 nhân vật giữa hai lần chạy) và mất hết công duyệt.
 */
const addEpBtn = (slug, status, videoId, label = "Thêm vào series") => (status === "approved"
  ? btn(label, { url: `/api/series/${enc(slug)}/episodes`, body: { videoId }, cls: "sm pri", ok: "Đã xếp thêm tập" })
  : btn(label, { url: `/api/series/${enc(slug)}/videos`, body: { videoIds: [videoId] }, cls: "sm pri", ok: "Đã thêm vào series" }));

// ---------- nhãn trạng thái ----------
const STAGE_VI = { A: "A · Sửa ASR", B: "B · Người nói", C: "C · Dịch", D: "D · Soát & sửa", E: "E · Xuất" };
const SUB_ST = { start: "đang chạy", ran: "chạy xong", reused: "dùng lại checkpoint (không tốn tiền)", skipped: "bỏ qua (không áp dụng)", error: "lỗi" };
const JOB_ST = { queued: ["xếp hàng", "q"], running: ["đang chạy", "run"], done: ["xong", "ok"], failed: ["lỗi", "err"], stopped: ["đã dừng", "mute"], interrupted: ["bị ngắt", "warn"] };
const EP_ST = {
  "no-stt": ["thiếu transcript", "warn"], idle: ["chưa dịch", "mute"], partial: ["chưa dịch", "mute"],
  review: ["chờ soát người nói", "act"], reviewed: ["đã soát, chờ dịch tiếp", "q"], translated: ["đã dịch", "ok"], dubbed: ["đã lồng tiếng", "ok2"],
};
const VID_ST = { collected: ["chưa tải", "mute"], fetched: ["đã tải, chưa STT", "q"], transcribed: ["sẵn sàng", "ok"], translated: ["sẵn sàng", "ok"], failed: ["lỗi", "err"] };
const SERIES_ST = { new: ["chưa dựng bible", "mute"], draft: ["chờ duyệt bible", "act"], approved: ["bible đã duyệt", "ok"] };
const pill = (p) => (p ? html`<span class="pill p-${p[1]}">${p[0]}</span>` : "");

// ---------- trạng thái chung + SSE ----------
const S = { jobs: new Map(), meta: null, overview: null, view: null };
const jobList = () => [...S.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
const activeJobs = () => jobList().filter((j) => j.status === "running" || j.status === "queued");
const jobsFor = (pred) => jobList().filter(pred);
const activeOf = (list) => list.find((j) => j.status === "running") || list.find((j) => j.status === "queued") || null;

function connect() {
  const es = new EventSource("/api/events");
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
  es.addEventListener("hello", (e) => {
    S.jobs = new Map(JSON.parse(e.data).jobs.map((j) => [j.id, j]));
    paintSide();
    refreshSoon();
  });
  es.addEventListener("job", (e) => {
    const j = JSON.parse(e.data);
    const prev = S.jobs.get(j.id);
    S.jobs.set(j.id, j);
    paintLive(j);
    paintSideSoon();
    if (!prev || prev.status !== j.status) {
      if (prev) notify(j);
      refreshSoon();
    }
  });
  es.addEventListener("log", (e) => {
    const { id, lines } = JSON.parse(e.data);
    for (const el of $$(`[data-log="${id}"]`)) appendLog(el, lines);
  });
}
function setConn(on) {
  const el = $("#conn");
  el.className = `conn ${on ? "on" : "off"}`;
  el.textContent = on ? "đã kết nối" : "mất kết nối — đang thử lại";
}

function notify(j) {
  const z = j.progress?.zhvi;
  let msg = null;
  let kind = "ok";
  if (j.status === "done" && (z?.gate?.stopped || Object.values(z?.eps || {}).some((x) => x.gate?.stopped))) {
    msg = `${j.title}: chờ bạn soát người nói`;
  } else if (j.status === "done" && z?.draft) msg = `${j.title}: xong, chờ bạn duyệt bible`;
  else if (j.status === "done") msg = `Xong: ${j.title}`;
  else if (j.status === "failed") { msg = `Lỗi: ${j.title}`; kind = "err"; }
  if (!msg) return;
  toast(msg, kind);
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    new Notification("Xưởng dịch", { body: msg });
  }
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    loadOverview();
    try {
      await S.view?.refresh?.();
    } catch (ex) {
      console.warn(ex);
    }
  }, 500);
}

async function loadOverview() {
  try {
    S.overview = await api("/api/overview");
  } catch {
    return;
  }
  const n = S.overview.inbox.filter((i) => i.level === "action" || i.level === "error").length;
  $("#nInbox").textContent = n || "";
  document.title = `${n ? `(${n}) ` : ""}Xưởng dịch`;
}

// ---------- thanh bên ----------
let sideRaf = 0;
const paintSideSoon = () => { if (!sideRaf) sideRaf = requestAnimationFrame(() => { sideRaf = 0; paintSide(); }); };
function paintSide() {
  const act = activeJobs();
  $("#nJobs").textContent = act.length || "";
  $("#sideJobs").innerHTML = val(act.slice(0, 6).map((j) => {
    const pct = Math.round((j.progress?.pct || 0) * 100);
    return html`<a class="sj" href="#/jobs/${j.id}">
      <div class="sj-t">${j.title}</div>
      <div class="sj-d">${j.status === "queued" ? "đang xếp hàng" : j.progress?.detail || j.progress?.label || "…"}</div>
      <div class="bar ${j.status}" style="margin-top:6px"><i style="width:${j.status === "queued" ? 0 : pct}%"></i></div>
    </a>`;
  }));
  const nb = $("#notifBtn");
  nb.hidden = !("Notification" in window) || Notification.permission !== "default";
}
function paintNav() {
  const h = location.hash || "#/";
  const key = h.startsWith("#/users") ? "users" : h.startsWith("#/series") ? "series" : h.startsWith("#/jobs") ? "jobs" : "home";
  for (const a of $$(".nav a")) a.classList.toggle("on", a.dataset.nav === key);
}

// ---------- khối tiến độ ----------
function timeline(scope, plan, { compact = false, only = null } = {}) {
  if (!plan?.length) return "";
  const stages = {};
  for (const x of plan) if (!only || only.includes(x.stage)) (stages[x.stage] ||= []).push(x);
  return html`<div class="tl ${compact ? "compact" : ""}">${Object.entries(stages).map(([st, subs]) => html`
    <div class="tl-stage"><div class="tl-h">${STAGE_VI[st] || st}</div>
      <div class="tl-subs">${subs.map((x) => {
        const s = scope?.subs?.[x.id];
        const status = s?.status || "pending";
        const tip = [`${x.id} · ${x.title}`, SUB_ST[status] || "chưa tới",
          s?.ms !== undefined ? `thời gian ${dur(s.ms)}` : null, s?.calls ? `${s.calls} lượt gọi model` : null,
          s?.usd ? `~${money(s.usd)}` : null, s?.error || null, x.cost === "free" ? "thuần code, miễn phí" : `tốn tiền (${x.cost})`].filter(Boolean).join("\n");
        return html`<span class="ss c-${status}" title="${tip}">${x.id}</span>`;
      })}</div></div>
    ${st === "B" && (!only || only.includes("C")) ? html`<div class="gate ${scope?.gate?.stopped ? "stop" : ""}" title="cổng soát người nói"><i></i></div>` : ""}`)}</div>`;
}
const legend = raw(`<div class="legend"><span><span class="ss c-ran"></span>chạy xong</span><span><span class="ss c-reused"></span>dùng lại, không tốn tiền</span><span><span class="ss c-start"></span>đang chạy</span><span><span class="ss c-skipped"></span>bỏ qua</span><span><span class="ss"></span>chưa tới</span></div>`);

function zhviNow(z) {
  if (!z?.plan) return "";
  const cur = z.current && z.plan.find((x) => x.id === z.current);
  const s = cur && z.subs[cur.id];
  const parts = [];
  if (s?.status === "start") parts.push(html`<span class="cur">Đang chạy <b>${cur.id}</b> — ${cur.title}${s.calls ? ` · ${s.calls} lượt gọi model` : ""}</span>`);
  if (z.gate?.stopped) {
    parts.push(html`<div class="callout act"><b>Dừng ở cổng soát người nói.</b> ${z.gate.why}</div>`);
  } else if (z.gate?.need === false && z.done) parts.push(html`<span class="dim small">Cổng soát: máy đã chắc, dịch thẳng.</span>`);
  if (z.lastCallError) parts.push(html`<span class="small" style="color:var(--warn)">lượt gọi gần nhất hỏng: ${z.lastCallError}</span>`);
  return parts;
}

function seriesSteps(z) {
  return html`<div class="steps">${z.steps.map((st) => {
    const ep = st.id.startsWith("ep") ? z.eps?.[st.id.slice(2)] : null;
    const cls = st.status === "running" ? "running" : st.status;
    return html`<div class="st ${cls}"><span class="ic"></span>
      <div><div>${st.title}${st.total ? html` <span class="dim">(${st.done}/${st.total})</span>` : ""}${st.failed ? html` <span class="pill p-warn">${st.failed} hỏng</span>` : ""}</div>
        ${ep?.plan ? html`<div style="margin-top:4px">${timeline(ep, ep.plan, { only: ["A", "B"], compact: true })}</div>` : ""}</div>
      <span class="money">${money((ep?.usd || 0) + (st.usd || 0))}</span></div>`;
  })}</div>`;
}

function stepsList(j) {
  return html`<div class="steps">${j.steps.map((s, i) => html`<div class="st ${s.status === "running" ? "running" : s.status === "done" ? "done" : s.status === "failed" ? (s.optional ? "warn" : "failed") : ""}">
    <span class="ic"></span><div>${s.label}${i === j.stepIndex && j.status === "running" && j.progress?.detail ? html` <span class="dim">— ${j.progress.detail}</span>` : ""}</div><span></span></div>`)}</div>`;
}

function liveJob(j, mode = "card") {
  if (!j) return "";
  const p = j.progress || {};
  const z = p.zhvi;
  const pct = Math.round((j.status === "queued" ? 0 : p.pct || 0) * 100);
  const doneN = z?.plan ? z.plan.filter((x) => ["ran", "reused", "skipped", "error"].includes(z.subs[x.id]?.status)).length : 0;
  const head = html`<div class="lj-head">${pill(JOB_ST[j.status])}
    ${mode === "card" ? html`<a href="#/jobs/${j.id}"><b>${j.title}</b></a>` : ""}
    <span class="dim small">${j.status === "queued" ? "chờ tới lượt (làn " + j.lane + ")" : p.detail || p.label || ""}</span>
    <span class="grow"></span><span class="money">${money(j.usd)}</span><span class="dim small">${elapsed(j)}</span></div>`;
  const bar = html`<div><div class="bar ${j.status}"><i style="width:${pct}%"></i></div>
    <div class="bar-l">${pct}%${z?.plan ? ` · ${doneN}/${z.plan.length} bước` : j.steps?.length > 1 ? ` · bước ${(j.stepIndex || 0) + 1}/${j.steps.length}` : ""}</div></div>`;
  if (mode === "mini") return html`${head}${bar}`;
  let body = "";
  if (z?.kind === "series") body = seriesSteps(z);
  else if (z?.plan) body = html`${timeline(z, z.plan)}${zhviNow(z)}`;
  else if (j.steps?.length > 1) body = stepsList(j);
  const input = p.waitingInput && j.status === "running"
    ? html`<div class="callout act"><b>Đăng nhập Douyin trên cửa sổ trình duyệt vừa mở</b> (quét mã QR hoặc SMS). Xong thì bấm:
        <div class="row">${btn("Tôi đã đăng nhập xong", { url: `/api/jobs/${j.id}/input`, body: { text: "\n" }, cls: "pri", ok: "Đã lưu phiên đăng nhập" })}</div></div>` : "";
  const err = ["failed", "interrupted"].includes(j.status)
    ? html`<div class="callout err"><div class="err-text">${j.error || "không rõ lỗi — xem log"}</div></div>` : "";
  const acts = html`<div class="row">
    ${j.status === "running" || j.status === "queued" ? btn(j.status === "queued" ? "Bỏ khỏi hàng" : "Dừng", { url: `/api/jobs/${j.id}/stop`, cls: "ghost sm", confirm: j.status === "running" ? "Dừng việc này? Phần đã chạy xong được giữ; chạy lại là đi tiếp, không trả tiền lại." : null, ok: "Đã gửi lệnh dừng" }) : ""}
    ${["failed", "stopped", "interrupted"].includes(j.status) ? btn("Chạy lại", { url: `/api/jobs/${j.id}/retry`, cls: "sm pri", ok: "Đã xếp chạy lại" }) : ""}
    ${mode === "card" ? "" : html`<a class="small" href="#/jobs/${j.id}">xem log</a>`}</div>`;
  return html`<div class="lj">${head}${bar}${input}${body}${err}${acts}</div>`;
}

function paintLive(j) {
  for (const el of $$(`[data-live-job="${j.id}"]`)) el.innerHTML = val(liveJob(j, el.dataset.mode || "card"));
}

function appendLog(el, lines) {
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  for (const l of lines) {
    const counter = /^\s*\d+\/\d+\s*$/.test(l.t);
    const last = el.lastElementChild;
    if (counter && last?.dataset.counter) {
      last.textContent = l.t + "\n";
      continue;
    }
    const s = document.createElement("span");
    s.className = l.k === "cmd" ? "cmd" : /\[WARN\]|\[!\]/.test(l.t) ? "warn" : l.k === "err" ? "err" : "";
    if (counter) s.dataset.counter = "1";
    s.textContent = l.t + "\n";
    el.append(s);
  }
  while (el.childElementCount > 1500) el.firstElementChild.remove();
  if (stick) el.scrollTop = el.scrollHeight;
}

async function logPanel(jobId) {
  const d = await api(`/api/jobs/${jobId}`);
  const box = html`<pre class="log" data-log="${jobId}"></pre>`;
  return { box, fill: (root) => { const el = $(`[data-log="${jobId}"]`, root); if (el) { el.innerHTML = ""; appendLog(el, d.tail || []); el.scrollTop = el.scrollHeight; } } };
}

// ---------- hành động (uỷ quyền click) ----------
const ACTIONS = {
  async post(b) {
    const r = await api(b.dataset.url, { method: "POST", body: b.dataset.body ? JSON.parse(b.dataset.body) : {} });
    for (const j of [r.job, ...(r.jobs || [])].filter(Boolean)) S.jobs.set(j.id, j);
    toast(b.dataset.ok || (r.job ? `Đã xếp: ${r.job.title}` : r.jobs ? `Đã xếp ${r.jobs.length} việc` : "Xong"));
    paintSide();
    if (b.dataset.go) location.hash = b.dataset.go.replace("{job}", r.job?.id || "");
    refreshSoon();
  },
  async open(b) {
    await api("/api/open", { method: "POST", body: { path: b.dataset.path } });
  },
  async del(b) {
    await api(b.dataset.url, { method: "DELETE", body: b.dataset.body ? JSON.parse(b.dataset.body) : {} });
    toast(b.dataset.ok || "Xong");
    if (b.dataset.go) location.hash = b.dataset.go;
    refreshSoon();
  },
  /**
   * Xoá series: hỏi đĩa trước rồi mới hỏi người. Hộp xác nhận phải nói đúng cái sắp mất, nhất là
   * hai thứ tiền không mua lại được — câu sửa tay và mẫu giọng. Thư mục video hỏi riêng một câu
   * vì đó là chỗ DÙNG CHUNG: video nào còn series khác nhận thì server không đụng, chỉ kể tên.
   */
  async delSeries(b) {
    const p = await api(`${b.dataset.url}/delete-preview`);
    if (p.busy.length) throw new Error(`đang chạy "${p.busy[0]}" cho series này — dừng việc đó rồi xoá`);
    const ln = [`Xoá series «${p.title}»?`, "", "Chuyển vào thùng rác (khôi phục được):",
      `  · ${p.episodes} tập — ${p.translated} đã dịch, ${p.dubbed} đã lồng tiếng`,
      `  · bible, nhãn người nói, mẫu giọng · ${mb(p.bytes)}`];
    if (p.edits) ln.push(`  · ${p.edits} câu BẠN SỬA TAY — chạy lại máy không ra được`);
    if (p.usd) ln.push(`  · ${money(p.usd)} đã trả cho LLM — dịch lại là trả lại`);
    ln.push("", "Giữ nguyên: video, audio, transcript (lượt ASR đã trả tiền) — vẫn ở trang tác giả.");
    if (p.sharedVideos.length) {
      ln.push("", `${p.sharedVideos.length} video còn series khác dùng chung (${p.sharedVideos[0].others[0]}) — không đụng tới.`);
    }
    if (!confirm(ln.join("\n"))) return;
    const purgeVideoArtifacts = p.videos.length
      ? confirm(`Dọn luôn bản dịch / bản lồng tiếng nằm trong ${p.videos.length} thư mục video của riêng series này?\n\n`
        + "OK = dọn (cũng vào thùng rác, khôi phục cùng series).\nCancel = để lại; không series nào khác đọc chúng.")
      : false;
    const r = await api(b.dataset.url, { method: "DELETE", body: { purgeVideoArtifacts } });
    toast(`Đã chuyển «${r.trash.title}» vào thùng rác`);
    location.hash = "#/series";
    refreshSoon();
  },
  async notify() {
    await Notification.requestPermission();
    paintSide();
  },
};
document.addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-act]");
  if (!b || !ACTIONS[b.dataset.act]) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
  b.disabled = true;
  try {
    await ACTIONS[b.dataset.act](b, ev);
  } catch (ex) {
    toast(ex.message, "err");
  } finally {
    b.disabled = false;
  }
});

window.addEventListener("message", (e) => {
  if (e.data?.zhvi !== "submitted") return;
  if (e.data.job) S.jobs.set(e.data.job.id, e.data.job);
  paintSide();
  const h = location.hash;
  const m = h.match(/^#\/series\/([^/]+)/);
  toast("Đã gửi — đang áp dụng, tiến độ ở thanh bên", "ok");
  if (!m) return;
  if (/\/bible$/.test(h)) location.hash = `#/series/${m[1]}`;
  else if (/\/speakers$/.test(h)) location.hash = h.replace(/\/speakers$/, "/progress");
});

// ---------- views ----------
const main = () => $("#main");
const setMain = (content) => { main().innerHTML = val(content); };
const loading = () => setMain(html`<div class="empty">Đang tải…</div>`);

// ===== Chờ bạn =====
async function viewHome() {
  const render = async () => {
    await loadOverview();
    const o = S.overview || { inbox: [], health: null };
    const groups = [["action", "Cần bạn"], ["error", "Lỗi cần xem"], ["todo", "Làm tiếp"], ["done", "Xong gần đây"]];
    const act = activeJobs();
    const h = o.health;
    setMain(html`
      <div class="page-h"><div><h1>Chờ bạn</h1><div class="sub">Việc máy đang đợi bạn quyết, và việc làm tiếp được ngay.</div></div>
        <span class="grow"></span>${link("+ Thêm tác giả", "#/users", "")}</div>
      <div class="stack">
        ${act.length ? html`<div class="card"><div class="card-h"><h3>Đang chạy</h3></div><div class="card-b stack">
          ${act.slice(0, 4).map((j) => html`<div data-live-job="${j.id}" data-mode="card">${liveJob(j)}</div>`)}</div></div>` : ""}
        ${groups.map(([lv, t]) => {
          const items = o.inbox.filter((i) => i.level === lv).slice(0, lv === "done" ? 6 : 50);
          if (!items.length) return "";
          return html`<div class="card"><div class="card-h"><h3>${t}</h3><span class="dim small">${items.length}</span></div>
            <div class="inbox">${items.map((i) => html`<div class="ib ${i.level}"><span class="dot"></span>
              <div style="min-width:0"><div class="ib-t">${i.title}</div><div class="ib-d">${i.detail}</div></div>
              <div class="row">${i.href ? link(i.level === "action" ? "Mở" : "Xem", i.href, i.level === "action" ? "pri act" : "") : ""}
                ${i.action ? btn(i.action.type === "login" ? "Đăng nhập" : "Chạy", { url: "/api/jobs", body: i.action, cls: "pri" }) : ""}
                ${i.job ? btn("Chạy lại", { url: `/api/jobs/${i.job}/retry`, cls: "sm" }) : ""}</div></div>`)}</div></div>`;
        })}
        ${!o.inbox.length && !act.length ? html`<div class="card empty"><b>Không có gì chờ bạn</b>Bắt đầu: thêm tác giả Douyin → chọn video → tạo series.<div style="margin-top:12px">${link("Thêm tác giả", "#/users", "pri")}</div></div>` : ""}
        ${h ? html`<div class="card card-b"><div class="health">
          ${Object.entries(h.keys).map(([k, v]) => html`<span class="${v ? "ok" : "no"}">${k}</span>`)}
          ${Object.entries(h.tools).map(([k, v]) => html`<span class="${v ? "ok" : "no"}">${k}</span>`)}
          <span class="${h.browserProfile && !h.loginSuspect ? "ok" : "no"}">phiên Douyin${h.loginSuspect ? " (nghi hết hạn)" : ""}</span>
          ${h.freeGb !== null ? html`<span class="${h.freeGb > 10 ? "ok" : "no"}">ổ đĩa trống ${h.freeGb} GB</span>` : ""}
          <span class="grow"></span>${btn("Đăng nhập Douyin", { url: "/api/jobs", body: { type: "login", params: {} }, cls: "ghost sm", go: "#/jobs/{job}" })}
        </div></div>` : ""}
      </div>`);
  };
  await render();
  return { refresh: render };
}

// ===== Tác giả =====
async function viewUsers() {
  const render = async () => {
    const users = await api("/api/users");
    setMain(html`
      <div class="page-h"><div><h1>Tác giả</h1><div class="sub">Dán link trang tác giả Douyin — máy quét danh sách video (mở cửa sổ trình duyệt thật để tránh bị chặn).</div></div></div>
      <div class="card card-b" style="margin-bottom:16px">
        <form class="row" id="addUser">
          <input type="text" name="input" placeholder="https://www.douyin.com/user/MS4wLjABAAAA…" style="flex:1;min-width:260px" required>
          <button class="btn pri" type="submit">Quét video</button>
          ${users.length ? btn(`Quét lại tất cả (${users.length})`, { url: "/api/users/collect-all", cls: "ghost",
            confirm: `Quét lại danh sách video của cả ${users.length} tác giả? Chạy lần lượt từng người, mỗi người mở một cửa sổ trình duyệt.`,
            ok: "Đã xếp hàng — xem tiến độ ở tab Việc" }) : ""}
          ${btn("Đăng nhập Douyin", { url: "/api/jobs", body: { type: "login", params: {} }, cls: "ghost", go: "#/jobs/{job}" })}
        </form>
      </div>
      ${users.length ? html`<div class="card tw"><table class="t">
        <tr><th>Tác giả</th><th class="num">Video</th><th class="num">Chưa tải</th><th class="num">Sẵn sàng</th><th class="num">Lỗi</th><th>Quét lần cuối</th><th></th></tr>
        ${users.map((u) => {
          const running = activeOf(jobsFor((j) => j.params?.userId === u.id));
          return html`<tr class="click" data-href="#/users/${u.id}">
            <td><b>${u.author || "(chưa rõ tên)"}</b><div class="dim mono">${u.id.slice(0, 22)}…</div></td>
            <td class="num">${u.total}</td><td class="num">${u.counts.collected || 0}</td>
            <td class="num">${(u.counts.transcribed || 0) + (u.counts.translated || 0)}</td>
            <td class="num">${u.counts.failed ? html`<span class="pill p-err">${u.counts.failed}</span>` : 0}</td>
            <td>${ago(u.lastCollectedAt)}</td>
            <td>${running ? pill(JOB_ST[running.status]) : btn("Quét lại", { url: `/api/users/${u.id}/collect`, cls: "sm" })}</td></tr>`;
        })}</table></div>` : html`<div class="card empty"><b>Chưa có tác giả nào</b>Dán link trang tác giả ở trên để bắt đầu.</div>`}`);
    $("#addUser").onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api("/api/users", { method: "POST", body: { input: e.target.input.value } });
        S.jobs.set(r.job.id, r.job);
        toast("Đang quét — cửa sổ trình duyệt sẽ mở ra");
        location.hash = `#/users/${r.userId}`;
      } catch (ex) {
        toast(ex.message, "err");
      }
    };
  };
  await render();
  return { refresh: render };
}

// ===== Video của một tác giả =====
const GENERIC_TAG = /^(ai|aigc|ai动漫|ai漫剧|国产动漫|原创动画|原创动漫|原创漫剧|动漫|动画|漫剧|抖音|热门|推荐|短剧)$/i;

async function viewUser([userId]) {
  const ui = { sel: new Set(), filter: "all", q: "" };
  let data = null;

  const visible = () => data.videos.filter((v) => {
    if (ui.filter === "new" && v.status !== "collected") return false;
    if (ui.filter === "ready" && !v.hasTranscript) return false;
    if (ui.filter === "err" && v.status !== "failed") return false;
    if (ui.filter === "free" && v.series.length) return false;
    if (ui.q) {
      const hay = `${v.title} ${v.tags.join(" ")} ${v.mix?.name || ""} ${v.id}`.toLowerCase();
      if (!hay.includes(ui.q.toLowerCase())) return false;
    }
    return true;
  });

  function suggestions() {
    const mix = {};
    const tags = {};
    for (const v of data.videos) {
      if (v.mix?.name) (mix[v.mix.name] ||= []).push(v.id);
      for (const t of new Set(v.tags)) if (!GENERIC_TAG.test(t)) (tags[t] ||= []).push(v.id);
    }
    const n = data.videos.length;
    const out = [
      ...Object.entries(mix).map(([k, ids]) => ({ label: `合集 ${k}`, name: k, ids })),
      ...Object.entries(tags).filter(([, ids]) => ids.length >= 2 && ids.length < Math.max(3, n * 0.6)).map(([k, ids]) => ({ label: `#${k}`, name: k, ids })),
    ];
    return out.sort((a, b) => b.ids.length - a.ids.length).slice(0, 12);
  }

  const card = (v) => {
    const thumb = v.hasVideo ? `/api/thumb/${enc(userId)}/${v.id}` : v.cover;
    return html`<div class="vc ${ui.sel.has(v.id) ? "sel" : ""}" data-vid="${v.id}">
      <div class="th">${thumb ? html`<img src="${thumb}" loading="lazy" referrerpolicy="no-referrer" alt="">` : "chưa có ảnh"}
        ${v.cover ? html`<img class="cv-badge" src="/api/cover/${enc(userId)}/${v.id}" loading="lazy" alt="" title="ảnh bìa — để nhận video cùng series" onerror="this.remove()">` : ""}
        <span class="ck">${ui.sel.has(v.id) ? "✓" : ""}</span>
        ${v.duration ? html`<span class="dur">${mmss(v.duration)}</span>` : ""}
        ${v.hasVideo ? html`<button class="play" data-play="${v.id}">▶ xem</button>` : ""}</div>
      <div class="bd"><div class="ti">${v.title || html`<span class="faint">(chưa có tiêu đề — tải về sẽ có)</span>`}</div>
        <div class="mt">${pill(VID_ST[v.status] || [v.status, "mute"])}
          ${v.duration !== null && v.duration < 60 ? html`<span class="pill p-warn" title="dưới 60s thường là trailer/thông báo — series init sẽ gạt">ngắn</span>` : ""}
          ${v.gone && !v.hasVideo ? html`<span class="pill p-mute" title="lượt quét gần nhất không còn thấy video này trên trang tác giả">không còn trên trang</span>` : ""}
          <span>${v.createTime ? new Date(v.createTime).toLocaleDateString("vi-VN") : ""}</span>
          ${v.mix ? html`<span class="tag">合集 ${v.mix.ep ? `tập ${v.mix.ep}` : ""}</span>` : ""}</div>
        ${v.series.length ? html`<div class="mt">${v.series.map((s) => html`<a class="tag" href="#/series/${enc(s.slug)}">${s.title}${s.ep ? ` · tập ${s.ep}` : ""}</a>`)}</div>` : ""}
        ${v.error ? html`<div class="small" style="color:var(--err)" title="${v.error}">${String(v.error).slice(0, 80)}</div>` : ""}
      </div></div>`;
  };

  function paintGrid() {
    const vs = visible();
    $("#vgrid").innerHTML = vs.length ? val(vs.map(card)) : val(html`<div class="empty" style="grid-column:1/-1">Không có video nào khớp bộ lọc.</div>`);
    $("#vcount").textContent = `${vs.length}/${data.videos.length} video`;
    paintSel();
  }

  function paintSel() {
    const bar = $("#selbar");
    const n = ui.sel.size;
    bar.hidden = !n;
    if (!n) return;
    const picked = data.videos.filter((v) => ui.sel.has(v.id));
    const need = picked.filter((v) => !v.hasTranscript).length;
    bar.innerHTML = val(html`<span>Đã chọn <b>${n}</b></span>
      ${need ? html`<button class="btn" id="bFetch">Tải + STT ${need} video</button>` : ""}
      <button class="btn pri" id="bSeries">Tạo series…</button>
      <button class="btn" id="bAdd">Thêm vào series…</button>
      <button class="btn ghost" id="bClear">Bỏ chọn</button>`);
    $("#bClear").onclick = () => { ui.sel.clear(); paintGrid(); };
    $("#bSeries").onclick = () => seriesDialog(picked);
    $("#bAdd").onclick = () => addToSeriesDialog(picked);
    if ($("#bFetch")) {
      $("#bFetch").onclick = async () => {
        try {
          const r = await api(`/api/users/${enc(userId)}/fetch`, { method: "POST", body: { videoIds: picked.filter((v) => !v.hasTranscript).map((v) => v.id) } });
          S.jobs.set(r.job.id, r.job);
          paintSide();
          toast("Đã xếp tải — xong sẽ tự STT");
        } catch (ex) {
          toast(ex.message, "err");
        }
      };
    }
  }

  function seriesDialog(picked) {
    // cùng một 合集 và đủ số tập -> theo số tập tác giả đánh; không thì theo ngày đăng
    const mixIds = new Set(picked.map((v) => v.mix?.id).filter(Boolean));
    const byMix = mixIds.size === 1 && picked.every((v) => v.mix?.ep);
    const sorted = [...picked].sort((a, b) => (byMix ? a.mix.ep - b.mix.ep : BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    const sug = picked.find((v) => v.mix?.name)?.mix.name
      || Object.entries(picked.flatMap((v) => v.tags.filter((t) => !GENERIC_TAG.test(t))).reduce((m, t) => ({ ...m, [t]: (m[t] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    const need = picked.filter((v) => !v.hasTranscript).length;
    let n = 0;
    const dlg = $("#dlg");
    dlg.innerHTML = val(html`<form method="dialog" id="sForm">
      <div class="dlg-h"><h2>Tạo series từ ${picked.length} video</h2></div>
      <div class="dlg-b">
        <label class="field">Tên series (tên phim — máy sẽ đặt lại tên Việt khi dựng bible)
          <input type="text" name="name" value="${sug}" placeholder="vd. 杂役合道 hoặc Tạp Dịch Hợp Đạo" required></label>
        <div class="card tw"><table class="t">
          <tr><th>Tập</th><th>Video</th><th>Dài</th><th></th></tr>
          ${sorted.map((v) => {
            const short = v.duration !== null && v.duration < 60;
            return html`<tr class="${short ? "off" : ""}"><td>${short ? "—" : ++n}</td><td>${v.title || v.id}</td><td>${v.duration ? mmss(v.duration) : "?"}</td>
              <td>${short ? html`<span class="pill p-warn">ngắn, sẽ bị gạt</span>` : !v.hasTranscript ? html`<span class="pill p-q">sẽ tải + STT</span>` : ""}</td></tr>`;
          })}</table></div>
        <div class="dim small">Thứ tự tập theo ${byMix ? "số tập trong 合集" : "ngày đăng"}. Sửa lại được trong trang duyệt bible.</div>
        <label class="chk"><input type="checkbox" name="init" checked> Dựng bible nháp ngay <span class="dim">(~$0.12/tập × ${n} ≈ $${(0.12 * n).toFixed(2)})</span></label>
        ${need ? html`<div class="callout info">${need} video chưa có transcript — sẽ tải + STT trước, xong tự dựng bible.</div>` : ""}
      </div>
      <div class="dlg-f"><button class="btn" value="cancel" formnovalidate>Huỷ</button><button class="btn pri" value="ok">Tạo series</button></div></form>`);
    dlg.showModal();
    $("#sForm").onsubmit = async (e) => {
      if (e.submitter?.value !== "ok") return;
      e.preventDefault();
      try {
        const r = await api("/api/series", { method: "POST", body: { name: e.target.name.value.trim(), userId, videoIds: sorted.map((v) => v.id), init: e.target.init.checked } });
        if (r.job) S.jobs.set(r.job.id, r.job);
        dlg.close();
        paintSide();
        location.hash = `#/series/${enc(r.slug)}`;
      } catch (ex) {
        toast(ex.message, "err");
      }
    };
  }

  /**
   * Thêm video đã chọn vào series ĐÃ CÓ.
   *
   * Không có đường này thì lối duy nhất là auto-detect theo 合集 (`scan.mixNews`: video cùng 合集
   * với các tập đang có). Đo trên dữ liệu thật thì lối đó phủ quá ít: ai-qing 46/46 video KHÔNG
   * thuộc 合集 nào — series ấy không bao giờ hiện nổi một nút thêm tập; 飞鸟炮灰 cũng chỉ 10/35
   * video có 合集. Tức thêm tay mới là lối chính, 合集 chỉ là đường tắt lúc may.
   */
  async function addToSeriesDialog(picked) {
    const dlg = $("#dlg");
    let all;
    try {
      all = await api("/api/series");
    } catch (ex) {
      return toast(ex.message, "err");
    }
    // Chỉ series của CHÍNH tác giả này: `series.json` giữ đúng một `userId`, và `seriesCore` dựng
    // đường dẫn cho video lẻ bằng `data/<meta.userId>/<vid>` — video của tác giả khác sẽ trỏ vào
    // thư mục không tồn tại mà không báo gì.
    const mine = all.filter((s) => s.userId === userId);
    if (!mine.length) {
      dlg.innerHTML = val(html`<div class="dlg-h"><h2>Tác giả này chưa có series nào</h2></div>
        <div class="dlg-b"><p>Chưa có series nào để thêm vào. Dùng <b>Tạo series…</b> để lập series mới từ các video đang chọn.</p></div>
        <div class="dlg-f"><button class="btn" onclick="this.closest('dialog').close()">Đóng</button></div>`);
      return dlg.showModal();
    }

    // cùng khuôn xếp thứ tự với `seriesDialog` — thứ tự này quyết định số tập, nên phải thấy được
    const mixIds = new Set(picked.map((v) => v.mix?.id).filter(Boolean));
    const byMix = mixIds.size === 1 && picked.every((v) => v.mix?.ep);
    const sorted = [...picked].sort((a, b) => (byMix ? a.mix.ep - b.mix.ep : BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    // nối đuôi: cùng luật với `series.addEpisode`, không đánh số lại tập cũ
    const nextEp = (s) => {
      const nums = s.episodes.filter((e) => e.use).map((e) => Number(e.ep)).filter((n) => Number.isFinite(n) && n > 0);
      return nums.length ? Math.max(...nums) + 1 : 1;
    };
    const dupOf = (v, s) => (v.series || []).some((m) => m.slug === s.slug);
    const tooShort = (v) => v.duration !== null && v.duration < 60;
    const skipOf = (v, s) => dupOf(v, s) || (s.status === "approved" && tooShort(v));

    const paint = () => {
      const s = mine.find((x) => x.slug === $("#aSel").value);
      const approved = s.status === "approved";
      let n = nextEp(s) - 1;
      $("#aPrev").innerHTML = val(html`<div class="card tw"><table class="t">
          <tr><th>${approved ? "Sẽ là tập" : "Thứ tự"}</th><th>Video</th><th>Dài</th><th></th></tr>
          ${sorted.map((v) => {
            const skip = skipOf(v, s);
            return html`<tr class="${skip ? "off" : ""}"><td>${skip ? "—" : approved ? ++n : "+"}</td>
              <td>${v.title || v.id}</td><td>${v.duration ? mmss(v.duration) : "?"}</td>
              <td>${dupOf(v, s) ? html`<span class="pill p-mute">đã ở trong series</span>`
                : tooShort(v) ? html`<span class="pill p-warn">${approved ? "ngắn — sẽ bị từ chối" : "ngắn, sẽ bị gạt"}</span>`
                : !v.hasTranscript ? html`<span class="pill p-q">sẽ tải + STT trước</span>` : ""}</td></tr>`;
          })}</table></div>
        <div class="dim small">${approved
          ? `Số tập nối đuôi theo thứ tự trên (${byMix ? "số tập trong 合集" : "ngày đăng"}); tập cũ không bị đánh số lại và bible không đổi phiên bản, nên tập đã dịch không phải chạy lại.`
          : "Series này chưa duyệt bible — video chỉ vào danh sách nguồn, số tập được đánh khi dựng bible."}</div>`);
    };

    dlg.innerHTML = val(html`<form method="dialog" id="aForm">
      <div class="dlg-h"><h2>Thêm ${picked.length} video vào series</h2></div>
      <div class="dlg-b">
        <label class="field">Series
          <select name="slug" id="aSel">${mine.map((s) => html`<option value="${s.slug}">${s.title} — ${s.episodes.filter((e) => e.use).length} tập${s.status === "approved" ? "" : " (chưa duyệt bible)"}</option>`)}</select></label>
        <div id="aPrev"></div>
      </div>
      <div class="dlg-f"><button class="btn" value="cancel" formnovalidate>Huỷ</button><button class="btn pri" value="ok">Thêm vào series</button></div></form>`);
    dlg.onclose = null;
    dlg.showModal();
    paint();
    $("#aSel").onchange = paint;
    $("#aForm").onsubmit = async (e) => {
      if (e.submitter?.value !== "ok") return;
      e.preventDefault();
      const s = mine.find((x) => x.slug === $("#aSel").value);
      const todo = sorted.filter((v) => !skipOf(v, s));
      if (!todo.length) return toast("không còn video nào để thêm", "err");
      try {
        if (s.status === "approved") {
          // xếp LẦN LƯỢT: số tập nối đuôi nên thứ tự xếp hàng chính là thứ tự đánh số
          for (const v of todo) {
            const r = await api(`/api/series/${enc(s.slug)}/episodes`, { method: "POST", body: { videoId: v.id } });
            if (r.job) S.jobs.set(r.job.id, r.job);
          }
        } else {
          await api(`/api/series/${enc(s.slug)}/videos`, { method: "POST", body: { videoIds: todo.map((v) => v.id) } });
        }
        dlg.close();
        ui.sel.clear();
        paintSide();
        location.hash = `#/series/${enc(s.slug)}`;
      } catch (ex) {
        toast(ex.message, "err");
      }
    };
  }

  function preview(vid) {
    const v = data.videos.find((x) => x.id === vid);
    const dlg = $("#dlg");
    dlg.innerHTML = val(html`<div class="dlg-h"><h2>${v.title || v.id}</h2></div>
      <div class="dlg-b"><video src="/media/${v.dir.split("/").map(enc).join("/")}/video.mp4" controls autoplay></video>
      <div class="row small dim">${v.tags.map((t) => html`<span class="tag">#${t}</span>`)}</div></div>
      <div class="dlg-f">${openBtn(v.dir)}<button class="btn" onclick="this.closest('dialog').close()">Đóng</button></div>`);
    dlg.onclose = () => { dlg.innerHTML = ""; };
    dlg.showModal();
  }

  async function render(first = false) {
    data = await api(`/api/users/${enc(userId)}`);
    const running = activeOf(jobsFor((j) => j.params?.userId === userId));
    if (first) {
      setMain(html`
        <div class="crumb"><a href="#/users">Tác giả</a> ›</div>
        <div class="page-h"><div><h1>${data.author || "(chưa rõ tên)"}</h1>
          <div class="sub mono">${userId}</div></div><span class="grow"></span>
          <div id="uActs" class="row"></div></div>
        <div id="uLive"></div>
        <div class="toolbar">
          <input type="search" id="q" placeholder="Tìm tiêu đề, hashtag, 合集…" style="min-width:240px">
          <div class="seg" id="flt">
            <button data-f="all" class="on">Tất cả</button><button data-f="new">Chưa tải</button>
            <button data-f="ready">Có transcript</button><button data-f="free">Chưa vào series</button><button data-f="err">Lỗi</button>
          </div>
          <span class="grow"></span><span class="dim small" id="vcount"></span>
        </div>
        <div class="toolbar" id="sug"></div>
        <div class="vgrid" id="vgrid"></div>
        <div class="selbar" id="selbar" hidden></div>`);
      $("#q").oninput = (e) => { ui.q = e.target.value; paintGrid(); };
      $("#flt").onclick = (e) => {
        const b = e.target.closest("[data-f]");
        if (!b) return;
        ui.filter = b.dataset.f;
        $$("#flt button").forEach((x) => x.classList.toggle("on", x === b));
        paintGrid();
      };
      $("#vgrid").onclick = (e) => {
        const p = e.target.closest("[data-play]");
        if (p) return preview(p.dataset.play);
        if (e.target.closest("a")) return;
        const c = e.target.closest("[data-vid]");
        if (!c) return;
        ui.sel.has(c.dataset.vid) ? ui.sel.delete(c.dataset.vid) : ui.sel.add(c.dataset.vid);
        c.classList.toggle("sel");
        $(".ck", c).textContent = ui.sel.has(c.dataset.vid) ? "✓" : "";
        paintSel();
      };
      $("#sug").onclick = (e) => {
        const c = e.target.closest("[data-ids]");
        if (!c) return;
        const ids = c.dataset.ids.split(",");
        const all = ids.every((id) => ui.sel.has(id));
        ids.forEach((id) => (all ? ui.sel.delete(id) : ui.sel.add(id)));
        paintGrid();
      };
    }
    $("#uActs").innerHTML = val(html`${running ? "" : btn("Quét lại danh sách", { url: `/api/users/${enc(userId)}/collect` })}
      ${openBtn(`data/${userId}`)}`);
    $("#uLive").innerHTML = val(running ? html`<div class="card card-b" style="margin-bottom:14px" data-live-job="${running.id}" data-mode="card">${liveJob(running)}</div>` : "");
    const sug = suggestions();
    const noTitle = data.videos.filter((v) => !v.title && !v.gone).length;
    const gone = data.videos.filter((v) => v.gone && !v.hasVideo).length;
    $("#sug").innerHTML = val(html`${sug.length ? html`<span class="dim small">Gợi ý gom series:</span><div class="chips">
      ${sug.map((s) => html`<button class="chip" data-ids="${s.ids.join(",")}" title="chọn/bỏ chọn ${s.ids.length} video">${s.label}<b>${s.ids.length}</b></button>`)}</div>` : ""}
      ${noTitle ? html`<span class="dim small">${noTitle} video chưa có tiêu đề — «Quét lại danh sách» để lấy tiêu đề/合集 trước khi tải.</span>` : ""}
      ${gone ? html`<span class="dim small">${gone} video không còn trên trang tác giả (đã ẩn/xoá) — không tải được nữa.</span>` : ""}`);
    paintGrid();
  }
  await render(true);
  return { refresh: () => render(false) };
}

// ===== Danh sách series =====
const EP_COLORS = { dubbed: "var(--ok)", translated: "color-mix(in srgb, var(--ok) 55%, transparent)", review: "var(--act)", reviewed: "var(--accent)" };
async function viewSeriesList() {
  const render = async () => {
    const [list, bin] = await Promise.all([api("/api/series"), api("/api/trash")]);
    setMain(html`
      <div class="page-h"><div><h1>Series</h1><div class="sub">Tạo series từ trang tác giả: chọn các tập → «Tạo series».</div></div><span class="grow"></span>${link("Chọn video", "#/users")}</div>
      ${list.length ? html`<div class="scards">${list.map((s) => {
        const eps = s.episodes.filter((e) => e.state);
        const by = eps.reduce((m, e) => ({ ...m, [e.state.status]: (m[e.state.status] || 0) + 1 }), {});
        const running = activeOf(jobsFor((j) => j.params?.slug === s.slug));
        return html`<a class="card sc" href="#/series/${enc(s.slug)}">
          ${s.cover ? html`<div class="sc-th"><img src="${s.cover}" loading="lazy" alt="" onerror="this.parentElement.remove()"></div>` : ""}
          <div class="sc-body">
            <div class="row"><span class="sc-t">${s.title}</span><span class="grow"></span>${running ? pill(JOB_ST.running) : pill(SERIES_ST[s.status])}</div>
            <div class="dim small">${s.titleZh ? html`<span class="zh">${s.titleZh}</span> · ` : ""}${eps.length || s.episodes.length + s.extra.length} tập</div>
            <div class="stackbar">${Object.entries(EP_COLORS).map(([k, c]) => (by[k] ? html`<i style="width:${(100 * by[k]) / Math.max(1, eps.length)}%;background:${c}"></i>` : ""))}</div>
            <div class="dim small">${[["dubbed", "lồng tiếng"], ["translated", "đã dịch"], ["review", "chờ soát"]].map(([k, t]) => (by[k] ? `${by[k]} ${t}` : "")).filter(Boolean).join(" · ") || "chưa tập nào xong"}</div>
          </div>
        </a>`;
      })}</div>` : html`<div class="card empty"><b>Chưa có series</b>Vào trang tác giả, chọn các video cùng một phim, bấm «Tạo series».<div style="margin-top:12px">${link("Chọn video", "#/users", "pri")}</div></div>`}
      ${bin.length ? html`<details class="card" style="margin-top:16px"><summary class="dim small" style="cursor:pointer">Thùng rác — ${bin.length} series đã xoá</summary>
        <div class="dim small" style="margin:8px 0 4px">Video, audio và transcript không nằm ở đây — chúng thuộc về tác giả, xoá series không đụng tới.</div>
        <table class="t"><tr><th>Series</th><th>Xoá lúc</th><th>Còn gì</th><th></th></tr>
        ${bin.map((t) => html`<tr><td><b>${t.title}</b><div class="dim mono small">${t.slug}</div></td>
          <td class="dim small">${ago(t.deletedAt)}</td>
          <td class="dim small">${[t.stats.episodes ? `${t.stats.episodes} tập` : "", t.stats.edits ? `${t.stats.edits} câu sửa tay` : "",
            t.stats.usd ? `${money(t.stats.usd)} đã trả` : "", mb(t.bytes)].filter(Boolean).join(" · ")}
            ${t.keptShared.length ? html`<div>${t.keptShared.length} video dùng chung đã để nguyên</div>` : ""}</td>
          <td class="num"><div class="row" style="justify-content:flex-end">
            ${btn("Khôi phục", { url: `/api/trash/${enc(t.name)}/restore`, cls: "sm", ok: `Đã khôi phục «${t.title}»` })}
            ${btn("Xoá hẳn", { act: "del", url: `/api/trash/${enc(t.name)}`, cls: "sm danger ghost", ok: "Đã xoá hẳn",
              confirm: `Xoá hẳn «${t.title}»? Lần này mất thật: ${[t.stats.edits ? `${t.stats.edits} câu sửa tay` : "", t.stats.usd ? `${money(t.stats.usd)} đã trả cho LLM` : "", "bible, nhãn, mẫu giọng"].filter(Boolean).join(", ")}.` })}
          </div></td></tr>`)}</table></details>` : ""}`);
  };
  await render();
  return { refresh: render };
}

// ===== Một series =====
function epAction(s, e, active) {
  const base = `#/series/${enc(s.slug)}/ep/${enc(e.ep)}`;
  const url = `/api/series/${enc(s.slug)}/ep/${enc(e.ep)}`;
  if (active) return link("Xem tiến độ", `${base}/progress`, "sm");
  if (s.status !== "approved") return html`<span class="dim small">chờ bible</span>`;
  switch (e.state.status) {
    case "no-stt": return html`<span class="dim small">thiếu transcript</span>`;
    case "idle": case "partial": return btn("Dịch", { url: `${url}/translate`, cls: "sm pri", ok: `Đã xếp dịch tập ${e.ep}` });
    case "review": return link("Soát người nói", `${base}/speakers`, "sm pri act");
    case "reviewed": return btn("Dịch tiếp", { url: `${url}/translate`, cls: "sm pri" });
    case "translated": return html`<div class="row">${link("Xem bản dịch", `${base}/translation`, "sm")}${link("Lồng tiếng", `${base}/dub`, "sm pri")}</div>`;
    case "dubbed": return link("Xem thành phẩm", `${base}/dub`, "sm pri");
    default: return "";
  }
}

async function viewSeries([slug]) {
  const plan = S.meta.plan;
  const render = async () => {
    const s = await api(`/api/series/${enc(slug)}`);
    const sJobs = jobsFor((j) => j.params?.slug === slug || j.params?.then?.params?.slug === slug);
    const initJob = activeOf(sJobs.filter((j) => ["seriesInit", "bibleApply", "fetch", "stt"].includes(j.type)));
    const lastInit = sJobs.find((j) => ["seriesInit", "fetch", "stt"].includes(j.type));
    const lastApply = sJobs.find((j) => j.type === "bibleApply");
    const missing = s.episodes.filter((e) => !e.hasTranscript).length;
    const used = s.episodes.filter((e) => e.state);
    const todo = used.filter((e) => ["idle", "partial", "reviewed"].includes(e.state.status));
    const bibleStep = s.status === "approved" ? "ok" : s.status === "draft" ? "act" : "";
    const collectJob = activeOf(jobsFor((j) => j.type === "collect" && j.params?.userId === s.userId));
    // Cờ nghi ngờ cho video sắp thêm. So với TRUNG VỊ các tập đã có chứ không với hằng số: mỗi
    // series một nhịp dài ngắn. Chỉ cảnh báo, không chặn — máy không chắc được, người bấm mới chắc.
    const durs = used.map((e) => e.duration).filter(Boolean).sort((a, b) => a - b);
    const medDur = durs.length ? durs[durs.length >> 1] : null;
    const oddity = (v) => {
      if (v.duration && v.duration < 60) return `chỉ ${v.duration}s — giống clip thông báo hơn là một tập`;
      if (v.duration && medDur && v.duration > medDur * 3) return `dài gấp ${(v.duration / medDur).toFixed(1)}× tập thường — nghi là bản gộp nhiều tập`;
      return null;
    };

    let bibleBody;
    if (initJob) {
      bibleBody = html`<div data-live-job="${initJob.id}" data-mode="card">${liveJob(initJob)}</div>`;
    } else if (s.status === "new") {
      bibleBody = html`<p style="margin-top:0">Máy đọc thoại cả series để lập <b>danh sách nhân vật</b> (tên Việt, giới tính, ngoại hình), <b>xưng hô</b> và <b>thuật ngữ</b>. Bạn duyệt lại bằng tiếng Việt, sau đó mọi tập dịch theo cùng một bible.</p>
        ${["failed", "interrupted"].includes(lastInit?.status) ? html`<div class="callout err" style="margin-bottom:10px"><b>${lastInit.title} — lỗi.</b><div class="err-text">${lastInit.error}</div></div>` : ""}
        <div class="row">${btn(missing ? `Tải + STT ${missing} video còn thiếu, rồi dựng bible` : "Dựng bible nháp", { url: `/api/series/${enc(slug)}/init`, cls: "pri", ok: "Đã xếp dựng bible" })}
          <span class="dim small">~$0.12/tập · vài phút mỗi tập</span></div>`;
    } else if (s.status === "draft") {
      bibleBody = html`
        ${s.extra.length ? html`<div class="callout warn" style="margin-bottom:12px">${s.extra.length} video mới thêm vào series chưa có trong nháp.
          <div class="row">${btn("Dựng lại nháp gồm video mới", { url: `/api/series/${enc(slug)}/init`, body: { force: true }, cls: "sm pri", ok: "Đã xếp dựng lại nháp" })}
          <span class="dim small">chỉ tính tiền phần của video mới + lượt gộp lại</span></div></div>` : ""}
        <div class="callout act"><b>Nháp xong — chờ bạn duyệt.</b> ${s.draft.cast} nhân vật, ${s.draft.doubts.length} điều máy không chắc.
          ${lastApply?.status === "failed" ? html`<div class="callout err" style="margin:8px 0"><b>Áp dụng bible lỗi</b> — sửa trong trang duyệt rồi gửi lại.<div class="err-text">${lastApply.error}</div></div>` : ""}
          <div class="row">${link("Duyệt bible", `#/series/${enc(slug)}/bible`, "pri act")}
          ${btn("Dựng lại nháp", { url: `/api/series/${enc(slug)}/init`, body: { force: true }, cls: "ghost", confirm: "Dựng lại nháp từ đầu? Phần đã trả tiền (sửa ASR, gộp nhân vật, tả ngoại hình) được dùng lại nếu đầu vào không đổi." })}</div></div>
        ${s.draft.doubts.length ? html`<ul class="small" style="margin:10px 0 0;padding-left:18px">${s.draft.doubts.slice(0, 6).map((d) => html`<li>${d}</li>`)}</ul>` : ""}`;
    } else {
      bibleBody = html`
        ${s.draft?.stale ? html`<div class="callout act" style="margin-bottom:12px">Có bản nháp mới hơn bible đang dùng. ${link("Duyệt nháp mới", `#/series/${enc(slug)}/bible`, "sm pri act")}</div>` : ""}
        ${s.extra.length ? html`<div class="callout warn" style="margin-bottom:12px">${s.extra.length} video đã thêm vào series nhưng chưa có số tập trong bible.
          <div class="dim small" style="margin:2px 0 8px">Thêm thẳng vào bible: đánh số nối đuôi, không đụng dàn nhân vật, các tập đã dịch không phải chạy lại.</div>
          ${s.extra.map((v) => html`<div class="row" style="align-items:baseline;gap:8px;margin-bottom:4px">
            ${addEpBtn(slug, s.status, v, "Thêm vào bible")}<span class="dim mono small">${v}</span></div>`)}</div>` : ""}
        <div class="castg">${s.bible.cast.map((c) => html`<div class="cast"><b>${c.vi || c.zh}</b> <span class="zh dim">${c.zh}</span>
          <div class="row small dim" style="gap:4px;margin-top:2px"><span class="tag">${{ male: "nam", female: "nữ" }[c.gender] || "?"}</span><span class="tag">${{ main: "chính", episodic: "phụ", mentioned: "chỉ được nhắc" }[c.role] || c.role}</span></div>
          ${c.look ? html`<div class="lk">${c.look}</div>` : ""}</div>`)}</div>
        <div class="row" style="margin-top:12px"><span class="dim small">${s.bible.terms.length} thuật ngữ · ${s.bible.address} cặp xưng hô · phiên bản ${String(s.bible.version).slice(0, 8)} · duyệt ${ago(s.bible.approvedAt)}</span>
          <span class="grow"></span>${s.draft ? link("Sửa bible", `#/series/${enc(slug)}/bible`, "sm") : ""}</div>`;
    }

    setMain(html`
      <div class="crumb"><a href="#/series">Series</a> ›</div>
      <div class="page-h"><div><h1>${s.title}</h1>
        <div class="sub">${s.titleZh ? html`<span class="zh">${s.titleZh}</span> · ` : ""}${used.length || s.episodes.length} tập ${s.userId ? html`· <a href="#/users/${enc(s.userId)}">trang tác giả</a>` : ""}</div></div>
        <span class="grow"></span>${pill(SERIES_ST[s.status])}${openBtn(s.outRoot, "Mở thư mục kết quả")}
        <details style="position:relative"><summary class="btn ghost sm" style="list-style:none">⋯</summary>
          <div class="card card-b stack" style="position:absolute;right:0;top:34px;z-index:5;min-width:260px;gap:8px">
            ${openBtn(`series/${slug}`, "Mở thư mục series")}
            ${btn("Xoá series…", { act: "delSeries", url: `/api/series/${enc(slug)}`, cls: "sm danger" })}
          </div></details></div>

      ${s.mixNews.length ? html`<div class="callout info" style="margin-bottom:8px">
        <b>Tác giả đã đăng ${s.mixNews.length} tập mới trong 合集.</b>
        <div class="dim small" style="margin:2px 0 8px">Thêm từng tập, <b>bấm từ trên xuống</b>: tập mới được đánh số nối đuôi theo thứ tự bạn bấm, không lấy số của 合集 — số 合集 hay lệch (bản 补档 chen vào giữa) và trong đó có cả clip thông báo lẫn bản gộp.</div>
        ${s.mixNews.map((v) => html`<div class="row" style="align-items:baseline;gap:8px;margin-bottom:4px">
          ${addEpBtn(slug, s.status, v.id, `Thêm${v.ep ? ` (合集 ghi tập ${v.ep})` : ""}`)}
          <span style="flex:1;min-width:180px">${v.title || v.id}
            <span class="dim small">${v.duration ? ` · ${mmss(v.duration)}` : ""}${v.status === "collected" ? " · chưa tải" : ""}</span>
            ${oddity(v) ? html`<div class="dim small" style="color:var(--warn,#a60)">⚠ ${oddity(v)}</div>` : ""}</span>
        </div>`)}</div>` : ""}
      ${s.userId ? html`<div class="row small dim" style="margin-bottom:12px;gap:8px;align-items:baseline">
        <span>Danh sách video quét lần cuối ${ago(s.lastCollectedAt)}${s.mixNews.length ? "" : " — không thấy tập mới nào"}.</span>
        ${collectJob ? pill(JOB_ST[collectJob.status]) : btn("Quét lại tác giả", { url: `/api/users/${enc(s.userId)}/collect`, cls: "sm ghost", ok: "Đang quét — cửa sổ trình duyệt sẽ mở ra" })}</div>` : ""}
      <div class="section-t"><span class="step-n ${bibleStep}">1</span><h2>Bible nhân vật</h2></div>
      <div class="card card-b">${bibleBody}</div>

      <div class="section-t"><span class="step-n ${used.some((e) => ["translated", "dubbed"].includes(e.state.status)) ? "ok" : ""}">2</span><h2>Dịch & lồng tiếng từng tập</h2>
        <span class="grow"></span>
        ${s.status === "approved" && todo.length ? btn(`Dịch ${todo.length} tập chưa dịch`, { url: `/api/series/${enc(slug)}/translate-all`, cls: "pri", confirm: `Xếp dịch ${todo.length} tập (~$0.10/tập)? Tập nào máy chưa chắc người nói sẽ dừng chờ bạn soát, các tập khác vẫn chạy.` }) : ""}</div>
      <div class="card tw"><table class="t">
        <tr><th>Tập</th><th>Video</th><th>Trạng thái</th><th>Tiến độ</th><th class="num">Lượt gần nhất</th><th></th></tr>
        ${s.episodes.map((e, i) => {
          if (s.status === "new") {
            return html`<tr><td class="dim">${i + 1}</td><td style="max-width:320px">${e.title || e.videoId}<div class="dim small">${e.duration ? mmss(e.duration) : ""}</div></td>
              <td>${e.hasTranscript ? pill(["có transcript", "ok"]) : pill(["chưa tải / STT", "warn"])}</td>
              <td colspan="3" class="dim small">số tập chốt khi dựng bible${e.duration && e.duration < 60 ? " · video ngắn, sẽ bị gạt" : ""}</td></tr>`;
          }
          if (!e.state) {
            return html`<tr class="off"><td>—</td><td>${e.title || e.videoId}<div class="dim small">${e.why || "không dùng"}</div></td><td colspan="4"></td></tr>`;
          }
          const ej = jobsFor((j) => j.params?.slug === slug && String(j.params?.ep) === e.ep);
          const act = activeOf(ej);
          const diskT = Math.max(e.state.times.translation, e.state.times.review, e.state.times.dub);
          const failed = !act && ej[0] && ["failed", "interrupted"].includes(ej[0].status) && new Date(ej[0].endedAt).getTime() > diskT ? ej[0] : null;
          const z = (act || ej.find((j) => j.type === "translate"))?.progress?.zhvi;
          const scope = act?.progress?.zhvi?.plan ? act.progress.zhvi
            : e.state.status === "translated" || e.state.status === "dubbed" ? { subs: Object.fromEntries(plan.map((x) => [x.id, { status: "ran" }])) }
              : z?.plan ? z : { subs: Object.fromEntries(e.state.paid.map((id) => [id, { status: "ran" }])), gate: e.state.status === "review" ? { stopped: true } : null };
          return html`<tr class="click" data-href="#/series/${enc(slug)}/ep/${enc(e.ep)}">
            <td><b>${e.ep}</b></td>
            <td style="max-width:320px">${e.title || e.videoId}<div class="dim small">${e.duration ? mmss(e.duration) : ""}</div></td>
            <td>${act ? pill(JOB_ST[act.status]) : failed ? html`<span class="pill p-err" title="${failed.error || ""}">lỗi ở lần chạy trước</span>` : pill(EP_ST[e.state.status])}
              ${e.state.labelsStale ? html`<div class="small" style="color:var(--act)">nhãn soát mới hơn bản dịch</div>` : ""}
              ${e.state.dubStale ? html`<div class="small" style="color:var(--warn)">lồng tiếng cũ hơn bản dịch</div>` : ""}</td>
            <td>${act ? html`<div data-live-job="${act.id}" data-mode="mini" style="min-width:220px">${liveJob(act, "mini")}</div>` : timeline(scope, plan, { compact: true })}</td>
            <td class="num money">${money(e.state.lastCost)}</td>
            <td>${failed ? html`<div class="row">${btn("Chạy lại", { url: `/api/jobs/${failed.id}/retry`, cls: "sm pri" })}${link("Xem lỗi", `#/jobs/${failed.id}`, "sm ghost")}</div>` : epAction(s, e, act)}</td></tr>`;
        })}</table></div>
      ${legend}`);
  };
  await render();
  return { refresh: render };
}

// ===== Duyệt bible (nhúng trang zhvi) =====
async function viewBible([slug]) {
  const s = await api(`/api/series/${enc(slug)}`);
  if (!s.draft?.page) {
    setMain(html`<div class="card empty"><b>Chưa có trang duyệt</b>Dựng bible nháp trước. ${link("Về series", `#/series/${enc(slug)}`)}</div>`);
    return {};
  }
  setMain(html`
    <div class="crumb"><a href="#/series">Series</a> › <a href="#/series/${enc(slug)}">${s.title}</a> ›</div>
    <div class="page-h"><div><h1>Duyệt bible</h1>
      <div class="sub">Soát phía tiếng Việt: nghe giọng, đọc cảnh (bấm <b>▶ Xem cảnh</b> để xem đúng đoạn phim), sửa tên/giới tính/ngoại hình nếu sai,
        gộp mục trùng người, thêm nhân vật máy bỏ sót ở cuối trang. Không sửa = đồng ý với máy.
        Xong bấm <b>«Lưu &amp; áp dụng bible»</b> ở góc trên trang.</div></div></div>
    ${s.status === "approved" ? html`<div class="callout warn" style="margin-bottom:12px">Series đã có bible. Áp dụng lại sẽ đổi phiên bản bible → các tập đã dịch chạy lại phần gán người nói và dịch (tốn tiền lại).</div>` : ""}
    <iframe class="frame" src="/review/bible/${enc(slug)}"></iframe>`);
  return {};
}

// ===== Một tập =====
async function viewEpisode([slug, ep, tab]) {
  const plan = S.meta.plan;
  let d = await api(`/api/series/${enc(slug)}/ep/${enc(ep)}`);
  const defTab = { review: "speakers", translated: "translation", dubbed: "dub" }[d.state.status] || "progress";
  tab = tab || defTab;
  const base = `#/series/${enc(slug)}/ep/${enc(ep)}`;
  const url = `/api/series/${enc(slug)}/ep/${enc(ep)}`;
  const epJobs = () => jobsFor((j) => j.params?.slug === slug && String(j.params?.ep) === String(ep));
  const previewJob = () => activeOf(jobsFor((j) => j.type === "preview" && j.params?.videoId === d.videoId));
  // video.mp4 gốc mã hoá HEVC thì trình duyệt không phát được (xem scan.js videoCodec) — dựng bản
  // xem trước riêng thay vì hiện khung đen/đứng hình khó hiểu
  function previewNotice() {
    const pj = previewJob();
    if (pj) return html`<div data-live-job="${pj.id}" data-mode="card">${liveJob(pj)}</div>`;
    return html`<div class="empty"><b>Video gốc mã hoá HEVC, trình duyệt không phát được</b>
      ${btn("Dựng bản xem trước", { url: d.urls.buildPreview, cls: "sm pri", ok: "Đang dựng bản xem trước…" })}</div>`;
  }
  // lõi dịch của tập (v2 = 2 task todo LLM, v1 = nhiều lượt API). Server chọn recipe theo cái này;
  // màn hình chỉ đổi mấy chỗ thật sự khác nhau (tên bước, nút chạy lại), không có màn hình riêng.
  const v2 = d.state.engine === "v2";

  function header() {
    const ej = epJobs();
    const act = activeOf(ej);
    const st = d.state.status;
    const diskT = Math.max(d.state.times.translation, d.state.times.review, d.state.times.dub);
    const failed = !act && ej[0] && ["failed", "interrupted"].includes(ej[0].status) && new Date(ej[0].endedAt).getTime() > diskT ? ej[0] : null;
    let primary = "";
    if (act) primary = "";
    else if (d.seriesStatus !== "approved") primary = link("Duyệt bible trước", `#/series/${enc(slug)}/bible`, "pri act");
    else if (st === "idle" || st === "partial" || st === "reviewed") primary = btn(st === "reviewed" ? "Dịch tiếp" : "Dịch tập này", { url: `${url}/translate`, cls: "pri", go: `${base}/progress` });
    else if (st === "review") primary = link("Soát người nói", `${base}/speakers`, "pri act");
    const tabs = [["progress", "Tiến độ"], ["speakers", "Soát người nói", st === "review" ? "!" : ""], ["translation", "Bản dịch"], ["dub", "Lồng tiếng"],
      ["log", "Log"]];
    return html`
      <div class="crumb"><a href="#/series">Series</a> › <a href="#/series/${enc(slug)}">${d.seriesTitle}</a> ›</div>
      <div class="page-h"><div><h1>Tập ${d.ep}</h1><div class="sub">${d.title || d.videoId}${d.duration ? ` · ${mmss(d.duration)}` : ""}</div></div>
        <span class="grow"></span><span class="pill p-mute" title="${v2 ? "zhvi2: 2 task todo LLM mỗi tập" : "zhvi v1: nhiều lượt API"}">lõi ${d.state.engine}</span>
        ${act ? pill(JOB_ST[act.status]) : pill(EP_ST[st])}${primary}
        <details style="position:relative"><summary class="btn ghost sm" style="list-style:none">⋯</summary>
          <div class="card card-b stack" style="position:absolute;right:0;top:34px;z-index:5;min-width:260px;gap:8px">
            ${v2 ? btn("Dịch lại (chỉ lượt dịch)", { url: `${url}/translate`, body: { force: "T" }, cls: "sm", confirm: "Chạy lại lượt dịch (1 task todo, ~10 phút)? Phần hiểu tập và nhãn người soát giữ nguyên.", go: `${base}/progress` })
              : btn("Dịch lại từ bước dịch (C trở đi)", { url: `${url}/translate`, body: { force: "C" }, cls: "sm", confirm: "Dịch lại từ pass C (tốn tiền C+D, ~$0.03)? Sửa ASR và gán người nói giữ nguyên.", go: `${base}/progress` })}
            ${btn("Chạy lại toàn bộ (tính tiền lại)", { url: `${url}/translate`, body: { force: "all" }, cls: "sm danger", confirm: "Chạy lại mọi bước tốn tiền của tập này?", go: `${base}/progress` })}
            ${btn(v2 ? "Chạy bằng lõi cũ v1 (dự phòng)" : "Chạy bằng lõi v2 (todo LLM)", { url: `${url}/translate`, body: { engine: v2 ? "v1" : "v2" }, cls: "sm", confirm: v2 ? "Dịch tập này lại bằng lõi v1 (nhiều lượt API, ~$0.03)? Kết quả v2 vẫn giữ." : "Dịch tập này bằng lõi v2 (2 task todo LLM)? Kết quả v1 vẫn giữ làm dự phòng.", go: `${base}/progress` })}
            ${openBtn(d.state.outDir, "Mở thư mục kết quả zhvi")}${openBtn(d.dir, "Mở thư mục video")}
          </div></details></div>
      ${failed ? html`<div class="callout err" style="margin-bottom:12px"><b>${failed.title} — lỗi.</b> Phần đã chạy xong được giữ, chạy lại là đi tiếp.
        <div class="err-text">${failed.error}</div>
        <div class="row">${btn("Chạy lại", { url: `/api/jobs/${failed.id}/retry`, cls: "sm pri" })}${link("Xem log", `#/jobs/${failed.id}`, "sm")}</div></div>` : ""}
      <nav class="tabs">${tabs.map(([k, t, badge]) => html`<a href="${base}/${k}" class="${tab === k ? "on" : ""}">${t}${badge ? html`<span class="count act">${badge}</span>` : ""}</a>`)}</nav>`;
  }

  async function body() {
    const ej = epJobs();
    const act = activeOf(ej);
    if (tab === "progress") {
      const last = act || ej.find((j) => ["translate", "translate2", "speakerApply", "speakerApply2"].includes(j.type)) || ej[0];
      const z = last?.progress?.zhvi;
      const staticScope = ["translated", "dubbed"].includes(d.state.status)
        ? { subs: Object.fromEntries(plan.map((x) => [x.id, { status: "ran" }])) }
        : { subs: Object.fromEntries(d.state.paid.map((id) => [id, { status: "ran" }])), gate: d.state.status === "review" ? { stopped: true } : null };
      // v2 không đi qua A–E của v1: hai task todo, cổng soát nằm giữa. Vẽ đúng 4 bước đó.
      const paid = new Set(d.state.paid);
      const V2STEPS = [["V", "Hình (VLM)"], ["U", "Hiểu tập"], ["—", "Soát người nói"], ["T", "Dịch"], ["E", "Xuất"]];
      const v2steps = html`<div class="row" style="flex-wrap:wrap;gap:6px">${V2STEPS.map(([id, name]) => {
        const done = id === "—" ? d.state.times.labels > 0 : id === "E" ? d.state.times.translation > 0 : paid.has(id);
        return html`<span class="pill ${done ? "p-ok" : "p-mute"}">${done ? "✓ " : ""}${name}</span>`;
      })}</div>`;
      return html`<div class="stack">
        ${act ? html`<div class="card card-b" data-live-job="${act.id}" data-mode="card">${liveJob(act)}</div>` : ""}
        ${!act ? html`<div class="card card-b stack">
          <div class="row"><h3>${v2 ? "Các bước (lõi v2 — todo LLM)" : "Các bước zhvi"}</h3><span class="grow"></span>${d.state.lastCost ? html`<span class="money">lượt gần nhất ${money(d.state.lastCost)}</span>` : ""}</div>
          ${v2 ? v2steps : timeline(z?.plan && last?.type === "translate" ? z : staticScope, plan)}
          ${v2 ? html`<div class="dim small">Mỗi tập <b>2 task todo LLM</b> (~10 phút/task): <b>hiểu tập</b> (sửa ASR, gán người nói, cắt câu nhiều người, dịch thô) → cổng soát → <b>dịch</b>.
            Kết quả ở <code>${d.state.outDir}</code>.</div>` : ""}
          ${d.state.dataStale ? html`<div class="callout warn">Bản dịch này <b>chưa nằm trong thư mục video</b>, mà lồng tiếng đọc ở đó — chạy lại tập để ghi sang (không tốn lượt LLM nào, phần đã chạy được dùng lại).
            ${btn("Ghi sang thư mục video", { url: `${url}/translate`, cls: "sm pri", go: `${base}/progress` })}</div>` : ""}
          ${!v2 && z?.plan ? zhviNow(z) : ""}
          ${v2 ? "" : legend}
          ${d.state.status === "review" ? html`<div class="callout act">Máy chưa chắc ai nói một số câu — soát xong tập tự dịch tiếp. ${link("Soát người nói", `${base}/speakers`, "sm pri act")}</div>` : ""}
          ${["translated", "dubbed"].includes(d.state.status) ? html`<div class="callout info">Đã dịch xong ${d.segments.length} câu. ${link("Xem bản dịch", `${base}/translation`, "sm")} ${link("Lồng tiếng", `${base}/dub`, "sm pri")}</div>` : ""}
          ${d.backup ? html`<div class="dim small">Lõi ${d.backup.engine} còn một bản dịch ${d.backup.lines} câu ở <code>${d.backup.outDir}</code> — giữ làm dự phòng, không dùng để lồng tiếng.
            ${d.backup.reviewUrl ? html`<a href="${d.backup.reviewUrl}" target="_blank">xem trang soát của bản đó</a>` : ""}</div>` : ""}
        </div>` : ""}
        ${ej.length ? html`<div class="card tw"><div class="card-h"><h3>Lịch sử việc của tập</h3></div><table class="t">
          ${ej.slice(0, 12).map((j) => html`<tr class="click" data-href="#/jobs/${j.id}"><td>${j.title}</td><td>${pill(JOB_ST[j.status])}</td>
            <td class="dim">${ago(j.createdAt)}</td><td class="dim">${elapsed(j)}</td><td class="num money">${money(j.usd)}</td></tr>`)}</table></div>` : ""}
      </div>`;
    }
    if (tab === "speakers") {
      if (!d.urls.review) return html`<div class="card empty"><b>Không có gì để soát</b>Trang soát người nói chỉ có khi máy dừng ở cổng soát (sau pass B).</div>`;
      return html`
        ${d.state.status !== "review" ? html`<div class="callout info" style="margin-bottom:10px">Tập này đã soát và đã dịch.
          Sửa nhãn rồi gửi lại thì nhãn của bạn được áp ngay và là bản cuối — <b>không</b> hỏi lại LLM.
          ${v2 ? "Câu nào đổi người sau khi đã dịch thì bị đánh dấu «xưng hô có thể lệch» để bạn tự sửa câu chữ; muốn máy dịch lại cả tập thì dùng «Dịch lại (chỉ lượt dịch)» ở menu ⋯." : ""}</div>` : ""}
        <div class="callout act" style="margin-bottom:10px">Chốt <b>cụm giọng</b> trước (sửa một lần là cả cụm), rồi mới tới câu lẻ được đánh dấu. Phím <b>Space</b> phát câu đang trỏ.
          ${v2 ? html`Câu có hai người nói thì chọn <b>«nhiều người»</b> rồi bấm vào khe giữa hai chữ để <b>cắt</b>, mỗi mảnh chọn một người.` : ""}
          Xong bấm <b>«Lưu &amp; dịch tiếp»</b> ở góc trên trang — nhãn được nạp và tập đi tiếp.</div>
        <iframe class="frame" src="${d.urls.review}"></iframe>`;
    }
    if (tab === "translation") {
      if (!d.segments.length) return html`<div class="card empty"><b>Chưa có bản dịch</b>${d.state.status === "review" ? "Soát người nói xong thì tập dịch tiếp." : "Bấm «Dịch tập này»."}</div>`;
      const names = [...new Set(d.segments.map((s) => s.name).filter(Boolean))];
      const rate = (s) => (s.vi ? s.vi.trim().split(/\s+/).length / Math.max(0.3, s.end - s.start) : 0);
      const flagged = d.segments.filter((s) => s.needsReview || s.suspect || rate(s) > d.cps * 1.25).length;
      return html`<div class="split">
        <div class="player card card-b">
          ${d.urls.video ? html`<video id="vid" controls preload="metadata" src="${d.urls.video}" crossorigin="anonymous">
            <track kind="subtitles" srclang="vi" label="Tiếng Việt" src="${url}/subs.vtt" default>
            <track kind="subtitles" srclang="zh" label="中文" src="${url}/subs.vtt?lang=zh"></video>`
            : d.needsPreview ? previewNotice() : html`<div class="empty">không có video.mp4</div>`}
          <div class="row small dim"><span>${d.segments.length} câu</span><span>·</span><span>${flagged} câu nên xem</span><span>·</span>
            <span>${d.speakerReviewed ? "người nói đã soát" : "người nói do máy chốt"}</span><span class="grow"></span>
            <label class="chk"><input type="checkbox" id="follow" checked> cuộn theo video</label></div>
          <div class="row">${d.urls.srt ? html`<a class="btn sm" href="${d.urls.srt}" download="tap-${d.ep}.vi.srt">Tải phụ đề .srt</a>` : ""}${link("Lồng tiếng →", `${base}/dub`, "sm pri")}</div>
          <div class="dim small">Bấm ✎ ở một câu để sửa. Câu sửa tay được giữ khi chạy lại zhvi; lồng tiếng lại chỉ làm lại những câu đã đổi.</div>
        </div>
        <div class="card">
          ${d.staleEdits.length ? html`<div class="callout warn" style="margin:12px">
            <b>${d.staleEdits.length} câu bạn sửa tay không còn khớp bản dịch mới</b> (máy tách/gộp câu khác đi) — chưa áp. Sửa lại ở câu tương ứng rồi bỏ bản cũ.
            ${d.staleEdits.map((x) => html`<div class="row small" style="margin-top:6px"><span class="zh dim">${x.zh}</span><span>→ <b>${x.vi}</b></span><span class="grow"></span>${btn("Bỏ", { url: `${url}/line`, body: { index: x.index, drop: true }, cls: "sm ghost", ok: "Đã bỏ bản sửa cũ" })}</div>`)}</div>` : ""}
          <div class="card-h"><div class="seg" id="lf"><button data-f="all" class="on">Tất cả</button><button data-f="flag">Nên xem (${flagged})</button></div>
            <select id="ls"><option value="">mọi nhân vật</option>${names.map((n) => html`<option>${n}</option>`)}</select>
            <input type="search" id="lq" placeholder="tìm câu…" style="flex:1;min-width:120px"></div>
          <div class="lines" id="lines">${d.segments.map((s, i) => {
            const long = rate(s) > d.cps * 1.25;
            return html`<div class="ln" data-idx="${s.i}" data-start="${s.start}" data-end="${s.end}" data-flag="${s.needsReview || s.suspect || long ? 1 : 0}" data-name="${s.name || ""}">
              <div class="tm">${mmss(s.start)}</div>
              <div><div>${s.name ? spk(s.name) : ""}<span class="vi">${s.vi || html`<span class="faint">(không dịch)</span>`}</span>
                <button class="edit" title="Sửa câu dịch — giữ nguyên khi chạy lại">✎</button>
                ${s.edited ? html`<span class="flag ed" title="đã sửa tay">sửa tay</span>` : ""}
                ${s.needsReview ? html`<span class="flag rv" title="${(s.review || []).join(" · ") || "critic chấm thấp / luật code báo lỗi"}">cần xem</span>` : ""}
                ${s.suspect ? html`<span class="flag sp" title="${JSON.stringify(s.suspect)}">nghi người nói</span>` : ""}
                ${s.voiceSafe === false ? html`<span class="flag ln2" title="máy tự cắt/đổi người mà bạn chưa chốt — không dùng làm mẫu clone giọng">máy tách/đổi</span>` : ""}
                ${long ? html`<span class="flag ln2" title="${rate(s).toFixed(1)} âm tiết/giây — lồng tiếng dễ tràn khung">dài</span>` : ""}</div>
                <div class="zhl zh">${s.zh}</div></div></div>`;
          })}</div></div></div>`;
    }
    if (tab === "dub") {
      if (!["translated", "dubbed"].includes(d.state.status)) return html`<div class="card empty"><b>Chưa lồng tiếng được</b>Dịch xong tập trước đã.</div>`;
      const ttsJob = ej.find((j) => j.type === "tts");
      return html`<div class="split">
        <div class="player card card-b">
          ${!act && d.urls.dub && d.dub && ttsJob?.status !== "failed" ? html`<div class="callout ok" id="dubOk"><b>✓ Đã lồng tiếng thành công</b>
            <div class="small">VieNeu ${d.dub.engine} · ${d.dub.synth === "preset" ? "giọng có sẵn" : "clone"} · ${d.dub.bed === "original" ? "giữ tiếng Trung gốc" : "bỏ tiếng Trung"} · ${d.dub.lines} câu${d.dub.overflow.length ? `, ${d.dub.overflow.length} câu tràn khung` : ""}${ttsJob?.status === "done" && ttsJob.endedAt ? ` · ${ago(ttsJob.endedAt)}` : ""}${ttsJob?.usd ? ` · ${money(ttsJob.usd)}` : ""}</div></div>` : ""}
          ${d.urls.dub ? html`<video id="dubv" controls preload="metadata" src="${d.urls.dub}"></video>
            <div class="row">
              <div class="seg" id="srcSeg"><button data-src="dub" class="on">Lồng tiếng Việt</button>
                <button data-src="orig" ${d.urls.video ? "" : "disabled"} title="${d.urls.video ? "" : (d.needsPreview ? "video gốc mã hoá HEVC — cần dựng bản xem trước trước" : "không có video.mp4")}">Bản gốc</button></div>
              <span class="grow"></span><a class="btn sm" href="${d.urls.dub}" download="tap-${d.ep}-long-tieng.mp4">Tải mp4</a></div>
            ${d.needsPreview ? previewNotice() : ""}
            ${d.state.dubStale ? html`<div class="callout warn">Bản lồng tiếng cũ hơn bản dịch hiện tại — lồng tiếng lại để khớp.</div>` : ""}`
            : html`<div class="empty"><b>Chưa có bản lồng tiếng</b>Chọn engine rồi bấm «Lồng tiếng».</div>`}
          ${act?.type === "tts" ? html`<div data-live-job="${act.id}" data-mode="card">${liveJob(act)}</div>` : ""}
          ${!act && ttsJob?.status === "failed" ? html`<div class="callout err"><b>Lần lồng tiếng trước hỏng</b><div class="err-text">${ttsJob.error}</div></div>` : ""}
          ${act ? "" : html`<form id="ttsForm" class="stack" style="gap:10px">
            <div class="row">
              <select name="engine"><option value="v3">VieNeu v3 (mặc định)</option><option value="v4">VieNeu v4 (clone tốt hơn, đắt hơn)</option></select>
              <select name="mode" title="Clone bị VieNeu giới hạn theo ngày/tháng; giọng có sẵn thì không">
                <option value="clone">Clone giọng từ mẫu (tính hạn mức clone)</option>
                <option value="preset">Giọng có sẵn của VieNeu (không clone)</option></select>
              <select name="bed" title="Âm thanh nền dưới giọng Việt">
                <option value="vocals-removed">Bỏ tiếng Trung gốc (tách bằng demucs, giữ nhạc nền)</option>
                <option value="original">Giữ tiếng Trung gốc (nghe cả Trung + Việt)</option></select>
              <select name="origDb" title="Giọng Trung gốc to cỡ nào so với giọng Việt (tự đo, tự hạ thêm khi giọng Việt đang nói); nhạc nền không đổi" hidden>
                <option value="-14">Tiếng Trung nhỏ</option>
                <option value="-8">Tiếng Trung vừa</option>
                <option value="-3">Tiếng Trung to</option></select>
              <label class="chk" id="reextractLbl"><input type="checkbox" name="reextract"> tách lại giọng mẫu</label>
              <button class="btn pri">${d.urls.dub ? "Lồng tiếng lại" : "Lồng tiếng"}</button></div>
            <div id="presetBox" class="stack" style="gap:6px" hidden></div></form>
            <div class="dim small">Chạy tuần tự 1 luồng (VieNeu giới hạn tốc độ) — tập 5 phút mất cỡ vài chục phút. Đóng trang vẫn chạy.
              «Giữ tiếng Trung gốc» = nhạc nền + giọng Trung (đã tách, hạ nhỏ) dưới giọng Việt: giọng Trung được đo rồi cân theo giọng Việt, tự hạ thêm lúc giọng Việt đang nói, nhạc nền giữ nguyên. Đổi kiểu nền hay mức to nhỏ rồi «Lồng tiếng lại» thì dùng lại clip đã đọc, không tốn thêm token.</div>`}
        </div>
        <div class="stack">
          <div class="card"><div class="card-h"><h3>Giọng nhân vật</h3></div><div class="tw"><table class="t">
            ${d.voices.map((v) => html`<tr><td>${spk(v.name)}<span class="dim small zh">${v.speaker !== v.name ? v.speaker : ""}</span></td>
              <td class="num">${v.lines} câu</td>
              <td>${v.preset ? html`<span class="pill p-ok" title="lần lồng tiếng gần nhất dùng giọng có sẵn này">${v.preset}</span>`
                : v.source === "series" ? html`<span class="pill p-ok" title="dùng chung cho mọi tập của series">giọng series</span>`
                : v.source === "episode" ? html`<span class="pill p-q">mẫu của tập này</span>` : html`<span class="pill p-mute">chưa có mẫu</span>`}</td>
              <td>${v.refUrl ? html`<audio controls preload="none" style="height:28px;width:180px" src="${v.refUrl}"></audio>` : ""}</td></tr>`)}
          </table></div>
          <div class="card-b dim small">Tập đầu tiên được lồng tiếng đặt giọng cho nhân vật; các tập sau dùng chung để giọng không đổi giữa các tập. «Tách lại giọng mẫu» thay giọng series bằng mẫu của tập này.</div></div>
          ${d.dub ? html`<div class="card"><div class="card-h"><h3>Câu tràn khung</h3><span class="dim small">${d.dub.overflow.length}/${d.dub.lines} câu · engine ${d.dub.engine} · nền ${d.dub.bed === "original" ? "gốc (còn tiếng Trung)" : "đã bỏ tiếng Trung"}</span></div>
            ${d.dub.overflow.length ? html`<div class="lines" style="max-height:420px">${d.dub.overflow.map((o) => html`<div class="ln" data-start="${o.start}">
              <div class="tm">${mmss(o.start)}</div><div>${o.speaker ? spk(o.speaker) : ""}<span class="vi">${o.vi}</span>
              <div class="small" style="color:var(--err)">thừa ${o.over}s dù đã nén ${o.tempo}× — <a href="${base}/translation" data-focus="${o.index}">rút gọn câu này</a></div></div></div>`)}</div>`
              : html`<div class="card-b dim">Không câu nào tràn — mọi câu vừa khung.</div>`}</div>` : ""}
        </div></div>`;
    }
    if (tab === "log") {
      const j = act || ej[0];
      if (!j) return html`<div class="card empty"><b>Chưa có việc nào</b></div>`;
      const lp = await logPanel(j.id);
      queueMicrotask(() => lp.fill(main()));
      return html`<div class="stack"><div class="row"><b>${j.title}</b>${pill(JOB_ST[j.status])}<span class="grow"></span><a class="btn sm" href="/api/jobs/${j.id}/log" target="_blank">Log đầy đủ</a></div>${lp.box}</div>`;
    }
    return "";
  }

  function openEditor(r) {
    if ($(".editor", r)) return;
    const seg = d.segments.find((s) => s.i === r.dataset.idx);
    if (!seg) return;
    const room = Math.max(0.3, seg.end - seg.start);
    const box = document.createElement("div");
    box.className = "editor";
    box.innerHTML = val(html`<textarea rows="2">${seg.vi || ""}</textarea>
      <div class="row small"><span class="dim rate"></span><span class="grow"></span>
        ${seg.edited ? html`<button class="btn sm ghost" data-x="revert">Về bản máy</button>` : ""}
        <button class="btn sm ghost" data-x="cancel">Huỷ</button><button class="btn sm pri" data-x="save">Lưu</button></div>`);
    r.lastElementChild.append(box);
    const ta = $("textarea", box);
    const rate = () => {
      const n = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0;
      const v = n / room;
      $(".rate", box).textContent = `${n} âm tiết / ${room.toFixed(1)}s = ${v.toFixed(1)}/s${v > d.cps * 1.25 ? " — dài, dễ tràn khung khi lồng tiếng" : ""}`;
    };
    rate();
    ta.oninput = rate;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const save = async (text) => {
      try {
        const res = await api(`${url}/line`, { method: "POST", body: { index: seg.i, vi: text } });
        seg.vi = res.vi;
        seg.edited = res.edited;
        box.remove();
        $(".vi", r).textContent = res.vi;
        $(".flag.ed", r)?.remove();
        if (res.edited) $(".edit", r).insertAdjacentHTML("afterend", '<span class="flag ed" title="đã sửa tay">sửa tay</span>');
        toast(res.edited ? "Đã lưu — giữ nguyên khi chạy lại zhvi" : "Đã về bản máy dịch", "ok");
      } catch (ex) {
        toast(ex.message, "err");
      }
    };
    box.onclick = (ev) => {
      const x = ev.target.closest("[data-x]")?.dataset.x;
      if (!x) return;
      ev.stopPropagation();
      if (x === "cancel") box.remove();
      else if (x === "save") save(ta.value);
      else if (x === "revert") save(null);
    };
    ta.onkeydown = (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        save(ta.value);
      } else if (ev.key === "Escape") box.remove();
    };
  }

  function wire() {
    const vid = $("#vid");
    const lines = $("#lines");
    if (lines) {
      lines.onclick = (e) => {
        if (e.target.closest(".editor")) return;
        const r = e.target.closest(".ln");
        if (!r) return;
        if (e.target.closest(".edit")) return openEditor(r);
        if (!vid) return;
        vid.currentTime = Number(r.dataset.start) + 0.01;
        vid.play();
      };
      if (S.focusLine !== undefined) {
        const r = lines.querySelector(`[data-idx="${CSS.escape(String(S.focusLine))}"]`);
        S.focusLine = undefined;
        if (r) {
          r.scrollIntoView({ block: "center" });
          openEditor(r);
        }
      }
    }
    for (const a of $$("[data-focus]")) {
      a.onclick = (ev) => {
        ev.stopPropagation();
        S.focusLine = a.dataset.focus;
      };
    }
    if (vid && lines) {
      let cur = null;
      vid.ontimeupdate = () => {
        const t = vid.currentTime;
        const r = [...lines.children].find((x) => t >= Number(x.dataset.start) && t < Number(x.dataset.end) + 0.15);
        if (r === cur) return;
        cur?.classList.remove("now");
        cur = r;
        if (r) {
          r.classList.add("now");
          if ($("#follow")?.checked) r.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      };
      const filt = () => {
        const f = $("#lf .on").dataset.f;
        const n = $("#ls").value;
        const q = $("#lq").value.toLowerCase();
        for (const r of lines.children) r.hidden = (f === "flag" && r.dataset.flag !== "1") || (n && r.dataset.name !== n) || (q && !r.textContent.toLowerCase().includes(q));
      };
      $("#lf").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; $$("#lf button").forEach((x) => x.classList.toggle("on", x === b)); filt(); };
      $("#ls").onchange = filt;
      $("#lq").oninput = filt;
    }
    const dubv = $("#dubv");
    if (dubv) {
      $("#srcSeg").onclick = (e) => {
        const b = e.target.closest("[data-src]");
        if (!b) return;
        const t = dubv.currentTime;
        const playing = !dubv.paused;
        dubv.src = b.dataset.src === "dub" ? d.urls.dub : d.urls.video;
        dubv.currentTime = t;
        if (playing) dubv.play();
        $$("#srcSeg button").forEach((x) => x.classList.toggle("on", x === b));
      };
      for (const r of $$(".ln[data-start]")) r.onclick = () => { dubv.currentTime = Number(r.dataset.start); dubv.play(); };
    }
    const f = $("#ttsForm");
    if (f) {
      // Chế độ «giọng có sẵn»: mỗi nhân vật một ô chọn giọng, danh sách lấy từ VieNeu theo engine.
      // Nhớ lựa chọn của series (d.presets) và của ô đang chọn khi đổi engine.
      const box = $("#presetBox");
      const preset = () => f.mode.value === "preset";
      const picks = () => Object.fromEntries($$("select[data-sp]", box).filter((s) => s.value).map((s) => [s.dataset.sp, s.value]));
      // vẽ lại tab (job khác vừa xong…) không được làm mất lựa chọn đang dở
      const draft = ((S.ttsDraft ??= {})[url] ??= {});
      let loaded = null;
      const label = (v) => (v.kind === "cloned" ? `${v.name} (bạn đã clone)` : `${v.name} — ${v.description}`);
      const GROUPS = { cloned: "Giọng bạn đã clone (dùng lại không tốn lượt clone)", male: "Nam", female: "Nữ", other: "Khác" };
      const groupOf = (v) => (v.kind === "cloned" ? "cloned" : v.gender === "male" || v.gender === "female" ? v.gender : "other");
      const paintPreset = async () => {
        $("#reextractLbl").hidden = preset();
        box.hidden = !preset();
        if (!preset() || loaded === f.engine.value) return;
        const keep = { ...d.presets, ...draft.picks, ...picks() };
        const engine = f.engine.value;
        box.innerHTML = val(html`<div class="dim small">Đang tải danh sách giọng VieNeu…</div>`);
        let list;
        try {
          list = (await api(`/api/vieneu/voices?engine=${engine}`)).voices;
        } catch (ex) {
          box.innerHTML = val(html`<div class="callout err">${ex.message}</div>`);
          return;
        }
        if (f.engine.value !== engine) return; // đổi engine trong lúc chờ: lượt vẽ mới lo
        loaded = engine;
        const by = Object.groupBy(list, groupOf);
        box.innerHTML = val(html`${d.voices.map((v) => {
          // giới tính của nhân vật (từ bible) đưa nhóm cùng giới lên trước — đỡ cuộn qua 300 giọng
          const order = ["cloned", v.gender, "male", "female", "other"].filter((g, i, a) => g && a.indexOf(g) === i);
          return html`<div class="row"><span style="min-width:140px">${spk(v.name)}${v.gender ? html` <span class="dim small">${v.gender === "male" ? "nam" : "nữ"}</span>` : ""}</span>
            <span class="dim small" style="min-width:52px">${v.lines} câu</span>
            <select data-sp="${v.speaker}" style="flex:1;min-width:220px"><option value="">— chọn giọng —</option>
              ${order.filter((g) => by[g]).map((g) => html`<optgroup label="${GROUPS[g]}">${by[g].map((o) => html`<option value="${o.id}">${label(o)}</option>`)}</optgroup>`)}</select></div>`;
        })}<div class="dim small">Giọng có sẵn không tốn hạn mức clone (ngày/tháng); vẫn tính token theo số ký tự. Lựa chọn được nhớ cho cả series.</div>`);
        for (const s of $$("select[data-sp]", box)) if ([...s.options].some((o) => o.value === keep[s.dataset.sp])) s.value = keep[s.dataset.sp];
      };
      f.engine.value = draft.engine ?? f.engine.value;
      f.mode.value = draft.mode ?? (d.dub?.synth === "preset" ? "preset" : "clone");
      f.bed.value = draft.bed ?? d.dub?.bed ?? "vocals-removed"; // mặc định theo lần lồng tiếng gần nhất
      const wantDb = draft.origDb ?? String(d.dub?.origDb ?? -8);
      f.origDb.value = wantDb;
      if (f.origDb.value !== wantDb) f.origDb.value = "-8"; // mức lạ (đặt bằng CLI) → về «vừa»
      const paintBed = () => { f.origDb.hidden = f.bed.value !== "original"; };
      f.bed.addEventListener("change", paintBed);
      paintBed();
      f.mode.onchange = f.engine.onchange = paintPreset;
      // chỉ ghi nhớ những gì NGƯỜI DÙNG chọn: đổi engine làm ô mất giọng không có ở engine kia, đổi lại thì có lại
      f.addEventListener("change", (e) => {
        Object.assign(draft, { mode: f.mode.value, engine: f.engine.value, bed: f.bed.value, origDb: f.origDb.value });
        if (e.target.dataset.sp) (draft.picks ??= {})[e.target.dataset.sp] = e.target.value;
      });
      paintPreset();
      f.onsubmit = async (e) => {
        e.preventDefault();
        const presets = preset() ? picks() : null;
        if (presets) {
          const missing = d.voices.filter((v) => !presets[v.speaker]).map((v) => v.name);
          if (!box.querySelector("select")) return toast("Danh sách giọng chưa tải xong", "err");
          if (missing.length) return toast(`Chưa chọn giọng cho: ${missing.join(", ")}`, "err");
        }
        const how = presets ? "giọng có sẵn — không tốn lượt clone" : "clone từ mẫu";
        const bed = f.bed.value;
        const origDb = bed === "original" ? { origDb: Number(f.origDb.value) } : {};
        const nen = bed === "original" ? `giữ tiếng Trung gốc (${f.origDb.selectedOptions[0].text.toLowerCase()})` : "bỏ tiếng Trung";
        if (!confirm(`Lồng tiếng tập ${d.ep} bằng VieNeu ${f.engine.value}, ${how}, ${nen}? Tính tiền theo token VieNeu.`)) return;
        try {
          const r = await api(`${url}/tts`, { method: "POST", body: presets
            ? { engine: f.engine.value, mode: "preset", presets, bed, ...origDb }
            : { engine: f.engine.value, reextract: f.reextract.checked, bed, ...origDb } });
          S.jobs.set(r.job.id, r.job);
          paintSide();
          toast("Đã xếp lồng tiếng");
          refreshSoon();
        } catch (ex) {
          toast(ex.message, "err");
        }
      };
    }
  }

  async function render(full) {
    if (full) {
      setMain(html`<div id="epHead">${header()}</div><div id="epBody">${await body()}</div>`);
      wire();
    } else {
      $("#epHead").innerHTML = val(header());
      // tab có video/iframe: đừng vẽ lại (mất vị trí phát, mất chỗ đang soát)
      if (!["speakers", "translation", "dub", "v2"].includes(tab) || !$("video, iframe", $("#epBody"))) {
        $("#epBody").innerHTML = val(await body());
        wire();
      }
    }
  }
  await render(true);
  return {
    refresh: async () => {
      d = await api(`/api/series/${enc(slug)}/ep/${enc(ep)}`);
      await render(false);
    },
  };
}

// ===== Việc chạy nền =====
async function viewJobs() {
  let f = "all";
  const render = () => {
    const list = jobList().filter((j) => f === "all" || (f === "active" ? ["running", "queued"].includes(j.status) : ["failed", "interrupted"].includes(j.status)));
    const box = $("#jobsT");
    const content = list.length ? html`<table class="t">
      <tr><th>Việc</th><th>Trạng thái</th><th style="width:220px">Tiến độ</th><th>Bắt đầu</th><th>Thời gian</th><th class="num">Chi phí</th><th></th></tr>
      ${list.map((j) => html`<tr class="click" data-href="#/jobs/${j.id}"><td><b>${j.title}</b><div class="dim small">${j.progress?.detail || (j.status === "failed" ? String(j.error || "").slice(0, 120) : "")}</div></td>
        <td>${pill(JOB_ST[j.status])}</td>
        <td><div class="bar ${j.status}"><i style="width:${Math.round((j.progress?.pct || 0) * 100)}%"></i></div></td>
        <td class="dim">${ago(j.startedAt || j.createdAt)}</td><td class="dim">${elapsed(j)}</td><td class="num money">${money(j.usd)}</td>
        <td>${["running", "queued"].includes(j.status) ? btn("Dừng", { url: `/api/jobs/${j.id}/stop`, cls: "sm ghost", confirm: "Dừng việc này?" }) : ["failed", "stopped", "interrupted"].includes(j.status) ? btn("Chạy lại", { url: `/api/jobs/${j.id}/retry`, cls: "sm" }) : ""}</td></tr>`)}
    </table>` : html`<div class="empty">Không có việc nào.</div>`;
    if (box) box.innerHTML = val(content);
    return content;
  };
  setMain(html`<div class="page-h"><div><h1>Việc chạy nền</h1><div class="sub">Mọi việc chạy bằng đúng lệnh CLI; đóng trang vẫn chạy. Dừng giữa chừng an toàn — chạy lại dùng lại phần đã xong.</div></div></div>
    <div class="toolbar"><div class="seg" id="jf"><button data-f="all" class="on">Tất cả</button><button data-f="active">Đang chạy</button><button data-f="err">Lỗi</button></div></div>
    <div class="card tw" id="jobsT"></div>`);
  render();
  $("#jf").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; f = b.dataset.f; $$("#jf button").forEach((x) => x.classList.toggle("on", x === b)); render(); };
  const t = setInterval(render, 2000);
  return { refresh: render, destroy: () => clearInterval(t) };
}

async function viewJob([id]) {
  const j0 = S.jobs.get(id) || (await api(`/api/jobs/${id}`));
  const lp = await logPanel(id);
  const related = (j) => {
    const p = j.params || {};
    if (p.slug && p.ep) return link("Mở tập", `#/series/${enc(p.slug)}/ep/${enc(p.ep)}`, "sm");
    if (p.slug) return link("Mở series", `#/series/${enc(p.slug)}`, "sm");
    if (p.userId) return link("Mở tác giả", `#/users/${enc(p.userId)}`, "sm");
    return "";
  };
  setMain(html`<div class="crumb"><a href="#/jobs">Việc chạy nền</a> ›</div>
    <div class="page-h"><div><h1>${j0.title}</h1><div class="sub">tạo ${ago(j0.createdAt)} · làn ${j0.lane}${j0.parent ? html` · tiếp nối <a href="#/jobs/${j0.parent}">việc trước</a>` : ""}${j0.nextJob ? html` · đã xếp <a href="#/jobs/${j0.nextJob}">việc tiếp theo</a>` : ""}</div></div>
      <span class="grow"></span>${related(j0)}<a class="btn sm" href="/api/jobs/${id}/log" target="_blank">Log đầy đủ</a></div>
    <div class="stack"><div class="card card-b" data-live-job="${id}" data-mode="card">${liveJob(S.jobs.get(id) || j0)}</div>
    ${lp.box}</div>`);
  lp.fill(main());
  return {};
}

// ---------- router ----------
const ROUTES = [
  [/^#?\/?$/, viewHome],
  [/^#\/users$/, viewUsers],
  [/^#\/users\/([^/]+)$/, viewUser],
  [/^#\/series$/, viewSeriesList],
  [/^#\/series\/([^/]+)$/, viewSeries],
  [/^#\/series\/([^/]+)\/bible$/, viewBible],
  [/^#\/series\/([^/]+)\/ep\/([^/]+)(?:\/(\w+))?$/, viewEpisode],
  [/^#\/jobs$/, viewJobs],
  [/^#\/jobs\/([^/]+)$/, viewJob],
];

async function route() {
  S.view?.destroy?.();
  S.view = null;
  paintNav();
  const h = location.hash || "#/";
  for (const [re, fn] of ROUTES) {
    const m = h.match(re);
    if (!m) continue;
    loading();
    try {
      S.view = await fn(m.slice(1).map((x) => (x === undefined ? undefined : decodeURIComponent(x))));
    } catch (ex) {
      setMain(html`<div class="card empty"><b>Không mở được</b>${ex.message}</div>`);
    }
    window.scrollTo(0, 0);
    return;
  }
  setMain(html`<div class="card empty"><b>Không có trang này</b><a href="#/">Về trang chính</a></div>`);
}

// hàng bảng bấm được
document.addEventListener("click", (e) => {
  if (e.target.closest("a, button, input, select, label, audio, video, details")) return;
  const r = e.target.closest("[data-href]");
  if (r) location.hash = r.dataset.href;
});

window.addEventListener("hashchange", route);
S.meta = await api("/api/meta");
connect();
loadOverview();
setInterval(loadOverview, 60000);
route();
