import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { logApiCall, OPENAI_V1 } from "../apiLog.js";
import {
  buildUserPrompt,
  genreRules,
  glossaryFlags,
  LINE_PROTOCOL_RULES,
  speakerRules,
  sttFixRules,
  translateTask,
} from "./openai.js";
import { client, polish } from "./openai-polish.js";

const log = createLogger("TR/openai-2pass");

export const name = "openai-2pass";
export const needsBrowser = false;
export const concurrencySafe = true;
export const supportsSpeakers = true;
// Provider LLM không bị chặn bởi ô nhập của translate.google.com — xem
// `translateMaxCharsLlm` trong config.js.
export const maxChars = config.translateMaxCharsLlm;

/**
 * Dịch 2 lượt (MTPE — Machine Translation Post-Editing), cả 2 lượt đều do OpenAI
 * đảm nhiệm: lượt 1 dịch sát nghĩa (nháp), lượt 2 đưa cả bản gốc lẫn bản nháp cho
 * chính OpenAI biên tập lại cho mượt (xem openai-polish.js).
 *
 * Lý do tách 2 lượt thay vì dịch thẳng như provider `openai`: LLM "sửa bài có sẵn"
 * bám sát nghĩa gốc hơn là "viết lại từ đầu" — ít bịa, ít bỏ sót — và với model rẻ
 * thì polish một bản nháp dễ hơn hẳn tự dịch trọn một đoạn dài mà vẫn mượt.
 *
 * Đã cân nhắc dùng translate.google.com làm nháp thay vì tự OpenAI dịch (rẻ hơn vì
 * lượt nháp miễn phí — xem google-2pass.js) nhưng không chọn làm mặc định: nháp
 * Google hay bị bóp xuống NMT đời cũ không báo trước (xem provider google-web), lúc
 * đó lượt biên tập có xu hướng chỉ "sửa câu chữ" trên nền dịch sai thay vì dịch lại
 * đúng (anchoring bias). Ở đây cả 2 lượt đều do chính OpenAI sinh, không thêm phụ
 * thuộc browser automation / rủi ro captcha, chỉ đổi lấy thêm một lượt gọi API.
 *
 * Không export qualityCanary: không có hiện tượng tụt chất lượng cần phát hiện khi
 * cả 2 lượt đều là OpenAI (khác google-web/google-2pass).
 */
// KHÔNG dump bảng glossary đầy đủ vào đây — xem lý do ở buildSystemPrompt() trong
// openai.js (đo được model chọn nhầm mục trong bảng dù placeholderDict đã đúng).
function buildDraftSystemPrompt({ hasGlossary, hasPlaceholders }) {
  return [
    "Bạn là dịch giả truyện tiên hiệp/huyền huyễn Trung Quốc sang tiếng Việt.",
    "Đây là LƯỢT DỊCH NHÁP — sẽ có một lượt biên tập lại văn phong sau, nên ưu tiên",
    "dịch ĐÚNG VÀ SÁT NGHĨA hơn là chăm chút câu chữ.",
    "",
    translateTask({ hasPlaceholders }),
    "",
    "Quy tắc BẮT BUỘC:",
    sttFixRules({ hasGlossary, hasPlaceholders }),
    genreRules({ hasGlossary, hasPlaceholders }),
    LINE_PROTOCOL_RULES,
  ]
    .filter((part) => part !== null)
    .join("\n");
}

export async function translateText(text, { to, speakerHint, surrounding, glossaryDict, hasPlaceholders }) {
  const flags = glossaryFlags({ glossaryDict, hasPlaceholders });
  const draftSystemPrompt = buildDraftSystemPrompt(flags);
  const openai = client();

  const model = config.translateModel;
  const draftMessages = [
    // Bản đồ người nói phải vào từ lượt NHÁP: xưng hô quyết định ngay khi chọn từ,
    // lượt biên tập sau đó chỉ sửa văn phong chứ không dựng lại quan hệ nhân vật.
    { role: "system", content: [draftSystemPrompt, speakerRules(speakerHint)].filter(Boolean).join("\n") },
    { role: "user", content: buildUserPrompt(text, to, surrounding, glossaryDict, flags.hasPlaceholders) },
  ];

  const draftParams = { model, temperature: 0.2, messages: draftMessages };
  const t0 = Date.now();
  const draftRes = await logApiCall(log, { url: `${OPENAI_V1}/chat/completions`, body: draftParams }, () =>
    openai.chat.completions.create(draftParams),
  );
  const draft = draftRes.choices[0]?.message?.content?.trim() ?? "";
  log.debug(`nháp: ${text.length} → ${draft.length} ký tự (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const polished = await polish(text, draft, { to, speakerHint, glossaryDict, hasPlaceholders: flags.hasPlaceholders });
  log.debug(`${text.length} → nháp ${draft.length} → biên tập ${polished.length} ký tự`);
  return polished;
}
