import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
// Âm sắc (MFCC) thay vì chỉ cao độ. Đây mới là thứ tai người dùng để phân biệt
// "giọng già khàn" với "giọng trẻ trong" khi CÙNG một người lồng.
const SR = 16000, N = 512, HOP = 160, NMEL = 26, NCEP = 13;
const dir = process.argv[2];
const review = JSON.parse(fs.readFileSync(path.join(dir, "speaker-review.json"), "utf8"));
const audio = fs.readdirSync(dir).find((f) => /^audio\.(m4a|mp3|wav|mp4)$/i.test(f));
const buf = execFileSync("ffmpeg", ["-v", "quiet", "-i", path.join(dir, audio), "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"], { maxBuffer: 1 << 30 });
const pcm = new Float32Array(buf.length / 2);
for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2) / 32768;

const cosT = new Float32Array(N / 2), sinT = new Float32Array(N / 2);
for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos((-2 * Math.PI * i) / N); sinT[i] = Math.sin((-2 * Math.PI * i) / N); }
function fft(re, im) { // radix-2, in place
  for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= N; len <<= 1) { const step = N / len;
    for (let i = 0; i < N; i += len) for (let k = 0; k < len / 2; k++) {
      const c = cosT[k * step], s = sinT[k * step];
      const ur = re[i + k], ui = im[i + k];
      const vr = re[i + k + len / 2] * c - im[i + k + len / 2] * s;
      const vi = re[i + k + len / 2] * s + im[i + k + len / 2] * c;
      re[i + k] = ur + vr; im[i + k] = ui + vi;
      re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi; } }
}
const hz2mel = (h) => 2595 * Math.log10(1 + h / 700), mel2hz = (m) => 700 * (10 ** (m / 2595) - 1);
const melPts = Array.from({ length: NMEL + 2 }, (_, i) => Math.floor((N + 1) * mel2hz(hz2mel(80) + (i * (hz2mel(SR / 2) - hz2mel(80))) / (NMEL + 1)) / SR));
const win = Float32Array.from({ length: N }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (N - 1)));

function frameMfcc(off) {
  const re = new Float32Array(N), im = new Float32Array(N);
  let e = 0;
  for (let i = 0; i < N; i++) { re[i] = pcm[off + i] * win[i]; e += re[i] * re[i]; }
  if (e < 1e-4) return null;
  fft(re, im);
  const pow = new Float32Array(N / 2 + 1);
  for (let i = 0; i <= N / 2; i++) pow[i] = (re[i] * re[i] + im[i] * im[i]) / N;
  const fb = new Float32Array(NMEL);
  for (let m = 1; m <= NMEL; m++) { let s = 0;
    for (let k = melPts[m - 1]; k < melPts[m]; k++) s += pow[k] * ((k - melPts[m - 1]) / Math.max(1, melPts[m] - melPts[m - 1]));
    for (let k = melPts[m]; k < melPts[m + 1]; k++) s += pow[k] * ((melPts[m + 1] - k) / Math.max(1, melPts[m + 1] - melPts[m]));
    fb[m - 1] = Math.log(s + 1e-10); }
  const c = new Float32Array(NCEP);
  for (let j = 0; j < NCEP; j++) { let s = 0;
    for (let m = 0; m < NMEL; m++) s += fb[m] * Math.cos((Math.PI * j * (m + 0.5)) / NMEL); c[j] = s; }
  return c;
}
const rows = review.lines.filter((l) => l.speaker && l.speaker !== "NON_SPEECH").map((l) => {
  const from = Math.max(0, Math.floor(l.start * SR)), to = Math.min(pcm.length, Math.floor(l.end * SR));
  const acc = new Float64Array(NCEP); let n = 0;
  for (let off = from; off + N < to; off += HOP) { const c = frameMfcc(off); if (c) { for (let j = 0; j < NCEP; j++) acc[j] += c[j]; n++; } }
  return { line: l.line, speaker: l.speaker, audioCluster: l.audioCluster ?? "—", n,
    mfcc: n ? Array.from(acc, (v) => v / n) : null };
}).filter((r) => r.mfcc && r.n >= 5);
fs.writeFileSync(path.join(dir, "mfcc.json"), JSON.stringify(rows), "utf8");

// bỏ c0 (năng lượng), chuẩn hoá, k-means
const X0 = rows.map((r) => r.mfcc.slice(1));
const D = X0[0].length;
const mu = Array.from({ length: D }, (_, d) => X0.reduce((s, x) => s + x[d], 0) / X0.length);
const sd = Array.from({ length: D }, (_, d) => Math.sqrt(X0.reduce((s, x) => s + (x[d] - mu[d]) ** 2, 0) / X0.length) || 1);
const X = X0.map((x) => x.map((v, d) => (v - mu[d]) / sd[d]));
function kmeans(X, k, seed) { let rnd = seed; const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let C = Array.from({ length: k }, () => X[Math.floor(rand() * X.length)].slice()), a = new Array(X.length).fill(0);
  for (let it = 0; it < 80; it++) { let moved = false;
    X.forEach((x, i) => { let b = 0, bd = Infinity;
      C.forEach((c, j) => { let d = 0; for (let t = 0; t < x.length; t++) d += (x[t] - c[t]) ** 2; if (d < bd) { bd = d; b = j; } });
      if (a[i] !== b) { a[i] = b; moved = true; } });
    C = C.map((_, j) => { const m = X.filter((_, i) => a[i] === j); return m.length ? m[0].map((_, t) => m.reduce((s, x) => s + x[t], 0) / m.length) : C[j]; });
    if (!moved) break; }
  return a; }
const pair = (A, B) => { let ag = 0, t = 0; for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) { t++; if ((A[i] === A[j]) === (B[i] === B[j])) ag++; } return ag / t; };
const llm = rows.map((r) => r.speaker), dia = rows.map((r) => r.audioCluster);
const K = new Set(llm).size;
let best = null;
for (let s = 1; s <= 20; s++) { const a = kmeans(X, K, s * 7919); const sc = pair(a, llm); if (!best || sc > best.sc) best = { a, sc }; }
console.log(`\n${path.basename(dir)}  n=${rows.length} k=${K}`);
console.log(`  MFCC(âm sắc) ↔ LLM   : ${(pair(best.a, llm) * 100).toFixed(1)}%   [nghiệm tốt nhất trong 20 seed]`);
console.log(`  diarize      ↔ LLM   : ${(pair(dia, llm) * 100).toFixed(1)}%`);
console.log(`  MFCC ↔ diarize       : ${(pair(best.a, dia) * 100).toFixed(1)}%`);
const tab = {}; rows.forEach((r, i) => { (tab[`M${best.a[i]}`] ??= {})[r.speaker] = (tab[`M${best.a[i]}`][r.speaker] ?? 0) + 1; });
for (const [c, row] of Object.entries(tab).sort()) console.log(`  ${c}  ${JSON.stringify(row)}`);
