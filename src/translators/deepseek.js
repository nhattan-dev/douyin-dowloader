import { config } from "../config.js";
import { createChatTranslator } from "./chat.js";

/**
 * DeepSeek — API tương thích OpenAI, endpoint đặt ở TQ.
 *
 * Lý do thêm vào: nội dung là truyện tiên hiệp tiếng Trung, và model TQ nắm thuật
 * ngữ 玄幻 tốt hơn hẳn. Rẻ hơn nhiều lần gpt-4o-mini, nhưng ở quy mô này (~57k ký tự
 * cho 122 video, tổng ~$0.03) tiền không phải lý do — đường mạng mới là: đo từ VN
 * thấy api.deepseek.com bắt tay TLS trong 0.33s, còn api.openai.com thì chập chờn
 * (xem ghi chú HTTPS_PROXY trong .env.example).
 *
 * RỦI RO đã biết: điểm yếu không nằm ở phần hiểu tiếng Trung mà ở phần VIẾT tiếng
 * Việt. Lỗi từng gặp là model bí thì quay ra phiên âm Hán-Việt (此物若是运作得当 →
 * "Tử vật nhược thị vận tác đắc đương") — model thạo tiếng Trung mà yếu tiếng Việt
 * dễ rơi vào đó hơn chứ không phải ít hơn. Đo bằng `npm run translate-compare`
 * trước khi đổi TRANSLATE_PROVIDER, đừng đổi theo cảm tính.
 */
export const name = "deepseek";
export const needsBrowser = false;
export const concurrencySafe = true;
export const supportsSpeakers = true;
// Provider LLM không bị chặn bởi ô nhập của translate.google.com — xem
// `translateMaxCharsLlm` trong config.js.
export const maxChars = config.translateMaxCharsLlm;

export const translateText = createChatTranslator({
  name,
  baseURL: config.deepseekBaseUrl,
  apiKey: config.deepseekApiKey,
  model: config.deepseekModel,
  keyHint: "DEEPSEEK_API_KEY",
  // DeepSeek có JSON Mode chính thức (api-docs.deepseek.com/guides/json_mode) —
  // xem jsonOutput.js để biết vì sao bước dịch cần nó.
  json: true,
});
