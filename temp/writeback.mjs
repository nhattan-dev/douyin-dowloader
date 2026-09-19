import fs from "node:fs";
import path from "node:path";
// Ghi nhãn vào 2 nơi, mỗi nơi một mức chi tiết khác nhau:
//  - translation.json ← toàn bộ lượt đã tách (dub-video.mjs đọc file này)
//  - transcript.json  ← CHỈ những segment thuộc unit không bị tách. Segment nào nằm
//    trong unit có nhiều lượt thì để null: extract-voice.js cắt theo mốc của
//    transcript, mà một segment chứa 2 người thì mẫu giọng bị lẫn — thà bỏ còn hơn.
const [userId, videoId] = process.argv.slice(2);
const dir = path.join("data", userId, videoId);
const dub = JSON.parse(fs.readFileSync(path.join(dir, "dub-segments.json"), "utf8"));

for (const f of ["translation.json", "transcript.json"]) {
  const src = path.join(dir, f), bak = path.join(dir, f + ".orig");
  if (!fs.existsSync(bak)) fs.copyFileSync(src, bak);
}
const trans = JSON.parse(fs.readFileSync(path.join(dir, "translation.json.orig"), "utf8"));
const tr = JSON.parse(fs.readFileSync(path.join(dir, "transcript.json.orig"), "utf8"));

trans.segments = dub.segments.map((s) => ({ ...s, speakerSource: "llm-v3" }));
trans.speakers = [...new Set(dub.segments.map((s) => s.speaker))];
fs.writeFileSync(path.join(dir, "translation.json"), JSON.stringify(trans, null, 2), "utf8");

const owners = new Map();   // segmentIndex -> Set(speaker) trên toàn bộ lượt
for (const s of dub.segments) for (const i of s.segmentIndexes ?? []) {
  (owners.get(i) ?? owners.set(i, new Set()).get(i)).add(s.speaker);
}
let clean = 0;
tr.segments = tr.segments.map((seg, i) => {
  const set = owners.get(i);
  const one = set && set.size === 1 ? [...set][0] : null;
  if (one) clean += 1;
  return { ...seg, speaker: one, speakerSource: one ? "llm-v3" : null };
});
tr.speakers = [...new Set(tr.segments.map((s) => s.speaker).filter(Boolean))];
fs.writeFileSync(path.join(dir, "transcript.json"), JSON.stringify(tr, null, 2), "utf8");

const dist = {};
for (const s of tr.segments) if (s.speaker) dist[s.speaker] = (dist[s.speaker] ?? 0) + 1;
console.log(`${videoId}: translation ${trans.segments.length} lượt | transcript ${clean}/${tr.segments.length} segment sạch  ${JSON.stringify(dist)}`);
