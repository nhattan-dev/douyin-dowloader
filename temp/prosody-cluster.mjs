import fs from "node:fs";
import path from "node:path";
// Phân cụm CHỈ bằng prosody (không đọc chữ), rồi so phân nhóm với:
//  - nhãn LLM v2 (đọc chữ, không nghe)  → hai giác quan độc lập hoàn toàn
//  - cụm của diarize (nghe, nhưng đo danh tính người chứ không đo diễn xuất)
const dir = process.argv[2];
const rows = JSON.parse(fs.readFileSync(path.join(dir, "prosody.json"), "utf8"))
  .filter((r) => r.f0 && r.speaker && r.speaker !== "NON_SPEECH");
const K = new Set(rows.map((r) => r.speaker)).size;

// đặc trưng chuẩn hoá: log F0, log tốc độ, log năng lượng, tỷ lệ hữu thanh
const feat = rows.map((r) => [Math.log(r.f0), Math.log(Math.max(0.5, r.rate)), Math.log(Math.max(1e-3, r.rms)), r.voiced]);
const D = feat[0].length;
const mu = Array.from({ length: D }, (_, d) => feat.reduce((s, f) => s + f[d], 0) / feat.length);
const sd = Array.from({ length: D }, (_, d) => Math.sqrt(feat.reduce((s, f) => s + (f[d] - mu[d]) ** 2, 0) / feat.length) || 1);
const X = feat.map((f) => f.map((v, d) => (v - mu[d]) / sd[d]));

function kmeans(X, k, seed = 1) {
  let rnd = seed;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let C = Array.from({ length: k }, () => X[Math.floor(rand() * X.length)].slice());
  let a = new Array(X.length).fill(0);
  for (let it = 0; it < 60; it++) {
    let moved = false;
    X.forEach((x, i) => { let b = 0, bd = Infinity;
      C.forEach((c, j) => { let d = 0; for (let t = 0; t < x.length; t++) d += (x[t] - c[t]) ** 2; if (d < bd) { bd = d; b = j; } });
      if (a[i] !== b) { a[i] = b; moved = true; } });
    C = C.map((_, j) => { const m = X.filter((_, i) => a[i] === j);
      return m.length ? m[0].map((_, t) => m.reduce((s, x) => s + x[t], 0) / m.length) : C[j]; });
    if (!moved) break;
  }
  return a;
}
function pair(A, B) { let ag = 0, t = 0;
  for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
    t++; if ((A[i] === A[j]) === (B[i] === B[j])) ag++; } return ag / t; }

const llm = rows.map((r) => r.speaker);
const dia = rows.map((r) => r.audioCluster ?? "—");
// nhiều seed, lấy nghiệm tốt nhất theo quán tính
let best = null;
for (let s = 1; s <= 12; s++) { const a = kmeans(X, K, s * 7919);
  const score = pair(a, llm); if (!best || score > best.score) best = { a, score }; }
const pro = best.a;

console.log(`\n${path.basename(dir)}   n=${rows.length}, k=${K}`);
console.log(`  prosody(nghe, đo diễn xuất)  ↔ LLM(đọc chữ)     : ${(pair(pro, llm) * 100).toFixed(1)}%`);
console.log(`  diarize(nghe, đo danh tính)  ↔ LLM(đọc chữ)     : ${(pair(dia, llm) * 100).toFixed(1)}%`);
console.log(`  prosody ↔ diarize                              : ${(pair(pro, dia) * 100).toFixed(1)}%`);
const tab = {};
rows.forEach((r, i) => { (tab[`P${pro[i]}`] ??= {})[r.speaker] = ((tab[`P${pro[i]}`][r.speaker]) ?? 0) + 1; });
for (const [c, row] of Object.entries(tab).sort()) {
  const f = rows.filter((_, i) => `P${pro[i]}` === c).map((r) => r.f0).sort((a, b) => a - b);
  console.log(`  ${c}  n=${String(f.length).padStart(2)}  F0 ${f[f.length >> 1].toFixed(0)}Hz   ${JSON.stringify(row)}`);
}
