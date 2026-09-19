import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Đo ĐẶC TRƯNG DIỄN XUẤT của từng segment, không phải danh tính người nói:
// cao độ (F0), độ rộng cao độ, năng lượng, tỷ lệ khung hữu thanh, tốc độ nói.
// Giả thuyết: một người lồng nhiều vai thì các vai tách nhau trên mấy trục này,
// dù embedding speaker-ID coi tất cả là MỘT người (nó được huấn luyện để bất biến
// với đúng những thứ này).
const SR = 8000, FRAME = 256, HOP = 80;      // 32ms / 10ms
const LAG_MIN = Math.round(SR / 400), LAG_MAX = Math.round(SR / 60);  // 60–400 Hz

const dir = process.argv[2];
const T = JSON.parse(fs.readFileSync(path.join(dir, "transcript.json"), "utf8"));
const review = JSON.parse(fs.readFileSync(path.join(dir, "speaker-review.json"), "utf8"));
const audio = fs.readdirSync(dir).find((f) => /^audio\.(m4a|mp3|wav|mp4)$/i.test(f));

const pcmBuf = execFileSync("ffmpeg", ["-v", "quiet", "-i", path.join(dir, audio),
  "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"], { maxBuffer: 1 << 30 });
const pcm = new Float32Array(pcmBuf.length / 2);
for (let i = 0; i < pcm.length; i++) pcm[i] = pcmBuf.readInt16LE(i * 2) / 32768;

/** F0 một khung bằng tự tương quan chuẩn hoá; null nếu không hữu thanh. */
function f0(off) {
  let mean = 0;
  for (let i = 0; i < FRAME; i++) mean += pcm[off + i];
  mean /= FRAME;
  const x = new Float32Array(FRAME);
  let e0 = 0;
  for (let i = 0; i < FRAME; i++) { x[i] = pcm[off + i] - mean; e0 += x[i] * x[i]; }
  if (e0 < 1e-4) return null;                       // im lặng
  let best = 0, bestLag = 0;
  for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
    let s = 0, e = 0;
    for (let i = 0; i + lag < FRAME; i++) { s += x[i] * x[i + lag]; e += x[i + lag] * x[i + lag]; }
    const r = e > 0 ? s / Math.sqrt(e0 * e) : 0;
    if (r > best) { best = r; bestLag = lag; }
  }
  return best > 0.4 ? { hz: SR / bestLag, rms: Math.sqrt(e0 / FRAME) } : null;
}
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

const rows = review.lines.map((l) => {
  const from = Math.max(0, Math.floor(l.start * SR));
  const to = Math.min(pcm.length, Math.floor(l.end * SR));
  const hz = [], rms = [];
  let frames = 0;
  for (let off = from; off + FRAME < to; off += HOP) { frames += 1;
    const r = f0(off); if (r) { hz.push(r.hz); rms.push(r.rms); } }
  const dur = l.end - l.start;
  return { line: l.line, start: l.start, end: l.end, text: l.text, speaker: l.speaker,
    audioCluster: l.audioCluster, verdict: l.verdict,
    f0: med(hz), f0iqr: hz.length > 3 ? q(hz, 0.75) - q(hz, 0.25) : null,
    rms: med(rms), voiced: frames ? hz.length / frames : 0,
    rate: dur > 0 ? [...l.text].filter((c) => /\p{Script=Han}/u.test(c)).length / dur : 0 };
});

const by = {};
for (const r of rows) if (r.f0 && r.speaker) (by[r.speaker] ??= []).push(r);
console.log(`\n${T.videoId}  (${audio})`);
console.log(`  nhân vật         n   F0 trung vị   F0 p25–p75     RMS     hữu thanh  chữ/giây`);
for (const [nme, rs] of Object.entries(by).sort((a, b) => b[1].length - a[1].length)) {
  const f = rs.map((r) => r.f0);
  console.log(`  ${nme.padEnd(14)}${String(rs.length).padStart(3)}   ${med(f).toFixed(1).padStart(6)} Hz   ` +
    `${(q(f, 0.25).toFixed(0) + "–" + q(f, 0.75).toFixed(0) + " Hz").padEnd(13)} ` +
    `${med(rs.map((r) => r.rms)).toFixed(3)}    ${(med(rs.map((r) => r.voiced)) * 100).toFixed(0)}%      ${med(rs.map((r) => r.rate)).toFixed(1)}`);
}
const all = rows.filter((r) => r.f0 && r.speaker);
const gm = med(all.map((r) => r.f0));
let sb = 0, sw = 0;
for (const rs of Object.values(by)) { const m = med(rs.map((r) => r.f0));
  sb += rs.length * (m - gm) ** 2; for (const r of rs) sw += (r.f0 - m) ** 2; }
const k = Object.keys(by).length;
console.log(`  → F-ratio F0 (giữa nhóm/trong nhóm): ${(sb / (k - 1) / (sw / (all.length - k))).toFixed(2)}   (n=${all.length}, k=${k})`);
fs.writeFileSync(path.join(dir, "prosody.json"), JSON.stringify(rows, null, 2), "utf8");
