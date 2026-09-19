import fs from "node:fs";
import path from "node:path";
const tr = process.argv[2], dir = path.dirname(tr);
const T = JSON.parse(fs.readFileSync(tr, "utf8")); const segs = T.segments;
const { runs } = JSON.parse(fs.readFileSync(path.join(dir, "raw-speaker-v2.json"), "utf8"));
// tên nhân vật giờ ổn định giữa các mẫu → quy về TÊN, không phải id
const nm = (r) => Object.fromEntries((r.cast ?? []).map((c) => [c.id, c.name]));
const votes = segs.map((_, i) => runs.map((r) => { const n = nm(r);
  const l = (r.lines ?? []).find((x) => Number(x.line) === i + 1); return l ? (n[l.speaker] ?? l.speaker) : "?"; }));
const audio = segs.map((s) => String(s.speaker ?? "null"));

const maj = votes.map((v) => { const c = {}; for (const x of v) c[x] = (c[x] ?? 0) + 1;
  const [n, k] = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; return { name: n, p: k / v.length }; });

// cụm audio × nhân vật (theo majority)
const tal = {}; segs.forEach((_, i) => { (tal[audio[i]] ??= {})[maj[i].name] = (tal[audio[i]][maj[i].name] ?? 0) + 1; });
console.log(`\n${T.videoId}  cast: ${[...new Set(maj.map((m) => m.name))].join(" · ")}`);
let pure = 0;
for (const [c, row] of Object.entries(tal)) { const e = Object.entries(row).sort((a, b) => b[1] - a[1]);
  const s = Object.values(row).reduce((a, b) => a + b, 0); pure += e[0][1];
  console.log(`  cụm ${c.padEnd(12)} ${String(s).padStart(2)} dòng purity ${String(((e[0][1]/s*100)|0)+"%").padStart(4)} → ${e[0][0]}   ${JSON.stringify(row)}`); }
console.log(`  purity tổng ${(pure/segs.length*100).toFixed(1)}%`);
const unan = maj.filter((m) => m.p === 1).length;
console.log(`  ${runs.length} mẫu nhất trí hoàn toàn: ${unan}/${segs.length} (${(unan/segs.length*100).toFixed(1)}%)`);

// ràng buộc addresses: người nói KHÔNG THỂ là người được gọi
let viol = 0;
console.log(`\n  dòng  p    nhãn(majority)   audio        text`);
segs.forEach((s, i) => {
  const addr = new Set();
  for (const r of runs) { const n = nm(r); const l = (r.lines ?? []).find((x) => Number(x.line) === i + 1);
    for (const a of l?.addresses ?? []) addr.add(n[a] ?? a); }
  const bad = addr.has(maj[i].name);
  if (bad) viol++;
  const flag = bad ? "‼" : maj[i].p < 1 ? "?" : " ";
  console.log(`${flag} ${String(i+1).padStart(4)} ${maj[i].p.toFixed(2)} ${maj[i].name.padEnd(14)} ${audio[i].padEnd(12)} ${s.text.slice(0,32)}${addr.size?"   →gọi: "+[...addr].join(","):""}`);
});
console.log(`\n  vi phạm ràng buộc "gọi chính mình": ${viol}`);
