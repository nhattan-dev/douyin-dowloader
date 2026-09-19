import { fetchLogged } from "../apiLog.js";
import { createLogger } from "../logger.js";

const log = createLogger("TR/google-free");

export const name = "google-free";
export const needsBrowser = false;
export const concurrencySafe = true;

// Endpoint free đời cũ (thứ mà các extension dịch hay dùng). Không cần API key,
// nhưng CHẤT LƯỢNG KÉM HẲN model đang chạy trên translate.google.com — đã đo:
// 下品宝剑 ra "đặt một thanh kiếm vào trong một cái chai". Giữ lại vì nó chạy được
// ngay không cần cấu hình gì, hợp để kiểm thử phần chia/ghép segment và làm dự
// phòng khi provider chính hỏng. Đừng dùng cho bản dịch cuối.
const ENDPOINT = "https://translate.googleapis.com/translate_a/single";

export async function translateText(text, { from, to }) {
  const url =
    `${ENDPOINT}?client=gtx&dt=t` +
    `&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}` +
    `&q=${encodeURIComponent(text)}`;

  // Endpoint này nhét cả câu vào query string nên URL trong log ĐÃ là request đầy
  // đủ; `logBody` thêm phần text đọc được thay vì bắt đọc chuỗi đã percent-encode.
  const { res, json } = await fetchLogged(
    log,
    url,
    { signal: AbortSignal.timeout(30_000) },
    { logBody: { sl: from, tl: to, q: text } },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!Array.isArray(json?.[0])) throw new Error("response không đúng dạng mong đợi");

  // json[0] là mảng các mảnh [dịch, gốc, ...]; ghép lại thành text hoàn chỉnh.
  const out = json[0].map((chunk) => chunk?.[0] ?? "").join("");
  log.debug(`${text.length} → ${out.length} ký tự`);
  return out;
}
