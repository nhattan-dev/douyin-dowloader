import OpenAI from "openai";

import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { logApiCall, OPENAI_V1 } from "../apiLog.js";
import {
  genreRules,
  glossaryBlock,
  glossaryFlags,
  LINE_PROTOCOL_RULES,
  speakerRules,
  sttFixRules,
  translateTask,
} from "./openai.js";

const log = createLogger("TR/polish");

/**
 * Lượt gọi OpenAI dùng chung cho các provider dịch 2 lượt. Có 2 kiểu, dùng cho 2
 * tình huống khác nhau:
 *
 * - `polish(text, draft, opts)` — SỬA bản nháp có sẵn, giữ nguyên alignment theo
 *   dòng. Dùng khi bản nháp đáng tin về cấu trúc (cùng do OpenAI dịch ra theo đúng
 *   số dòng yêu cầu) — xem openai-2pass.js.
 * - `translateWithReference(text, reference, opts)` — TỰ dịch bản gốc, bản tham
 *   khảo chỉ để tham chiếu, không bắt buộc bám theo. Dùng khi bản tham khảo không
 *   có alignment theo dòng (dịch nguyên đoạn văn xuôi) — xem google-2pass.js.
 *
 * Bản thân module này KHÔNG phải provider: không export `name`/`needsBrowser`,
 * không đăng ký trong translators/index.js.
 */
export function client() {
  if (!config.openaiApiKey) {
    throw new Error("thiếu OPENAI_API_KEY — thêm vào .env (xem .env.example)");
  }
  return new OpenAI({
    apiKey: config.openaiApiKey,
    maxRetries: config.sttMaxRetries,
    timeout: config.sttTimeoutMs,
  });
}

// Không dump bảng glossary đầy đủ ở đây: bảng của riêng cụm này (glossaryDict) đủ
// để đối chiếu, và ở chế độ có bọc thì bước biên tập còn không thấy chữ Hán gốc của
// thuật ngữ, chỉ thấy placeholder ⟦n⟧ — ràng buộc thuật ngữ đã chốt từ lượt nháp.
function buildPolishSystemPrompt({ hasGlossary, hasPlaceholders }) {
  return [
    "Bạn là biên tập viên văn học tiếng Việt, chuyên truyện tiên hiệp/huyền huyễn mạng.",
    "Nhiệm vụ: viết lại BẢN NHÁP cho mượt mà, đúng văn phong lời kể truyện mạng, dùng",
    "từ Hán-Việt quen thuộc với độc giả Việt — nhưng TUYỆT ĐỐI không được thêm, bớt,",
    "hay làm lệch ý so với BẢN GỐC. Nếu BẢN NHÁP dịch sai/thiếu so với BẢN GỐC, hãy",
    "sửa lại cho đúng nghĩa trước khi viết mượt.",
    "",
    // Bản nháp ĐÁNG LẼ đã là tiếng Việt — nhưng đã đo được trường hợp lượt nháp trả
    // về nguyên tiếng Trung (xem deepseek-review.js), và lượt biên tập không có luật
    // nào để bắt lỗi đó thì chỉ biên tập tiếp bản tiếng Trung.
    "TRƯỚC MỌI VIỆC KHÁC: dòng nào trong BẢN NHÁP còn nguyên tiếng Trung (lượt dịch",
    "trước hỏng) thì DỊCH dòng đó sang tiếng Việt. Đầu ra không được còn chữ Hán ở",
    `bất kỳ dòng nào${hasPlaceholders ? " — trừ ký hiệu ⟦số⟧" : ""}.`,
    "",
    "Quy tắc BẮT BUỘC:",
    "- Chỉ trả về đúng các dòng đã đánh số, không thêm lời bình, không giải thích.",
    hasPlaceholders
      ? "- Mọi ký hiệu dạng ⟦số⟧ trong BẢN NHÁP là placeholder cho thuật ngữ cố định — giữ\n  nguyên y hệt, không dịch, không đổi kiểu ngoặc, không thử đoán nghĩa của nó."
      : null,
    LINE_PROTOCOL_RULES,
    sttFixRules({ hasGlossary, hasPlaceholders }),
    genreRules({ hasGlossary, hasPlaceholders }),
  ]
    .filter((part) => part !== null)
    .join("\n");
}

/**
 * @param text   bản gốc (đã đánh số; đã bọc placeholder nếu chạy chế độ có bọc).
 * @param draft  bản dịch thô tương ứng — nguồn gốc tuỳ provider gọi vào đây.
 */
export async function polish(text, draft, { to, speakerHint, glossaryDict, hasPlaceholders }) {
  const openai = client();
  const flags = glossaryFlags({ glossaryDict, hasPlaceholders });
  const model = config.translatePolishModel || config.translateModel;

  const messages = [
    {
      role: "system",
      content: [buildPolishSystemPrompt(flags), speakerRules(speakerHint)]
        .filter(Boolean)
        .join("\n"),
    },
    {
      role: "user",
      content: [
        `BẢN GỐC (tiếng Trung, đã đánh số):\n${text}`,
        `BẢN NHÁP (${to}, dịch thô, đã đánh số):\n${draft}`,
        glossaryBlock(glossaryDict, { hasPlaceholders: flags.hasPlaceholders, subject: "BẢN GỐC" }),
        "Biên tập lại BẢN NHÁP cho mượt, đối chiếu BẢN GỐC nếu nghi ngờ sai nghĩa.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];

  const params = { model, temperature: 0.5, messages };
  const t0 = Date.now();
  const res = await logApiCall(log, { url: `${OPENAI_V1}/chat/completions`, body: params }, () =>
    openai.chat.completions.create(params),
  );

  const out = res.choices[0]?.message?.content?.trim() ?? "";
  log.debug(`biên tập (model=${model}): ${draft.length} → ${out.length} ký tự (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return out;
}

// Khác POLISH_SYSTEM_PROMPT: ở đây model KHÔNG sửa bài có sẵn theo từng dòng — nó tự
// dịch BẢN GỐC (vẫn đánh số, phải giữ đúng số dòng), bản tham khảo chỉ để tham chiếu
// nghĩa/văn phong khi hữu ích, được phép bỏ qua toàn bộ nếu thấy sai. Điều này né
// được anchoring bias của "sửa bài": model không bị ép bám câu chữ của một bản tham
// khảo không theo dòng (không thể "sửa" thứ không khớp cấu trúc với output cần ra).
function buildReferenceSystemPrompt({ hasGlossary, hasPlaceholders }) {
  return [
    "Bạn là dịch giả truyện tiên hiệp/huyền huyễn Trung Quốc sang tiếng Việt.",
    "Bạn nhận BẢN GỐC đã đánh số, và một BẢN THAM KHẢO — bản dịch máy của TOÀN BỘ đoạn,",
    "KHÔNG chia theo dòng, có thể sai hoặc lệch nghĩa ở đôi chỗ. Dùng BẢN THAM KHẢO để",
    "tham chiếu nghĩa/thuật ngữ/văn phong khi thấy hợp lý — không bắt buộc phải bám",
    "theo nó, và được phép bỏ qua hoàn toàn nếu thấy sai.",
    "",
    translateTask({ hasPlaceholders }),
    "",
    "Quy tắc BẮT BUỘC:",
    "- Dịch đúng BẢN GỐC, đúng số dòng như BẢN GỐC.",
    LINE_PROTOCOL_RULES,
    sttFixRules({ hasGlossary, hasPlaceholders }),
    genreRules({ hasGlossary, hasPlaceholders }),
  ]
    .filter((part) => part !== null)
    .join("\n");
}

/**
 * @param text       bản gốc (đã đánh số; đã bọc placeholder nếu chạy chế độ có bọc).
 * @param reference  bản dịch tham khảo của TOÀN đoạn, KHÔNG theo dòng — xem
 *                   google-2pass.js (gửi nguyên văn không numbering cho Google, vì
 *                   Google dịch cả câu/đoạn tự nhiên mượt hơn hẳn dịch kiểu liệt kê
 *                   từng dòng đánh số).
 */
export async function translateWithReference(text, reference, { to, speakerHint, glossaryDict, hasPlaceholders }) {
  const openai = client();
  const flags = glossaryFlags({ glossaryDict, hasPlaceholders });
  const model = config.translatePolishModel || config.translateModel;

  const messages = [
    {
      role: "system",
      content: [buildReferenceSystemPrompt(flags), speakerRules(speakerHint)]
        .filter(Boolean)
        .join("\n"),
    },
    {
      role: "user",
      content: [
        `BẢN GỐC (tiếng Trung, đã đánh số):\n${text}`,
        `BẢN THAM KHẢO (${to}, dịch máy nguyên đoạn, không theo dòng):\n${reference}`,
        glossaryBlock(glossaryDict, { hasPlaceholders: flags.hasPlaceholders, subject: "BẢN GỐC" }),
        `Dịch BẢN GỐC sang ${to}, đúng số dòng, có thể tham khảo BẢN THAM KHẢO.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];

  const params = { model, temperature: 0.4, messages };
  const t0 = Date.now();
  const res = await logApiCall(log, { url: `${OPENAI_V1}/chat/completions`, body: params }, () =>
    openai.chat.completions.create(params),
  );

  const out = res.choices[0]?.message?.content?.trim() ?? "";
  log.debug(`tham khảo (model=${model}): ref ${reference.length} → ${out.length} ký tự (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return out;
}
