// Thử VOICE CLONING xuyên ngôn ngữ: lấy mẫu giọng TIẾNG TRUNG của một nhân vật
// (do scripts/extract-voice.js cắt ra), đăng ký làm âm sắc riêng trên DashScope,
// rồi bắt nó đọc TIẾNG VIỆT — kiểm tra bằng vòng lặp ASR như tts-probe.mjs.
//
// Vì sao script này tồn tại: bản -plus chỉ có 2 giọng hệ thống cho 7-8 nhân vật
// (xem tts-probe.mjs), nên sớm muộn phải clone. Câu hỏi chặn đường là "mẫu giọng
// tiếng Trung có clone ra giọng đọc tiếng Việt được không, hay bắt buộc phải có
// mẫu tiếng Việt sẵn?" — tài liệu Alibaba KHÔNG nói gì về ràng buộc ngôn ngữ giữa
// audio đăng ký và ngôn ngữ tổng hợp, nên chỉ có cách đo.
//
// Cách đo: đưa câu tiếng Việt vào giọng clone → mp3 → cho ASR nghe lại → so với
// câu gửi đi. Cùng lượt chạy giọng hệ thống longanlufeng làm ĐỐI CHỨNG, để phân
// biệt "clone hỏng" với "cả model hôm nay hỏng".
//
// Dùng:
//   node --env-file-if-exists=.env scripts/voice-clone-probe.mjs --dir <videoDir> --speaker 孙悟空
//   ... --seconds 18       độ dài mẫu đăng ký (khuyến nghị 10-20s, tối đa 60s)
//   ... --lines 3          số câu tiếng Việt đem thử
//   ... --voice <id>       dùng lại voice_id đã tạo lần trước, bỏ qua bước đăng ký
//   ... --keep             giữ voice_id lại sau khi chạy (mặc định xoá cho sạch quota)
//   ... --list             chỉ liệt kê các voice_id đang có rồi thoát
//   ... --delete <id>      xoá một voice_id rồi thoát
//
// Ghi ra <videoDir>/temp/voice-clone/: enroll.wav, clone-NN.mp3, sys-NN.mp3,
// report.json.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { alignChars, normalize } from "../src/align.js";
import { fetchBufferLogged, fetchLogged } from "../src/apiLog.js";
import { transcribeQwenAsr } from "../src/asr-qwen.js";
import { config } from "../src/config.js";
import { createLogger } from "../src/logger.js";

const log = createLogger("CLONE-PROBE");

const run = promisify(execFile);
const sh = (cmd, args) => run(cmd, args, { maxBuffer: 1024 * 1024 * 64 });

const TARGET_MODEL = "qwen-audio-3.0-tts-plus";
const CONTROL_VOICE = "longanlufeng"; // giọng hệ thống -plus, đã đo đọc được tiếng Việt
const ASR_MODEL = "qwen-audio-3.0-asr-flash-filetrans";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

function requireConfig(value, name) {
  if (!value) throw new Error(`thiếu ${name} — thêm vào .env`);
  return value;
}

const base = () => requireConfig(config.dashscopeBaseUrl, "DASHSCOPE_BASE_URL").replace(/\/+$/, "");
const authHeaders = () => ({
  Authorization: `Bearer ${requireConfig(config.dashscopeApiKey, "DASHSCOPE_API_KEY")}`,
  "Content-Type": "application/json",
});

/** POST + parse, có lùi khi 429 (endpoint này rate-limit rất chặt — xem tts-probe.mjs). */
async function post(url, body) {
  for (let attempt = 0; ; attempt += 1) {
    const { res, raw, json: parsed } = await fetchLogged(
      log,
      url,
      { method: "POST", headers: authHeaders(), body: JSON.stringify(body) },
      { logBody: body },
    );
    if (raw && (parsed === null || typeof parsed !== "object")) {
      throw new Error(`DashScope ${res.status}: không parse được — ${raw.slice(0, 300)}`);
    }
    const json = parsed && typeof parsed === "object" ? parsed : {};
    if (res.ok) return json;
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    throw new Error(`DashScope ${res.status}: ${json.code ?? "?"} — ${json.message ?? raw.slice(0, 300)}`);
  }
}

const customizationUrl = () => `${base()}/api/v1/services/audio/tts/customization`;
const synthUrl = () => `${base()}/api/v1/services/audio/tts/SpeechSynthesizer`;

async function createVoice(wavPath, prefix) {
  const b64 = (await fs.readFile(wavPath)).toString("base64");
  const mb = (b64.length / 1024 / 1024).toFixed(2);
  if (b64.length > 10 * 1024 * 1024) throw new Error(`mẫu ${mb} MB base64 > 10 MB, cắt ngắn lại`);
  console.log(`  gửi mẫu ${mb} MB (base64 data URI)`);
  const json = await post(customizationUrl(), {
    model: "voice-enrollment",
    input: {
      action: "create_voice",
      target_model: TARGET_MODEL,
      prefix,
      url: `data:audio/wav;base64,${b64}`,
    },
  });
  const id = json.output?.voice_id ?? json.output?.voice;
  if (!id) throw new Error(`create_voice không trả voice_id: ${JSON.stringify(json).slice(0, 300)}`);
  return id;
}

const listVoices = () =>
  post(customizationUrl(), { model: "voice-enrollment", input: { action: "list_voice", prefix: "" } });
const deleteVoice = (voiceId) =>
  post(customizationUrl(), { model: "voice-enrollment", input: { action: "delete_voice", voice_id: voiceId } });

/** Tổng hợp 1 câu, trả Buffer mp3. */
async function synthesize(text, voice) {
  const json = await post(synthUrl(), {
    model: TARGET_MODEL,
    input: { text, voice, format: "mp3", sample_rate: 24000 },
  });
  const audio = json.output?.audio;
  if (audio?.data) return Buffer.from(audio.data, "base64");
  if (audio?.url) return (await fetchBufferLogged(log, audio.url)).buf;
  throw new Error(`không có audio trong response: ${JSON.stringify(json).slice(0, 300)}`);
}

/** Tỉ lệ ký tự khớp giữa câu gửi đi và câu ASR nghe lại (bỏ dấu câu, hạ chữ thường). */
function matchRate(sent, heard) {
  const a = normalize(sent.toLowerCase()).chars;
  const b = normalize(heard.toLowerCase()).chars;
  if (!a.length) return 0;
  return alignChars(a, b).matches / a.length;
}

const probeDuration = async (f) =>
  Number.parseFloat(
    (await sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f])).stdout,
  );

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    console.log(JSON.stringify(await listVoices(), null, 2));
    return;
  }
  if (args.delete && args.delete !== true) {
    console.log(JSON.stringify(await deleteVoice(args.delete), null, 2));
    return;
  }

  const dir = path.resolve(args.dir ?? "");
  const speaker = args.speaker;
  if (!args.dir || !speaker || speaker === true) throw new Error("cần --dir <videoDir> và --speaker <tên>");

  const seconds = Number.parseFloat(args.seconds ?? "18");
  const nLines = Number.parseInt(args.lines ?? "3", 10);

  const outDir = path.join(dir, "temp", "voice-clone");
  await fs.mkdir(outDir, { recursive: true });

  // ── mẫu đăng ký ─────────────────────────────────────────────────────────
  let enrollPath = args.ref && args.ref !== true ? path.resolve(args.ref) : null;
  if (!enrollPath) {
    const voiceDir = path.join(dir, "voice", speaker);
    const manifest = JSON.parse(await fs.readFile(path.join(voiceDir, "manifest.json"), "utf8"));
    // Câu dài mang đủ ngữ điệu; gom tới khi đủ `seconds` rồi xếp lại theo thời gian.
    const chosen = [];
    let acc = 0;
    for (const clip of [...manifest.clips].sort((a, b) => b.duration - a.duration)) {
      if (acc >= seconds) break;
      chosen.push(clip);
      acc += clip.duration;
    }
    chosen.sort((a, b) => a.start - b.start);
    const listFile = path.join(outDir, "enroll.txt");
    await fs.writeFile(listFile, chosen.map((c) => `file '${path.join(voiceDir, c.file)}'`).join("\n"), "utf8");
    enrollPath = path.join(outDir, "enroll.wav");
    await sh("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", enrollPath]);
    console.log(`mẫu đăng ký: ${chosen.length} câu, ${(await probeDuration(enrollPath)).toFixed(1)}s`);
    console.log(`  ${chosen.map((c) => c.text).join(" ")}`);
  }

  // ── câu tiếng Việt đem thử ──────────────────────────────────────────────
  const translation = JSON.parse(await fs.readFile(path.join(dir, "translation.json"), "utf8"));
  const lines = translation.segments.filter((s) => s.speaker === speaker && s.vi).slice(0, nLines);
  if (!lines.length) throw new Error(`không có câu tiếng Việt nào của ${speaker} trong translation.json`);

  // ── đăng ký ─────────────────────────────────────────────────────────────
  let voiceId = args.voice && args.voice !== true ? args.voice : null;
  let created = false;
  if (!voiceId) {
    console.log(`\nđăng ký âm sắc (target_model=${TARGET_MODEL})…`);
    voiceId = await createVoice(enrollPath, "wk");
    created = true;
    console.log(`  voice_id = ${voiceId}`);
  } else {
    console.log(`\ndùng lại voice_id = ${voiceId}`);
  }

  const report = { speaker, voiceId, targetModel: TARGET_MODEL, enrollSeconds: await probeDuration(enrollPath), lines: [] };
  try {
    for (const [i, seg] of lines.entries()) {
      const tag = String(i + 1).padStart(2, "0");
      console.log(`\n[${tag}] ${seg.vi}`);
      const row = { index: seg.index, zh: seg.zh, vi: seg.vi, slotSeconds: Number((seg.end - seg.start).toFixed(2)) };

      for (const [kind, voice] of [["clone", voiceId], ["sys", CONTROL_VOICE]]) {
        const file = path.join(outDir, `${kind}-${tag}.mp3`);
        await fs.writeFile(file, await synthesize(seg.vi, voice));
        const dur = await probeDuration(file);
        const heard = (await transcribeQwenAsr(file, ASR_MODEL)).text;
        const rate = matchRate(seg.vi, heard);
        row[kind] = { file: path.basename(file), seconds: Number(dur.toFixed(2)), heard, matchRate: Number(rate.toFixed(3)) };
        console.log(`     ${kind.padEnd(5)} ${dur.toFixed(2)}s  khớp ${(rate * 100).toFixed(0)}%  ASR: ${heard}`);
      }
      report.lines.push(row);
    }
  } finally {
    if (created && !args.keep) {
      await deleteVoice(voiceId).catch((e) => console.warn(`  (không xoá được ${voiceId}: ${e.message})`));
      console.log(`\nđã xoá voice_id ${voiceId} (dùng --keep để giữ)`);
      report.deleted = true;
    }
    await fs.writeFile(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  const avg = (k) => report.lines.reduce((s, r) => s + (r[k]?.matchRate ?? 0), 0) / (report.lines.length || 1);
  console.log(`\nkhớp trung bình — clone ${(avg("clone") * 100).toFixed(0)}%  |  giọng hệ thống ${(avg("sys") * 100).toFixed(0)}%`);
  console.log(`→ ${outDir}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
