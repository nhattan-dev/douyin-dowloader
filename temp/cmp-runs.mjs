import fs from "node:fs";
const [a, b] = process.argv.slice(2);
const load = (p) => { const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const n = Object.fromEntries((j.cast ?? []).map((c) => [c.id, c.name]));
  return new Map((j.lines ?? []).map((l) => [Number(l.line), n[l.speaker] ?? l.speaker])); };
const A = load(a), B = load(b);
let same = 0, diff = [];
for (const [k, v] of A) { const w = B.get(k); if (v === w) same += 1; else diff.push(`${k}: ${v} vs ${w}`); }
console.log(`giống ${same}/${A.size} (${(same / A.size * 100).toFixed(1)}%)`);
for (const d of diff) console.log("  " + d);
