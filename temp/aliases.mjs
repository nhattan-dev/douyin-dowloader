import fs from "node:fs";
import OpenAI from "openai";

import { logApiCall } from "../src/apiLog.js";
import { createLogger } from "../src/logger.js";

// stderr: script này ghi kết quả JSON ra stdout để pipe sang bước sau.
const log = createLogger("ALIASES", { stderr: true });
// Xin lexicon cách gọi từng nhân vật (tự xưng / người khác gọi / nhắc ngôi ba).
// Tách thành call riêng, rất ngắn, để không đụng vào prompt của lượt gán chính.
const [tr, r1] = process.argv.slice(2);
const segs = JSON.parse(fs.readFileSync(tr, "utf8")).segments;
const j = JSON.parse(fs.readFileSync(r1, "utf8"));
const client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com", timeout: 300000 });
const params = {
  model: "deepseek-chat", temperature: 0, response_format: { type: "json_object" },
  messages: [
    { role: "system", content: [
      "Cho dàn nhân vật và lời thoại của một truyện Trung Quốc.",
      "Với mỗi nhân vật, liệt kê các cách gọi XUẤT HIỆN trong thoại, chia 2 nhóm:",
      "- self: từ nhân vật đó dùng để TỰ XƯNG (老孙, 本座, 老夫, 晚辈…)",
      "- other: từ NGƯỜI KHÁC dùng để gọi hoặc nhắc tới nhân vật đó (悟空, 猴子, 猴头, 大师兄, 呆子, 师傅…)",
      'Trả JSON: {"aliases":[{"id":"C1","self":["…"],"other":["…"]}]}',
    ].join("\n") },
    { role: "user", content:
      "DÀN: " + j.cast.map((c) => `${c.id}=${c.name}`).join(", ") + "\n\n" +
      segs.map((s, i) => `${i + 1}. ${s.text}`).join("\n") },
  ],
};
const res = await logApiCall(log, { url: "https://api.deepseek.com/chat/completions", body: params }, () =>
  client.chat.completions.create(params),
);
console.error(`aliases: in=${res.usage.prompt_tokens} out=${res.usage.completion_tokens}`);
fs.writeFileSync(process.argv[2].replace(/[/]/g, "_") + ".aliases.json", res.choices[0].message.content);
console.log(res.choices[0].message.content);
