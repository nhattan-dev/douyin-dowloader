#!/usr/bin/env node
/**
 * Xưởng dịch — UI local cho cả chuỗi: tác giả → video → series → bible → dịch → soát → lồng tiếng.
 *
 *   npm run ui                 mở http://127.0.0.1:5178
 *   npm run ui -- --port 8080
 *
 * Không thêm dependency: node:http + trang tĩnh. Chỉ nghe 127.0.0.1 (không có đăng nhập).
 * Việc nặng chạy bằng đúng các lệnh CLI (xem recipes.js); trạng thái đọc từ đĩa (scan.js).
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pinyin } from "pinyin-pro";

import { STAGES, readEnvFile, subsOf } from "../zhvi/index.js";
import { saveEdit } from "./edits.js";
import { Jobs } from "./jobs.js";
import { recipes, saveSubmission } from "./recipes.js";
import * as scan from "./scan.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(ROOT);
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const PORT = Number(opt("--port", process.env.UI_PORT || 5178));
const HOST = opt("--host", "127.0.0.1");
const PUBLIC = path.join(ROOT, "src/ui/public");

const jobs = await new Jobs({ root: ROOT, dir: path.join(ROOT, "data/_ui"), recipes }).load();

// ---------- http helpers ----------

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".mp4": "video/mp4", ".m4a": "audio/mp4", ".mp3": "audio/mpeg",
  ".wav": "audio/wav", ".jpg": "image/jpeg", ".png": "image/png", ".srt": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".vtt": "text/vtt; charset=utf-8", ".svg": "image/svg+xml",
};

const send = (res, code, body, type = "application/json; charset=utf-8") => {
  const buf = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(buf);
};
const fail = (res, code, msg) => send(res, code, { error: msg });

async function body(req, limit = 32e6) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw Object.assign(new Error("body quá lớn"), { code: 413 });
    chunks.push(c);
  }
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : {};
}

/** File trong ROOT, chỉ các thư mục cho phép; chống ../ */
function safePath(relPath, allowed = ["data", "out", "series"]) {
  const abs = path.resolve(ROOT, relPath);
  const r = path.relative(ROOT, abs);
  if (r.startsWith("..") || path.isAbsolute(r) || !allowed.includes(r.split(path.sep)[0])) return null;
  return abs;
}

async function serveFile(req, res, abs, extraHead = {}) {
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return fail(res, 404, "không có file");
  }
  const type = TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start >= st.size) {
      res.writeHead(416, { "content-range": `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, {
      "content-type": type, "accept-ranges": "bytes", "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${st.size}`, ...extraHead,
    });
    return fs.createReadStream(abs, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "content-length": st.size, "accept-ranges": "bytes", ...extraHead });
  fs.createReadStream(abs).pipe(res);
}

// ---------- SSE ----------

const clients = new Set();
const pendingLogs = new Map();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
jobs.on("job", (j) => broadcast("job", j));
jobs.on("log", (id, line) => {
  if (!pendingLogs.has(id)) pendingLogs.set(id, []);
  pendingLogs.get(id).push(line);
});
setInterval(() => {
  for (const [id, lines] of pendingLogs) broadcast("log", { id, lines });
  pendingLogs.clear();
}, 350).unref();
setInterval(() => {
  for (const c of clients) c.write(": ping\n\n");
}, 20000).unref();

// ---------- ảnh thu nhỏ ----------

let ffBusy = 0;
const ffQueue = [];
function ffmpegThumb(src, dst) {
  return new Promise((resolve) => {
    const go = () => {
      ffBusy += 1;
      execFile("ffmpeg", ["-v", "error", "-y", "-ss", "3", "-i", src, "-frames:v", "1", "-vf", "scale=360:-2", dst], () => {
        ffBusy -= 1;
        ffQueue.shift()?.();
        resolve();
      });
    };
    if (ffBusy < 3) go();
    else ffQueue.push(go);
  });
}

/**
 * Ảnh đại diện series (thẻ ở trang danh sách) = ảnh bìa Douyin của tập đầu (state.json → info.cover),
 * ghép thành khung cùng tỉ lệ với video: ảnh bìa phóng to làm nền mờ, ảnh bìa nét nằm giữa. Ảnh bìa
 * Douyin là ảnh dọc 323x430 nên nhét thẳng vào khung 16:9 sẽ bị viền đen hai bên. Lỗi (không có bìa,
 * tải hỏng) → 404, trang danh sách tự bỏ ảnh, chỉ còn tiêu đề.
 */
async function buildPoster(user, vid, dst) {
  const st = await scan.readJson(path.join("data", user, "state.json"));
  const url = st?.videos?.[vid]?.info?.cover;
  if (!url) return false;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok || !String(res.headers.get("content-type")).startsWith("image/")) return false;
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const src = dst.replace(/\.jpg$/, ".src.jpg");
  await fsp.writeFile(src, Buffer.from(await res.arrayBuffer()));
  // khung theo độ phân giải video (vd. 1920x1080 → 960x540; video dọc → khung dọc), cạnh dài 960
  const meta = await scan.readJson(path.join("data", user, vid, "meta.json"));
  const [rw, rh] = String(meta?.videoResolution ?? "").split("x").map(Number);
  const k = rw > 0 && rh > 0 ? 960 / Math.max(rw, rh) : 960 / 1920;
  const W = 2 * Math.round(((rw > 0 && rh > 0 ? rw : 1920) * k) / 2);
  const H = 2 * Math.round(((rw > 0 && rh > 0 ? rh : 1080) * k) / 2);
  const vf = `split[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:4,eq=brightness=-0.12[bg];`
    + `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`;
  const ok = await new Promise((resolve) => execFile("ffmpeg", ["-v", "error", "-y", "-i", src, "-filter_complex", vf, "-frames:v", "1", "-q:v", "3", dst], (err) => resolve(!err)));
  return ok;
}

// ---------- sức khoẻ hệ thống ----------

let healthCache = null;
async function health() {
  if (healthCache && Date.now() - healthCache.at < 30000) return healthCache.v;
  const env = { ...(await readEnvFile(path.join(ROOT, ".env"))), ...process.env };
  // Windows không có `which`; `where.exe` in mỗi đường dẫn một dòng
  const which = (bin) => new Promise((r) => execFile(process.platform === "win32" ? "where.exe" : "which", [bin],
    (err, out) => r(err ? null : out.trim().split(/\r?\n/)[0])));
  // `env` đã gộp .env — server chạy bằng `node src/ui/server.js` không nạp .env vào process.env
  const py = env.RESEMBLYZER_PYTHON ?? path.join(os.homedir(), "WorkSpace/tools/seed-vc/.venv/bin/python");
  let freeGb = null;
  try {
    const s = await fsp.statfs(ROOT);
    freeGb = Math.round((s.bavail * s.bsize) / 1e9);
  } catch { /* node cũ */ }
  const loginFail = [...jobs.list].reverse().find((j) => ["collect", "fetch", "login"].includes(j.type) && ["done", "failed"].includes(j.status));
  const v = {
    keys: {
      "DashScope (Qwen)": Boolean(env.DASHSCOPE_API_KEY),
      "DeepSeek": Boolean(env.DEEPSEEK_API_KEY),
      "VieNeu (TTS)": Boolean(env.VIENUE_KEY || env.VIENEU_API_KEY),
    },
    tools: {
      ffmpeg: Boolean(await which("ffmpeg")),
      demucs: Boolean(await which("demucs")),
      resemblyzer: Boolean(await scan.mtime(py)),
    },
    browserProfile: Boolean(await scan.mtime(path.join(ROOT, ".browser-profile"))),
    loginSuspect: Boolean(loginFail && loginFail.status === "failed" && /đăng nhập|login|chặn/i.test(loginFail.error || "")),
    freeGb,
  };
  healthCache = { at: Date.now(), v };
  return v;
}

// ---------- hộp "chờ bạn" ----------

async function inbox() {
  const items = [];
  const busy = (pred) => jobs.active(pred).length > 0;
  const h = await health();
  if (h.loginSuspect) {
    items.push({ level: "action", kind: "login", title: "Đăng nhập Douyin lại", detail: "lần quét/tải gần nhất hỏng, nghi phiên đăng nhập đã hết hạn", action: { type: "login", params: {} } });
  }
  for (const s of await scan.listSeries()) {
    const sBusy = busy((j) => j.params?.slug === s.slug);
    const base = `#/series/${encodeURIComponent(s.slug)}`;
    if (s.status === "new" && !sBusy) {
      items.push({ level: "todo", kind: "init", title: `Dựng bible cho «${s.title}»`, detail: `${s.episodes.length + s.extra.length} video`, href: base });
    }
    if (s.mixNews.length && !sBusy) {
      items.push({
        level: "todo", kind: "newEp", title: `«${s.title}» có ${s.mixNews.length} tập mới trong 合集`,
        detail: s.mixNews.map((v) => `tập ${v.ep ?? "?"}: ${v.title}`).join(" · ").slice(0, 200), href: base,
      });
    }
    if (s.status === "draft" && !sBusy) {
      items.push({ level: "action", kind: "bible", title: `Duyệt bible «${s.title}»`, detail: `${s.draft.cast} nhân vật · ${s.draft.doubts.length} điều máy không chắc`, href: `${base}/bible` });
    }
    if (s.status !== "approved") continue;
    const idle = [];
    for (const e of s.episodes) {
      if (!e.state || busy((j) => j.params?.slug === s.slug && String(j.params?.ep) === e.ep)) continue;
      const href = `${base}/ep/${encodeURIComponent(e.ep)}`;
      const st = e.state.status;
      if (st === "review") items.push({ level: "action", kind: "speakers", title: `Soát người nói — «${s.title}» tập ${e.ep}`, detail: "máy còn cụm giọng/câu chưa chắc", href: `${href}/speakers` });
      else if (st === "reviewed") items.push({ level: "todo", kind: "translate", title: `Dịch tiếp «${s.title}» tập ${e.ep}`, detail: "đã soát người nói, chưa chạy tiếp", action: { type: "translate", params: { slug: s.slug, ep: e.ep } } });
      else if (st === "idle" || st === "partial") idle.push(e.ep);
      else if (st === "translated") items.push({ level: "todo", kind: "tts", title: `Xem bản dịch & lồng tiếng — «${s.title}» tập ${e.ep}`, detail: e.state.labelsStale ? "có nhãn soát mới hơn bản dịch" : "đã dịch xong", href: `${href}/translation` });
      else if (st === "dubbed") items.push({ level: "done", kind: "watch", title: `Xem thành phẩm — «${s.title}» tập ${e.ep}`, detail: e.state.dubStale ? "bản lồng tiếng cũ hơn bản dịch" : "đã lồng tiếng", href: `${href}/dub` });
    }
    if (idle.length) items.push({ level: "todo", kind: "translate", title: `Dịch ${idle.length} tập «${s.title}»`, detail: `tập ${idle.join(", ")}`, href: base });
  }
  // việc hỏng mà chưa có lượt nào cùng loại chạy lại sau nó
  const seen = new Set();
  for (const j of [...jobs.list].reverse()) {
    if (seen.has(j.key)) continue;
    seen.add(j.key);
    if (["failed", "interrupted"].includes(j.status)) {
      items.push({ level: "error", kind: "job", title: `Lỗi: ${j.title}`, detail: (j.error || "").slice(0, 220), href: `#/jobs/${j.id}`, job: j.id });
    }
  }
  const order = { action: 0, error: 1, todo: 2, done: 3 };
  return items.sort((a, b) => order[a.level] - order[b.level]);
}

// ---------- router ----------

const routes = [];
const on = (method, pattern, fn) => routes.push([method, new RegExp(`^${pattern}$`), fn]);

on("GET", "/api/overview", async () => ({ inbox: await inbox(), health: await health() }));
on("GET", "/api/meta", async () => ({
  plan: STAGES.flatMap((s) => subsOf(s, { rounds: 2 }).map((x) => ({ id: x.id, stage: s.id, name: x.name, title: x.title, cost: x.cost }))),
  stages: STAGES.map((s) => ({ id: s.id, name: s.name, title: s.title })),
  wsl: /microsoft/i.test(await fsp.readFile("/proc/version", "utf8").catch(() => "")),
}));

// tác giả + video
/**
 * Người dùng dán gì cũng phải ra sec_uid: link trang tác giả, sec_uid trần, hoặc đoạn chia sẻ
 * từ app ("…打开抖音… https://v.douyin.com/xxxx/") — link rút gọn thì lần theo redirect.
 */
async function resolveUser(input) {
  const s = String(input || "").trim();
  let m = s.match(/(MS4wLjABAAAA[\w-]+)/);
  if (m) return m[1];
  let cur = s.match(/https?:\/\/[^\s，。"']+/)?.[0];
  for (let i = 0; cur && i < 6; i++) {
    const r = await fetch(cur, {
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    const loc = r?.headers.get("location");
    if (!loc) break;
    cur = new URL(loc, cur).href;
    if ((m = cur.match(/(MS4wLjABAAAA[\w-]+)/)) && !/\/video\/|\/share\/video\//.test(cur)) return m[1];
    if (/\/video\/\d+|\/share\/video\//.test(cur)) {
      throw Object.assign(new Error("đây là link một VIDEO — mở trang tác giả của video đó rồi copy link trang tác giả"), { code: 400 });
    }
  }
  return null;
}

on("GET", "/api/users", () => scan.listUsers());
on("POST", "/api/users", async (req) => {
  const { input } = await body(req);
  const userId = await resolveUser(input);
  if (!userId) throw Object.assign(new Error("không nhận ra tác giả — dán link trang tác giả (douyin.com/user/…) hoặc link chia sẻ từ app"), { code: 400 });
  return { userId, job: await jobs.enqueue("collect", { userId }) };
});
on("GET", "/api/users/([^/]+)", async (req, [id]) => (await scan.userDetail(id)) ?? Promise.reject(Object.assign(new Error("không có tác giả này"), { code: 404 })));
on("POST", "/api/users/([^/]+)/collect", async (req, [id]) => ({ job: await jobs.enqueue("collect", { userId: id }) }));
on("POST", "/api/users/([^/]+)/fetch", async (req, [id]) => {
  const { videoIds } = await body(req);
  if (!videoIds?.length) throw Object.assign(new Error("chưa chọn video"), { code: 400 });
  return { job: await jobs.enqueue("fetch", { userId: id, videoIds }) };
});
on("POST", "/api/users/([^/]+)/stt", async (req, [id]) => {
  const { videoIds } = await body(req);
  return { job: await jobs.enqueue("stt", { userId: id, videoIds }) };
});
on("GET", "/api/thumb/([^/]+)/([^/]+)", async (req, [user, vid], res) => {
  const video = safePath(path.join("data", user, vid, "video.mp4"));
  if (!video) return fail(res, 400, "sai đường dẫn");
  const dst = path.join(ROOT, "data/_ui/thumbs", `${vid}.jpg`);
  if (!(await scan.mtime(dst))) {
    if (!(await scan.mtime(video))) return fail(res, 404, "chưa tải video");
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await ffmpegThumb(video, dst);
  }
  return serveFile(req, res, dst, { "cache-control": "max-age=86400" });
});

on("GET", "/api/cover/([^/]+)/([^/]+)", async (req, [user, vid], res) => {
  if (!safePath(path.join("data", user, vid))) return fail(res, 400, "sai đường dẫn");
  const dst = path.join(ROOT, "data/_ui/covers", `${vid}.jpg`);
  if (!(await scan.mtime(dst)) && !(await buildPoster(user, vid, dst).catch(() => false))) return fail(res, 404, "không có ảnh bìa");
  return serveFile(req, res, dst, { "cache-control": "max-age=86400" });
});

// video.mp4 gốc mã hoá HEVC thì trình duyệt không phát được — dựng bản xem trước riêng (xem
// scan.js videoCodec + urls.buildPreview), việc chạy nền như mọi việc khác, xong tự hiện qua SSE
on("POST", "/api/preview/([^/]+)/([^/]+)", async (req, [userId, videoId]) => {
  if (!safePath(path.join("data", userId, videoId))) throw Object.assign(new Error("sai đường dẫn"), { code: 400 });
  return { job: await jobs.enqueue("preview", { userId, videoId }) };
});

// series
// tên chữ Hán -> pinyin (杂役合道 -> za-yi-he-dao), không thì thư mục series thành series-<id>
const slugify = (s) => {
  let t = String(s || "");
  if (/[一-鿿]/.test(t)) t = pinyin(t, { toneType: "none", nonZh: "consecutive" });
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[đĐ]/g, "d")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
};

on("GET", "/api/series", () => scan.listSeries());
on("POST", "/api/series", async (req) => {
  const { name, userId, videoIds, init = true } = await body(req);
  if (!userId || !videoIds?.length) throw Object.assign(new Error("cần tác giả và ít nhất một video"), { code: 400 });
  let slug = slugify(name) || `series-${videoIds[0]}`;
  for (let i = 2; await scan.mtime(path.join("series", slug)); i++) slug = `${slugify(name) || `series-${videoIds[0]}`}-${i}`;
  const ids = [...new Set(videoIds)]; // thứ tự tập do trang chọn (số tập 合集, không thì ngày đăng)
  await fsp.mkdir(path.join("series", slug), { recursive: true });
  await fsp.writeFile(path.join("series", slug, "series.json"), JSON.stringify({
    slug, name: name || null, userId, videoIds: ids, createdAt: new Date().toISOString(),
  }, null, 1));
  if (!init) return { slug };
  const missing = [];
  for (const v of ids) if (!(await scan.mtime(path.join("data", userId, v, "transcript.json")))) missing.push(v);
  const then = { type: "seriesInit", params: { slug } };
  const job = missing.length
    ? await jobs.enqueue("fetch", { userId, videoIds: missing, then })
    : await jobs.enqueue(then.type, then.params);
  return { slug, job };
});
on("GET", "/api/series/([^/]+)", async (req, [slug]) => {
  const s = await scan.seriesInfo(slug);
  if (!s) throw Object.assign(new Error("không có series này"), { code: 404 });
  return s;
});
on("POST", "/api/series/([^/]+)/videos", async (req, [slug]) => {
  const { videoIds } = await body(req);
  const file = path.join("series", slug, "series.json");
  const s = await scan.seriesInfo(slug);
  if (!s) throw Object.assign(new Error("không có series này"), { code: 404 });
  const meta = (await scan.readJson(file)) || { slug, name: s.title, userId: s.userId, videoIds: s.episodes.map((e) => e.videoId), createdAt: new Date().toISOString() };
  meta.videoIds = [...new Set([...meta.videoIds, ...videoIds])];
  await fsp.writeFile(file, JSON.stringify(meta, null, 1));
  return { ok: true, videoIds: meta.videoIds };
});
on("POST", "/api/series/([^/]+)/init", async (req, [slug]) => {
  const { force = false } = await body(req);
  const s = await scan.seriesInfo(slug);
  const ids = [...s.episodes.map((e) => e.videoId), ...s.extra];
  const missing = [];
  for (const v of ids) if (!(await scan.mtime(path.join("data", s.userId, v, "transcript.json")))) missing.push(v);
  const then = { type: "seriesInit", params: { slug, force } };
  return { job: missing.length ? await jobs.enqueue("fetch", { userId: s.userId, videoIds: missing, then }) : await jobs.enqueue(then.type, then.params) };
});
on("POST", "/api/series/([^/]+)/bible-review", async (req, [slug]) => {
  const file = await saveSubmission(path.join("series", slug, "draft", "reviews"), "bible-review", await body(req));
  return { file, job: await jobs.enqueue("bibleApply", { slug, file }) };
});
on("POST", "/api/series/([^/]+)/translate-all", async (req, [slug]) => {
  const s = await scan.seriesInfo(slug);
  if (s.status !== "approved") throw Object.assign(new Error("chưa có bible đã duyệt"), { code: 400 });
  const out = [];
  for (const e of s.episodes) {
    if (e.state && ["idle", "partial", "reviewed"].includes(e.state.status)) out.push(await jobs.enqueue("translate", { slug, ep: e.ep }));
  }
  return { jobs: out };
});
on("GET", "/api/series/([^/]+)/ep/([^/]+)", async (req, [slug, ep]) => {
  const d = await scan.episodeDetail(slug, ep);
  if (!d) throw Object.assign(new Error("không có tập này"), { code: 404 });
  delete d.abs;
  return d;
});
on("POST", "/api/series/([^/]+)/ep/([^/]+)/translate", async (req, [slug, ep]) => {
  const { force = null } = await body(req);
  return { job: await jobs.enqueue("translate", { slug, ep, ...(force ? { force } : {}) }) };
});
on("POST", "/api/series/([^/]+)/ep/([^/]+)/speaker-review", async (req, [slug, ep]) => {
  const file = await saveSubmission(path.join("series", slug, "reviews"), `ep${ep}.speaker-review`, await body(req));
  return { file, job: await jobs.enqueue("speakerApply", { slug, ep, file }) };
});
// Danh sách giọng của VieNeu (catalog + giọng bạn đã clone/enrol) — GET /voices chỉ đọc, không tốn token.
// Cache 10 phút: ~1200 giọng, và id trùng giữa v3/v4 nên phải lọc theo engine.
let voicesCache = null;
async function vieneuVoices(engine) {
  if (!voicesCache || Date.now() - voicesCache.at > 600000) {
    const env = { ...(await readEnvFile(path.join(ROOT, ".env"))), ...process.env };
    const key = (env.VIENUE_KEY || env.VIENEU_API_KEY || "").trim();
    if (!key) throw Object.assign(new Error("thiếu VIENUE_KEY trong .env"), { code: 400 });
    const res = await fetch("https://api.vieneu.io/api/v1/voices", {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw Object.assign(new Error(`VieNeu ${res.status} khi lấy danh sách giọng`), { code: 502 });
    voicesCache = { at: Date.now(), list: (await res.json()).voices || [] };
  }
  const seen = new Set();
  return voicesCache.list
    .filter((v) => v.engine === engine && !seen.has(v.id) && seen.add(v.id))
    // giọng đã clone của chính bạn lên đầu: dùng lại không tốn thêm lượt clone nào
    .sort((a, b) => (a.kind === "cloned" ? 0 : 1) - (b.kind === "cloned" ? 0 : 1))
    .map(({ id, name, description, gender, region, kind }) => ({ id, name, description, gender, region, kind }));
}
on("GET", "/api/vieneu/voices", async (req, m, res, url) => {
  const engine = url.searchParams.get("engine") || "v3";
  if (!["v3", "v4"].includes(engine)) throw Object.assign(new Error("engine phải là v3 hoặc v4"), { code: 400 });
  return { engine, voices: await vieneuVoices(engine) };
});
on("POST", "/api/series/([^/]+)/ep/([^/]+)/tts", async (req, [slug, ep]) => {
  const { engine = "v3", reextract = false, mode = "clone", presets = {}, bed = "vocals-removed", origDb } = await body(req);
  if (!["v3", "v4"].includes(engine)) throw Object.assign(new Error("engine phải là v3 hoặc v4"), { code: 400 });
  if (!["clone", "preset"].includes(mode)) throw Object.assign(new Error("mode phải là clone hoặc preset"), { code: 400 });
  if (!["vocals-removed", "original"].includes(bed)) throw Object.assign(new Error("bed phải là vocals-removed hoặc original"), { code: 400 });
  if (origDb !== undefined &&!(Number.isFinite(origDb) && origDb >= -30 && origDb <= 0)) throw Object.assign(new Error("origDb phải là số dB từ -30 đến 0"), { code: 400 });
  const withBed = bed === "original" ? { bed, ...(origDb === undefined ? {} : { origDb }) } : {}; // mặc định không ghi vào params — job cũ/mới cùng khoá
  if (mode === "clone") return { job: await jobs.enqueue("tts", { slug, ep, engine, ...(reextract ? { reextract: true } : {}), ...withBed }) };
  // chặn từ đầu: thiếu/sai giọng thì báo ngay, khỏi xếp hàng rồi mới hỏng
  const d = await scan.episodeDetail(slug, ep);
  if (!d) throw Object.assign(new Error("không có tập này"), { code: 404 });
  const valid = new Set((await vieneuVoices(engine)).map((v) => v.id));
  const picked = {};
  const bad = [];
  for (const v of d.voices) {
    if (valid.has(presets[v.speaker])) picked[v.speaker] = presets[v.speaker];
    else bad.push(v.name);
  }
  if (bad.length) throw Object.assign(new Error(`chưa chọn giọng (hoặc giọng không có ở engine ${engine}) cho: ${bad.join(", ")}`), { code: 400 });
  return { job: await jobs.enqueue("tts", { slug, ep, engine, mode, presets: picked, ...withBed }) };
});
on("POST", "/api/series/([^/]+)/ep/([^/]+)/line", async (req, [slug, ep]) => {
  const { index, vi = null, drop = false } = await body(req);
  if (index === undefined || index === null) throw Object.assign(new Error("thiếu số câu"), { code: 400 });
  return saveEdit(slug, ep, String(index), vi, { drop });
});
// phụ đề dựng từ translation.json (đã gồm câu sửa tay): .vtt cho trình phát (kèm tên người nói), .srt để tải
on("GET", "/api/series/([^/]+)/ep/([^/]+)/subs\\.(vtt|srt)", async (req, [slug, ep, fmt], res, url) => {
  const d = await scan.episodeDetail(slug, ep);
  if (!d) return fail(res, 404, "không có tập này");
  const lang = url.searchParams.get("lang") === "zh" ? "zh" : "vi";
  const ts = (t) => {
    const s = new Date(Math.max(0, t) * 1000).toISOString().slice(11, 23);
    return fmt === "srt" ? s.replace(".", ",") : s;
  };
  const segs = d.segments.filter((s) => s[lang] && s.start !== null && s.start !== undefined);
  if (fmt === "srt") {
    return send(res, 200, segs.map((s, i) => `${i + 1}\n${ts(s.start)} --> ${ts(s.end)}\n${s[lang]}\n`).join("\n"), "application/x-subrip; charset=utf-8");
  }
  const cues = segs.map((s) => `${ts(s.start)} --> ${ts(s.end)}\n${s.name && lang === "vi" ? `[${s.name}] ` : ""}${s[lang]}`);
  return send(res, 200, `WEBVTT\n\n${cues.join("\n\n")}\n`, TYPES[".vtt"]);
});

// Trang soát zhvi là HTML tự chứa (mở bằng file:// được), nút Xuất tải về một file .json qua
// <a download> + blob. Mở qua UI thì chặn đúng cú tải đó và gửi thẳng về server. Chặn ở đây
// thay vì sửa trang: áp được cho cả trang đã dựng từ trước, không phải dựng lại (tốn MT).
const submitHook = (url, label) => String.raw`<script>(function(){
  var go=function(body){var b=document.getElementById('exp');if(b){b.disabled=true;b.textContent='Đang gửi…'}
    fetch(${JSON.stringify(url)},{method:'POST',headers:{'content-type':'application/json'},body:body})
      .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||r.status);
        if(b)b.textContent='Đã gửi ✓';parent.postMessage({zhvi:'submitted',job:j.job||null},'*')})})
      .catch(function(e){if(b){b.disabled=false;b.textContent='Gửi lại'}alert('Gửi không được: '+e.message)})};
  var click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){
    if(this.download&&/\.json$/.test(this.download)&&this.href.indexOf('blob:')===0){
      fetch(this.href).then(function(r){return r.text()}).then(go);return}
    return click.call(this)};
  document.addEventListener('DOMContentLoaded',function(){var b=document.getElementById('exp');if(b)b.textContent=${JSON.stringify(label)}});
})();</script>`;

async function injectReview(res, file, url, label) {
  let html;
  try {
    html = await fsp.readFile(file, "utf8");
  } catch {
    return fail(res, 404, "chưa có trang soát");
  }
  return send(res, 200, html.replace("<head>", `<head>${submitHook(url, label)}`), TYPES[".html"]);
}
on("GET", "/review/bible/([^/]+)", async (req, [slug], res) =>
  injectReview(res, path.join(ROOT, "series", slug, "bible-review.html"), `/api/series/${encodeURIComponent(slug)}/bible-review`, "Lưu & áp dụng bible"));
on("GET", "/review/speakers/([^/]+)/([^/]+)", async (req, [slug, ep], res) => {
  const d = await scan.episodeDetail(slug, ep);
  if (!d) return fail(res, 404, "không có tập này");
  return injectReview(res, path.join(ROOT, d.state.outDir, "review.html"),
    `/api/series/${encodeURIComponent(slug)}/ep/${encodeURIComponent(ep)}/speaker-review`, "Lưu & dịch tiếp");
});

// việc
on("GET", "/api/jobs", () => jobs.list.map((j) => jobs.summary(j)).reverse());
on("POST", "/api/jobs", async (req) => {
  const { type, params } = await body(req);
  if (!["login", "translate"].includes(type)) throw Object.assign(new Error("loại việc không mở qua đường này"), { code: 400 });
  return { job: await jobs.enqueue(type, params || {}) };
});
on("GET", "/api/jobs/([^/]+)", async (req, [id]) => {
  const j = jobs.byId.get(id);
  if (!j) throw Object.assign(new Error("không có việc này"), { code: 404 });
  return { ...jobs.summary(j), tail: j.tail };
});
on("GET", "/api/jobs/([^/]+)/log", async (req, [id], res) => send(res, 200, await jobs.logText(id), TYPES[".txt"]));
on("POST", "/api/jobs/([^/]+)/stop", async (req, [id]) => ({ job: jobs.summary(jobs.stop(id)) }));
on("POST", "/api/jobs/([^/]+)/retry", async (req, [id]) => ({ job: await jobs.retry(id) }));
on("POST", "/api/jobs/([^/]+)/input", async (req, [id]) => {
  const { text = "\n" } = await body(req);
  jobs.input(id, text);
  return { ok: true };
});

// mở thư mục bằng trình quản lý file của máy (WSL -> Explorer)
on("POST", "/api/open", async (req) => {
  const { path: p } = await body(req);
  const abs = safePath(p);
  if (!abs) throw Object.assign(new Error("chỉ mở được thư mục trong data/, out/, series/"), { code: 400 });
  const wsl = /microsoft/i.test(await fsp.readFile("/proc/version", "utf8").catch(() => ""));
  if (process.platform === "win32") {
    spawn("explorer.exe", [path.normalize(abs)], { detached: true, stdio: "ignore" }).unref();
  } else if (wsl) {
    const win = await new Promise((r, j) => execFile("wslpath", ["-w", abs], (e, o) => (e ? j(e) : r(o.trim()))));
    spawn("explorer.exe", [win], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [abs], { detached: true, stdio: "ignore" }).unref();
  }
  return { ok: true };
});

on("GET", "/api/events", async (req, m, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write(`event: hello\ndata: ${JSON.stringify({ jobs: jobs.list.map((j) => jobs.summary(j)) })}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
  return undefined;
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = decodeURIComponent(url.pathname);
  try {
    if (req.method === "GET" && (p === "/" || p === "/index.html")) return serveFile(req, res, path.join(PUBLIC, "index.html"));
    if (req.method === "GET" && /^\/(app\.js|app\.css|favicon\.svg)$/.test(p)) return serveFile(req, res, path.join(PUBLIC, p.slice(1)));
    if (req.method === "GET" && p.startsWith("/media/")) {
      const abs = safePath(p.slice(7));
      return abs ? serveFile(req, res, abs) : fail(res, 403, "ngoài vùng cho phép");
    }
    for (const [method, re, fn] of routes) {
      if (method !== req.method) continue;
      const m = p.match(re);
      if (!m) continue;
      const out = await fn(req, m.slice(1), res, url);
      if (out !== undefined && !res.headersSent) send(res, 200, out);
      return;
    }
    fail(res, 404, "không có đường này");
  } catch (ex) {
    if (!res.headersSent) fail(res, ex.code >= 400 && ex.code < 600 ? ex.code : 500, ex.message || String(ex));
    if (!(ex.code >= 400 && ex.code < 500)) console.error(ex);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Xưởng dịch: http://${HOST}:${PORT}`);
  console.log(`việc chạy nền ghi ở data/_ui/ (log từng việc: data/_ui/logs/)`);
});
