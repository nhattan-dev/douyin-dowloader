import fs from "node:fs";
const [tr, r1, r2] = process.argv.slice(2);
const segs = JSON.parse(fs.readFileSync(tr, "utf8")).segments;
const load = (p) => { const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const n = Object.fromEntries((j.cast ?? []).map((c) => [c.id, c.name]));
  return { id: new Map((j.lines ?? []).map((l) => [Number(l.line), String(l.speaker)])),
           name: (k) => n[j.lines.find((l) => Number(l.line) === k)?.speaker] ?? "?",
           conf: new Map((j.lines ?? []).map((l) => [Number(l.line), l.confidence ?? 0])) }; };
const A = load(r1), B = load(r2);
const audio = new Map(segs.map((s, i) => [i + 1, String(s.speaker ?? "null")]));

// ánh xạ nhãn run2 -> run1 theo đa số (tên khác nhau giữa 2 lượt, chỉ phân nhóm là so được)
const cross = {};
for (const [k, v] of B.id) { (cross[v] ??= {})[A.id.get(k)] = (cross[v][A.id.get(k)] ?? 0) + 1; }
const b2a = Object.fromEntries(Object.entries(cross).map(([k, row]) => [k, Object.entries(row).sort((x, y) => y[1] - x[1])[0][0]]));

// cụm audio -> nhân vật (đa số theo run1) + purity
const tal = {};
for (const [k, v] of audio) (tal[v] ??= {})[A.id.get(k)] = (tal[v][A.id.get(k)] ?? 0) + 1;
const map = {}, purity = {};
for (const [c, row] of Object.entries(tal)) { const e = Object.entries(row).sort((x, y) => y[1] - x[1]);
  map[c] = e[0][0]; purity[c] = e[0][1] / Object.values(row).reduce((a, b) => a + b, 0); }

const PURE = 0.6, CONF = 0.7;
const out = { ok: 0, auto: 0, human: 0 };
const rows = [];
for (const [k, cl] of audio) {
  const a = A.id.get(k), b = b2a[B.id.get(k)], mapped = map[cl];
  const stable = a === b, disputed = mapped !== a, lowConf = (A.conf.get(k) ?? 0) < CONF;
  let verdict, why;
  if (!disputed && stable && !lowConf) { verdict = "ok"; why = ""; }
  else if (disputed && stable && purity[cl] < PURE) { verdict = "auto"; why = `cụm bẩn ${(purity[cl]*100)|0}%, 2 lượt LLM khớp`; }
  else if (!stable) { verdict = "human"; why = "2 lượt LLM lệch nhau"; }
  else if (disputed) { verdict = "human"; why = `xung đột thật (cụm sạch ${(purity[cl]*100)|0}%)`; }
  else { verdict = "human"; why = `LLM tự tin thấp ${A.conf.get(k)}`; }
  out[verdict] += 1;
  if (verdict !== "ok") rows.push(`  ${verdict.toUpperCase().padEnd(6)} ${String(k).padStart(3)} audio=${cl}→${A.name(k)} | ${why} | ${segs[k-1].text.slice(0,26)}`);
}
console.log(`  giữ nguyên ${out.ok}  |  tự sửa ${out.auto}  |  NGƯỜI SOÁT ${out.human}  / ${audio.size} dòng`);
for (const r of rows) console.log(r);
