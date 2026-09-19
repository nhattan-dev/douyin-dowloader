import fs from "node:fs/promises";
import OpenAI from "openai";

import { logApiCall } from "../src/apiLog.js";
import { createLogger } from "../src/logger.js";

// stderr: script này ghi kết quả JSON ra stdout để pipe sang bước sau.
const log = createLogger("BLIND-ATTR", { stderr: true });

const [file, providerName = "deepseek"] = process.argv.slice(2);
const t = JSON.parse(await fs.readFile(file, "utf8"));
const segs = t.segments ?? [];

const P = {
  deepseek: { baseURL: "https://api.deepseek.com", key: process.env.DEEPSEEK_API_KEY, model: process.env.DS_MODEL || "deepseek-chat" },
  qwen: { baseURL: process.env.QWEN_BASE_URL, key: process.env.DASHSCOPE_API_KEY, model: process.env.QW_MODEL || "qwen-plus" },
  openai: { baseURL: undefined, key: process.env.OPENAI_API_KEY, model: process.env.OA_MODEL || "gpt-4o-mini" },
}[providerName];

const client = new OpenAI({ apiKey: P.key, baseURL: P.baseURL, timeout: 300000, maxRetries: 2 });

// Dòng đánh số + mốc thời gian + khoảng lặng trước đó (đổi cảnh). KHÔNG lộ nhãn audio.
const lines = segs.map((s, i) => {
  const gap = i === 0 ? 0 : s.start - segs[i - 1].end;
  const mark = gap > 4 ? `  <<< im lặng ${gap.toFixed(1)}s` : "";
  return `${i + 1}. [${s.start.toFixed(1)}s] ${s.text}${mark}`;
}).join("\n");

const sys = [
  "Bạn phân định NGƯỜI NÓI cho lời thoại đã bóc băng từ một video kể truyện Trung Quốc.",
  "Bạn KHÔNG nghe được audio. Chỉ suy từ nội dung: xưng hô (本座/晚辈/前辈/道友/师傅/大师兄/呆子…),",
  "ai hỏi ai đáp, ai đang trong cảnh, mốc thời gian và khoảng im lặng (đổi cảnh).",
  "",
  "Bước 1: liệt kê dàn nhân vật thật sự xuất hiện (kể cả người dẫn truyện nếu có).",
  "Bước 2: gán mỗi dòng cho đúng một nhân vật trong dàn đó.",
  "Với mỗi dòng cho `confidence` 0..1 và `cue` = manh mối ngắn gọn khiến bạn quyết định vậy.",
  "Dòng nào không phải lời thoại (nhạc, tiếng động, ký tự rác) thì speaker = \"NON_SPEECH\".",
  "Dòng nào thật sự không đủ căn cứ thì speaker = \"UNKNOWN\", confidence thấp.",
  "",
  'Trả JSON: {"cast":[{"id":"C1","name":"…","note":"…"}],',
  ' "lines":[{"line":1,"speaker":"C1","confidence":0.9,"cue":"…"}]}',
  "Mọi dòng đều phải có mặt trong `lines`.",
].join("\n");

const t0 = Date.now();
const params = {
  model: P.model, temperature: 0, response_format: { type: "json_object" },
  messages: [{ role: "system", content: sys }, { role: "user", content: lines }],
};
const res = await logApiCall(log, { url: "https://api.deepseek.com/chat/completions", body: params }, () =>
  client.chat.completions.create(params),
);
const out = JSON.parse(res.choices[0].message.content);
const u = res.usage;
console.error(`[${providerName}:${P.model}] ${((Date.now() - t0) / 1000).toFixed(1)}s  in=${u.prompt_tokens} out=${u.completion_tokens}`);

const castName = Object.fromEntries((out.cast ?? []).map((c) => [c.id, c.name]));
console.log("CAST:", (out.cast ?? []).map((c) => `${c.id}=${c.name}`).join("  "));

const llm = new Map((out.lines ?? []).map((l) => [Number(l.line), l]));

// cluster audio -> nhân vật LLM chiếm đa số
const tally = {};
segs.forEach((s, i) => {
  const a = s.speaker ?? "null";
  const b = llm.get(i + 1)?.speaker ?? "?";
  (tally[a] ??= {})[b] = (tally[a][b] ?? 0) + 1;
});
const map = {};
for (const [c, row] of Object.entries(tally)) {
  const [best] = Object.entries(row).sort((a, b) => b[1] - a[1]);
  map[c] = best[0];
  console.log(`  ${c.padEnd(4)} -> ${String(castName[best[0]] ?? best[0]).padEnd(8)} (${best[1]}/${Object.values(row).reduce((x, y) => x + y, 0)})  ${JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, v]) => [castName[k] ?? k, v])))}`);
}

let dis = 0;
console.log("\nDÒNG:");
segs.forEach((s, i) => {
  const l = llm.get(i + 1) ?? {};
  const audio = s.speaker ?? "null";
  const mapped = map[audio];
  const bad = mapped !== l.speaker;
  if (bad) dis += 1;
  console.log(
    `${bad ? "✗" : " "} ${String(i + 1).padStart(3)} ${s.start.toFixed(1).padStart(6)}s ` +
    `audio=${String(audio).padEnd(4)}→${String(castName[mapped] ?? mapped).padEnd(8)} ` +
    `llm=${String(castName[l.speaker] ?? l.speaker).padEnd(8)} c=${(l.confidence ?? 0).toFixed(2)} ` +
    `| ${s.text.slice(0, 34)} | ${l.cue ?? ""}`,
  );
});
console.log(`\nBẤT ĐỒNG: ${dis}/${segs.length} (${(dis / segs.length * 100).toFixed(1)}%)`);
await fs.writeFile(file.replace(/[/]/g, "_") + `.${providerName}.json`, JSON.stringify(out, null, 2));
