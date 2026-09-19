import fs from "node:fs/promises";
import path from "node:path";

import OpenAI from "openai";

import { logApiCall } from "./apiLog.js";
import { transcribeQwenAsr } from "./asr-qwen.js";
import { config } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("STT/engine");

/**
 * Nhiều nhà cung cấp STT sau cùng một chữ ký, để `compare` xếp chúng cạnh nhau.
 *
 * Cú pháp chọn: `engine:model`, ví dụ `openai:whisper-1`, `qwen:qwen3-asr-flash`.
 * Thiếu phần `engine:` thì mặc định là `openai` — giữ nguyên các giá trị
 * STT_COMPARE_MODELS cũ.
 *
 * CHÚ Ý về cái không so được: timestamp chỉ có ở `openai:whisper-1` và các model
 * `qwen:` (siliconflow không trả), còn nhãn người nói thì KHÔNG engine nào ở đây có —
 * nó đến từ bước diarize riêng của OpenAI. Các engine ở đây so ĐÚNG CHỮ NGHE ĐƯỢC,
 * không so phần timestamp/speaker — đó là câu hỏi riêng, xem README.
 */

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const MIME = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};

/** `whisper-1` → openai/whisper-1; `qwen:qwen3-asr-flash` → qwen/qwen3-asr-flash */
export function parseSpec(spec) {
  const i = spec.indexOf(":");
  // Tên model của SiliconFlow có dạng `Nhà/Model`, không chứa ":" nên tách theo ":"
  // là an toàn.
  if (i < 0) return { engine: "openai", model: spec.trim() };
  return { engine: spec.slice(0, i).trim(), model: spec.slice(i + 1).trim() };
}

async function readAudio(audioPath) {
  const { size } = await fs.stat(audioPath);
  if (size > MAX_UPLOAD_BYTES) {
    throw new Error(`file ${(size / 1024 / 1024).toFixed(1)} MB vượt 25 MB — cần cắt nhỏ trước`);
  }
  const ext = path.extname(audioPath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`không biết mime type của đuôi "${ext}"`);
  return { buffer: await fs.readFile(audioPath), mime, size };
}

function requireKey(value, name) {
  if (!value) throw new Error(`thiếu ${name} — thêm vào .env (xem .env.example)`);
  return value;
}

/**
 * Qwen-ASR — dùng chung đúng một cài đặt với flow chính, xem `src/asr-qwen.js`.
 *
 * Trước đây chỗ này tự gọi compatible-mode (/chat/completions với content
 * `input_audio`). Đã đo lại: model `qwen-audio-3.0-asr-flash` trả 400 body rỗng ở
 * đường đó, chỉ DashScope native chạy. Và cái ghi chú cũ "nhận file local là mất
 * timestamp" cũng sai — native trả timestamp tới từng chữ ngay với base64.
 */
const transcribeQwen = (audioPath, model) => transcribeQwenAsr(audioPath, model);

/**
 * SiliconFlow — host các model ASR mã nguồn mở của TQ (SenseVoice, Fun-ASR) sau đúng
 * giao thức /audio/transcriptions của OpenAI, nên chỉ khác baseURL + tên model.
 */
async function transcribeSiliconFlow(audioPath, model) {
  const { buffer, mime } = await readAudio(audioPath);
  const openai = new OpenAI({
    apiKey: requireKey(config.siliconflowApiKey, "SILICONFLOW_API_KEY"),
    baseURL: config.siliconflowBaseUrl,
    maxRetries: config.sttMaxRetries,
    timeout: config.sttTimeoutMs,
  });

  const params = { file: new File([buffer], path.basename(audioPath), { type: mime }), model };
  const res = await logApiCall(
    log,
    { url: `${config.siliconflowBaseUrl}/audio/transcriptions`, body: params },
    () => openai.audio.transcriptions.create(params),
  );
  return { text: (res.text ?? "").trim(), hasTimestamps: false, detectedLanguage: null };
}

const ENGINES = {
  qwen: transcribeQwen,
  siliconflow: transcribeSiliconFlow,
};

export const ENGINE_NAMES = ["openai", ...Object.keys(ENGINES)];

/**
 * Chạy một engine trên một file audio.
 *
 * `openaiTranscribe` được tiêm từ ngoài vào thay vì import: đường OpenAI đã chạy ổn
 * trong stt.js (giới hạn upload, prompt, nhánh timestamp riêng cho whisper-1), chép
 * lại sang đây là mời sai lệch giữa hai đường.
 */
export async function transcribeWith(spec, audioPath, openaiTranscribe) {
  const { engine, model } = parseSpec(spec);
  const startedAt = Date.now();

  if (engine === "openai") {
    const r = await openaiTranscribe(audioPath, model);
    return { engine, model, ...r, ms: Date.now() - startedAt };
  }

  const run = ENGINES[engine];
  if (!run) {
    throw new Error(`engine "${engine}" không có — chọn một trong: ${ENGINE_NAMES.join(", ")}`);
  }
  const r = await run(audioPath, model);
  log.debug(`${engine}/${model}: ${r.text.length} ký tự trong ${Date.now() - startedAt}ms`);
  return { engine, model, ...r, ms: Date.now() - startedAt };
}
