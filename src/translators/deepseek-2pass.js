import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { logApiCall } from "../apiLog.js";
import {
  buildUserPrompt,
  genreRules,
  glossaryFlags,
  speakerRules,
  sttFixRules,
  translateTask,
} from "./openai.js";
import { JSON_RESPONSE_FORMAT, jsonOutputRules, parseTranslations, toNumbered } from "./jsonOutput.js";
import { client, polish, review } from "./deepseek-review.js";

const log = createLogger("TR/deepseek-2pass");

export const name = "deepseek-2pass";
export const needsBrowser = false;
export const concurrencySafe = true;
export const supportsSpeakers = true;
// Provider LLM không bị chặn bởi ô nhập của translate.google.com — xem
// `translateMaxCharsLlm` trong config.js.
export const maxChars = config.translateMaxCharsLlm;

/**
 * Dịch 3 lượt, CẢ 3 đều DeepSeek:
 *   1. Nháp     — `config.deepseekModel` (mặc định alias deepseek-chat, KHÔNG suy
 *      luận, ~3s/cụm). Ưu tiên đúng/sát nghĩa, nhanh và rẻ.
 *   2. Review   — `config.translateReviewModel` (mặc định deepseek-v4-pro, CÓ suy
 *      luận). Đối chiếu BẢN GỐC, sửa dòng SAI NGHĨA theo checklist lỗi thật (xem
 *      deepseek-review.js). Chốt nghĩa; cấm rewrite dòng đã đúng.
 *      Đây là lượt DUY NHẤT dùng model suy luận, và là chủ ý: đo trên cùng một bản
 *      nháp cố định (video 7658103101886434560, 22 dòng, 4 lỗi nghĩa soát tay),
 *      deepseek-chat đổi 1/22 dòng và sửa đúng 1/4 ca, còn deepseek-v4-pro đổi 6/22
 *      và sửa đúng 3/4 — kể cả ca 面修 (lỗi ASR của 面首 "nam sủng") mà mọi model
 *      không suy luận đều bó tay. Giá: 377s và ~21.700 token suy luận cho 22 dòng.
 *   3. Polish   — model đọc từ `config.deepseekReviewModel` (mặc định deepseek-
 *      chat). Coi nghĩa đã đúng, đọc CẢ ĐOẠN như một mạch và chữa văn phong:
 *      câu bám cú pháp Hán, liên từ dịch mặt chữ, thành ngữ sượng, Hán-Việt tự
 *      chế. Đây là lượt DUY NHẤT được phép viết lại dòng đúng-nghĩa — tách hẳn
 *      khỏi lượt review để guardrail chống-rewrite của review không bị nới.
 *      (Trước đây lượt 3 là "review lần 2"; đo thật thấy audit lặp gần như không
 *      đổi gì so với review#1, đổi vai sang biên tập mạch lạc thì có giá trị.)
 *
 * Khác `openai-2pass`/`google-2pass` ở chỗ KHÔNG mượn OpenAI cho bất kỳ lượt
 * nào — toàn bộ pipeline rẻ, tận dụng giá DeepSeek thấp để bù lại việc chạy
 * nhiều lượt thay vì 1 lượt "vừa đủ tốt" như provider `deepseek` (1 lượt).
 *
 * Không export qualityCanary: DeepSeek không có hiện tượng tụt model theo tần
 * suất như google-web.
 *
 * CẢ 3 lượt ép JSON Mode của DeepSeek. Vì sao — xem jsonOutput.js: giao thức
 * đánh số cũ cho phép model trả lại nguyên tiếng Trung mà vẫn "đúng định dạng",
 * và nó đã làm đúng thế (video 7658103101886434560, cả 3 lượt).
 */
// KHÔNG dump bảng glossary đầy đủ vào đây — xem lý do ở buildSystemPrompt() trong
// openai.js (đo được model chọn nhầm mục trong bảng dù placeholderDict đã đúng).
//
// Thứ tự khối là có chủ ý: VAI → NHIỆM VỤ → quy tắc → định dạng. Bản cũ mở bằng
// vai diễn rồi đổ thẳng ~40 dòng quy tắc, không có chỗ nào phát biểu nhiệm vụ như
// một mệnh lệnh — xem translateTask() trong openai.js để biết hậu quả đo được.
function buildDraftSystemPrompt({ hasGlossary, hasPlaceholders }) {
  return [
    "Bạn là dịch giả truyện tiên hiệp/huyền huyễn Trung Quốc sang tiếng Việt.",
    "Đây là LƯỢT DỊCH NHÁP — sẽ có 2 lượt kiểm duyệt lại sau, nên ưu tiên dịch",
    "ĐÚNG VÀ SÁT NGHĨA hơn là chăm chút câu chữ.",
    "",
    translateTask({ hasPlaceholders }),
    "",
    "Quy tắc BẮT BUỘC:",
    sttFixRules({ hasGlossary, hasPlaceholders }),
    genreRules({ hasGlossary, hasPlaceholders }),
    jsonOutputRules(),
  ].join("\n");
}

export async function translateText(text, { to, speakerHint, surrounding, glossaryDict, hasPlaceholders, expectLines }) {
  const deepseek = client();
  const flags = glossaryFlags({ glossaryDict, hasPlaceholders });
  // Cả 3 lượt phải thấy CÙNG bảng thuật ngữ và cùng cơ chế — lượt sau soát lại đúng
  // cái bản ghim mà lượt trước đã nhận.
  const opts = { to, speakerHint, surrounding, glossaryDict, hasPlaceholders: flags.hasPlaceholders, expectLines };

  // Lượt 1 — nháp, deepseek-chat.
  const draftMessages = [
    {
      role: "system",
      content: [buildDraftSystemPrompt(flags), speakerRules(speakerHint)]
        .filter(Boolean)
        .join("\n"),
    },
    { role: "user", content: buildUserPrompt(text, to, surrounding, glossaryDict, flags.hasPlaceholders) },
  ];
  const draftParams = {
    model: config.deepseekModel,
    temperature: 0.2,
    messages: draftMessages,
    response_format: JSON_RESPONSE_FORMAT,
    max_tokens: config.translateMaxTokens,
  };
  const t0 = Date.now();
  const draftRes = await logApiCall(
    log,
    { url: `${config.deepseekBaseUrl}/chat/completions`, body: draftParams },
    () => deepseek.chat.completions.create(draftParams),
  );

  const draftLines = parseTranslations(draftRes.choices[0]?.message?.content, "nháp", expectLines ?? null);
  // Nháp hỏng thì DỪNG luôn, trả "" — translate.js chia đôi cụm rồi chạy lại. Chạy
  // tiếp review/polish trên một bản nháp rỗng chỉ tốn thêm 2 lời gọi cho không gì cả.
  if (!draftLines) {
    log.warn("lượt nháp không dựng được JSON — bỏ qua review/polish, để translate.js chia cụm thử lại");
    return "";
  }
  const draft = toNumbered(draftLines);
  log.debug(`nháp: ${text.length} → ${draft.length} ký tự (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // Lượt 2 — review: soát và chốt NGHĨA (cấm rewrite dòng đã đúng). Model đọc từ
  // `config.translateReviewModel`, KHÔNG dùng chung với lượt nháp nữa: đo được lượt
  // nháp và lượt review chạy cùng `deepseek-chat` thì lượt review đổi 0/22 dòng —
  // model không suy luận không tự bắt được lỗi đồng âm ASR mà chính nó vừa tạo ra.
  const t1 = Date.now();
  const reviewed = await review(text, draft, { ...opts, model: config.translateReviewModel });
  log.debug(`review (${config.translateReviewModel}): ${draft.length} → ${reviewed.length} ký tự (${((Date.now() - t1) / 1000).toFixed(1)}s)`);

  // Lượt 3 — polish: đọc cả đoạn như một mạch, chữa văn phong trên bản đã đúng nghĩa.
  const t2 = Date.now();
  const polished = await polish(text, reviewed, { ...opts, model: config.deepseekReviewModel });
  log.debug(
    `polish (${config.deepseekReviewModel}): ${reviewed.length} → ${polished.length} ký tự (${((Date.now() - t2) / 1000).toFixed(1)}s)`,
  );

  log.debug(`${text.length} → nháp ${draft.length} → review ${reviewed.length} → polish ${polished.length} ký tự`);
  return polished;
}
