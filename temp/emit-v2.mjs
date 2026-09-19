import fs from "node:fs";
import path from "node:path";

// Stage quyết định của v2.
// Text là nguồn CHÍNH (đo được mạnh hơn audio trên nội dung này), audio là đối chứng.
// Độ tin cậy = tỷ lệ phiếu giữa k mẫu, KHÔNG dùng confidence model tự khai (toàn 0.8/0.9).
const tr = process.argv[2], dir = path.dirname(tr);
const T = JSON.parse(fs.readFileSync(tr, "utf8"));
const segs = T.segments;
const { desc, runs } = JSON.parse(fs.readFileSync(path.join(dir, "raw-speaker-v2.json"), "utf8"));
const PRON = new Set(["你", "我", "他", "她", "它", "您", "咱"]);
const nm = (r) => Object.fromEntries((r.cast ?? []).map((c) => [c.id, c.name]));
const lineOf = (r, k) => (r.lines ?? []).find((x) => Number(x.line) === k);

// ── 1. Bỏ phiếu trên PHÂN NHÓM, không trên tên ─────────────────────────────
// Mỗi mẫu tự đặt tên (拍卖行管事 vs 拍卖行晚辈 là cùng một người) — so tên thì một
// khác biệt chính tả thành "bất đồng" giả. Căn tên từng mẫu về mẫu 1 bằng ghép cặp
// 1-1 theo số dòng trùng; tên không ghép được thì giữ nguyên — đó mới là bất đồng thật.
const raw = runs.map((r) => { const n = nm(r);
  return segs.map((_, i) => { const l = lineOf(r, i + 1); return l ? (n[l.speaker] ?? l.speaker) : null; }); });
function align(ref, cur) {
  const pairs = [];
  for (const a of new Set(cur.filter(Boolean))) for (const b of new Set(ref.filter(Boolean))) {
    let o = 0; for (let i = 0; i < ref.length; i++) if (cur[i] === a && ref[i] === b) o += 1;
    if (o > 0) pairs.push([o, a, b]);
  }
  pairs.sort((x, y) => y[0] - x[0]);
  const map = {}, taken = new Set();
  for (const [, a, b] of pairs) { if (map[a] || taken.has(b)) continue; map[a] = b; taken.add(b); }
  return { rows: cur.map((v) => (v ? map[v] ?? v : null)), map };
}
const alignRes = raw.map((r, i) => (i === 0 ? { rows: r, map: {} } : align(raw[0], r)));
const aligned = alignRes.map((a) => a.rows);
const votes = segs.map((_, i) => aligned.map((r) => r[i]));
const maj = votes.map((v) => { const c = {}; for (const x of v) if (x) c[x] = (c[x] ?? 0) + 1;
  const e = Object.entries(c).sort((a, b) => b[1] - a[1]);
  return e.length ? { name: e[0][0], p: e[0][1] / v.length } : { name: null, p: 0 }; });

// ── 2. Dàn nhân vật + alias, gom theo tên ĐÃ CĂN ───────────────────────────
const cast = new Map();
for (const [ri, r] of runs.entries()) for (const c0 of r.cast ?? []) {
  const name = alignRes[ri].map[c0.name] ?? c0.name;
  const e = cast.get(name) ?? { name, note: "", self: new Set(), other: new Map(), seen: 0 };
  for (const x of c0.self ?? []) e.self.add(x);
  for (const x of c0.other ?? []) e.other.set(x, (e.other.get(x) ?? 0) + 1);
  e.seen += 1; e.note ||= c0.note ?? ""; cast.set(name, e);
}
// Alias dùng cho lint phải LỌC, không hợp nhất thô:
//  - chỉ giữ từ được ĐA SỐ mẫu công nhận (một mẫu lạc đường là đủ đẻ ra báo nhầm);
//  - trừ từ chính nhân vật đó tự xưng (白骨精 cải trang thì 老汉/女儿 là tự xưng);
//  - trừ kính ngữ chung có trong glossary.json (道友/前辈/晚辈/长老) — dùng qua lại,
//    không định danh ai;
//  - trừ từ gán cho từ 2 nhân vật trở lên.
const GENERIC = new Set(Object.keys(JSON.parse(fs.readFileSync("glossary.json", "utf8"))));
const owners = {};
for (const [n, e] of cast) for (const [t, c] of e.other) if (c * 2 > e.seen) (owners[t] ??= new Set()).add(n);
const other = new Map([...cast].map(([n, e]) => [n,
  [...e.other].filter(([t, c]) => c * 2 > e.seen).map(([t]) => t)
    .filter((t) => t && !PRON.has(t) && !e.self.has(t) && !GENERIC.has(t) && owners[t]?.size === 1)]));

// ── 3. Đối chứng audio (không dùng để quyết) ───────────────────────────────
const audio = segs.map((s) => String(s.speaker ?? "null"));
const tal = {}; segs.forEach((_, i) => { (tal[audio[i]] ??= {})[maj[i].name] = (tal[audio[i]][maj[i].name] ?? 0) + 1; });
const amap = {}, purity = {}, asize = {};
for (const [c, row] of Object.entries(tal)) { const e = Object.entries(row).sort((a, b) => b[1] - a[1]);
  asize[c] = Object.values(row).reduce((a, b) => a + b, 0); amap[c] = e[0][0]; purity[c] = e[0][1] / asize[c]; }
// Cụm chứa ≥2 nhân vật mỗi người ≥2 dòng = cụm GỘP NHẦM, không phải "mấy dòng sai".
const overMerged = Object.fromEntries(Object.entries(tal).map(([c, row]) =>
  [c, Object.values(row).filter((n) => n >= 2).length >= 2]));

// ── 4. Chốt ────────────────────────────────────────────────────────────────
const stat = { ok: 0, llm: 0, human: 0, drop: 0 };
const lines = segs.map((s, i) => {
  const k = i + 1, m = maj[i], cl = audio[i];
  const addr = new Set();
  for (const [ri, r] of runs.entries()) { const n = nm(r), l = lineOf(r, k);
    for (const a of l?.addresses ?? []) { const nme = n[a] ?? a; addr.add(alignRes[ri].map[nme] ?? nme); } }
  const lint = m.name && (other.get(m.name) ?? []).find((t) => s.text.includes(t));
  let verdict, why;
  if (m.name === "NON_SPEECH") { verdict = "drop"; why = "không phải thoại"; }
  else if (lint) { verdict = "human"; why = `LINT: câu gọi "${lint}" mà lại gán cho ${m.name}`; }
  else if (m.name && addr.has(m.name)) { verdict = "human"; why = `LINT: câu này gọi ${m.name}` }
  else if (m.p < 1) { verdict = "human"; why = `${runs.length} mẫu chỉ ${Math.round(m.p * runs.length)} phiếu (${votes[i].filter(Boolean).join(" / ")})`; }
  else if (amap[cl] === m.name) { verdict = "ok"; why = "text + audio khớp"; }
  else { verdict = "llm"; why = `audio nói ${amap[cl]} ${overMerged[cl] ? `(cụm ${cl} gộp nhầm ${Object.keys(tal[cl]).length} người)` : `(cụm ${cl} purity ${(purity[cl] * 100) | 0}%)`}`; }
  stat[verdict] += 1;
  return { line: k, start: s.start, end: s.end, text: s.text, speaker: m.name, vote: m.p, votes: votes[i],
    audioCluster: cl === "null" ? null : cl, audioSpeaker: amap[cl], addresses: [...addr], verdict, reason: why };
});

fs.writeFileSync(path.join(dir, "speaker-review.json"), JSON.stringify({
  videoId: T.videoId, duration: T.duration, descPrior: desc, samples: runs.length,
  cast: [...cast.values()].map((c) => ({ name: c.name, note: c.note, self: [...c.self],
    aliasForLint: other.get(c.name) ?? [], otherRaw: [...c.other.keys()], inSamples: `${c.seen}/${runs.length}` })),
  audioCrossCheck: Object.keys(tal).sort().map((c) => ({ cluster: c === "null" ? null : c, lines: asize[c],
    mapsTo: amap[c], purity: Number(purity[c].toFixed(3)), overMerged: overMerged[c], mixture: tal[c] })),
  counts: stat, lines,
}, null, 2), "utf8");

const M = { ok: "  ", llm: "→ ", human: "? ", drop: "✂ " };
const t = [];
t.push(`${T.videoId}  ${segs.length} dòng  ${(T.duration ?? 0) | 0}s   ${runs.length} mẫu LLM`);
t.push(`prior (desc): ${desc.slice(0, 110)}`);
t.push(`cast : ${[...cast.keys()].filter((n) => n !== "NON_SPEECH").join(" · ")}`);
t.push(`chốt ${stat.ok} (text+audio khớp) · ${stat.llm} theo text (audio cãi) · ${stat.human} cần soát · ${stat.drop} bỏ`);
t.push("", "đối chứng cụm audio:");
for (const c of Object.keys(tal).sort())
  t.push(`  ${String(c === "null" ? "—" : c).padEnd(12)} ${String(asize[c]).padStart(2)} dòng → ${String(amap[c]).padEnd(12)} purity ${String(((purity[c] * 100) | 0) + "%").padStart(4)}${overMerged[c] ? "   ⚠ GỘP NHẦM " + JSON.stringify(tal[c]) : ""}`);
t.push("", `── ${stat.human} DÒNG CẦN NGƯỜI SOÁT ${"─".repeat(40)}`);
for (const l of lines.filter((x) => x.verdict === "human")) {
  t.push(`  ${String(l.line).padStart(3)} ${l.start.toFixed(1).padStart(6)}s  ${l.text}`);
  t.push(`      đang để: ${l.speaker}   |   ${l.reason}`);
}
t.push("", `── TOÀN BỘ (→ theo text, ? cần soát, ✂ bỏ) ${"─".repeat(28)}`);
for (const l of lines) {
  t.push(`${M[l.verdict]}${String(l.line).padStart(3)} ${l.start.toFixed(1).padStart(6)}s ${String(l.speaker ?? "(bỏ)").padEnd(13)}${l.text}`);
  if (l.verdict !== "ok") t.push(`        └ ${l.reason}`);
}
fs.writeFileSync(path.join(dir, "speaker-review.txt"), t.join("\n") + "\n", "utf8");
console.log(`${dir}/speaker-review.{json,txt}   chốt ${stat.ok} · theo-text ${stat.llm} · soát ${stat.human} · bỏ ${stat.drop} / ${segs.length}`);
