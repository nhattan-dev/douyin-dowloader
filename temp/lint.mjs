import fs from "node:fs";
// Chính sách LOOSE (cụm bẩn HOẶC khối) + guard "tự nhắc mình ở ngôi hai/ba".
// Guard: dòng gán cho nhân vật X mà trong text có từ NGƯỜI KHÁC dùng để gọi X
// (悟空/猴子/大师兄…) thì X không thể là người nói → đẩy sang người soát.
const PURITY_MIN = 0.6, BLOCK_MIN = 2;
const PRON = new Set(["你", "我", "他", "她", "它", "您", "咱"]);
const [tr, r1, r2, al] = process.argv.slice(2);
const T = JSON.parse(fs.readFileSync(tr, "utf8")); const segs = T.segments;
const load = (p) => { const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return { lab: new Map(j.lines.map((l) => [Number(l.line), String(l.speaker)])),
           nm: Object.fromEntries((j.cast ?? []).map((c) => [c.id, c.name])), cast: j.cast ?? [] }; };
const A = load(r1), B = load(r2);
const other = new Map((JSON.parse(fs.readFileSync(al, "utf8")).aliases ?? [])
  .map((a) => [a.id, (a.other ?? []).filter((t) => t && !PRON.has(t))]));
const audio = new Map(segs.map((s, i) => [i + 1, String(s.speaker ?? "null")]));
const name = (id) => A.nm[id] ?? id;
const cross = {}; for (const [k, v] of B.lab) (cross[v] ??= {})[A.lab.get(k)] = (cross[v][A.lab.get(k)] ?? 0) + 1;
const b2a = Object.fromEntries(Object.entries(cross).map(([k, r]) => [k, Object.entries(r).sort((x, y) => y[1] - x[1])[0][0]]));
const tal = {}; for (const [k, v] of audio) (tal[v] ??= {})[A.lab.get(k)] = (tal[v][A.lab.get(k)] ?? 0) + 1;
const map = {}, purity = {};
for (const [c, row] of Object.entries(tal)) { const e = Object.entries(row).sort((x, y) => y[1] - x[1]);
  map[c] = e[0][0]; purity[c] = e[0][1] / Object.values(row).reduce((a, b) => a + b, 0); }
const disputed = new Map(); for (const [k] of audio) if (map[audio.get(k)] !== A.lab.get(k)) disputed.set(k, A.lab.get(k));
const block = new Map();
for (const [k, a] of disputed) { let n = 1;
  for (let j = k - 1; disputed.get(j) === a; j--) n++; for (let j = k + 1; disputed.get(j) === a; j++) n++; block.set(k, n); }

const stat = { keep: 0, fix: 0, human: 0, drop: 0, lint: 0 };
const rows = [];
for (const [k, cl] of audio) {
  const a = A.lab.get(k), stable = a === b2a[B.lab.get(k)], dis = disputed.has(k);
  let v, final, why;
  if (name(a) === "NON_SPEECH") { v = "BỎ"; final = a; stat.drop++; why = "không phải thoại"; }
  else if (!dis) { v = "giữ"; final = map[cl]; stat.keep++; why = ""; }
  else if (!stable) { v = "SOÁT"; final = map[cl]; stat.human++; why = "2 lượt LLM lệch"; }
  else if (purity[cl] < PURITY_MIN || block.get(k) >= BLOCK_MIN) { v = "SỬA"; final = a; stat.fix++;
    why = block.get(k) >= BLOCK_MIN ? `khối ${block.get(k)}` : `cụm bẩn ${(purity[cl] * 100) | 0}%`; }
  else { v = "SOÁT"; final = map[cl]; stat.human++; why = `lẻ trong cụm sạch ${(purity[cl] * 100) | 0}%`; }

  const hit = v !== "BỎ" && (other.get(final) ?? []).find((t) => segs[k - 1].text.includes(t));
  if (hit) { if (v === "SỬA") stat.fix--; else if (v === "giữ") stat.keep--; else stat.human--;
    v = "SOÁT"; stat.human++; stat.lint++; why = `LINT: câu gọi "${hit}" mà lại gán cho ${name(final)}`; }
  if (v !== "giữ") rows.push(`  ${v.padEnd(5)} ${String(k).padStart(3)} ${name(final).padEnd(12)} ${segs[k - 1].text.slice(0, 34)}\n        └ ${why}`);
}
console.log(`\n${T.videoId}: giữ ${stat.keep} · sửa ${stat.fix} · soát ${stat.human} (lint bắt thêm ${stat.lint}) · bỏ ${stat.drop} / ${segs.length}`);
for (const r of rows) console.log(r);
