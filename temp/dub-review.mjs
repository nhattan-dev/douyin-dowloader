import fs from "node:fs";
import path from "node:path";
const [userId, videoId] = process.argv.slice(2);
const dir = path.join("data", userId, videoId);
const d = JSON.parse(fs.readFileSync(path.join(dir, "dub-segments.json"), "utf8"));
// Cờ soát đến từ HAI bước khác nhau — phải nói rõ bước nào, không thì đọc report
// thấy "3/3 phiếu" mà vẫn bị gắn cờ, tưởng lỗi hiển thị.
const unitReason = new Map(JSON.parse(fs.readFileSync(path.join(dir, "speaker-review.json"), "utf8"))
  .lines.map((l) => [l.index, l.verdict === "ok" ? null : l.reason]));
const t = [];
const dist = {};
for (const s of d.segments) dist[s.speaker] = (dist[s.speaker] ?? 0) + 1;
t.push(`${videoId} — ${d.segments.length} lượt thoại, tách từ ${d.unitsSplit} unit bị ASR gộp`);
t.push(`cần soát: ${d.segments.filter((x) => x.needsReview).length}/${d.segments.length}`);
t.push(`nhân vật: ${Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(" · ")}`);
t.push("");
let prev = null;
for (const s of d.segments) {
  const mark = s.needsReview ? "?" : s.index.includes(".") ? "✂" : " ";
  const gap = prev ? s.start - prev.end : 0;
  if (gap > 4) t.push(`      … im lặng ${gap.toFixed(1)}s`);
  t.push(`${mark} ${s.index.padStart(5)} ${s.start.toFixed(1).padStart(6)}s ${String(s.speaker).padEnd(11)} ${s.zh || "(cùng đoạn zh ở trên)"}`);
  t.push(`${" ".repeat(27)}${s.vi}`);
  if (s.needsReview) {
    const why = (s.vote ?? 1) < 1
      ? `bước tách lượt: 3 mẫu chỉ ${Math.round(s.vote * 3)} phiếu cho ${s.speaker}`
      : `bước gán nhân vật: ${unitReason.get(s.fromUnit ?? Number(s.index)) ?? "?"}`;
    t.push(`${" ".repeat(27)}└ ${why}`);
  }
  if (s.voiceBorrowed) t.push(`${" ".repeat(27)}└ ${s.voiceBorrowed}`);
  prev = s;
}
fs.writeFileSync(path.join(dir, "dub-review.txt"), t.join("\n") + "\n", "utf8");
console.log(path.join(dir, "dub-review.txt"));
