import { config } from "../config.js";
import { createChatTranslator } from "./chat.js";

/**
 * Qwen (通义千问) của Alibaba, gọi qua compatible-mode của DashScope.
 *
 * Khác DeepSeek ở chỗ Qwen được huấn luyện nhiều với tiếng Việt hơn, nên là ứng viên
 * đáng tin hơn cho chiều zh→vi — nhưng vẫn phải đo, xem ghi chú rủi ro ở deepseek.js.
 *
 * Chọn endpoint theo nơi mở tài khoản, hai bên KHÔNG dùng chung API key:
 *   dashscope-intl.aliyuncs.com — bản quốc tế (Singapore), đăng ký bằng thẻ nước ngoài
 *   dashscope.aliyuncs.com      — bản nội địa (Bắc Kinh), thường đòi thực danh TQ
 * Đo từ VN: bản quốc tế 0.31s, bản nội địa 1.55s.
 */
export const name = "qwen";
export const needsBrowser = false;
export const concurrencySafe = true;
export const supportsSpeakers = true;
// Provider LLM không bị chặn bởi ô nhập của translate.google.com — xem
// `translateMaxCharsLlm` trong config.js.
export const maxChars = config.translateMaxCharsLlm;

export const translateText = createChatTranslator({
  name,
  baseURL: config.qwenBaseUrl,
  apiKey: config.dashscopeApiKey,
  model: config.qwenModel,
  keyHint: "DASHSCOPE_API_KEY",
});
