import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { logApiRequest, logApiResponse, logApiError, maybeJson } from "./apiLog.js";
import { config } from "./config.js";
import { createLogger } from "./logger.js";

const run = promisify(execFile);
const log = createLogger("STT/qwen");

/**
 * Qwen-ASR của Alibaba Model Studio (bản `*-filetrans`, chạy async), trả về ĐÚNG
 * hình dạng kết quả của whisper-1 (`text` / `segments` / `words`, mốc thời gian
 * tính bằng giây) để stt.js dùng thay whisper mà không phải sửa gì phía sau.
 *
 * Vì sao dùng bản filetrans async chứ không phải sync (`multimodal-generation`):
 * - Sync chặn audio dài (~4 phút là trả 400 text rỗng). Video Douyin dạng truyện
 *   dài 10+ phút → bắt buộc filetrans.
 * - Filetrans tính tiền theo GIÂY CÓ TIẾNG NÓI (`content_duration`), không phải cả
 *   độ dài file — nội dung nhiều nhạc đệm rẻ hơn ~2-3 lần.
 * - Filetrans trả sẵn `sentences[]` đã cắt câu, không phải tự ghép lại từ dấu câu.
 *
 * Diarize: bản filetrans CÓ trả `speaker_id`, nhưng đo trên nội dung "một người
 * lồng nhiều giọng + nhạc nền" thì nó tách loạn (10 cụm cho 3 vai thật), kể cả khi
 * ép `speaker_count`. Mặc định TẮT (`QWEN_DIARIZE`); nhãn người nói vẫn để bước
 * riêng trong stt.js lo. Bật lên chỉ để thử nghiệm.
 *
 * QUIRK: submit task lên host workspace (`DASHSCOPE_BASE_URL`) được, nhưng hỏi trạng
 * thái task ở đúng host đó lại trả 403 — phải poll qua host vùng công khai
 * (`DASHSCOPE_POLL_URL`, mặc định dashscope-intl.aliyuncs.com cho region Singapore).
 */

// Body submit là JSON nên audio nhét base64. Đo thực tế: DashScope đóng kết nối
// (SSLEOF) khi base64 vượt ~10 MB. Sau bước hạ mẫu, video ~10 phút chỉ còn ~3.5 MB
// base64 — đây chỉ là chốt an toàn cho input dài bất thường.
const MAX_BASE64_BYTES = 10 * 1024 * 1024;

// Video ghép nhiều tập (>~33 phút sau hạ mẫu) vượt trần trên — cắt khúc theo thời
// lượng thay vì lỗi thẳng ra. Nhắm dưới trần một khoảng dư để mp3 cắt lệch vài giây
// (ffmpeg segment không cắt đúng tuyệt đối) không đẩy khúc nào vọt qua trần.
const CHUNK_TARGET_BASE64_BYTES = 8.5 * 1024 * 1024;

// Hạ mẫu về mono 16 kHz MP3 32 kbps trước khi gửi:
// - ASR không cần hơn 16 kHz mono; stereo 44.1 kHz chỉ làm base64 phình ~8 lần.
// - Douyin trả ~192 kbps stereo → video 10 phút = 15 MB file = 20 MB base64, vượt
//   giới hạn. Sau khi hạ: ~2.5 MB. Đã đo text không đổi (video 修真 + 西游).
const DOWNSAMPLE_ARGS = ["-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k"];

function requireConfig(value, name) {
  if (!value) throw new Error(`thiếu ${name} — thêm vào .env (xem .env.example)`);
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hạ mẫu audio về mono 16 kHz MP3 vào file tạm, trả về đường dẫn file tạm đó.
 *
 * Tên file tạm băm từ đường dẫn gốc để hai video chạy song song không đạp lên nhau.
 * Bên gọi phải xoá file khi xong (khối `finally` trong transcribeQwenAsr).
 */
async function downsampleToTemp(audioPath) {
  const tag = createHash("sha1").update(audioPath).digest("hex").slice(0, 12);
  const outPath = path.join(os.tmpdir(), `qwen-asr-${tag}.mp3`);
  try {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", audioPath, ...DOWNSAMPLE_ARGS, outPath]);
  } catch (err) {
    throw new Error(`ffmpeg hạ mẫu audio lỗi (đã cài ffmpeg chưa?): ${err.message}`);
  }
  return outPath;
}

/** Thời lượng file audio/video (giây), qua ffprobe. */
async function probeDurationSec(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error(`ffprobe không đọc được thời lượng của ${filePath}`);
  return seconds;
}

/**
 * Cắt file mp3 (đã hạ mẫu) thành nhiều khúc ~`chunkSeconds` mỗi khúc, bằng
 * `-f segment -c copy` (không encode lại — mp3 cắt theo khung, gần như tức thời).
 *
 * Trả về đường dẫn các file khúc, đúng thứ tự thời gian. Bên gọi chịu trách nhiệm
 * xoá khi xong.
 */
async function splitIntoChunks(mp3Path, chunkSeconds) {
  const tag = createHash("sha1").update(mp3Path).digest("hex").slice(0, 12);
  const prefix = `qwen-asr-${tag}-chunk-`;
  const pattern = path.join(os.tmpdir(), `${prefix}%04d.mp3`);
  try {
    await run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      mp3Path,
      "-f",
      "segment",
      "-segment_time",
      String(chunkSeconds),
      "-c",
      "copy",
      pattern,
    ]);
  } catch (err) {
    throw new Error(`ffmpeg cắt khúc audio lỗi: ${err.message}`);
  }
  const files = (await fs.readdir(os.tmpdir()))
    .filter((f) => f.startsWith(prefix) && f.endsWith(".mp3"))
    .sort()
    .map((f) => path.join(os.tmpdir(), f));
  if (files.length === 0) throw new Error("cắt khúc audio xong nhưng không thấy file khúc nào");
  return files;
}

/** Model async luôn là bản `-filetrans`; chấp nhận cả tên ngắn cho tiện gõ .env. */
function filetransModel(model) {
  return model.endsWith("-filetrans") ? model : `${model}-filetrans`;
}

/**
 * fetch + parse JSON với timeout tự dọn.
 *
 * KHÔNG dùng `AbortSignal.timeout()`: timer của nó ref vào event loop, request xong
 * sớm thì timer vẫn treo tiến trình tới khi hết hạn (đo được: `npm run stt` đứng im
 * ~3 phút sau khi transcribe xong). Tự quản `setTimeout`/`clearTimeout` để chắc.
 */
async function fetchJson(url, { method = "GET", body, headers } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.sttTimeoutMs);
  // `body` gốc (object) chứ không phải chuỗi JSON: apiLog cắt được data URI base64
  // ~3.5 MB trong `input.file_urls` thay vì in nguyên cả khối.
  logApiRequest(log, { method, url, headers, body });
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json", ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const raw = await res.text();
    logApiResponse(log, { method, url, status: res.status, ms: Date.now() - t0, body: maybeJson(raw) });
    let json;
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`DashScope ${res.status}: không parse được response — ${raw.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(`DashScope ${res.status}: ${json.code ?? "?"} — ${json.message ?? raw.slice(0, 200)}`);
    }
    return json;
  } catch (error) {
    // Chỉ lỗi tầng mạng/timeout mới tới đây mà chưa có dòng RESPONSE nào — lỗi HTTP
    // đã được log ở trên rồi, nhưng in thêm dòng ERROR không hại, vẫn cùng một lời gọi.
    logApiError(log, { method, url, ms: Date.now() - t0, error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Submit task filetrans, poll tới khi xong, trả về JSON kết quả (đã tải từ transcription_url). */
async function runFiletrans(dataUri, model) {
  const auth = { Authorization: `Bearer ${requireConfig(config.dashscopeApiKey, "DASHSCOPE_API_KEY")}` };
  const submitUrl = `${requireConfig(config.dashscopeBaseUrl, "DASHSCOPE_BASE_URL").replace(/\/+$/, "")}/api/v1/services/audio/asr/transcription`;
  const pollBase = requireConfig(config.dashscopePollUrl, "DASHSCOPE_POLL_URL").replace(/\/+$/, "");

  const params = {};
  if (config.qwenDiarize) {
    params.diarization_enabled = true;
    if (config.qwenSpeakerCount) params.speaker_count = config.qwenSpeakerCount;
  }

  const submit = await fetchJson(submitUrl, {
    method: "POST",
    body: { model, input: { file_urls: [dataUri] }, parameters: params },
    headers: { ...auth, "X-DashScope-Async": "enable" },
  });
  const taskId = submit.output?.task_id;
  if (!taskId) throw new Error(`submit không trả task_id: ${JSON.stringify(submit).slice(0, 200)}`);

  const deadline = Date.now() + config.sttTimeoutMs;
  for (;;) {
    await sleep(config.dashscopePollIntervalMs);
    const task = await fetchJson(`${pollBase}/api/v1/tasks/${taskId}`, { headers: auth });
    const status = task.output?.task_status;
    if (status === "SUCCEEDED") {
      const url = task.output.transcription_url ?? task.output.results?.[0]?.transcription_url;
      if (!url) throw new Error(`task SUCCEEDED nhưng không có transcription_url`);
      return fetchJson(url);
    }
    if (status === "FAILED") {
      throw new Error(`task FAILED: ${task.output.message ?? task.output.code ?? "không rõ"}`);
    }
    if (Date.now() > deadline) throw new Error(`task ${taskId} quá ${config.sttTimeoutMs}ms vẫn ${status}`);
  }
}

/**
 * Gửi 1 buffer mp3 (đã dưới trần base64) lên filetrans, trả về transcript thô. Truyền
 * `remoteUrl` thay vì `buffer` để gửi thẳng URL công khai (bỏ qua base64).
 */
async function transcribeChunk(buffer, model, remoteUrl = null) {
  const source = remoteUrl ?? `data:audio/mpeg;base64,${buffer.toString("base64")}`;
  const result = await runFiletrans(source, filetransModel(model));
  const t = result.transcripts?.[0];
  if (!t?.text) throw new Error("filetrans trả kết quả nhưng không có text");
  return t;
}

/** `worker` trên `items`, tối đa `limit` việc song song — submit+poll chờ mạng là chính. */
async function runPool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) await worker(queue.shift());
  });
  await Promise.all(runners);
}

/** Ghép các transcript thô của nhiều khúc liên tiếp thành một, dịch mốc thời gian theo offset tích luỹ. */
function mergeChunkTranscripts(chunkResults, chunkDurationsMs) {
  const sentences = [];
  const textParts = [];
  let contentDurationMs = 0;
  let offsetMs = 0;
  chunkResults.forEach((t, i) => {
    textParts.push(t.text.trim());
    contentDurationMs += t.content_duration_in_milliseconds ?? 0;
    for (const s of t.sentences ?? []) {
      sentences.push({
        ...s,
        begin_time: s.begin_time + offsetMs,
        end_time: s.end_time + offsetMs,
        words: (s.words ?? []).map((w) => ({ ...w, begin_time: w.begin_time + offsetMs, end_time: w.end_time + offsetMs })),
        // Namespace theo khúc: filetrans đánh số speaker_id lại từ đầu ở mỗi khúc, ghép
        // thẳng "S0" của khúc 2 vào "S0" của khúc 1 là suy diễn cùng người sai — tách rõ
        // để người xem tự đối chiếu, không giả vờ liên tục xuyên khúc.
        ...(s.speaker_id != null ? { speaker_id: `${i}.${s.speaker_id}` } : {}),
      });
    }
    offsetMs += chunkDurationsMs[i];
  });
  return { text: textParts.join("\n"), sentences, content_duration_in_milliseconds: contentDurationMs };
}

function buildResult(t) {
  const sentences = t.sentences ?? [];
  const allWords = sentences.flatMap((s) => s.words ?? []);
  return {
    text: t.text.trim(),
    segments: sentences.map((s, id) => ({
      id,
      start: s.begin_time / 1000,
      end: s.end_time / 1000,
      text: s.text,
      // speaker_id chỉ có khi QWEN_DIARIZE bật; không tin cậy — stt.js quyết định
      // có dùng hay không.
      ...(s.speaker_id != null ? { qwenSpeakerId: s.speaker_id } : {}),
    })),
    words: allWords.map((w) => ({ word: w.text, start: w.begin_time / 1000, end: w.end_time / 1000 })),
    duration: (t.content_duration_in_milliseconds ?? 0) / 1000 || null,
    detectedLanguage: null,
    hasTimestamps: allWords.length > 0,
  };
}

export async function transcribeQwenAsr(audioPath, model) {
  // `audioPath` là URL công khai (http/https) thay vì file local: filetrans nhận
  // thẳng qua `file_urls`, tự tải về phía DashScope — không phải base64-nhét-JSON nên
  // KHÔNG dính trần 10MB (giới hạn của cách nhúng base64), tài liệu ghi hỗ trợ tới
  // 2GB. Dùng khi audio quá dài để hạ mẫu vẫn vượt trần, mà không muốn cắt khúc cục bộ
  // (mất liên tục nhãn người nói qua ranh giới khúc) — xem [[douyind-downloader-aliyun-asr]].
  if (/^https?:\/\//i.test(audioPath)) {
    log.info(`${model}: transcribe qua URL công khai (bỏ qua hạ mẫu/base64 local)`);
    const t = await transcribeChunk(null, model, audioPath);
    return buildResult(t);
  }

  const mp3Path = await downsampleToTemp(audioPath);
  const tempFiles = [mp3Path];
  try {
    const buffer = await fs.readFile(mp3Path);
    const base64Len = buffer.toString("base64").length;

    let t;
    if (base64Len <= MAX_BASE64_BYTES) {
      t = await transcribeChunk(buffer, model);
    } else {
      // Video ghép nhiều tập vượt trần 10 MB base64 của DashScope — cắt khúc theo tỉ lệ
      // đo được (byte base64 / giây) rồi transcribe từng khúc, ghép lại theo offset.
      const durationSec = await probeDurationSec(mp3Path);
      const bytesPerSecBase64 = base64Len / durationSec;
      const chunkSeconds = Math.max(60, Math.floor(CHUNK_TARGET_BASE64_BYTES / bytesPerSecBase64));
      const chunkFiles = await splitIntoChunks(mp3Path, chunkSeconds);
      tempFiles.push(...chunkFiles);

      log.info(
        `${model}: audio ${(base64Len / 1024 / 1024).toFixed(1)} MB base64 vượt trần — ` +
          `cắt ${chunkFiles.length} khúc ~${chunkSeconds}s`,
      );

      const chunkDurationsSec = [];
      for (const f of chunkFiles) chunkDurationsSec.push(await probeDurationSec(f));

      const chunkResults = new Array(chunkFiles.length);
      await runPool(
        chunkFiles.map((f, i) => ({ f, i })),
        3,
        async ({ f, i }) => {
          const chunkBuffer = await fs.readFile(f);
          chunkResults[i] = await transcribeChunk(chunkBuffer, model);
        },
      );

      t = mergeChunkTranscripts(
        chunkResults,
        chunkDurationsSec.map((s) => s * 1000),
      );
    }

    const sentences = t.sentences ?? [];
    const allWords = sentences.flatMap((s) => s.words ?? []);
    log.debug(
      `${model}: ${t.text.length} ký tự, ${sentences.length} câu, ${allWords.length} từ, ` +
        `content ${Math.round((t.content_duration_in_milliseconds ?? 0) / 1000)}s`,
    );

    return buildResult(t);
  } finally {
    await Promise.all(tempFiles.map((f) => fs.rm(f, { force: true })));
  }
}
