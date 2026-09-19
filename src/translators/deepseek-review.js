import OpenAI from "openai";

import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { logApiCall } from "../apiLog.js";
import { genreRules, glossaryBlock, glossaryFlags, speakerRules, sttFixRules } from "./openai.js";
import { JSON_RESPONSE_FORMAT, jsonExample, jsonOutputRules, parseTranslations, toNumbered } from "./jsonOutput.js";

const log = createLogger("TR/deepseek-review");

/**
 * Hai lượt hậu kỳ dùng cho `deepseek-2pass`, KHUNG NHIỆM VỤ khác hẳn nhau, cố ý
 * KHÔNG gộp làm một (gộp lại là phải nới guardrail chống-rewrite của lượt audit,
 * mất luôn tác dụng của nó):
 *
 * - `review(text, draft, …)` — AUDIT đúng/sai theo checklist lỗi đã đo thực tế
 *   (video 7670837569118145855). Sửa dòng SAI NGHĨA; dòng đúng thì cấm đụng, kể
 *   cả khi sượng văn. Chốt NGHĨA.
 * - `polish(text, draft, …)` — BIÊN TẬP mạch lạc: coi nghĩa đã đúng (đã qua
 *   `review`), chỉ chữa câu bám cú pháp Hán / liên từ dịch mặt chữ / thành ngữ
 *   sượng / Hán-Việt tự chế. Cấm đổi nghĩa.
 *
 * `deepseek-2pass.js` chạy `review` rồi tới `polish` (xem thứ tự ở đó). Bản thân
 * module này KHÔNG phải provider: không export `name`/`needsBrowser`, không đăng
 * ký trong translators/index.js — cùng quy ước với openai-polish.js.
 *
 * CẢ HAI lượt đều ép JSON Mode và đều mở đầu bằng luật "đầu ra phải là tiếng Việt".
 * Lý do: đo được trên video 7658103101886434560, khi lượt nháp trả về nguyên tiếng
 * Trung thì hai lượt này KHÔNG cứu — chúng chỉ "soát" và "biên tập" tiếp cái tiếng
 * Trung đó (差点憋。/死。 → 差点憋死。), vì prompt cũ mặc định BẢN NHÁP đã là tiếng
 * Việt và không có luật nào nói phải làm gì khi không phải. Giờ mỗi lượt tự bắt
 * được dòng chưa dịch và dịch nốt — hàng rào thứ hai, không thay cho việc sửa lượt
 * nháp ở deepseek-2pass.js.
 */
export function client() {
  if (!config.deepseekApiKey) {
    throw new Error("thiếu DEEPSEEK_API_KEY — thêm vào .env (xem .env.example)");
  }
  return new OpenAI({
    apiKey: config.deepseekApiKey,
    baseURL: config.deepseekBaseUrl,
    maxRetries: config.sttMaxRetries,
    timeout: config.sttTimeoutMs,
  });
}


/** Đánh số các mục checklist; dòng thân của mục (thụt đầu dòng) giữ nguyên. */
function numbered(items) {
  let n = 0;
  return items.map((line) => (line.startsWith("   ") ? line : `${(n += 1)}. ${line}`));
}

// Luật chung cho cả review lẫn polish: bản đưa vào ĐÁNG LẼ đã là tiếng Việt, nhưng
// không được coi đó là điều hiển nhiên.
function stillChineseRule({ hasPlaceholders }) {
  return [
    "TRƯỚC MỌI VIỆC KHÁC: nếu một dòng trong bản đưa vào vẫn còn nguyên tiếng Trung",
    "(lượt dịch trước hỏng), hãy DỊCH dòng đó sang tiếng Việt. Đầu ra không được còn",
    `chữ Hán ở bất kỳ dòng nào${hasPlaceholders ? " — trừ ký hiệu ⟦số⟧" : ""}.`,
  ].join("\n");
}

// Không cần bảng glossary đầy đủ ở đây: bảng của riêng cụm này (glossaryDict) đủ để
// đối chiếu chỗ nào bị trôi khỏi bản ghim, và ở chế độ có bọc thì bước review còn
// không thấy chữ Hán gốc của thuật ngữ, chỉ thấy placeholder ⟦n⟧.
function buildReviewSystemPrompt({ hasGlossary, hasPlaceholders }) {
  const glossaryChecks = hasPlaceholders
    ? [
        "Placeholder ⟦số⟧ bị dịch/mất, HOẶC bị lặp nghĩa hai lần — BẢN NHÁP vừa giữ",
        "   nguyên placeholder vừa tự diễn giải lại ý của thuật ngữ đó ở chỗ khác trong",
        "   cùng câu (VD ⟦6⟧=妖尊 giữ đúng nhưng câu lại thêm 'yêu thú' trùng nghĩa). ĐỐI",
        "   CHIẾU TỪNG dòng placeholderDict với BẢN NHÁP: nếu ⟦số⟧ đã biến mất khỏi BẢN",
        "   NHÁP (viết lại thành văn xuôi), phần thay thế PHẢI đúng y hệt bản dịch đã",
        "   ghim — không phải cách dịch khác nghe hợp lý hơn (VD LỖI THẬT: placeholderDict",
        "   ghi ⟦0⟧ = 三界巅峰妖兽 (yêu thú tam phẩm đỉnh phong), BẢN NHÁP lại viết 'yêu",
        "   thú đỉnh phong tam giới' — tự suy 三界='tam giới' theo nghĩa đen, bỏ qua bản",
        "   ghim; PHẢI sửa lại đúng thành 'yêu thú tam phẩm đỉnh phong').",
        "Chữ Hán rời 镜/境/期 đứng ngay sau placeholder tên cảnh giới bị dịch nghĩa",
        "   đen (gương/cảnh giới) thay vì đúng quy ước 'X Kỳ'.",
      ]
    : hasGlossary
      ? [
          // Không bọc placeholder: cùng lỗi trôi-khỏi-bản-ghim, chỉ đối chiếu theo
          // mặt chữ Hán trong BẢN GỐC thay vì theo chỉ số ⟦n⟧.
          "Cụm có trong bảng thuật ngữ ở đề bài nhưng BẢN NHÁP dịch ra mặt chữ khác —",
          "   ĐỐI CHIẾU TỪNG dòng của bảng đó với BẢN NHÁP, sửa lại đúng bản đã ghim, kể",
          "   cả khi cách dịch của BẢN NHÁP nghe hợp lý hơn (VD LỖI THẬT: bảng ghi",
          "   三界巅峰妖兽 = 'yêu thú tam phẩm đỉnh phong', BẢN NHÁP viết 'yêu thú đỉnh",
          "   phong tam giới' — tự suy 三界='tam giới' theo nghĩa đen, bỏ qua bản ghim).",
          "Chữ Hán rời 镜/境/期 đứng ngay sau tên cảnh giới bị dịch nghĩa đen",
          "   (gương/cảnh giới) thay vì đúng quy ước 'X Kỳ'.",
        ]
      : [
          "Chữ Hán rời 镜/境/期 đứng ngay sau tên cảnh giới bị dịch nghĩa đen",
          "   (gương/cảnh giới) thay vì đúng quy ước 'X Kỳ'.",
        ];

  return [
    "Bạn là người KIỂM DUYỆT bản dịch truyện tiên hiệp/huyền huyễn Trung Quốc sang",
    "tiếng Việt — không phải người dịch lại từ đầu. Nhiệm vụ: so BẢN GỐC (tiếng",
    "Trung) với BẢN NHÁP (tiếng Việt) TỪNG DÒNG, tìm SAI NGHĨA trước, xét văn phong",
    "sau. Sửa lại đúng những dòng có lỗi; DÒNG ĐÃ ĐÚNG THÌ GIỮ NGUYÊN Y HỆT, tuyệt",
    "đối không viết lại chỉ vì lý do văn phong hay để câu 'mượt hơn' — mỗi chỗ sửa",
    "không cần thiết là một rủi ro làm lệch bản đã đúng.",
    "",
    stillChineseRule({ hasPlaceholders }),
    "",
    "Các lớp lỗi thực tế cần rà, theo đúng thứ tự ưu tiên:",
    // Đánh số bằng code: bỏ mục glossary khi không có glossary mà số viết tay thì
    // danh sách nhảy cóc ("1. 2. 4. 5."), model đọc như thể có mục bị giấu đi.
    ...numbered([
      "Từ đồng âm do lỗi nhận dạng giọng nói (ASR) chưa được BẢN NHÁP sửa — đối",
      "   chiếu ngữ cảnh tu tiên để phát hiện (VD: 零食 'đồ ăn vặt' dịch nhầm từ 灵石",
      "   'linh thạch' vì đọc giống hệt nhau).",
      ...glossaryChecks,
      "Đơn vị lớn 万/亿 bị quy đổi sai kiểu phương Tây (nghìn/triệu) thay vì giữ",
      "   Hán Việt (vạn/ức).",
      "Trật tự định ngữ-danh từ còn giữ nguyên kiểu Hán (định ngữ trước danh từ)",
      "   chưa đảo về trật tự tự nhiên tiếng Việt.",
      "Câu dịch trôi chảy nhưng BỊA nghĩa — sai hẳn ý gốc dù đọc mượt.",
      "Ranh giới câu/dòng bị gộp hoặc xẻ sai so với BẢN GỐC.",
      "Công thức văn ngôn / thành ngữ 4 chữ bị dịch NGHĨA ĐEN thành câu vô nghĩa",
      "   trong ngữ cảnh — đối chiếu AI nói, NÓI VỚI AI, ĐANG LÀM GÌ (VD 只此为诏/照",
      "   là công thức cuối tờ trục xuất đồ đệ, nghĩa 'lấy đây làm bằng chứng', KHÔNG",
      "   phải 'chiếu chỉ' — người nói là sư phụ chứ không phải vua; 理当先奉给高僧 =",
      "   'đương nhiên phải dâng cao tăng trước mới phải', KHÔNG phải 'lẽ ra nên' —",
      "   'lẽ ra' trong tiếng Việt hàm ý ĐÃ KHÔNG làm, trái ý gốc).",
    ]),
    "",
    "Quy tắc BẮT BUỘC:",
    "- Không gộp dòng, không tách dòng, không thêm lời bình hay giải thích.",
    hasPlaceholders
      ? "- Mọi ký hiệu dạng ⟦số⟧ trong BẢN NHÁP là placeholder cho thuật ngữ cố định — giữ\n  nguyên y hệt, không dịch, không đổi kiểu ngoặc, không thử đoán nghĩa của nó."
      : null,
    sttFixRules({ hasGlossary, hasPlaceholders }),
    genreRules({ hasGlossary, hasPlaceholders }),
    jsonOutputRules({
      subject: "bản tiếng Việt SAU khi đã kiểm duyệt",
      // Dòng 1 minh hoạ luật "còn tiếng Trung thì dịch"; dòng 2 minh hoạ luật
      // "đã đúng thì giữ nguyên y hệt" — hai luật dễ mâu thuẫn nhất của lượt này.
      exampleInput: [
        "BẢN GỐC (tiếng Trung, đã đánh số):",
        "1. 你是谁？",
        "2. 身死道消。",
        "",
        "BẢN NHÁP (vi, đã đánh số):",
        "1. 你是谁？",
        "2. Thân tử đạo tiêu.",
      ].join("\n"),
      exampleOutput: jsonExample(["Ngươi là ai?", "Thân tử đạo tiêu."]),
    }),
  ]
    .filter((part) => part !== null)
    .join("\n");
}

/**
 * Gọi DeepSeek cho một lượt hậu kỳ, ép JSON Mode.
 *
 * Hỏng thì trả lại NGUYÊN bản đưa vào chứ không trả "" — khác hẳn lượt nháp. Lý do:
 * bản vào đây đã là một bản dịch dùng được, còn "" sẽ bắt translate.js chia đôi cụm
 * và chạy lại CẢ 3 lượt cho từng nửa (3 → 6 lời gọi). Mất một lượt biên tập rẻ hơn
 * nhiều so với dịch lại từ đầu, và log đã ghi rõ lượt nào hỏng.
 */
async function runPass({ tag, systemPrompt, userContent, model, temperature, fallback, expectLines, maxTokens }) {
  const deepseek = client();
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  const params = {
    model,
    ...(temperature === undefined ? {} : { temperature }),
    messages,
    response_format: JSON_RESPONSE_FORMAT,
    max_tokens: maxTokens ?? config.translateMaxTokens,
  };
  const t0 = Date.now();
  const res = await logApiCall(log, { url: `${config.deepseekBaseUrl}/chat/completions`, body: params }, () =>
    deepseek.chat.completions.create(params),
  );

  // Model suy luận (deepseek-v4-pro/-flash, alias deepseek-reasoner) trả kèm
  // `reasoning_content` song song với `content` — chỉ `content` là JSON cần dùng
  // tiếp, `reasoning_content` bỏ qua hẳn, không phải một phần output.
  const choice = res.choices[0];
  const content = choice?.message?.content ?? "";
  const reasoningTokens = res.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

  // Hết quota GIỮA LÚC ĐANG NGHĨ thì content về rỗng, và nhánh fallback bên dưới sẽ
  // âm thầm trả lại bản cũ — nhìn từ ngoài y hệt một lượt review "không tìm thấy lỗi".
  // Phải gọi tên nó ra: đây là lỗi cấu hình trần token, không phải bản dịch đã sạch.
  if (!content.trim() && choice?.finish_reason === "length" && reasoningTokens > 0) {
    log.error(
      `${tag} (model=${model}): HẾT TRẦN TOKEN khi đang suy luận — ${reasoningTokens} token suy ` +
        `luận, chưa kịp viết JSON nào. Lượt này KHÔNG soát được gì. Nâng ` +
        `TRANSLATE_REVIEW_MAX_TOKENS (hiện ${params.max_tokens}) hoặc đổi model.`,
    );
  }

  const lines = parseTranslations(content, tag, expectLines ?? null);
  if (!lines) {
    log.warn(`${tag} (model=${model}) hỏng — giữ nguyên bản đưa vào, không chia lại cụm`);
    return fallback;
  }

  const out = toNumbered(lines);
  // Số dòng THỰC SỰ đổi là thước đo duy nhất nói được lượt này có làm gì không —
  // độ dài ký tự thì một lượt no-op hoàn toàn vẫn in ra hai số bằng nhau trông rất
  // bình thường. Đo được: deepseek-chat ở lượt review đổi 0/22 dòng, hai lần liên tiếp.
  const before = fallback.split("\n");
  const changed = out.split("\n").filter((line, i) => line !== before[i]).length;
  log.debug(
    `${tag} (model=${model}): ${fallback.length} → ${out.length} ký tự, đổi ${changed}/${lines.length} dòng` +
      `${reasoningTokens ? `, ${reasoningTokens} token suy luận` : ""} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );
  if (changed === 0) log.warn(`${tag} (model=${model}) không đổi dòng nào — lượt này không đóng góp gì`);
  return out;
}

/**
 * @param text     bản gốc (đã đánh số; đã bọc placeholder nếu chạy chế độ có bọc).
 * @param draft    bản dịch cần audit — đầu ra của lượt trước (nháp, hoặc review
 *                 trước đó nếu gọi nối tiếp nhiều lần với model khác nhau).
 * @param model    model DeepSeek dùng cho lượt review này — cùng hàm này được gọi
 *                 2 lần với 2 model khác nhau trong deepseek-2pass.js (chat rồi
 *                 reasoner), model càng "nặng" thì càng chỉ cần rà nốt lỗi tinh vi
 *                 vì bản đưa vào đã qua ít nhất 1 lượt sửa trước đó.
 */
export async function review(text, draft, { to, speakerHint, glossaryDict, hasPlaceholders, model, expectLines }) {
  const flags = glossaryFlags({ glossaryDict, hasPlaceholders });
  return runPass({
    tag: "review",
    systemPrompt: [buildReviewSystemPrompt(flags), speakerRules(speakerHint)].filter(Boolean).join("\n"),
    userContent: [
      `BẢN GỐC (tiếng Trung, đã đánh số):\n${text}`,
      `BẢN NHÁP (${to}, đã đánh số):\n${draft}`,
      glossaryBlock(glossaryDict, { hasPlaceholders: flags.hasPlaceholders, subject: "BẢN GỐC" }),
      `Kiểm duyệt BẢN NHÁP theo đúng checklist trên, đối chiếu BẢN GỐC. Trả về json ${to}.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    model,
    fallback: draft,
    expectLines,
    // Trần riêng, rộng hơn hẳn: model mặc định của lượt này là model SUY LUẬN và
    // token suy luận ăn chung hạn ngạch completion — xem translateReviewMaxTokens.
    maxTokens: config.translateReviewMaxTokens,
  });
}

// Lượt BIÊN TẬP mạch lạc — chạy SAU `review` nên coi nghĩa đã đúng. Khác
// `review` ở chỗ được phép (và phải) viết lại dòng đúng-nghĩa-nhưng-sượng; khác
// `openai-polish.js`'s `polish()` ở chỗ checklist nhắm đúng lỗi văn phong đã đo
// thật trên bản deepseek-2pass (video 7673825419585408302): câu bám cú pháp Hán
// (động từ treo cuối câu), 也/理当 dịch mặt chữ làm đứt logic, 斋饭→"chay phạn"
// (Hán-Việt tự chế), 花儿咒语→"chú hoa" (mơ hồ với độc giả).
function buildPolishSystemPrompt({ hasGlossary, hasPlaceholders }) {
  return [
    "Bạn là BIÊN TẬP VIÊN tiếng Việt cho phim/truyện tiên hiệp - huyền huyễn Trung",
    "Quốc. Bản đưa cho bạn ĐÃ QUA một lượt soát sai nghĩa — coi NGHĨA đã đúng. Việc",
    "của bạn KHÔNG phải dịch lại hay bắt lỗi nghĩa, mà là đọc CẢ ĐOẠN như một mạch",
    "hội thoại liền và chữa cho câu tiếng Việt tự nhiên, mạch lạc.",
    "",
    stillChineseRule({ hasPlaceholders }),
    "",
    "Chữa các chỗ sau — CHỈ khi thật sự vướng; dòng đã trôi chảy thì GIỮ NGUYÊN Y HỆT:",
    "1. Câu bám cú pháp tiếng Hán: động từ/bổ ngữ treo ở cuối câu, định ngữ đứng",
    "   trước danh từ, 'của' thừa do dịch 的 — đảo về trật tự tự nhiên tiếng Việt.",
    "2. Liên từ / hư từ dịch mặt chữ làm đứt logic đoạn: 也 thường là 'đến cả... còn/",
    "   nói gì...', 却 = 'vậy mà', 便 = 'liền'. Thêm hoặc đổi liên từ cho ý nối được.",
    "3. Thành ngữ, công thức văn ngôn, sáo ngữ cổ trang dịch nghĩa đen nghe sượng —",
    "   thay bằng cách nói cổ trang tương đương mà độc giả Việt hiểu ngay.",
    "4. Từ Hán-Việt tự chế / hiếm làm người đọc khựng (VD 'chay phạn' → 'cơm chay').",
    "   Ưu tiên Hán-Việt QUEN THUỘC hoặc thuần Việt hợp không khí truyện.",
    "5. Xưng hô lệch vai, hoặc đổi qua đổi lại giữa các dòng trong cùng một cảnh.",
    "6. Đại từ / cách gọi mơ hồ ('người này', 'cái chú hoa đó') — làm rõ theo ngữ",
    "   cảnh khi bản gốc đã đủ rõ để suy ra.",
    "",
    "TUYỆT ĐỐI KHÔNG:",
    "- Đổi nghĩa, thêm/bớt thông tin so với BẢN GỐC. Nếu nghi một dòng SAI NGHĨA (chứ",
    "  không phải sượng văn), để NGUYÊN dòng đó — đừng tự sửa.",
    "- Gộp dòng, tách dòng. Vào bao nhiêu dòng ra đúng bấy nhiêu.",
    hasPlaceholders ? "- Đụng vào ký hiệu ⟦số⟧: giữ y hệt, không dịch, không đoán nghĩa." : null,
    "- 'Nống' văn lên hoa mỹ. Bản gốc là khẩu ngữ thì giữ khẩu ngữ.",
    "- Thêm lời bình hay giải thích.",
    "",
    // PHẢI có tiêu đề riêng: gắn thẳng vào sau danh sách "TUYỆT ĐỐI KHÔNG" thì cả
    // khối quy tắc bị đọc thành điều cấm (lỗi có trong bản cũ, bắt được khi soát log).
    "Quy tắc BẮT BUỘC:",
    sttFixRules({ hasGlossary, hasPlaceholders }),
    genreRules({ hasGlossary, hasPlaceholders }),
    jsonOutputRules({
      subject: "bản tiếng Việt SAU khi đã biên tập",
      // Dòng 1 đã trôi chảy → giữ nguyên y hệt; dòng 2 dùng đúng lỗi văn ngôn đã đo
      // ở checklist ('lẽ ra' hàm ý ĐÃ KHÔNG làm, trái ý gốc) → chữa.
      exampleInput: [
        "BẢN GỐC (tiếng Trung, đã đánh số):",
        "1. 你是谁？",
        "2. 理当先奉给高僧。",
        "",
        "BẢN DỊCH ĐÃ SOÁT NGHĨA (vi, đã đánh số):",
        "1. Ngươi là ai?",
        "2. Lẽ ra nên dâng cho cao tăng trước.",
      ].join("\n"),
      exampleOutput: jsonExample(["Ngươi là ai?", "Đương nhiên phải dâng cao tăng trước mới phải."]),
    }),
  ]
    .filter((part) => part !== null)
    .join("\n");
}

/**
 * @param text   bản gốc (đã đánh số; đã bọc placeholder nếu chạy chế độ có bọc).
 * @param draft  bản đã qua `review` — nghĩa coi như đã đúng, chỉ chữa văn phong.
 * @param model  model DeepSeek cho lượt này (xem deepseek-2pass.js).
 */
export async function polish(text, draft, { to, speakerHint, glossaryDict, hasPlaceholders, model, expectLines }) {
  const flags = glossaryFlags({ glossaryDict, hasPlaceholders });
  return runPass({
    tag: "polish",
    systemPrompt: [buildPolishSystemPrompt(flags), speakerRules(speakerHint)].filter(Boolean).join("\n"),
    userContent: [
      `BẢN GỐC (tiếng Trung, đã đánh số):\n${text}`,
      `BẢN DỊCH ĐÃ SOÁT NGHĨA (${to}, đã đánh số):\n${draft}`,
      glossaryBlock(glossaryDict, { hasPlaceholders: flags.hasPlaceholders, subject: "BẢN GỐC" }),
      `Biên tập lại cho mạch lạc theo checklist trên, giữ nguyên nghĩa và số dòng. Trả về json ${to}.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    model,
    temperature: 0.4,
    fallback: draft,
    expectLines,
  });
}
