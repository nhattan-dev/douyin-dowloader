import { createLogger } from "../logger.js";

const log = createLogger("TR/json");

/**
 * Hợp đồng "trả về JSON" dùng chung cho mọi lượt gọi LLM của bước dịch.
 *
 * VÌ SAO: giao thức cũ là văn bản đánh số ("1. ...\n2. ..."), model tự do viết gì
 * cũng được miễn có số ở đầu dòng — và ĐÃ ĐO thấy nó lợi dụng đúng chỗ đó: video
 * 7658103101886434560, 43 dòng, deepseek-chat (server trả `deepseek-v4-flash`) trả
 * về nguyên 43 dòng TIẾNG TRUNG đã được chuẩn hoá lại (差点憋。/死。 → 差点憋死。),
 * cả 3 lượt nháp/review/polish đều vậy. Output vẫn "đúng định dạng" nên
 * `parsePayload()` của translate.js nhận, ghi thẳng ra translation.json, chỉ để lại
 * 1 dòng cảnh báo "còn chữ Hán".
 *
 * Ràng buộc kiểu dữ liệu không chữa được việc model chọn nhầm việc, nhưng nó ép
 * output ra khỏi hình dạng "y hệt input" — và quan trọng hơn, cho chỗ này một lỗi
 * PHÂN BIỆT ĐƯỢC (JSON hỏng) thay vì một bản dịch giả trông như thật.
 *
 * Dạng chốt: `{"translations": ["...", "..."]}` — trùng schema mà provider `openai`
 * đang ép bằng Structured Outputs (`json_schema`, strict), nên hai đường dùng chung
 * được hàm parse ở dưới. Khác biệt: DeepSeek chỉ có JSON Mode (`json_object`) —
 * đảm bảo CÚ PHÁP JSON hợp lệ chứ không đảm bảo đúng schema, nên phần kiểm tra
 * hình dạng ở đây là bắt buộc, không phải phòng xa.
 *
 * Doc: https://api-docs.deepseek.com/guides/json_mode — 3 điều kiện bắt buộc:
 *   1. `response_format: { type: "json_object" }`
 *   2. prompt PHẢI có chữ "json"
 *   3. prompt PHẢI có VÍ DỤ về dạng JSON mong muốn
 * Thiếu (2) hoặc (3) thì API trả content rỗng — doc ghi rõ, không phải suy đoán.
 */
export const JSON_RESPONSE_FORMAT = { type: "json_object" };

/**
 * Dựng khối `EXAMPLE JSON OUTPUT` — in xuống dòng, thụt 4 dấu cách, đúng khuôn
 * mẫu trong doc DeepSeek. Cố ý KHÔNG in một dòng: ví dụ trong doc là JSON đã
 * xuống dòng, và ví dụ là thứ duy nhất định nghĩa cấu trúc ở đây (json_object
 * không nhận schema) nên nó phải nhìn đúng như output mong muốn.
 */
export function jsonExample(lines) {
  return JSON.stringify({ translations: lines }, null, 4);
}

/**
 * Khối ĐỊNH NGHĨA CẤU TRÚC + ví dụ, đặt ở CUỐI system prompt.
 *
 * `json_object` của DeepSeek chỉ đảm bảo output là JSON hợp lệ — nó KHÔNG nhận
 * schema (`response_format` chỉ chấp nhận `text` hoặc `json_object`, xem
 * api-docs.deepseek.com/api/create-chat-completion). Nghĩa là hình dạng dữ liệu
 * chỉ tồn tại ở đúng hai chỗ: mô tả khoá bên dưới, và cặp EXAMPLE INPUT/EXAMPLE
 * JSON OUTPUT. Doc JSON Mode nói thẳng: phải có chữ "json" trong prompt VÀ một ví
 * dụ về dạng JSON mong muốn — thiếu thì API trả content rỗng.
 *
 * Ba tham số vì mỗi lượt gọi có hình dạng ĐẦU VÀO khác nhau (nháp nhận bản gốc;
 * review/polish nhận bản gốc + bản dịch). Ví dụ phải khớp đúng đầu vào thật của
 * lượt đó — ví dụ lệch dạng thì nó dạy sai chính cái nó đang định nghĩa.
 *
 * @param subject       mô tả nội dung một phần tử, theo vai của lượt gọi.
 * @param exampleInput  đầu vào mẫu, CÙNG DẠNG với user message thật của lượt đó.
 * @param exampleOutput đầu ra mẫu tương ứng — dựng bằng `jsonExample()`.
 */
export function jsonOutputRules({
  subject = "bản dịch tiếng Việt",
  exampleInput = ["1. 你是谁？", "2. 身死道消。"].join("\n"),
  exampleOutput = jsonExample(["Ngươi là ai?", "Thân tử đạo tiêu."]),
} = {}) {
  return [
    "",
    "ĐỊNH DẠNG ĐẦU RA (json) — trả về DUY NHẤT một đối tượng json, không lời dẫn,",
    "không khối ``` , không giải thích. Đối tượng có ĐÚNG MỘT khoá:",
    "",
    '  "translations": mảng chuỗi, mỗi phần tử ứng với MỘT dòng đã đánh số ở đầu',
    "                  vào, theo đúng thứ tự.",
    `                  Phần tử thứ i = ${subject} của dòng số i.`,
    "",
    "Ràng buộc:",
    "- Số phần tử của mảng PHẢI bằng đúng số dòng đã đánh số ở đầu vào, đúng thứ tự.",
    "  Không gộp dòng, không tách dòng, không bỏ dòng nào.",
    "- Mỗi chuỗi chỉ chứa nội dung của dòng đó. KHÔNG chép số thứ tự vào trong chuỗi",
    '  ("Ngươi là ai?", không phải "4. Ngươi là ai?").',
    "- Không thêm bất kỳ khoá nào khác ngoài \"translations\".",
    "",
    "EXAMPLE INPUT:",
    exampleInput,
    "",
    "EXAMPLE JSON OUTPUT:",
    exampleOutput,
  ].join("\n");
}

// Model vẫn có lúc chép số thứ tự vào chuỗi (input trước mắt nó là "1. ..." nên xu
// hướng "giữ nguyên" rất mạnh) — bóc ra trước khi tự đánh số lại, khỏi ra "1. 1. ...".
const LEADING_NUMBER = /^\s*\d+\s*[.、:：)）]\s*/;

/**
 * Bóc mảng `translations` từ content của response.
 *
 * Trả `null` khi không dựng được — bên gọi tự quyết định hạ cấp thế nào (lượt nháp
 * trả "" để translate.js chia đôi thử lại; lượt review/polish giữ nguyên bản vào,
 * xem deepseek-review.js). KHÔNG tự đoán, không tự vá: bản dịch sai lặng lẽ đắt hơn
 * nhiều so với một lượt gọi lại.
 *
 * @param raw     content thô của message.
 * @param tag     tên lượt gọi, chỉ để ghi log khi hỏng.
 * @param expect  số dòng mong đợi; lệch thì coi là hỏng (translate.js cũng sẽ bắt
 *                được ở parsePayload, nhưng bắt ở đây thì log nói đúng nguyên nhân).
 */
export function parseTranslations(raw, tag, expect = null) {
  const text = (raw ?? "").trim();
  if (!text) {
    // Doc DeepSeek ghi nhận JSON Mode thỉnh thoảng trả content rỗng.
    log.warn(`${tag}: response rỗng (JSON Mode của DeepSeek có lỗi này) — sẽ thử lại`);
    return null;
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    log.warn(`${tag}: content không phải JSON hợp lệ dù đã bật JSON Mode — ${err.message}`);
    return null;
  }

  const arr = obj?.translations;
  if (!Array.isArray(arr)) {
    log.warn(`${tag}: JSON hợp lệ nhưng không có mảng "translations" (khoá thấy được: ${Object.keys(obj ?? {}).join(", ") || "không có"})`);
    return null;
  }
  if (expect !== null && arr.length !== expect) {
    log.warn(`${tag}: trả về ${arr.length} phần tử, cần đúng ${expect}`);
    return null;
  }
  return arr.map((line) => String(line ?? ""));
}

/** Dựng lại dạng văn bản đánh số mà translate.js/các lượt sau vẫn đang dùng. */
export function toNumbered(lines) {
  return lines.map((line, i) => `${i + 1}. ${line.replace(LEADING_NUMBER, "").trim()}`).join("\n");
}
