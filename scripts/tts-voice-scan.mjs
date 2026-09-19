// Quét toàn bộ giọng hệ thống của một model TTS trên MỘT câu tiếng Việt, để chọn
// dàn giọng cho các nhân vật.
//
// Vì sao cần: `gpt-4o-mini-tts` có 13 giọng, nhưng chúng được huấn luyện quanh
// tiếng Anh — không có gì bảo đảm cả 13 đọc được tiếng Việt, và không có gì bảo
// đảm chúng khác nhau đủ để khán giả phân biệt 7 nhân vật. Hai câu hỏi đó phải đo
// chứ không đọc doc ra được.
//
// Ba con số cho mỗi giọng:
//   - đọc đúng: đưa audio vào ASR rồi so với câu gửi đi. Giọng nào < ~85% là đọc
//     tiếng Việt sai, loại thẳng, không cần nghe.
//   - khác nhau: cosine giữa embedding các giọng (resemblyzer). Hai giọng > ~0.80
//     là dễ nghe nhầm thành một người, đừng gán cho hai nhân vật cùng cảnh.
//   - tự nhiên: để `scripts/voice-judge.mjs` chấm riêng — ở đây chỉ sinh file.
//
// Dùng:
//   node --env-file-if-exists=.env scripts/tts-voice-scan.mjs
//   ... --text "..."      câu đem thử (mặc định một câu thoại phim đủ dài)
//   ... --model <id>      mặc định gpt-4o-mini-tts
//   ... --instruct "..."  chỉ dẫn diễn cảm dùng chung cho mọi giọng
//   ... --out <dir>       nơi ghi wav (mặc định temp/tts-voice-scan/)
import fs from "node:fs/promises";
import path from "node:path";

import { alignChars, normalize } from "../src/align.js";
import { fetchBufferLogged, OPENAI_V1 } from "../src/apiLog.js";
import { transcribeQwenAsr } from "../src/asr-qwen.js";
import { config } from "../src/config.js";
import { createLogger } from "../src/logger.js";

const log = createLogger("TTS-SCAN");

const DEFAULT_MODEL = "gpt-4o-mini-tts";
const ASR_MODEL = "qwen-audio-3.0-asr-flash-filetrans";
// Lấy từ chính thông báo lỗi của API khi truyền voice sai — nguồn đáng tin hơn doc.
const VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer", "coral",
  "verse", "ballad", "ash", "sage", "marin", "cedar"];
const DEFAULT_TEXT = "Chỉ là lão Tôn vừa xem qua, quanh đây trăm dặm toàn đá đen, chẳng có chút ruộng vườn nào.";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next === undefined || next.startsWith("--") ? true : argv[++i];
  }
  return out;
}
const str = (v, fallback) => (v === undefined || v === true ? fallback : v);

async function speak({ model, voice, text, instructions, apiKey }) {
  const payload = {
    model, voice, input: text, response_format: "wav",
    ...(instructions ? { instructions } : {}),
  };
  // Response là wav nhị phân — fetchBufferLogged log cỡ + content-type; thân lỗi (JSON)
  // cũng về dưới dạng buffer nên đọc ngược ra text khi status không OK.
  const { res, buf } = await fetchBufferLogged(
    log,
    `${OPENAI_V1}/audio/speech`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    { logBody: payload },
  );
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${buf.toString("utf8").slice(0, 200)}`);
  return buf;
}

const matchRate = (sent, heard) => {
  const a = normalize(sent.toLowerCase()).chars;
  const b = normalize(heard.toLowerCase()).chars;
  return a.length ? alignChars(a, b).matches / a.length : 0;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = str(args.model, DEFAULT_MODEL);
  const text = str(args.text, DEFAULT_TEXT);
  const instructions = str(args.instruct, null);
  const outDir = path.resolve(str(args.out, path.join("temp", "tts-voice-scan")));
  const apiKey = config.openaiApiKey;
  if (!apiKey) throw new Error("thiếu OPENAI_API_KEY");

  await fs.mkdir(outDir, { recursive: true });
  console.log(`câu thử: "${text}"\nmodel: ${model}${instructions ? `\nchỉ dẫn: ${instructions}` : ""}\n`);

  const rows = [];
  for (const voice of VOICES) {
    const file = path.join(outDir, `${voice}.wav`);
    await fs.writeFile(file, await speak({ model, voice, text, instructions, apiKey }));
    const heard = (await transcribeQwenAsr(file, ASR_MODEL)).text;
    const rate = matchRate(text, heard);
    rows.push({ voice, file, matchRate: Number(rate.toFixed(3)), heard });
    console.log(`${voice.padEnd(9)} đọc đúng ${(rate * 100).toFixed(0).padStart(3)}%   ${heard.slice(0, 70)}`);
  }

  rows.sort((a, b) => b.matchRate - a.matchRate);
  await fs.writeFile(path.join(outDir, "scan.json"),
    `${JSON.stringify({ model, text, instructions, voices: rows }, null, 2)}\n`, "utf8");

  const usable = rows.filter((r) => r.matchRate >= 0.85).map((r) => r.voice);
  console.log(`\ndùng được (>=85%): ${usable.join(", ") || "(không có giọng nào)"}`);
  console.log(`→ ${outDir}`);
  console.log(`\nĐo độ khác nhau giữa các giọng: chạy resemblyzer trên thư mục này (xem README voice).`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
