import { createLogger } from "../logger.js";
import { translateWithReference } from "./openai-polish.js";
import { translateText as googleDraft } from "./google-web.js";

const log = createLogger("TR/google-2pass");

export const name = "google-2pass";
export const needsBrowser = true; // mượn browser context của google-web cho lượt tham khảo
export const concurrencySafe = false; // kế thừa rủi ro captcha của google-web
// Lượt dịch chính do OpenAI làm, nên nhãn người nói vẫn dùng được — chỉ lượt tham
// khảo của Google là không (nó không nhận chỉ dẫn).
export const supportsSpeakers = true;
// KHÔNG nâng trần: lượt tham khảo vẫn đi qua ô nhập của translate.google.com.
// google-web.js và google-free.js cũng vậy — giữ mặc định TRANSLATE_MAX_CHARS.

// Bóc số thứ tự "N. " ở đầu mỗi dòng, ghép lại thành 1 khối văn xuôi liền mạch —
// đúng định dạng translation.txt (`translations.join(" ")`), KHÔNG phải payload đã
// đánh số như translate.js xây cho các provider khác.
//
// Lý do: gửi nguyên payload dạng "1. dòng một\n2. dòng hai\n..." cho Google khiến nó
// dịch kiểu liệt kê rời rạc từng dòng, mất mạch văn — Google dịch cả đoạn văn xuôi
// tự nhiên mượt hơn hẳn. Numbering chỉ thật sự cần ở bước cuối, nơi OpenAI phải trả
// về đúng số dòng để translate.js còn tách lại theo segment/timestamp; Google ở đây
// chỉ đóng vai "bản tham khảo" cho toàn đoạn, không cần giữ alignment theo dòng.
const NUMBERED_PREFIX = /^\s*\d+\s*[.、:：)）]\s*/;
function stripNumbering(payload) {
  return payload
    .split("\n")
    .map((line) => line.replace(NUMBERED_PREFIX, "").trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Hướng A: translate.google.com dịch tham khảo (miễn phí) rồi OpenAI dịch chính
 * BẢN GỐC theo đúng số dòng, có tham chiếu bản dịch đó. Thử và thấy KHÔNG đạt để
 * dùng làm mặc định — giữ lại provider này chỉ để so sánh qua
 * `npm run translate-compare`, KHÔNG đặt làm TRANSLATE_PROVIDER cho việc dịch thật
 * (xem openai-2pass.js — hướng đang dùng, không phụ thuộc google-web).
 *
 * Khác thiết kế ban đầu (Google dịch nháp ĐÃ đánh số rồi OpenAI "sửa bài" theo từng
 * dòng): ở đây Google chỉ dịch một khối văn xuôi KHÔNG đánh số, và OpenAI luôn tự
 * dịch lại BẢN GỐC từ đầu — bản tham khảo chỉ để tham chiếu, được phép bỏ qua nếu
 * sai (xem translateWithReference trong openai-polish.js). Việc này giảm bớt
 * anchoring bias (OpenAI không còn bị ép "sửa câu chữ" trên một cấu trúc dòng đã cố
 * định sẵn từ Google) nhưng KHÔNG loại bỏ hẳn: nếu bản tham khảo tệ, OpenAI vẫn có
 * thể bị nó dắt sai nghĩa ở những chỗ mơ hồ.
 *
 * Vẫn cố tình KHÔNG export qualityCanary: câu mồi phát hiện Google tụt model (xem
 * google-web.js) chỉ đáng tin khi đọc được bản dịch TRẦN của riêng nó theo đúng
 * dòng — ở đây Google dịch cả khối văn xuôi gộp chung câu mồi lẫn nội dung thật nên
 * không tách được câu mồi ra để soi, và output cuối cùng dù sao cũng do OpenAI tự
 * dịch lại (không phải Google), nên marker có bật lên cũng không phản ánh đúng chất
 * lượng bản tham khảo đã dùng.
 */
export async function translateText(text, opts) {
  const raw = stripNumbering(text);
  const reference = await googleDraft(raw, { context: opts.context });
  const out = await translateWithReference(text, reference, {
    to: opts.to,
    speakerHint: opts.speakerHint,
    glossaryDict: opts.glossaryDict,
    hasPlaceholders: opts.hasPlaceholders,
  });
  log.debug(`Google tham khảo ${reference.length} ký tự → OpenAI dịch chính ${out.length} ký tự`);
  return out;
}
