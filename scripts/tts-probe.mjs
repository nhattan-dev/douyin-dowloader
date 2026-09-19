// Thử TTS tiếng Việt trên vài phân đoạn đã dịch, để nghe thật + ĐO ĐỘ VỪA KHUNG
// THỜI GIAN trước khi quyết định wire TTS vào pipeline.
//
// KHÔNG PHẢI pipeline chính. Chỉ đọc translation.json, ghi file phụ vào
// <videoDir>/temp/tts-probe/, không đụng state.json.
//
// Vì sao script này tồn tại: với dubbing, chất giọng chỉ là một nửa vấn đề. Nửa
// còn lại là câu tiếng Việt DÀI HƠN câu tiếng Trung nhiều (đo trên video mẫu:
// trung vị ~16 ký tự/giây, có câu tới 25.7 — vượt tốc độ đọc tự nhiên), nên đọc
// xong thì đã trôi mất khung hình. Script in ra chênh lệch từng đoạn để biết phải
// nén bao nhiêu (rút gọn câu dịch hay tăng `rate`).
//
// Vì sao dòng model là qwen-audio-3.0-tts chứ không phải CosyVoice:
// CosyVoice v3/v3-plus KHÔNG có tiếng Việt (chỉ Quan Thoại/Anh/tiếng địa phương TQ);
// bản duy nhất của CosyVoice có tiếng Việt là v3.5, mà v3.5 lại "Model not exist"
// ở workspace Singapore. Chỉ dòng qwen-audio-3.0-tts (16 ngôn ngữ, có vi) là vừa
// có tiếng Việt vừa gọi được ở region này.
//
// Dùng:
//   node --env-file-if-exists=.env scripts/tts-probe.mjs <userId> <videoId>
//   ... --segments 0-5,14      chọn đoạn (mặc định 6 đoạn đầu)
//   ... --model <model>        đổi model TTS
//   ... --voice <voiceId>      ép 1 giọng cho tất cả speaker
//   ... --voices S4=a,S2=b     map speaker → giọng (speaker không có trong map thì
//                              lấy vòng tròn từ danh sách giọng đã dùng)
//   ... --instruct "<câu>"     chỉ dẫn diễn cảm chung, bằng ngôn ngữ tự nhiên —
//                              viết tiếng Việt/Anh/Trung đều ăn. ĐÃ ĐO CÓ TÁC DỤNG:
//                              cùng 1 câu, không chỉ dẫn 4.61s, "giận dữ, nhịp gấp"
//                              4.06-4.46s, "chậm rãi, buồn bã" 6.29s. Tức là diễn cảm
//                              LÀM ĐỔI ĐỘ DÀI — phải đo lại khung sau khi đổi chỉ dẫn.
//   ... --rate 1.15            tăng tốc đọc để nhét vừa khung (đo được gần tuyến tính:
//                              rate 1.2 → 3.86s so với 4.61s)
//   ... --text "..."           bỏ qua translation.json, chỉ đọc 1 câu (test thông model)
//
// Mỗi đoạn ghi ra seg-NN.mp3 + raw-NN.json (response gốc, để soi shape khi model
// đổi field), cuối cùng ghi report.json + in bảng tổng kết.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { fetchBufferLogged, fetchLogged } from "../src/apiLog.js";
import { config, paths } from "../src/config.js";
import { createLogger } from "../src/logger.js";

const run = promisify(execFile);
const log = createLogger("TTS-PROBE");

// PHẢI dùng -plus: đã đo bằng cách đưa ngược mp3 do TTS sinh ra vào ASR
// (`qwen-audio-3.0-asr-flash-filetrans`) rồi so với câu gửi đi —
//   -plus  : ASR nghe lại ĐÚNG 100% từng chữ, đủ dấu.
//   -flash : ASR nghe ra tiếng Trung hoàn toàn không liên quan ("他咯，成绩卡低咯...")
//            → 12 giọng của -flash chỉ có Quan Thoại/Anh, đọc chữ Việt theo âm Hán.
// Đối chứng cùng lượt: -flash đọc tiếng Trung và tiếng Anh thì ASR nghe lại đúng
// hoàn toàn → lỗi nằm ở TTS, không phải ở ASR.
//
// Đánh đổi: -plus chỉ có 2 giọng hệ thống (1 nam 1 nữ) — không đủ cho video nhiều
// nhân vật, phải tính tới voice cloning (`qwen3-tts-vc`, có hỗ trợ vi).
const DEFAULT_MODEL = "qwen-audio-3.0-tts-plus";

// Giọng hệ thống của qwen-audio-3.0-tts-flash (đã quét thật, cả 12 giọng đều gọi
// được) — CHỈ để so sánh, không đọc được tiếng Việt (xem DEFAULT_MODEL).
//
// GIỌNG KHÔNG DÙNG CHUNG GIỮA CÁC MODEL: `longanlufeng`/`longanlingxin` là giọng của
// bản -plus, đưa vào -flash thì trả 400 `[cosyvoice:]Engine error [411]` — thông báo
// lỗi không hề nhắc tới voice, rất dễ tưởng hỏng chỗ khác.
const FLASH_VOICES = [
  "longchuanshu_v3.6",
  "longanfengyue",
  "loongjohn",
  "longanlingxi",
  "longhuohuo_v3.6",
  "longanyuanfei",
  "longjielidou_v3.6",
  "longanxiaoxin",
];

// Giọng của bản -plus: chỉ 2 (longanlufeng nam 25, longanlingxin nữ 25). Nhiều
// speaker hơn 2 thì bị lặp giọng — giới hạn thật của phương án này.
const PLUS_VOICES = ["longanlufeng", "longanlingxin"];

/** Danh sách giọng hợp lệ của model — giọng -plus và -flash KHÔNG dùng lẫn được. */
function voicePool(model) {
  return model.endsWith("-plus") ? PLUS_VOICES : FLASH_VOICES;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) flags[arg.slice(2)] = argv[i + 1]?.startsWith("--") ? true : argv[++i];
    else positional.push(arg);
  }
  return { positional, flags };
}

/** "0-5,14" → [0,1,2,3,4,5,14] */
function parseRanges(spec) {
  const out = [];
  for (const part of String(spec).split(",")) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`--segments không hiểu: "${part}"`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    for (let i = from; i <= to; i += 1) out.push(i);
  }
  return out;
}

/** "S4=longanlufeng,S2=longpaopao" → Map */
function parseVoiceMap(spec) {
  const map = new Map();
  if (!spec || spec === true) return map;
  for (const pair of String(spec).split(",")) {
    const [speaker, voice] = pair.split("=");
    if (!speaker || !voice) throw new Error(`--voices không hiểu: "${pair}"`);
    map.set(speaker.trim(), voice.trim());
  }
  return map;
}

/**
 * Gán giọng cho từng speaker: ưu tiên map người dùng đưa, còn lại phát vòng tròn
 * từ danh sách giọng của model theo thứ tự speaker xuất hiện nhiều → ít, để vai chính nhận
 * giọng đầu danh sách (giọng nam trưởng thành) thay vì giọng trẻ con.
 */
function assignVoices(segments, forced, userMap, pool) {
  if (forced && forced !== true) {
    const all = new Map();
    for (const seg of segments) all.set(seg.speaker ?? "?", forced);
    return all;
  }
  const count = new Map();
  for (const seg of segments) {
    const key = seg.speaker ?? "?";
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  const ordered = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const map = new Map();
  let next = 0;
  for (const speaker of ordered) {
    if (userMap.has(speaker)) map.set(speaker, userMap.get(speaker));
    else map.set(speaker, pool[next++ % pool.length]);
  }
  return map;
}

function requireConfig(value, name) {
  if (!value) throw new Error(`thiếu ${name} — thêm vào .env (xem .env.example)`);
  return value;
}

/**
 * Gọi TTS qua đường DashScope native trên host workspace.
 *
 * Route `audio/tts/SpeechSynthesizer` là route của dòng qwen-audio-tts/CosyVoice.
 * (Dòng qwen3-tts dùng route khác: `aigc/multimodal-generation/generation` — nếu
 * đổi sang model đó thì phải đổi cả route, nhưng qwen3-tts KHÔNG có tiếng Việt.)
 *
 * Trả về `{ json, audio }` với audio là Buffer, lấy từ `output.audio.url` (link ký
 * sống 24h) hoặc `output.audio.data` (base64) tuỳ model trả kiểu nào.
 */
async function synthesize({ model, text, voice, instruction, rate, format, sampleRate }) {
  const base = requireConfig(config.dashscopeBaseUrl, "DASHSCOPE_BASE_URL").replace(/\/+$/, "");
  const key = requireConfig(config.dashscopeApiKey, "DASHSCOPE_API_KEY");

  const input = { text, voice, format, sample_rate: sampleRate };
  if (rate) input.rate = rate;
  // Model tự nhận diện ngôn ngữ từ text; `language_hints` được API nhận nhưng CHƯA
  // đo được là nó có tác dụng gì không (endpoint nuốt cả field lạ mà không báo lỗi).
  input.language_hints = ["vi"];
  if (instruction) input.instruction = instruction;

  // Gọi liên tiếp nhiều đoạn là dính 429 Throttling.RateQuota — lùi rồi thử lại
  // thay vì bỏ dở cả lượt probe.
  let json;
  for (let attempt = 0; ; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.sttTimeoutMs);
    let res;
    let raw;
    try {
      ({ res, raw } = await fetchLogged(
        log,
        `${base}/api/v1/services/audio/tts/SpeechSynthesizer`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, input }),
          signal: ctrl.signal,
        },
        { logBody: { model, input } },
      ));
    } finally {
      clearTimeout(timer);
    }
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`DashScope ${res.status}: không parse được response — ${raw.slice(0, 200)}`);
    }
    if (res.ok) break;
    if (res.status === 429 && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
      continue;
    }
    throw new Error(`DashScope ${res.status}: ${json.code ?? "?"} — ${json.message ?? raw.slice(0, 300)}`);
  }

  const audioNode = json.output?.audio ?? {};
  if (audioNode.url) {
    const { res, buf } = await fetchBufferLogged(log, audioNode.url);
    if (!res.ok) throw new Error(`tải audio về lỗi ${res.status} từ ${audioNode.url}`);
    return { json, audio: buf };
  }
  if (audioNode.data) return { json, audio: Buffer.from(audioNode.data, "base64") };
  throw new Error(`response không có output.audio.url/.data — ${JSON.stringify(json).slice(0, 300)}`);
}

/** Độ dài thật của file audio, giây. */
async function probeDuration(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ]);
  return Number(stdout.trim());
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [userId, videoId] = positional;
  if (!userId || !videoId) {
    console.error("dùng: node --env-file-if-exists=.env scripts/tts-probe.mjs <userId> <videoId> [--segments 0-5] [--voice x] [--instruct \"...\"]");
    process.exitCode = 1;
    return;
  }

  const model = flags.model && flags.model !== true ? flags.model : DEFAULT_MODEL;
  const format = flags.format && flags.format !== true ? flags.format : "mp3";
  const sampleRate = Number(flags["sample-rate"] ?? 24000);
  const rate = flags.rate && flags.rate !== true ? Number(flags.rate) : undefined;
  const instructAll = flags.instruct && flags.instruct !== true ? flags.instruct : undefined;

  const videoDir = paths.videoDir(userId, videoId);
  const outDir = path.join(videoDir, "temp", "tts-probe");
  await fs.mkdir(outDir, { recursive: true });

  // --text: chỉ để kiểm tra model có gọi được + có đọc được tiếng Việt không,
  // không cần translation.json.
  if (flags.text && flags.text !== true) {
    const voice = flags.voice && flags.voice !== true ? flags.voice : voicePool(model)[0];
    log.info(`model=${model} voice=${voice} — "${flags.text}"`);
    const { json, audio } = await synthesize({ model, text: flags.text, voice, instruction: instructAll, rate, format, sampleRate });
    const file = path.join(outDir, `adhoc.${format}`);
    await fs.writeFile(file, audio);
    await fs.writeFile(path.join(outDir, "adhoc.json"), JSON.stringify(json, null, 2));
    log.info(`ghi ${file} (${(await probeDuration(file)).toFixed(2)}s)`);
    return;
  }

  const translation = JSON.parse(await fs.readFile(path.join(videoDir, "translation.json"), "utf8"));
  const wanted = flags.segments && flags.segments !== true ? new Set(parseRanges(flags.segments)) : null;
  const segments = translation.segments.filter((s) => (wanted ? wanted.has(s.index) : s.index < 6));
  if (!segments.length) throw new Error("không có đoạn nào khớp --segments");

  const voices = assignVoices(translation.segments, flags.voice, parseVoiceMap(flags.voices), voicePool(model));
  log.info(`model=${model} — ${segments.length} đoạn, map giọng: ${[...voices].map(([s, v]) => `${s}→${v}`).join(", ")}`);

  const rows = [];
  for (const seg of segments) {
    const slot = seg.end - seg.start;
    const voice = voices.get(seg.speaker ?? "?") ?? voicePool(model)[0];
    // `instruction`/`style` trên chính segment được ưu tiên: chỗ để bước dịch sau
    // này tự sinh chỉ dẫn diễn cảm cho từng câu mà không phải sửa script này.
    const instruction = seg.instruction ?? seg.style ?? instructAll;
    log.info(`[${seg.index}] ${seg.speaker} slot=${slot.toFixed(2)}s voice=${voice} — ${seg.vi}`);

    const { json, audio } = await synthesize({ model, text: seg.vi, voice, instruction, rate, format, sampleRate });
    const file = path.join(outDir, `seg-${String(seg.index).padStart(2, "0")}.${format}`);
    await fs.writeFile(file, audio);
    await fs.writeFile(path.join(outDir, `raw-${String(seg.index).padStart(2, "0")}.json`), JSON.stringify(json, null, 2));

    const spoken = await probeDuration(file);
    rows.push({
      index: seg.index,
      speaker: seg.speaker,
      voice,
      instruction: instruction ?? null,
      slotSec: Number(slot.toFixed(2)),
      spokenSec: Number(spoken.toFixed(2)),
      overrunSec: Number((spoken - slot).toFixed(2)),
      overrunPct: Number(((spoken / slot - 1) * 100).toFixed(1)),
      viChars: seg.vi.length,
      file: path.basename(file),
      vi: seg.vi,
    });
  }

  const report = { videoId, model, rate: rate ?? null, instruction: instructAll ?? null, generatedAt: new Date().toISOString(), rows };
  await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));

  console.log("\nidx spk  voice                slot   đọc   lệch    %");
  for (const r of rows) {
    console.log(
      `${String(r.index).padStart(3)} ${String(r.speaker).padEnd(4)} ${r.voice.padEnd(20)} ` +
      `${r.slotSec.toFixed(2).padStart(5)} ${r.spokenSec.toFixed(2).padStart(5)} ` +
      `${(r.overrunSec > 0 ? "+" : "") + r.overrunSec.toFixed(2)}`.padStart(7) +
      `${(r.overrunPct > 0 ? "+" : "") + r.overrunPct.toFixed(0)}%`.padStart(7),
    );
  }
  const over = rows.filter((r) => r.overrunSec > 0);
  log.info(`${over.length}/${rows.length} đoạn đọc quá khung; tổng lệch ${rows.reduce((a, r) => a + r.overrunSec, 0).toFixed(2)}s`);
  log.info(`file trong ${outDir}`);
}

main().catch((err) => {
  log.error(err.message);
  process.exitCode = 1;
});
