import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

import { logApiCall } from "../src/apiLog.js";
import { createLogger } from "../src/logger.js";

// stderr: script này ghi kết quả JSON ra stdout để pipe sang bước sau.
const log = createLogger("CAST", { stderr: true });
// STAGE 0 — dàn nhân vật cấp KÊNH, chạy MỘT lần cho cả series.
// Lý do: 11 tập cùng một phim, cùng dàn. Dựng riêng từng tập thì mỗi tập model đặt
// một kiểu tên (đã đo: 拍卖行管事 vs 拍卖行晚辈 cùng một người), giọng TTS cũng nhảy
// theo. Dựng chung một lần thì tên VÀ giọng ổn định xuyên tập.
const userId = process.argv[2];
const root = path.join("data", userId);
const ids = fs.readdirSync(root).filter((f) => /^\d+$/.test(f)).sort();

const descs = ids.map((v) => {
  const m = JSON.parse(fs.readFileSync(path.join(root, v, "meta.json"), "utf8"));
  return `- [${v}] ${(m.desc || "").replace(/\s+/g, " ").trim()}`;
}).join("\n");

// Kèm thoại thật của vài tập: hashtag cho tên nhân vật, thoại cho cách xưng hô.
const sample = ids.slice(0, 3).map((v) => {
  const t = JSON.parse(fs.readFileSync(path.join(root, v, "transcript.json"), "utf8"));
  return `### ${v}\n` + t.segments.map((s) => s.text).join("\n");
}).join("\n\n");

const client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com", timeout: 300000, maxRetries: 2 });
const params = {
  model: "deepseek-chat", temperature: 0, response_format: { type: "json_object" },
  messages: [{ role: "system", content: [
    "Bạn dựng DÀN NHÂN VẬT cho một series phim hoạt hình Trung Quốc, để dùng lại cho mọi tập.",
    "Nguồn: mô tả (caption + hashtag) của từng tập, và lời thoại thật của 3 tập đầu.",
    "",
    "Quy tắc:",
    "- Gộp mọi cách gọi của CÙNG một người vào MỘT nhân vật. Chức danh (师傅/大王/前辈/",
    "  道友/长老) là CÁCH GỌI, không phải nhân vật riêng.",
    "- Chỉ đưa vào nhân vật CÓ THOẠI hoặc được hashtag nêu tên. Không bịa.",
    "- `self` = từ nhân vật tự xưng; `other` = từ người khác gọi/nhắc tới nhân vật đó.",
    "- `gender` = male | female | unknown (dùng để chọn giọng lồng tiếng).",
    "- `role` = main nếu xuất hiện nhiều tập, episodic nếu chỉ một tập.",
    'Trả về JSON đúng shape sau:',
    '{"cast":[{"id":"C1","name":"…","gender":"…","role":"…","note":"…","self":[],"other":[]}]}',
  ].join("\n") },
  { role: "user", content: `## MÔ TẢ TỪNG TẬP\n${descs}\n\n## THOẠI 3 TẬP ĐẦU\n${sample}` }],
};
const res = await logApiCall(log, { url: "https://api.deepseek.com/chat/completions", body: params }, () =>
  client.chat.completions.create(params),
);
console.error(`in=${res.usage.prompt_tokens} out=${res.usage.completion_tokens}`);
const out = JSON.parse(res.choices[0].message.content);
fs.writeFileSync(path.join(root, "cast.json"), JSON.stringify(out, null, 2), "utf8");
for (const c of out.cast) console.log(`  ${c.id.padEnd(4)} ${c.name.padEnd(10)} ${String(c.gender).padEnd(8)} ${String(c.role).padEnd(9)} self=[${(c.self||[]).join(",")}] other=[${(c.other||[]).join(",")}]  ${c.note ?? ""}`);
console.log(`\n→ ${path.join(root, "cast.json")}`);
