import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

import { logApiCall } from "../src/apiLog.js";
import { createLogger } from "../src/logger.js";

// stderr: script này ghi kết quả JSON ra stdout để pipe sang bước sau.
const log = createLogger("TURNS-V2", { stderr: true });

// Tách lượt thoại — cách thứ ba, sau khi hai cách trước đo được là hỏng.
//
// Đã thử và BỎ:
//  1. Bắt model chép lại từng mảnh zh/vi → nó trả đúng 1 lượt cho mọi unit, không cắt.
//  2. Bắt model chỉ ra mỏ neo đầu mỗi lượt (+few-shot) → chỉ bắt được 3/20 unit.
// Cả hai hỏng vì "tự tìm ranh giới" là việc khó; model né bằng cách trả 1 lượt.
//
// Cách dùng ở đây: KHÔNG hỏi ranh giới nữa. Cắt sẵn bằng dấu câu rồi chỉ bắt model
// DÁN NHÃN từng câu — bài phân loại, dễ hơn hẳn.
//
// Cắt theo dấu câu của bản DỊCH chứ không của zh: đo được zh của mấy unit bị gộp
// KHÔNG có dấu chấm nào (ASR nuốt), trong khi bản dịch có đủ — người dịch đã hiểu ra
// cấu trúc lượt thoại và chấm câu đúng. Unit [24] của tập 1: zh 1 câu / vi 7 câu.
//
// Mốc thời gian: quy tỷ lệ ký tự vi → vị trí ký tự zh → tra word-timestamp thật của
// raw-qwen.json. Có xấp xỉ ở bước quy tỷ lệ, nhưng vẫn hơn nội suy tuyến tính theo
// thời gian vì tốc độ đọc không đều.
const [userId, videoId] = process.argv.slice(2);
const dir = path.join("data", userId, videoId);
// LUÔN đọc bản gốc nếu có: writeback đã ghi đè translation.json bằng các lượt đã
// tách, chạy lại trên đó là tách chồng lên tách (đã sập một lần: 38 → 8 lượt).
const transFile = fs.existsSync(path.join(dir, "translation.json.orig"))
  ? path.join(dir, "translation.json.orig") : path.join(dir, "translation.json");
const trans = JSON.parse(fs.readFileSync(transFile, "utf8"));
const review = JSON.parse(fs.readFileSync(path.join(dir, "speaker-review.json"), "utf8"));
const words = (JSON.parse(fs.readFileSync(path.join(dir, "raw-qwen.json"), "utf8")).words) ?? [];
const cast = JSON.parse(fs.readFileSync(path.join("data", userId, "cast.json"), "utf8")).cast;
const byIndex = new Map(review.lines.map((l) => [l.index, l]));

const splitVi = (s) => s.split(/(?<=[.?!…])\s+/).map((x) => x.trim()).filter(Boolean);
const PUNC = /[\s\p{P}\p{S}]/u;
const strip = (s) => [...s].filter((c) => !PUNC.test(c)).join("");

const client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com", timeout: 300000, maxRetries: 2 });
const sys = [
  "给对白的每一句标注【说话人】。ASR 会把不同角色的台词合并成一段，所以同一段里可能有多个说话人。",
  "",
  "角色表：" + cast.map((c) => `${c.name}（${c.gender}，${c.note}）`).join("；"),
  "",
  "输入：中文原文（可能整段没有断句），以及它的越南语译文，译文已按句编号。",
  "请逐句判断说话人。判据：问句与答句必属不同人；称呼反转（一方喊对方名字/称谓）；立场对立；自称词。",
  "同一个人可以连说多句。角色表以外的人物可以新增，但要用中文名。",
  "不是台词的（音乐、拟声、乱码）标 NON_SPEECH。",
  "",
  'JSON：{"labels":[{"i":1,"speaker":"…"},{"i":2,"speaker":"…"}]}  每句都要有。',
].join("\n");

// K mẫu cho MỖI unit rồi bỏ phiếu từng câu: một mẫu đơn lẻ hay đảo cực cặp hỏi/đáp
// (gán câu hỏi cho chính người vừa bị hỏi). Câu nào không nhất trí thì gắn cờ soát.
const K = Number(process.env.K ?? 3);
const raw = {};
let calls = 0, tin = 0, tout = 0;
for (const u of trans.segments) {
  const sents = splitVi(u.vi ?? "");
  if (sents.length <= 1) continue;
  const samples = [];
  for (let k = 0; k < K; k++) {
    const params = {
      model: "deepseek-chat", temperature: k === 0 ? 0 : 0.7, response_format: { type: "json_object" },
      messages: [{ role: "system", content: sys },
        { role: "user", content: `中文：${u.zh}\n\n越南语译文：\n${sents.map((s, i) => `${i + 1}. ${s}`).join("\n")}` }],
    };
    const res = await logApiCall(log, { url: "https://api.deepseek.com/chat/completions", body: params }, () =>
      client.chat.completions.create(params),
    );
    calls++; tin += res.usage.prompt_tokens; tout += res.usage.completion_tokens;
    samples.push(JSON.parse(res.choices[0].message.content).labels ?? []);
    process.stderr.write(`\r  ${calls}`);
  }
  const labels = sents.map((_, i) => {
    const v = samples.map((s) => String(s.find((x) => Number(x.i) === i + 1)?.speaker ?? ""));
    const c = {}; for (const x of v) if (x) c[x] = (c[x] ?? 0) + 1;
    const e = Object.entries(c).sort((a, b) => b[1] - a[1]);
    return { i: i + 1, speaker: e[0]?.[0] ?? null, vote: e.length ? e[0][1] / K : 0, votes: v };
  });
  raw[u.index] = { sents, labels };
}
process.stderr.write("\n");
fs.writeFileSync(path.join(dir, "raw-turns.json"), JSON.stringify(raw, null, 2), "utf8");

/** Mốc thời gian tại biên ký tự thứ k (đã bỏ dấu câu) của zh trong khoảng [a,b]. */
function timeAt(a, b, k) {
  const inRange = words.filter((w) => w.start >= a - 0.01 && w.end <= b + 0.01);
  if (!inRange.length) return null;
  let acc = 0;
  for (const w of inRange) { const len = strip(w.word).length;
    if (acc + len > k) return w.start; acc += len; }
  return inRange.at(-1).end;
}

const out = [];
let nsplit = 0;
for (const u of trans.segments) {
  const fallback = byIndex.get(u.index)?.speaker ?? null;
  const r = raw[u.index];
  if (!r) { out.push({ index: String(u.index), start: u.start, end: u.end, zh: u.zh, vi: u.vi,
    speaker: fallback, vote: byIndex.get(u.index)?.vote ?? 1,
    needsReview: (byIndex.get(u.index)?.verdict ?? "ok") !== "ok", segmentIndexes: u.segmentIndexes }); continue; }

  const lab = new Map(r.labels.map((l) => [Number(l.i), String(l.speaker)]));
  const conf = new Map(r.labels.map((l) => [Number(l.i), l.vote ?? 1]));
  // gộp câu liền nhau cùng người thành một lượt
  const groups = [];
  r.sents.forEach((s, i) => {
    const spk = lab.get(i + 1) ?? fallback;
    const last = groups.at(-1);
    const p = conf.get(i + 1) ?? 1;
    if (last && last.speaker === spk) { last.sents.push(s); last.vote = Math.min(last.vote, p); }
    else groups.push({ speaker: spk, sents: [s], vote: p });
  });
  if (groups.length > 1) nsplit++;

  const viTotal = strip(r.sents.join("")).length || 1;
  const zhTotal = strip(u.zh).length;
  let viAcc = 0;
  groups.forEach((g, gi) => {
    const startRatio = viAcc / viTotal;
    viAcc += strip(g.sents.join("")).length;
    const endRatio = viAcc / viTotal;
    const st = gi === 0 ? u.start : (timeAt(u.start, u.end, Math.round(startRatio * zhTotal)) ?? u.start);
    const en = gi === groups.length - 1 ? u.end : (timeAt(u.start, u.end, Math.round(endRatio * zhTotal)) ?? u.end);
    out.push({ index: groups.length > 1 ? `${u.index}.${gi}` : String(u.index),
      start: Number(st.toFixed(2)), end: Number(Math.max(en, st + 0.4).toFixed(2)),
      zh: gi === 0 ? u.zh : "", vi: g.sents.join(" "), speaker: g.speaker,
      vote: g.vote ?? 1, needsReview: (g.vote ?? 1) < 1,
      segmentIndexes: u.segmentIndexes, fromUnit: u.index });
  });
}
out.sort((a, b) => a.start - b.start);
const keep = out.filter((s) => s.speaker && s.speaker !== "NON_SPEECH" && s.vi);
fs.writeFileSync(path.join(dir, "dub-segments.json"), JSON.stringify({ videoId,
  tokens: { in: tin, out: tout, calls }, unitsSplit: nsplit,
  segments: keep }, null, 2), "utf8");
const dist = {};
for (const s of keep) dist[s.speaker] = (dist[s.speaker] ?? 0) + 1;
console.log(`${videoId}: ${trans.segments.length} unit → ${keep.length} lượt (tách ${nsplit} unit, ${calls} call, ${tin}+${tout} tok)`);
console.log(`   cần soát: ${keep.filter((s) => s.needsReview).length}/${keep.length}`);
console.log(`   ${Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(" ")}`);
