import fs from "node:fs";
const [tr, ...runs] = process.argv.slice(2);
const segs = JSON.parse(fs.readFileSync(tr, "utf8")).segments;
const load = (p) => { const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const n = Object.fromEntries((j.cast ?? []).map((c) => [c.id, c.name]));
  return { m: new Map((j.lines ?? []).map((l) => [Number(l.line), String(l.speaker)])), n }; };
const audio = new Map(segs.map((s, i) => [i + 1, String(s.speaker ?? "null")]));
function pair(A, B) { const k = [...A.keys()]; let ag = 0, t = 0, sb = 0, sp = 0;
  for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) {
    const a = A.get(k[i]) === A.get(k[j]), b = B.get(k[i]) === B.get(k[j]);
    t++; if (a === b) ag++; if (a && b) sb++; if (a || b) sp++; }
  return { rand: ag / t, jac: sp ? sb / sp : 1 }; }
const L = runs.map(load);
const p = (x, y, lbl) => { const r = pair(x, y); console.log(`  ${lbl.padEnd(22)} Rand=${(r.rand*100).toFixed(1)}%  Jaccard=${(r.jac*100).toFixed(1)}%`); };
p(audio, L[0].m, "audio vs llm#1");
if (L[1]) { p(audio, L[1].m, "audio vs llm#2"); p(L[0].m, L[1].m, "llm#1 vs llm#2"); }
// độ tinh khiết từng cụm audio theo llm#1
const tal = {}; for (const [k, v] of audio) { (tal[v] ??= {})[L[0].m.get(k)] = (tal[v][L[0].m.get(k)] ?? 0) + 1; }
let pure = 0, tot = 0;
for (const [c, row] of Object.entries(tal)) { const vals = Object.values(row); const m = Math.max(...vals); const s = vals.reduce((a, b) => a + b, 0);
  pure += m; tot += s; console.log(`  cụm ${c.padEnd(12)} purity ${(m/s*100).toFixed(0)}%  (${s} dòng, ${vals.length} nhân vật)`); }
console.log(`  → PURITY TỔNG ${(pure/tot*100).toFixed(1)}%`);
