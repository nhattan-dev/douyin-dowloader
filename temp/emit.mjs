import fs from "node:fs";
import path from "node:path";

// Chính sách đã chốt: LOOSE (cụm bẩn HOẶC khối liền) + lint xưng hô.
// Chỉ GHI RA speaker-review.{json,txt} cạnh transcript — KHÔNG sửa transcript.json.
const PURITY_MIN = 0.6, BLOCK_MIN = 2;
const PRON = new Set(["你", "我", "他", "她", "它", "您", "咱"]);

const [tr, r1, r2, al] = process.argv.slice(2);
const dir = path.dirname(tr);
const T = JSON.parse(fs.readFileSync(tr, "utf8"));
const segs = T.segments;
const load = (p) => { const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return { lab: new Map(j.lines.map((l) => [Number(l.line), String(l.speaker)])),
    conf: new Map(j.lines.map((l) => [Number(l.line), l.confidence ?? null])),
    cue: new Map(j.lines.map((l) => [Number(l.line), l.cue ?? ""])),
    nm: Object.fromEntries((j.cast ?? []).map((c) => [c.id, c.name])), cast: j.cast ?? [] }; };
const A = load(r1), B = load(r2);
const aliases = JSON.parse(fs.readFileSync(al, "utf8")).aliases ?? [];
const other = new Map(aliases.map((a) => [a.id, (a.other ?? []).filter((t) => t && !PRON.has(t))]));
const name = (id) => A.nm[id] ?? id ?? null;
const audio = new Map(segs.map((s, i) => [i + 1, String(s.speaker ?? "null")]));

// nhãn lượt 2 → không gian nhãn lượt 1 (2 lượt đặt tên khác nhau, chỉ phân nhóm so được)
const cross = {};
for (const [k, v] of B.lab) (cross[v] ??= {})[A.lab.get(k)] = (cross[v][A.lab.get(k)] ?? 0) + 1;
const b2a = Object.fromEntries(Object.entries(cross).map(([k, r]) => [k, Object.entries(r).sort((x, y) => y[1] - x[1])[0][0]]));

// cụm audio → nhân vật + purity
const tal = {};
for (const [k, v] of audio) (tal[v] ??= {})[A.lab.get(k)] = (tal[v][A.lab.get(k)] ?? 0) + 1;
const map = {}, purity = {}, size = {};
for (const [c, row] of Object.entries(tal)) { const e = Object.entries(row).sort((x, y) => y[1] - x[1]);
  size[c] = Object.values(row).reduce((a, b) => a + b, 0); map[c] = e[0][0]; purity[c] = e[0][1] / size[c]; }

// đồng thuận 2 lượt trên CẶP dòng (Rand) — thước đo "video này suy từ text được không"
const keys = [...A.lab.keys()]; let ag = 0, tot = 0;
for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
  const x = A.lab.get(keys[i]) === A.lab.get(keys[j]);
  const y = b2a[B.lab.get(keys[i])] === b2a[B.lab.get(keys[j])];
  tot++; if (x === y) ag++; }
const rand = tot ? ag / tot : 1;
const overall = Object.keys(tal).reduce((s, c) => s + purity[c] * size[c], 0) / segs.length;

// khối: các dòng bất đồng LIỀN NHAU cùng chỉ về một nhân vật = cụm bị gộp có hệ thống
const disputed = new Map();
for (const [k, cl] of audio) if (map[cl] !== A.lab.get(k)) disputed.set(k, A.lab.get(k));
const block = new Map();
for (const [k, a] of disputed) { let n = 1;
  for (let j = k - 1; disputed.get(j) === a; j--) n++;
  for (let j = k + 1; disputed.get(j) === a; j++) n++; block.set(k, n); }

const stat = { keep: 0, fix: 0, human: 0, drop: 0 };
const lines = segs.map((s, i) => {
  const k = i + 1, cl = audio.get(k);
  const a = A.lab.get(k), b = b2a[B.lab.get(k)];
  const stable = a === b, dis = disputed.has(k);
  let verdict, final, why;
  if (name(a) === "NON_SPEECH") { verdict = "drop"; final = null; why = "không phải thoại"; }
  else if (!dis) { verdict = "keep"; final = map[cl]; why = ""; }
  else if (!stable) { verdict = "human"; final = map[cl]; why = "2 lượt LLM lệch nhau"; }
  else if (purity[cl] < PURITY_MIN || block.get(k) >= BLOCK_MIN) { verdict = "fix"; final = a;
    why = block.get(k) >= BLOCK_MIN ? `khối ${block.get(k)} dòng liền` : `cụm ${cl} bẩn ${(purity[cl] * 100) | 0}%`; }
  else { verdict = "human"; final = map[cl]; why = `bất đồng lẻ trong cụm sạch ${(purity[cl] * 100) | 0}%`; }

  const hit = final && (other.get(final) ?? []).find((t) => s.text.includes(t));
  if (hit) { verdict = "human"; why = `LINT: câu gọi "${hit}" mà lại gán cho ${name(final)}`; }
  stat[{ keep: "keep", fix: "fix", human: "human", drop: "drop" }[verdict]]++;

  return { line: k, start: s.start, end: s.end, text: s.text,
    audioCluster: cl === "null" ? null : cl, audioSpeaker: name(map[cl]),
    llmPass1: name(a), llmPass2: name(b), llmConfidence: A.conf.get(k), llmCue: A.cue.get(k),
    speaker: name(final), verdict, reason: why };
});

const out = {
  videoId: T.videoId, model: T.model, diarizeModel: T.diarizeModel, duration: T.duration,
  policy: { name: "loose+lint", purityMin: PURITY_MIN, blockMin: BLOCK_MIN },
  cast: A.cast.map((c) => ({ ...c, aliases: aliases.find((x) => x.id === c.id) ?? null })),
  audit: {
    crossRunAgreement: Number(rand.toFixed(4)),
    audioPurity: Number(overall.toFixed(4)),
    needsFullReview: rand < 0.9 || overall < PURITY_MIN,
    clusters: Object.keys(tal).sort().map((c) => ({
      cluster: c === "null" ? null : c, lines: size[c],
      purity: Number(purity[c].toFixed(3)), mapsTo: name(map[c]), dirty: purity[c] < PURITY_MIN })),
  },
  counts: stat,
  lines,
};
fs.writeFileSync(path.join(dir, "speaker-review.json"), JSON.stringify(out, null, 2), "utf8");

const MARK = { keep: "  ", fix: "→ ", human: "? ", drop: "✂ " };
const txt = [];
txt.push(`${T.videoId}  ${segs.length} dòng  ${(T.duration ?? 0) | 0}s  ${T.model}`);
txt.push(`cast : ${A.cast.map((c) => c.name).join(" · ")}`);
txt.push(`đồng thuận 2 lượt LLM ${(rand * 100).toFixed(1)}%   purity audio ${(overall * 100).toFixed(1)}%   → ${out.audit.needsFullReview ? "CẦN SOÁT CẢ VIDEO" : "chỉ soát dòng gắn cờ"}`);
for (const c of out.audit.clusters)
  txt.push(`  cụm ${String(c.cluster ?? "—").padEnd(12)} ${String(c.lines).padStart(2)} dòng  purity ${String(((c.purity * 100) | 0) + "%").padStart(4)} → ${c.mapsTo}${c.dirty ? "   ⚠ BẨN" : ""}`);
txt.push(`giữ ${stat.keep} · sửa ${stat.fix} · soát ${stat.human} · bỏ ${stat.drop}`);
txt.push("");
txt.push(`── ${stat.human} DÒNG CẦN NGƯỜI SOÁT ${"─".repeat(40)}`);
for (const l of lines.filter((x) => x.verdict === "human")) {
  txt.push(`  ${String(l.line).padStart(3)} ${l.start.toFixed(1).padStart(6)}s  ${l.text}`);
  txt.push(`      audio=${l.audioSpeaker}   llm=${l.llmPass1}${l.llmPass2 !== l.llmPass1 ? ` / lượt2=${l.llmPass2}` : ""}   → đang để: ${l.speaker}`);
  txt.push(`      ${l.reason}${l.llmCue ? " · " + l.llmCue : ""}`);
}
txt.push("");
txt.push(`── TOÀN BỘ (→ tự sửa, ? cần soát, ✂ bỏ) ${"─".repeat(30)}`);
for (const l of lines) {
  txt.push(`${MARK[l.verdict]}${String(l.line).padStart(3)} ${l.start.toFixed(1).padStart(6)}s ${String(l.speaker ?? "(bỏ)").padEnd(14)}${l.text}`);
  if (l.verdict !== "keep") txt.push(`        └ ${l.reason}${l.llmCue ? " · " + l.llmCue : ""}`);
}
fs.writeFileSync(path.join(dir, "speaker-review.txt"), txt.join("\n") + "\n", "utf8");
console.log(`${path.join(dir, "speaker-review.json")}  +  .txt   (giữ ${stat.keep} · sửa ${stat.fix} · soát ${stat.human} · bỏ ${stat.drop})`);
