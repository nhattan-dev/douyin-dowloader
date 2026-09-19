import fs from "node:fs";

// Mô phỏng chính sách "consensus + luật khối" trên dữ liệu đã gọi sẵn (temp/run1, temp/run2).
// Chỉ đọc + in, không ghi đè transcript.
const PURITY_MIN = 0.6, CONF_MIN = 0.7, BLOCK_MIN = 2;

const [tr, r1, r2, mode] = process.argv.slice(2);
// STRICT: tự sửa CHỈ khi bất đồng đi liền khối. Cụm bẩn thôi thì chưa đủ —
// đo được nó nuốt cả dòng LLM đoán mò (西游 dòng 1 và 26).
const STRICT = mode !== "loose";
const T = JSON.parse(fs.readFileSync(tr, "utf8"));
const segs = T.segments;
const load = (p) => { const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const nm = Object.fromEntries((j.cast ?? []).map((c) => [c.id, c.name]));
  return { lab: new Map(j.lines.map((l) => [Number(l.line), String(l.speaker)])),
           nm, conf: new Map(j.lines.map((l) => [Number(l.line), l.confidence ?? 0])),
           cue: new Map(j.lines.map((l) => [Number(l.line), l.cue ?? ""])), cast: j.cast ?? [] }; };
const A = load(r1), B = load(r2);
const audio = new Map(segs.map((s, i) => [i + 1, String(s.speaker ?? "null")]));
const name = (id) => A.nm[id] ?? id;

// nhãn lượt 2 -> không gian nhãn lượt 1 (tên khác nhau giữa 2 lượt, chỉ phân nhóm là so được)
const cross = {};
for (const [k, v] of B.lab) (cross[v] ??= {})[A.lab.get(k)] = (cross[v][A.lab.get(k)] ?? 0) + 1;
const b2a = Object.fromEntries(Object.entries(cross).map(([k, r]) => [k, Object.entries(r).sort((x, y) => y[1] - x[1])[0][0]]));

// cụm audio -> nhân vật + purity
const tal = {};
for (const [k, v] of audio) (tal[v] ??= {})[A.lab.get(k)] = (tal[v][A.lab.get(k)] ?? 0) + 1;
const map = {}, purity = {}, size = {};
for (const [c, row] of Object.entries(tal)) { const e = Object.entries(row).sort((x, y) => y[1] - x[1]);
  const n = Object.values(row).reduce((a, b) => a + b, 0);
  map[c] = e[0][0]; purity[c] = e[0][1] / n; size[c] = n; }

// đồng thuận 2 lượt (Rand trên cặp) — thước đo "video này suy từ text được không"
const keys = [...A.lab.keys()]; let ag = 0, tot = 0;
for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
  const x = A.lab.get(keys[i]) === A.lab.get(keys[j]);
  const y = b2a[B.lab.get(keys[i])] === b2a[B.lab.get(keys[j])];
  tot++; if (x === y) ag++; }
const rand = ag / tot;
const overall = Object.entries(tal).reduce((s, [c]) => s + purity[c] * size[c], 0) / segs.length;

// luật khối: các dòng bất đồng LIỀN NHAU cùng chỉ về một nhân vật = cụm bị gộp có hệ thống
const disputed = new Map();
for (const [k] of audio) { const a = A.lab.get(k);
  if (map[audio.get(k)] !== a) disputed.set(k, a); }
const block = new Map();
for (const [k, a] of disputed) { let n = 1;
  for (let j = k - 1; disputed.get(j) === a; j--) n++;
  for (let j = k + 1; disputed.get(j) === a; j++) n++;
  block.set(k, n); }

console.log(`\n╔═ ${T.videoId}  ${segs.length} dòng, ${(T.duration ?? 0) | 0}s`);
console.log(`║ CAST (LLM tự dựng): ${A.cast.map((c) => c.name).join(" · ")}`);
console.log(`║ đồng thuận 2 lượt LLM: ${(rand * 100).toFixed(1)}%   purity audio tổng: ${(overall * 100).toFixed(1)}%`);
for (const c of Object.keys(tal).sort())
  console.log(`║   cụm ${c.padEnd(12)} ${String(size[c]).padStart(2)} dòng  purity ${String(((purity[c] * 100) | 0) + "%").padStart(4)} → ${name(map[c])}${purity[c] < PURITY_MIN ? "   ⚠ BẨN" : ""}`);
const verdict = rand < 0.9 || overall < PURITY_MIN ? "CẦN NGƯỜI SOÁT CẢ VIDEO" : "ổn, chỉ soát dòng gắn cờ";
console.log(`║ → ${verdict}`);
console.log("╚" + "═".repeat(70));

const stat = { keep: 0, fix: 0, human: 0, nonspeech: 0 };
for (const [k, cl] of audio) {
  const a = A.lab.get(k), b = b2a[B.lab.get(k)];
  const stable = a === b, dis = disputed.has(k), conf = A.conf.get(k) ?? 0;
  let mark, final, why = "";
  if (name(a) === "NON_SPEECH") { mark = "✂ BỎ "; final = "(không phải thoại)"; stat.nonspeech++; }
  else if (!dis) { mark = stable ? "  giữ" : "  giữ"; final = name(map[cl]); stat.keep++;
    if (conf < 0.5) { mark = "? soát"; why = `LLM tự tin ${conf}`; stat.keep--; stat.human++; } }
  else if (!stable) { mark = "? SOÁT"; final = `${name(map[cl])} ↔ ${name(a)}`; why = "2 lượt LLM lệch nhau"; stat.human++; }
  else if (STRICT ? block.get(k) >= BLOCK_MIN : (purity[cl] < PURITY_MIN || block.get(k) >= BLOCK_MIN)) {
    mark = "→ SỬA"; final = name(a); stat.fix++;
    why = block.get(k) >= BLOCK_MIN
      ? `khối ${block.get(k)} dòng liền${purity[cl] < PURITY_MIN ? `, cụm ${cl} bẩn ${(purity[cl] * 100) | 0}%` : ""}`
      : `cụm ${cl} bẩn ${(purity[cl] * 100) | 0}%`; }
  else { mark = "? SOÁT"; final = `${name(map[cl])} ↔ ${name(a)}`; stat.human++;
    why = `bất đồng LẺ 1 dòng (cụm ${cl} purity ${(purity[cl] * 100) | 0}%)`; }

  const line = `${mark} ${String(k).padStart(3)} ${segs[k - 1].start.toFixed(1).padStart(6)}s ${String(final).padEnd(16)}${segs[k - 1].text.slice(0, 40)}`;
  console.log(mark.trim() === "giữ" ? line : `${line}\n         └ ${why}${A.cue.get(k) ? " · " + A.cue.get(k) : ""}`);
}
console.log(`\n  giữ ${stat.keep}  ·  tự sửa ${stat.fix}  ·  người soát ${stat.human}  ·  bỏ ${stat.nonspeech}   / ${segs.length}`);
