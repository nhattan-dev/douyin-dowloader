import fs from "node:fs";
// So SỰ PHÂN NHÓM (ai chung nhóm với ai), không so tên — LLM đặt tên khác nhau mỗi lượt.
const load = (p) => { const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return new Map((j.lines ?? []).map((l) => [Number(l.line), String(l.speaker)])); };
function pairwise(A, B) {
  const keys = [...A.keys()].filter((k) => B.has(k));
  let agree = 0, total = 0, sameBoth = 0, samePairs = 0;
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const a = A.get(keys[i]) === A.get(keys[j]);
    const b = B.get(keys[i]) === B.get(keys[j]);
    total++; if (a === b) agree++; if (a && b) sameBoth++; if (a || b) samePairs++;
  }
  return { rand: agree / total, jaccard: samePairs ? sameBoth / samePairs : 1, n: keys.length };
}
const [a, b] = process.argv.slice(2);
const r = pairwise(load(a), load(b));
console.log(`  Rand=${(r.rand * 100).toFixed(1)}%  Jaccard=${(r.jaccard * 100).toFixed(1)}%  (n=${r.n})`);
