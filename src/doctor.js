import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import OpenAI from "openai";
import { toFile } from "openai/uploads";

import { fetchLogged, logApiCall, OPENAI_V1 } from "./apiLog.js";
import { config } from "./config.js";
import { createLogger } from "./logger.js";

const execFileAsync = promisify(execFile);
const log = createLogger("DOCTOR");

/**
 * Chẩn đoán đường mạng tới OpenAI.
 *
 * api.openai.com hỏng theo nhiều kiểu rất giống nhau nhìn từ phía SDK ("Connection
 * error", 403) nhưng cách xử lý hoàn toàn khác nhau, nên phải phân biệt bằng thân
 * response và nước mà IP đang thoát ra chứ không đoán.
 */

const TIMEOUT_MS = 20_000;

async function timed(label, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    return { label, ms: Date.now() - startedAt, ...result };
  } catch (err) {
    return { label, ms: Date.now() - startedAt, error: `${err.name}: ${err.message}` };
  }
}

// Trả `{ res, raw, json }` như fetchLogged — bản thân doctor in ra bản tóm tắt cho
// người đọc, còn nguyên văn request/response đi vào log API ở mức debug.
const fetchWithTimeout = (url, init = {}) =>
  fetchLogged(log, url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

/**
 * Gọi thật endpoint transcription bằng 1 giây im lặng.
 *
 * `GET /v1/models` trả 200 kể cả khi tài khoản hết credit, nên không đủ để kết luận
 * là chạy được. Chỉ có một request transcription thật mới lộ ra 429 insufficient_quota.
 *
 * Chạy với maxRetries=0 là điểm mấu chốt: khi bật retry, lỗi 429 ở lần đầu bị các
 * lần retry hỏng kết nối đè lên, và thứ nổi lên là "Connection error" — che mất
 * nguyên nhân thật và dẫn người đọc đi chẩn đoán nhầm sang lỗi mạng.
 */
async function probeTranscription() {
  const wav = path.join(os.tmpdir(), "douyin-doctor-silence.wav");
  try {
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
      "-t", "1", "-c:a", "pcm_s16le", wav,
    ]);
  } catch {
    console.log("  (bỏ qua — không chạy được ffmpeg để tạo file thử)");
    return;
  }

  const client = new OpenAI({ apiKey: config.openaiApiKey, maxRetries: 0, timeout: 60_000 });
  try {
    const file = await toFile(await fs.readFile(wav), "silence.wav");
    const params = { file, model: "whisper-1" };
    await logApiCall(log, { url: `${OPENAI_V1}/audio/transcriptions`, body: { ...params, file: wav } }, () =>
      client.audio.transcriptions.create(params),
    );
    console.log("  ✅ transcription chạy được — `npm run stt` sẵn sàng.");
  } catch (err) {
    const status = err.status ?? "-";
    console.log(`  ❌ ${err.constructor.name} status=${status}: ${err.message}`);
    if (status === 429 && /credit|quota/i.test(err.message)) {
      console.log(
        "  → Tài khoản hết credit. Nạp tại:\n" +
          "    https://platform.openai.com/settings/organization/billing",
      );
    } else if (status === 401) {
      console.log("  → OPENAI_API_KEY sai hoặc đã bị thu hồi.");
    }
  } finally {
    await fs.rm(wav, { force: true });
  }
}

export async function doctor() {
  console.log("Chẩn đoán kết nối tới OpenAI\n" + "─".repeat(60));

  // IP đang thoát ra nước nào — quyết định OpenAI có phục vụ hay không.
  const trace = await timed("exit IP", async () => {
    const { raw: text } = await fetchWithTimeout("https://www.cloudflare.com/cdn-cgi/trace");
    const kv = Object.fromEntries(
      text
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
    return { ip: kv.ip, country: kv.loc, colo: kv.colo };
  });
  if (trace.error) {
    console.log(`exit IP        : LỖI — ${trace.error}`);
  } else {
    console.log(`exit IP        : ${trace.ip}  nước=${trace.country}  colo=${trace.colo}`);
  }

  console.log(`proxy          : ${process.env.HTTPS_PROXY || process.env.https_proxy || "(không đặt)"}`);
  console.log(`api key        : ${config.openaiApiKey ? "có" : "CHƯA CÓ"}`);

  // Gọi thật một endpoint rẻ nhất, in nguyên thân lỗi.
  const api = await timed("api.openai.com", async () => {
    const { res, raw } = await fetchWithTimeout(`${OPENAI_V1}/models`, {
      headers: { Authorization: `Bearer ${config.openaiApiKey}` },
    });
    return { status: res.status, cfRay: res.headers.get("cf-ray"), body: raw.slice(0, 500) };
  });

  console.log("─".repeat(60));
  if (api.error) {
    console.log(`api.openai.com : LỖI sau ${api.ms}ms — ${api.error}`);
    console.log(
      "\nTLS bắt tay được nhưng không nhận về dữ liệu = bị chặn/nhiễu ở tầng mạng.\n" +
        "Đã quan sát được là chặn CHẬP CHỜN: cùng đường truyền, lúc timeout lúc 200.\n" +
        "Chạy lại `npm run doctor` vài lần trước khi kết luận. Bật VPN thường làm tệ hơn\n" +
        "(Cloudflare trả 403 cho IP datacenter) — thử đi thẳng và để retry lo phần còn lại.",
    );
    return api;
  }

  console.log(`api.openai.com : HTTP ${api.status} sau ${api.ms}ms  cf-ray=${api.cfRay ?? "-"}`);
  console.log(`body           : ${api.body}`);

  if (api.status === 200) {
    console.log("\nĐường mạng ổn. Thử luôn một lượt transcribe thật:");
    await probeTranscription();
  } else if (api.status === 403) {
    const isGeo = /country|region|territory|unsupported/i.test(api.body);
    console.log(
      isGeo
        ? `\n403 do VÙNG ĐỊA LÝ: IP đang thoát ra ${trace.country ?? "?"}, OpenAI không phục vụ.\n` +
            "Đổi VPN sang node ở US/UK/EU/SG/JP."
        : "\n403 nhưng KHÔNG phải lỗi vùng — nhiều khả năng Cloudflare chặn dải IP của VPN\n" +
            "(IP datacenter bị gắn cờ). Thử node VPN khác, ưu tiên loại residential.",
    );
  } else if (api.status === 401) {
    console.log("\n401: API key sai hoặc hết hạn — kiểm tra OPENAI_API_KEY trong .env.");
  } else if (api.status === 429) {
    console.log("\n429: hết quota hoặc bị rate-limit — kiểm tra billing của tài khoản.");
  }

  return api;
}
