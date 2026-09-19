import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

import { logApiCall } from "../src/apiLog.js";
import { createLogger } from "../src/logger.js";

// stderr: script này ghi kết quả JSON ra stdout để pipe sang bước sau.
const log = createLogger("ATTR-V2", { stderr: true });

// v2 khác v1 ở 3 chỗ:
//  1. NẠP PRIOR: desc của video (có tên nhân vật thật) + tóm tắt cốt truyện.
//  2. Bắt model xuất RÀNG BUỘC LOGIC (addressee / self-term) chứ không chỉ đáp án
//     cuối — ràng buộc kiểm chứng được bằng chuỗi, đáp án cuối thì không.
//  3. Lấy k mẫu để có xác suất thật thay vì con số confidence tự khai (toàn 0.8/0.9).
const [tr, kArg] = process.argv.slice(2);
const K = Number(kArg || 3);
const dir = path.dirname(tr);
const T = JSON.parse(fs.readFileSync(tr, "utf8"));
const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
const segs = T.segments;
const desc = (meta.desc || "").replace(/#\S+/g, "").replace(/\s+/g, " ").trim();

const lines = segs.map((s, i) => {
  const gap = i === 0 ? 0 : s.start - segs[i - 1].end;
  return `${i + 1}. [${s.start.toFixed(1)}s] ${s.text}${gap > 4 ? `   <<< im lặng ${gap.toFixed(1)}s` : ""}`;
}).join("\n");

const sys = [
  "Bạn phân định NGƯỜI NÓI cho lời thoại bóc băng từ một video kể truyện Trung Quốc.",
  "Bạn KHÔNG nghe được audio. Chỉ suy từ nội dung, xưng hô, ai đáp ai, mốc thời gian, khoảng im lặng.",
  "",
  "MÔ TẢ VIDEO do tác giả tự viết (nguồn tên nhân vật đáng tin nhất — ưu tiên dùng tên ở đây,",
  "kể cả khi trong thoại họ chỉ được gọi bằng chức danh):",
  desc || "(không có)",
  "",
  "Bước 1 — DÀN NHÂN VẬT: gộp mọi cách gọi của CÙNG một người vào MỘT nhân vật.",
  "  Chức danh (师傅/前辈/晚辈/道友/大师兄/长老) là CÁCH GỌI, không phải nhân vật riêng.",
  "  Nhân vật cải trang nhiều lớp vẫn là MỘT nhân vật (ghi rõ ở note).",
  "  Với mỗi nhân vật ghi: self (từ họ tự xưng), other (từ người khác gọi/nhắc họ).",
  "Bước 2 — RÀNG BUỘC: với mỗi dòng, nếu câu đó GỌI hoặc NHẮC TỚI một nhân vật thì ghi vào",
  "  `addresses` (người nói KHÔNG THỂ là người đó); nếu câu có từ TỰ XƯNG riêng của ai thì ghi `selfOf`.",
  "  Chỉ ghi khi có bằng chứng chuỗi thật trong câu, không suy diễn.",
  "Bước 3 — GÁN: mỗi dòng đúng một nhân vật, hoặc \"NON_SPEECH\" (nhạc/tiếng động/rác).",
  "",
  'JSON: {"cast":[{"id":"C1","name":"…","note":"…","self":["…"],"other":["…"]}],',
  ' "lines":[{"line":1,"speaker":"C1","addresses":["C2"],"selfOf":null,"cue":"…"}]}',
  "Mọi dòng phải có trong `lines`.",
].join("\n");

const client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com", timeout: 300000, maxRetries: 2 });
const runs = [];
for (let i = 0; i < K; i++) {
  const params = {
    model: "deepseek-chat", temperature: i === 0 ? 0 : 0.7,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: sys }, { role: "user", content: lines }],
  };
  const res = await logApiCall(log, { url: "https://api.deepseek.com/chat/completions", body: params }, () =>
    client.chat.completions.create(params),
  );
  console.error(`  mẫu ${i + 1}/${K}  in=${res.usage.prompt_tokens} out=${res.usage.completion_tokens}`);
  runs.push(JSON.parse(res.choices[0].message.content));
}
fs.writeFileSync(path.join(dir, "raw-speaker-v2.json"), JSON.stringify({ desc, runs }, null, 2), "utf8");
for (const [i, r] of runs.entries())
  console.log(`mẫu ${i + 1} CAST: ${(r.cast ?? []).map((c) => c.name).join(" · ")}`);
