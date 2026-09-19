import { config } from "./config.js";

/**
 * Log request/response cho MỌI lời gọi API trong dự án — một chỗ duy nhất thay vì
 * chép lại logic in JSON ở từng provider.
 *
 * Ba việc bắt buộc phải làm tập trung, vì làm lẻ ở từng nơi là sớm muộn sót:
 * - CHE KHOÁ: `Authorization`, `api_key`, cookie… không bao giờ được rơi vào log —
 *   log hay bị dán vào issue/chat.
 * - CẮT PAYLOAD NẶNG: qwen-asr nhét audio base64 ~3.5 MB vào body; in nguyên là
 *   log vô dụng và terminal treo. Cắt theo `API_LOG_MAX_CHARS` (0 = in đủ).
 * - LOG CẢ KHI LỖI: `logApiCall` in response ngay cả lúc call ném lỗi — đúng lúc
 *   cần nhìn request nhất lại là lúc nó hỏng.
 *
 * Mức log đọc từ `API_LOG_LEVEL`, mặc định `debug`: chạy batch hàng trăm video với
 * LOG_LEVEL=info thì các dòng này ẩn; cần soát từng lời gọi thì đặt LOG_LEVEL=debug,
 * hoặc API_LOG_LEVEL=info để chỉ nổi phần API lên mà không kéo theo debug của mọi
 * module khác.
 */

/** Base URL mặc định của SDK OpenAI — chỉ để hiện trong log cho biết gọi đi đâu. */
export const OPENAI_V1 = "https://api.openai.com/v1";

// Khoá phải che. Cố ý KHÔNG khớp mọi thứ chứa chữ "token": `prompt_tokens` /
// `completion_tokens` trong `usage` là số đếm để tính tiền — che chúng đi là bỏ mất
// đúng phần đáng đọc nhất của response.
const SECRET_EXACT_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|password|passwd|credential)s?$/i;
// Bắt thêm dạng ghép như `dashscopeApiKey`, `openai_api_key`, `clientSecret`.
const SECRET_PART_RE = /(api[-_]?key|apikey|secret|password|credential)/i;
const isSecret = (key) => SECRET_EXACT_RE.test(key) || SECRET_PART_RE.test(key);
const MAX = Math.max(0, config.apiLogMaxChars);

// Khối base64 (data URI của qwen-asr, audio trong message của voice-judge, mẫu wav
// gửi voice-enrollment) cắt RIÊNG và cắt rất ngắn, không theo API_LOG_MAX_CHARS:
// trần đó tồn tại để prompt dịch dài không bị cụt, mà 20 000 ký tự base64 thì vẫn
// chỉ là rác phủ kín terminal — không ai đọc base64 để soát request.
const BASE64_HEAD = 48;
const DATA_URI_RE = /^(data:[^;,]{0,80};base64,)([A-Za-z0-9+/=]+)$/;
const BASE64_BLOB_RE = /^[A-Za-z0-9+/=]{512,}$/;

function shortenBase64(s) {
  const m = DATA_URI_RE.exec(s);
  if (m) return `${m[1]}${m[2].slice(0, BASE64_HEAD)}…⟨base64 ${m[2].length} ký tự⟩`;
  if (BASE64_BLOB_RE.test(s)) return `${s.slice(0, BASE64_HEAD)}…⟨base64 ${s.length} ký tự⟩`;
  return null;
}

const cut = (s) =>
  shortenBase64(s) ?? (!MAX || s.length <= MAX ? s : `${s.slice(0, MAX)}…⟨cắt ${s.length - MAX} ký tự⟩`);

/**
 * Đưa một giá trị bất kỳ về dạng in được: che khoá, cắt chuỗi dài, mô tả ngắn gọn
 * những thứ JSON.stringify không diễn tả nổi (stream, Blob, Buffer, FormData).
 */
function scrub(value, key = "", seen = new WeakSet()) {
  if (value == null) return value;
  if (isSecret(key)) return "⟨đã che⟩";
  if (typeof value === "string") return cut(value);
  if (typeof value === "function") return `⟨function ${value.name || "?"}⟩`;
  if (typeof value !== "object") return value;

  if (seen.has(value)) return "⟨vòng lặp tham chiếu⟩";
  seen.add(value);

  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `⟨${value.byteLength} byte nhị phân⟩`;
  }
  // Blob/File: đọc nội dung là async, mà log phải đồng bộ — chỉ tả tên/kiểu/cỡ.
  if (typeof value.size === "number" && typeof value.arrayBuffer === "function") {
    return `⟨file ${value.name ?? "(không tên)"}${value.type ? ` ${value.type}` : ""}, ${value.size} byte⟩`;
  }
  if (typeof FormData !== "undefined" && value instanceof FormData) {
    return Object.fromEntries([...value.entries()].map(([k, v]) => [k, scrub(v, k, seen)]));
  }
  // fs.ReadStream — thứ stt.js đưa cho SDK OpenAI làm `file`.
  if (typeof value.path === "string" && typeof value.pipe === "function") {
    return `⟨stream ${value.path}⟩`;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, key, seen));

  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k, seen)]));
}

function render(value) {
  const cleaned = scrub(value);
  return typeof cleaned === "string" ? cleaned : JSON.stringify(cleaned, null, 2);
}

function emit(log, line) {
  (log[config.apiLogLevel] ?? log.debug)(line);
}

/** Chuỗi body có thể là JSON — in dạng JSON cho dễ đọc, không parse được thì in thô. */
export function maybeJson(raw) {
  if (typeof raw !== "string" || !raw) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function logApiRequest(log, { method = "POST", url, headers, body }) {
  const payload = { ...(headers ? { headers } : {}), ...(body === undefined ? {} : { body }) };
  const head = `--- API REQUEST ${method} ${url} ---`;
  // GET không header cũng không body thì URL ĐÃ là toàn bộ request — thêm dòng "{}"
  // chỉ tổ rác.
  emit(log, Object.keys(payload).length ? `${head}\n${render(payload)}` : head);
}

export function logApiResponse(log, { method = "POST", url, status, ms, body }) {
  const meta = [status != null ? `HTTP ${status}` : null, ms != null ? `${(ms / 1000).toFixed(2)}s` : null]
    .filter(Boolean)
    .join(", ");
  emit(log, `--- API RESPONSE ${method} ${url}${meta ? ` (${meta})` : ""} ---\n${render(body)}`);
}

export function logApiError(log, { method = "POST", url, ms, error }) {
  const status = error?.status ?? error?.response?.status;
  emit(
    log,
    `--- API ERROR ${method} ${url} (${status ? `HTTP ${status}, ` : ""}${((ms ?? 0) / 1000).toFixed(2)}s) ---\n` +
      render({ message: error?.message, status, body: error?.error ?? error?.response?.data ?? null }),
  );
}

/**
 * Bọc một lời gọi API bất kỳ (SDK OpenAI, Playwright request…): in request trước khi
 * gọi, in response sau khi xong — kể cả khi ném lỗi — rồi trả nguyên kết quả.
 *
 * `request` chỉ để mô tả cho log; `run` mới là thứ thật sự gọi. Tách đôi vì SDK dựng
 * request theo cách riêng của nó, ta không tái tạo lại được chính xác.
 */
export async function logApiCall(log, { method = "POST", url, headers, body }, run) {
  logApiRequest(log, { method, url, headers, body });
  const t0 = Date.now();
  try {
    const res = await run();
    logApiResponse(log, { method, url, ms: Date.now() - t0, body: res });
    return res;
  } catch (error) {
    logApiError(log, { method, url, ms: Date.now() - t0, error });
    throw error;
  }
}

/**
 * `fetch` có log. Trả `{ res, raw, json }` — body đã đọc sẵn dạng text (mọi API
 * trong dự án trả JSON hoặc text lỗi), `json` là bản đã parse nếu parse được.
 *
 * KHÔNG tự ném khi status lỗi: mỗi call site có cách diễn giải lỗi riêng (retry,
 * đọc `code`/`message` theo format của hãng) — chỗ này chỉ lo phần log.
 */
export async function fetchLogged(log, url, init = {}, { logBody = init.body } = {}) {
  const method = init.method ?? "GET";
  // `logBody` để log dạng OBJECT trong khi vẫn gửi đi chuỗi đã stringify — cần cho
  // body ôm audio base64 (voice-judge), vì cắt một chuỗi JSON khổng lồ thì mất luôn
  // phần đuôi đáng đọc, còn cắt theo từng field thì chỉ mất đúng khối base64.
  logApiRequest(log, { method, url, headers: init.headers, body: logBody });
  const t0 = Date.now();

  let res;
  try {
    res = await fetch(url, init);
  } catch (error) {
    logApiError(log, { method, url, ms: Date.now() - t0, error });
    throw error;
  }

  const raw = await res.text();
  const json = maybeJson(raw);
  logApiResponse(log, { method, url, status: res.status, ms: Date.now() - t0, body: json });
  return { res, raw, json };
}

/** `fetch` có log cho nội dung nhị phân (tải audio đã tổng hợp…): log cỡ, không log body. */
export async function fetchBufferLogged(log, url, init = {}, { logBody = init.body } = {}) {
  const method = init.method ?? "GET";
  logApiRequest(log, { method, url, headers: init.headers, body: logBody });
  const t0 = Date.now();

  let res;
  try {
    res = await fetch(url, init);
  } catch (error) {
    logApiError(log, { method, url, ms: Date.now() - t0, error });
    throw error;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  logApiResponse(log, {
    method,
    url,
    status: res.status,
    ms: Date.now() - t0,
    body: `⟨${buf.length} byte ${res.headers.get("content-type") ?? "?"}⟩`,
  });
  return { res, buf };
}
