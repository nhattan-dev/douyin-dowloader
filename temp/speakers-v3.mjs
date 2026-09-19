import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

import { logApiCall } from "../src/apiLog.js";
import { createLogger } from "../src/logger.js";

// stderr: script này ghi kết quả JSON ra stdout để pipe sang bước sau.
const log = createLogger("SPEAKERS-V3", { stderr: true });

// Gán nhân vật cho từng câu, dùng cho bước lồng tiếng.
//
// Gán ở mức ĐƠN VỊ DỊCH (translation.json), không phải segment thô: đó chính là đơn
// vị mà dub-video.mjs đem đi tổng hợp, và nó đã gộp mấy chỗ ASR cắt giữa câu. Gán
// xong mới rải ngược về transcript.json qua `segmentIndexes` cho extract-voice.js.
//
// Ba lớp bằng chứng, xếp theo độ tin:
//  1. k mẫu độc lập của LLM → bỏ phiếu trên PHÂN NHÓM (không phải trên tên: mỗi mẫu
//     tự đặt tên khác nhau cho cùng một người).
//  2. lint xưng hô: câu gọi X thì X không thể là người nói. Alias lấy từ cast kênh,
//     đã trừ kính ngữ chung.
//  3. cụm của diarize — video này không có, nên bỏ.
const K = Number(process.env.K ?? 3);
const PRON = new Set(["你", "我", "他", "她", "它", "您", "咱"]);
const [userId, videoId] = process.argv.slice(2);
const root = path.join("data", userId);
const dir = path.join(root, videoId);
const cast0 = JSON.parse(fs.readFileSync(path.join(root, "cast.json"), "utf8")).cast;
const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
const trans = JSON.parse(fs.readFileSync(path.join(dir, "translation.json"), "utf8"));
const units = trans.segments;
const desc = (meta.desc || "").replace(/\s+/g, " ").trim();

const listing = units.map((u, i) => {
  const gap = i === 0 ? 0 : u.start - units[i - 1].end;
  return `${i + 1}. [${u.start.toFixed(1)}s] ${u.zh}${gap > 4 ? `   <<< im lặng ${gap.toFixed(1)}s` : ""}`;
}).join("\n");

const sys = [
  "Bạn phân định NGƯỜI NÓI cho lời thoại bóc băng từ một tập phim hoạt hình Trung Quốc.",
  "Bạn KHÔNG nghe được audio. Chỉ suy từ nội dung, xưng hô, ai đáp ai, mốc thời gian, khoảng im lặng.",
  "",
  "DÀN NHÂN VẬT CỐ ĐỊNH của series (dùng ĐÚNG những tên này, đừng đặt tên mới cho người đã có ở đây):",
  ...cast0.map((c) => `  ${c.name} (${c.gender}, ${c.role}) — ${c.note}. tự xưng: ${(c.self ?? []).join("/") || "-"}; người khác gọi: ${(c.other ?? []).join("/") || "-"}`),
  "",
  "MÔ TẢ TẬP NÀY do tác giả viết:",
  desc || "(không có)",
  "",
  "Nếu tập này có nhân vật KHÔNG nằm trong dàn trên thì được thêm mới, ghi rõ ở `newCast`.",
  "Nhân vật cải trang nhiều lớp vẫn là MỘT nhân vật.",
  "Lời dẫn truyện / độc thoại nội tâm của nhân vật chính thì vẫn gán cho nhân vật chính.",
  "Dòng không phải thoại (nhạc, tiếng động, ký tự rác) thì speaker = \"NON_SPEECH\".",
  "",
  "Với mỗi dòng, nếu câu đó GỌI hoặc NHẮC TỚI một nhân vật thì liệt kê ở `addresses`",
  "(người nói KHÔNG THỂ là người đó). Chỉ ghi khi có bằng chứng chữ thật trong câu.",
  "",
  "Trả JSON đúng shape:",
  '{"newCast":[{"name":"…","gender":"…","self":[],"other":[]}],',
  ' "lines":[{"line":1,"speaker":"<tên nhân vật>","addresses":["<tên>"],"cue":"manh mối ngắn"}]}',
  "Mọi dòng phải có mặt trong `lines`. `speaker` là TÊN, không phải mã.",
].join("\n");

const cacheFile = path.join(dir, "raw-speaker-v3.json");
let cache = null;
try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch { /* chưa có */ }
if (!cache || cache.runs.length < K) {
  const client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com", timeout: 300000, maxRetries: 2 });
  const runs = [];
  let tok = { in: 0, out: 0 };
  for (let i = 0; i < K; i++) {
    const params = {
      model: "deepseek-chat", temperature: i === 0 ? 0 : 0.7,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: sys }, { role: "user", content: listing }],
    };
    const res = await logApiCall(log, { url: "https://api.deepseek.com/chat/completions", body: params }, () =>
      client.chat.completions.create(params),
    );
    tok.in += res.usage.prompt_tokens; tok.out += res.usage.completion_tokens;
    process.stderr.write(`  mẫu ${i + 1}/${K} (in=${res.usage.prompt_tokens} out=${res.usage.completion_tokens})\n`);
    runs.push(JSON.parse(res.choices[0].message.content));
  }
  cache = { desc, tokens: tok, runs };
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf8");
}
const runs = cache.runs;

// ── bỏ phiếu trên phân nhóm ────────────────────────────────────────────────
const raw = runs.map((r) => units.map((_, i) => {
  const l = (r.lines ?? []).find((x) => Number(x.line) === i + 1);
  return l?.speaker ? String(l.speaker) : null;
}));
function align(ref, cur) {
  const pairs = [];
  for (const a of new Set(cur.filter(Boolean))) for (const b of new Set(ref.filter(Boolean))) {
    let o = 0; for (let i = 0; i < ref.length; i++) if (cur[i] === a && ref[i] === b) o += 1;
    if (o) pairs.push([o, a, b]);
  }
  pairs.sort((x, y) => y[0] - x[0]);
  const map = {}, taken = new Set();
  for (const [, a, b] of pairs) { if (map[a] || taken.has(b)) continue; map[a] = b; taken.add(b); }
  return { rows: cur.map((v) => (v ? map[v] ?? v : null)), map };
}
const al = raw.map((r, i) => (i === 0 ? { rows: r, map: {} } : align(raw[0], r)));
const votes = units.map((_, i) => al.map((a) => a.rows[i]));
const maj = votes.map((v) => { const c = {}; for (const x of v) if (x) c[x] = (c[x] ?? 0) + 1;
  const e = Object.entries(c).sort((a, b) => b[1] - a[1]);
  return e.length ? { name: e[0][0], p: e[0][1] / v.length } : { name: null, p: 0 }; });

// ── alias cho lint ─────────────────────────────────────────────────────────
const GENERIC = new Set(Object.keys(JSON.parse(fs.readFileSync("glossary.json", "utf8"))));
const bag = new Map();
for (const c of cast0) bag.set(c.name, { self: new Set(c.self ?? []), other: new Map((c.other ?? []).map((t) => [t, 99])), seen: 1 });
for (const [ri, r] of runs.entries()) for (const c of r.newCast ?? []) {
  const nme = al[ri].map[c.name] ?? c.name;
  const e = bag.get(nme) ?? { self: new Set(), other: new Map(), seen: 0 };
  for (const x of c.self ?? []) e.self.add(x);
  for (const x of c.other ?? []) e.other.set(x, (e.other.get(x) ?? 0) + 1);
  e.seen += 1; bag.set(nme, e);
}
const owners = {};
for (const [n, e] of bag) for (const [t, c] of e.other) if (c * 2 > e.seen) (owners[t] ??= new Set()).add(n);
const alias = new Map([...bag].map(([n, e]) => [n,
  [...e.other].filter(([t, c]) => c * 2 > e.seen).map(([t]) => t)
    .filter((t) => t && !PRON.has(t) && !e.self.has(t) && !GENERIC.has(t) && owners[t]?.size === 1)]));

// ── chốt ───────────────────────────────────────────────────────────────────
const stat = { ok: 0, human: 0, drop: 0 };
const lines = units.map((u, i) => {
  const m = maj[i];
  const addr = new Set();
  for (const [ri, r] of runs.entries()) { const l = (r.lines ?? []).find((x) => Number(x.line) === i + 1);
    for (const a of l?.addresses ?? []) addr.add(al[ri].map[a] ?? a); }
  const hit = m.name && (alias.get(m.name) ?? []).find((t) => u.zh.includes(t));
  let verdict, why;
  if (m.name === "NON_SPEECH") { verdict = "drop"; why = "không phải thoại"; }
  else if (hit) { verdict = "human"; why = `LINT: câu gọi "${hit}" mà lại gán cho ${m.name}`; }
  else if (m.name && addr.has(m.name)) { verdict = "human"; why = `LINT: câu này gọi ${m.name}`; }
  else if (m.p < 1) { verdict = "human"; why = `${K} mẫu chỉ ${Math.round(m.p * K)} phiếu (${votes[i].filter(Boolean).join(" / ")})`; }
  else { verdict = "ok"; why = `${K}/${K} mẫu nhất trí`; }
  stat[verdict] += 1;
  return { index: u.index, line: i + 1, start: u.start, end: u.end, zh: u.zh, vi: u.vi,
    speaker: m.name, vote: m.p, votes: votes[i], segmentIndexes: u.segmentIndexes,
    addresses: [...addr], verdict, reason: why };
});

const dist = {};
for (const l of lines) if (l.verdict !== "drop") dist[l.speaker] = (dist[l.speaker] ?? 0) + 1;
fs.writeFileSync(path.join(dir, "speaker-review.json"), JSON.stringify({
  videoId, samples: K, descPrior: desc, castSource: "channel cast.json",
  distribution: dist, counts: stat, lines,
}, null, 2), "utf8");

const M = { ok: "  ", human: "? ", drop: "✂ " };
const t = [`${videoId}  ${units.length} câu  ${K} mẫu LLM`, `desc: ${desc.slice(0, 110)}`,
  `nhân vật: ${Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(" · ")}`,
  `chốt ${stat.ok} · cần soát ${stat.human} · bỏ ${stat.drop}`, ""];
t.push(`── ${stat.human} CÂU CẦN SOÁT ${"─".repeat(45)}`);
for (const l of lines.filter((x) => x.verdict === "human"))
  t.push(`  ${String(l.line).padStart(3)} ${l.start.toFixed(1).padStart(6)}s  ${l.zh}\n      đang để: ${l.speaker}  |  ${l.reason}`);
t.push("", `── TOÀN BỘ ${"─".repeat(55)}`);
for (const l of lines) {
  t.push(`${M[l.verdict]}${String(l.line).padStart(3)} ${l.start.toFixed(1).padStart(6)}s ${String(l.speaker ?? "(bỏ)").padEnd(12)}${l.zh}`);
  t.push(`${" ".repeat(24)}${l.vi ?? ""}`);
  if (l.verdict !== "ok") t.push(`        └ ${l.reason}`);
}
fs.writeFileSync(path.join(dir, "speaker-review.txt"), t.join("\n") + "\n", "utf8");
console.log(`${videoId}: chốt ${stat.ok} · soát ${stat.human} · bỏ ${stat.drop} / ${units.length}   ${Object.entries(dist).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}(${v})`).join(" ")}`);
