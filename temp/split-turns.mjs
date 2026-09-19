import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

import { logApiCall } from "../src/apiLog.js";
import { createLogger } from "../src/logger.js";

// stderr: script này ghi kết quả JSON ra stdout để pipe sang bước sau.
const log = createLogger("SPLIT-TURNS", { stderr: true });

// Tách unit chứa NHIỀU lượt thoại thành từng lượt riêng.
//
// Vì sao bắt buộc: ASR gộp `先别杀我` (A nói) với `凭什么信你？` (B nói) vào một
// segment; một segment chỉ nhận được MỘT giọng nên không tách thì hai nhân vật bị
// đọc cùng giọng.
//
// Vì sao hỏi MỎ NEO chứ không bắt model chép lại nguyên văn từng mảnh: đã thử, model
// trả về đúng 1 lượt cho mọi mục và không cắt gì. Bắt nó chỉ ra vài ký tự đầu của
// mỗi lượt là việc cơ học, kiểm chứng được, và phần cắt do code làm nên không thể
// sai lệch một ký tự nào.
//
// Mốc thời gian lấy từ word-timestamp của raw-qwen.json, không nội suy theo số ký tự
// — tốc độ đọc không đều, nội suy là lệch tiếng.
const HEAD = 6;
const [userId, videoId] = process.argv.slice(2);
const dir = path.join("data", userId, videoId);
const trans = JSON.parse(fs.readFileSync(path.join(dir, "translation.json"), "utf8"));
const review = JSON.parse(fs.readFileSync(path.join(dir, "speaker-review.json"), "utf8"));
const qwen = JSON.parse(fs.readFileSync(path.join(dir, "raw-qwen.json"), "utf8"));
const cast = JSON.parse(fs.readFileSync(path.join("data", userId, "cast.json"), "utf8")).cast;
const words = qwen.words ?? [];
const byIndex = new Map(review.lines.map((l) => [l.index, l]));

const suspect = trans.segments.filter((u) => {
  const l = byIndex.get(u.index);
  return l && (l.verdict === "human" || u.end - u.start > 8);
});

const client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com", timeout: 300000, maxRetries: 2 });
const sys = [
  "把一段语音转写文本按【说话人变化】切分。ASR 会把不同角色的台词合并成一段，你要找出切换点。",
  "",
  "角色表：" + cast.map((c) => `${c.name}（${c.note}）`).join("；"),
  "",
  "步骤：",
  "1. 先判断这段里有几个人说话（turnCount）。问答对、称呼反转、立场对立都说明换人了。",
  `2. 为每一轮给出：说话人、该轮在 zh 里的前${HEAD}个字、该轮在 vi 里的前8个字。`,
  "   只要开头锚点，不要抄全句，切分由程序完成。",
  "",
  "示例A（3 轮）：",
  '  zh: 差点忘了，池子里还藏着一只色妖。先别杀我，他是牛魔王的人，凭什么信你？',
  '  vi: Suýt quên, trong ao còn giấu một con yêu nghiệt. Khoan giết ta, hắn là người của Ngưu Ma Vương, dựa vào đâu mà tin ngươi?',
  '  {"turnCount":3,"turns":[',
  '    {"speaker":"玉面狐狸","zhHead":"差点忘了，池","viHead":"Suýt quê"},',
  '    {"speaker":"小钻风","zhHead":"先别杀我，他","viHead":"Khoan gi"},',
  '    {"speaker":"玉面狐狸","zhHead":"凭什么信你？","viHead":"dựa vào"}]}',
  "",
  "示例B（1 轮）：",
  '  zh: 谁让你来的？',
  '  {"turnCount":1,"turns":[{"speaker":"玉面狐狸","zhHead":"谁让你来的？","viHead":"Ai sai n"}]}',
  "",
  "注意：只返回一轮、但文本里明显存在问答对或立场对立，是错误答案。",
  "锚点必须逐字来自原文，且按出现顺序排列，第一轮的锚点就是原文开头。",
  "",
  'JSON 格式：{"turnCount":<n>,"turns":[{"speaker":"…","zhHead":"…","viHead":"…"}]}',
];

const PUNC = /[\s\p{P}\p{S}]/u;
const strip = (s) => [...s].filter((c) => !PUNC.test(c)).join("");
/** Mốc thời gian của biên ký tự thứ k (đã bỏ dấu câu) trong khoảng [a,b] giây. */
function timeAt(a, b, k) {
  const inRange = words.filter((w) => w.start >= a - 0.01 && w.end <= b + 0.01);
  if (!inRange.length) return null;
  let acc = 0;
  for (const w of inRange) { const len = strip(w.word).length;
    if (acc + len > k) return w.start; acc += len; }
  return inRange.at(-1).end;
}
/** Vị trí mỏ neo trong chuỗi, so khớp sau khi bỏ dấu câu để model khỏi phải chép đúng dấu. */
function findAnchor(text, head, from) {
  const target = strip(head);
  if (!target) return -1;
  for (let i = from; i <= text.length - 1; i++) {
    let j = i, got = "";
    while (j < text.length && got.length < target.length) { if (!PUNC.test(text[j])) got += text[j]; j++; }
    if (got === target) return i;
  }
  return -1;
}

const raw = {};
let calls = 0, tin = 0, tout = 0;
for (const u of suspect) {
  const params = {
    model: "deepseek-chat", temperature: 0, response_format: { type: "json_object" },
    messages: [{ role: "system", content: sys.join("\n") },
      { role: "user", content: `zh: ${u.zh}\nvi: ${u.vi}` }],
  };
  const res = await logApiCall(log, { url: "https://api.deepseek.com/chat/completions", body: params }, () =>
    client.chat.completions.create(params),
  );
  calls++; tin += res.usage.prompt_tokens; tout += res.usage.completion_tokens;
  raw[u.index] = JSON.parse(res.choices[0].message.content);
  process.stderr.write(`\r  ${calls}/${suspect.length}`);
}
process.stderr.write("\n");
fs.writeFileSync(path.join(dir, "raw-split.json"), JSON.stringify(raw, null, 2), "utf8");

const out = [];
let nsplit = 0, reject = 0;
for (const u of trans.segments) {
  const turns = raw[u.index]?.turns ?? [];
  const fallback = byIndex.get(u.index)?.speaker ?? null;
  if (turns.length <= 1) { out.push({ ...u, speaker: turns[0]?.speaker ?? fallback }); continue; }

  // định vị mỏ neo; lượt đầu luôn bắt đầu từ 0
  const zhCuts = [0], viCuts = [0];
  let okAll = true;
  for (const t of turns.slice(1)) {
    const z = findAnchor(u.zh, t.zhHead ?? "", zhCuts.at(-1) + 1);
    const v = findAnchor(u.vi, t.viHead ?? "", viCuts.at(-1) + 1);
    if (z < 0 || v < 0) { okAll = false; break; }
    zhCuts.push(z); viCuts.push(v);
  }
  if (!okAll) { reject++; out.push({ ...u, speaker: fallback, splitRejected: true }); continue; }
  zhCuts.push(u.zh.length); viCuts.push(u.vi.length);

  nsplit++;
  let acc = 0;
  for (let i = 0; i < turns.length; i++) {
    const zh = u.zh.slice(zhCuts[i], zhCuts[i + 1]).trim();
    const vi = u.vi.slice(viCuts[i], viCuts[i + 1]).trim();
    if (!zh || !vi) continue;
    const startChar = acc; acc += strip(zh).length;
    const st = i === 0 ? u.start : (timeAt(u.start, u.end, startChar) ?? u.start);
    const en = i === turns.length - 1 ? u.end : (timeAt(u.start, u.end, acc) ?? u.end);
    out.push({ index: `${u.index}.${i}`, start: Number(st.toFixed(2)),
      end: Number(Math.max(en, st + 0.3).toFixed(2)), zh, vi, speaker: turns[i].speaker,
      segmentIndexes: u.segmentIndexes, fromUnit: u.index });
  }
}
out.sort((a, b) => a.start - b.start);
fs.writeFileSync(path.join(dir, "dub-segments.json"), JSON.stringify({ videoId,
  tokens: { in: tin, out: tout, calls }, split: nsplit, rejected: reject, segments: out }, null, 2), "utf8");
const dist = {};
for (const s of out) dist[s.speaker] = (dist[s.speaker] ?? 0) + 1;
console.log(`${videoId}: ${trans.segments.length} → ${out.length} lượt (tách ${nsplit} unit, từ chối ${reject}) ` +
  `[${calls} call, ${tin}+${tout} tok]   ${Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(" ")}`);
