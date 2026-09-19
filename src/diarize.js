import fs from "node:fs/promises";
import path from "node:path";

import { logApiRequest, logApiResponse, maybeJson } from "./apiLog.js";
import { config } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("DIARIZE");

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

/**
 * Định danh người nói bằng `gpt-4o-transcribe-diarize` — CHỈ để lấy nhãn speaker
 * qua chồng lấn thời gian. Text riêng của response này không dùng: whisper-1 mới
 * là nguồn STT tổng thể (xem `src/stt.js`, `enrichTranscript`).
 *
 * Dùng fetch trần thay vì SDK `openai`: `diarized_json` là response_format riêng
 * của model này, chưa chắc SDK hỗ trợ.
 *
 * Hai điều đã đo, đừng đổi nếu không kiểm chứng lại:
 * - `chunking_strategy: "auto"` BẮT BUỘC với audio > 30s (audio của ta ~220s).
 * - Model bỏ hẳn những đoạn nhạc/hiệu ứng chạy liên tục — video mẫu mất 42 giây
 *   cuối (18%). Vì vậy KHÔNG dùng kết quả này làm khung thời gian; segment không
 *   chồng lấn được thì để `speaker: null` ("không xác định"), không đoán.
 *
 * `audioPath` luôn là audio gốc trong pipeline chính — đã thử tách vocal trước khi
 * gửi (đo được cải thiện coverage thật) nhưng bỏ vì Demucs thành bottleneck khi
 * chạy batch hàng trăm video (xem README, `src/vocals.js`). Hàm này không tự tách,
 * chỉ gửi đúng file được đưa vào — vẫn nhận `.wav` nếu ai gọi tay với audio đã tách.
 */
export async function diarizeAudio(audioPath, { prompt = "" } = {}) {
  if (!config.openaiApiKey) {
    throw new Error("thiếu OPENAI_API_KEY — thêm vào .env (xem .env.example)");
  }

  const form = new FormData();
  // Tên file theo đúng đuôi thật: nhánh diarize có thể nhận .wav (đã tách vocal
  // bằng Demucs) thay vì .m4a gốc — gửi sai đuôi là gửi sai định dạng cho API.
  form.append("file", new Blob([await fs.readFile(audioPath)]), path.basename(audioPath));
  form.append("model", config.sttDiarizeModel);
  form.append("response_format", "diarized_json");
  form.append("chunking_strategy", "auto");
  // CHƯA KIỂM CHỨNG model diarize có nhận `prompt` không — doc OpenAI không ghi rõ
  // tham số này áp dụng cho model nào ngoài whisper-1. Gửi thử, API trả 400 là biết
  // không hỗ trợ.
  if (prompt) form.append("prompt", prompt);

  // Log tay chứ không qua `fetchLogged`: body là FormData ôm nguyên file audio, phải
  // in phần mô tả field (apiLog tự rút file thành "⟨file …, N byte⟩") chứ không phải
  // stream nội dung.
  logApiRequest(log, { method: "POST", url: ENDPOINT, body: form });
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiApiKey}` },
    body: form,
    signal: AbortSignal.timeout(config.sttTimeoutMs),
  });

  const body = await res.text();
  logApiResponse(log, {
    method: "POST",
    url: ENDPOINT,
    status: res.status,
    ms: Date.now() - t0,
    body: maybeJson(body),
  });
  if (!res.ok) throw new Error(`diarize HTTP ${res.status}: ${body.slice(0, 300)}`);

  const json = JSON.parse(body);
  const speakers = [...new Set((json.segments ?? []).map((s) => s.speaker))];
  const covered = json.segments?.length ? Math.max(...json.segments.map((s) => s.end)) : 0;
  log.debug(
    `${json.segments?.length ?? 0} segment, ${speakers.length} người nói, ` +
      `phủ tới ${covered.toFixed(1)}s/${(json.duration ?? 0).toFixed(1)}s`,
  );

  return json;
}

/** USD của một lời gọi, tính từ `usage` thật thay vì bảng ước tính theo phút. */
export function callCost(usage, { inputPerM = 2.5, outputPerM = 10 } = {}) {
  if (!usage) return null;
  // gpt-transcribe tính theo thời lượng chứ không theo token.
  if (usage.type === "duration") return ((usage.seconds ?? 0) / 60) * 0.0045;
  return ((usage.input_tokens ?? 0) / 1e6) * inputPerM + ((usage.output_tokens ?? 0) / 1e6) * outputPerM;
}
