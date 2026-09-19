import fs from "node:fs/promises";

import { config } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("GLOSSARY");

/**
 * Thuật ngữ cố định, để 122 tập dịch ra cùng một mặt chữ.
 *
 * Không có nó thì tập 1 ra "Kim Đan", tập 5 ra "Kim Đơn", tập 9 ra "viên thuốc vàng"
 * — đọc rời từng tập thì không thấy sai, ghép cả bộ mới lộ.
 */

// Đã kiểm chứng: ⟦n⟧ đi qua Google Translate mà không bị dịch hay bị bóp méo.
// Ký tự này hiếm tới mức không đụng nội dung thật, và không phải ký tự đặc biệt
// của regex nên ghép/tách bằng split/join là đủ, không cần escape.
const OPEN = "⟦";
const CLOSE = "⟧";

let cached = null;

export async function loadGlossary() {
  if (cached) return cached;
  try {
    const raw = await fs.readFile(config.glossaryFile, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Object.entries(parsed).filter(([k, v]) => k && typeof v === "string");
    // Thay từ dài trước: 下品宝剑 phải ăn trước 宝剑, không thì chỉ khớp được phần đuôi.
    entries.sort((a, b) => b[0].length - a[0].length);
    cached = entries;
    log.debug(`nạp ${entries.length} thuật ngữ từ ${config.glossaryFile}`);
    return cached;
  } catch (err) {
    if (err.code !== "ENOENT") log.warn(`không đọc được ${config.glossaryFile}: ${err.message}`);
    cached = [];
    return cached;
  }
}

/**
 * Quét thuật ngữ có mặt trong text theo ĐÚNG một thứ tự/quy tắc ăn khớp, rồi thay
 * mỗi lần khớp bằng `token(i)`.
 *
 * Dùng chung cho protect() và matchedTerms() là có chủ ý: hai chế độ A/B (bọc
 * placeholder hay chỉ đưa bảng thuật ngữ) phải thấy CÙNG một tập thuật ngữ, không
 * thì so nhầm thêm một biến nữa. Việc thay chuỗi cũng là thứ quyết định tập đó:
 * 下品宝剑 ăn trước thì 宝剑 không còn khớp phần đuôi nữa (entries đã sắp dài trước).
 */
function scan(text, entries, token) {
  const used = [];
  // Song song với `used` (cùng chỉ số ⟦n⟧) nhưng giữ cả vế Hán tự gốc — `used` chỉ
  // có vế tiếng Việt vì đó là tất cả restore() cần. `pairs` để bên gọi (translate.js)
  // dựng bảng "⟦n⟧ = Hán tự (bản dịch)" nhét vào prompt, thay vì bắt model đoán mù
  // ⟦n⟧ là chữ gì — từng gây lỗi thật: "⟦0⟧镜" (đáng lẽ 金丹境, bị placeholder nuốt
  // mất 金丹) bị dịch thành "Kim Đan kính" vì model không biết ⟦0⟧ là gì.
  const pairs = [];
  let out = text;
  for (const [zh, vi] of entries) {
    if (!out.includes(zh)) continue;
    out = out.split(zh).join(token(used.length));
    used.push(vi);
    pairs.push([zh, vi]);
  }
  return { text: out, used, pairs };
}

/**
 * Thay thuật ngữ bằng placeholder trước khi dịch.
 *
 * Cách này khiến glossary dùng được với CẢ provider không nhận chỉ dẫn (Google) —
 * bản dịch không đụng được vào chỗ đã bọc, nên thuật ngữ luôn ra đúng ý mình.
 */
export function protect(text, entries) {
  // Bọc placeholder trong dấu cách. Tiếng Trung viết liền không khoảng trắng, nên
  // không có cặp dấu cách này thì thuật ngữ khôi phục xong dính chặt vào từ bên
  // cạnh: "tiền bốiĐùa thôi", "Kim Đanold", "30.000hạ phẩm".
  return scan(text, entries, (i) => ` ${OPEN}${i}${CLOSE} `);
}

/**
 * Chế độ `--no-protect`: KHÔNG đụng vào text, chỉ trả về những thuật ngữ có mặt để
 * bên gọi đưa vào prompt dưới dạng bảng "Hán tự = bản dịch".
 *
 * Tách được protect() ra khỏi glossary mới A/B được đúng một biến: `--no-glossary`
 * cũ vừa bỏ placeholder vừa bỏ luôn mọi tri thức thuật ngữ, nên bản đo trên case
 * 乾坤袋 không quy trách nhiệm được cho riêng cơ chế placeholder.
 */
export function matchedTerms(text, entries) {
  // Vẫn phải thay chuỗi trong bản nháp nội bộ (rồi vứt đi) để tập thuật ngữ khớp
  // hệt protect() — xem scan(). Dấu cách là token vô hại nhất cho vòng quét.
  return scan(text, entries, () => " ").pairs;
}

// Model LLM của Google "chuẩn hoá" dấu ngoặc lạ về dạng quen thuộc — ⟦0⟧ đi vào,
// [0] đi ra. Nhận mọi biến thể, không thì thuật ngữ lọt nguyên ra bản dịch:
// "cao thủ cấp [0] hậu kỳ" đáng lẽ phải là "cao thủ Kim Đan hậu kỳ".
const OPEN_ANY = "[⟦\\[(（{【]";
const CLOSE_ANY = "[⟧\\])）}】]";

// Câu vừa kết thúc chưa? Xét phần output đã dựng tới lúc này. Dấu phẩy KHÔNG tính —
// thà bỏ sót vài chỗ còn hơn viết hoa bừa giữa câu.
const SENTENCE_BREAK = /[.!?…;:。！？\n][\s"'“‘([]*$/u;

const upperFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Khôi phục placeholder thành thuật ngữ tiếng Việt.
 *
 * Vừa thay vừa sửa hoa/thường quanh chỗ thay. Model không thấy được chữ nằm trong
 * ⟦n⟧ nên coi nó không phải chữ, và viết hoa từ ngay SAU nó:
 *
 *   前辈去而复返   → "⟦0⟧ Đi rồi lại về"   → "tiền bối Đi rồi lại về"
 *   极品宝器      → "⟦1⟧"                → "cực phẩm bảo khí"  (đầu câu, không hoa)
 *
 * Placeholder đứng đầu câu thì vai trò "chữ cái đầu" thuộc về thuật ngữ vừa khôi
 * phục: viết hoa nó, rồi hạ chữ ngay sau xuống. Placeholder giữa câu thì để yên —
 * chữ hoa ở đó có thể là tên riêng thật, không dám đoán.
 */
export function restore(text, used) {
  const token = new RegExp(`${OPEN_ANY}\\s*(\\d+)\\s*${CLOSE_ANY}`, "g");
  let out = "";
  let last = 0;

  for (let m = token.exec(text); m !== null; m = token.exec(text)) {
    const vi = used[Number(m[1])];
    // Số lạ (model tự bịa placeholder) — để nguyên cho leftoverTokens báo.
    if (vi === undefined) continue;

    out += text.slice(last, m.index);
    last = m.index + m[0].length;

    const opensSentence = out.trim() === "" || SENTENCE_BREAK.test(out);
    out += opensSentence ? upperFirst(vi) : vi;

    if (opensSentence) {
      const next = text.slice(last).match(/^(\s*)(\p{Lu})/u);
      if (next) {
        out += next[1] + next[2].toLowerCase();
        last += next[0].length;
      }
    }
  }
  out += text.slice(last);

  return tidySpacing(out);
}

/** Dọn khoảng trắng thừa do việc bọc placeholder sinh ra. */
function tidySpacing(text) {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.!?;:…、。，！？])/g, "$1")
    .replace(/([(["'“‘])[ \t]+/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+/gm, "");
}

/** Còn sót placeholder nào không — dấu hiệu provider đã làm hỏng payload. */
export function leftoverTokens(text) {
  return [...text.matchAll(new RegExp(`${OPEN_ANY}\\s*\\d+\\s*${CLOSE_ANY}`, "g"))].map((m) => m[0]);
}
