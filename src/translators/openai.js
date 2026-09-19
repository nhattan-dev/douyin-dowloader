import OpenAI from "openai";

import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { logApiCall, OPENAI_V1 } from "../apiLog.js";
import { parseTranslations, toNumbered } from "./jsonOutput.js";

const log = createLogger("TR/openai");

export const name = "openai";
export const needsBrowser = false;
export const concurrencySafe = true;
export const supportsSpeakers = true;
// Provider LLM không bị chặn bởi ô nhập của translate.google.com — xem
// `translateMaxCharsLlm` trong config.js.
export const maxChars = config.translateMaxCharsLlm;

/**
 * Dịch bằng LLM.
 *
 * Khác biệt so với google-web: chất lượng ổn định, không bị hạ model theo tần suất
 * (google-web tụt xuống NMT đời cũ khi dùng nhiều). Đổi lại tốn tiền — nhưng với
 * ~57k ký tự cho 122 video thì gpt-4o-mini chỉ khoảng $0.03.
 *
 * Lợi thế riêng: dặn được model tự đoán lại chữ đồng âm mà STT nghe nhầm. Transcript
 * có 下瓶宝剑 (đáng lẽ 下品宝剑) và 当饶料 (đáng lẽ 当燃料) — Google chỉ dịch được cái
 * nó thấy, còn LLM biết đó là lỗi nghe và sửa được.
 */
function client() {
  if (!config.openaiApiKey) {
    throw new Error("thiếu OPENAI_API_KEY — thêm vào .env (xem .env.example)");
  }
  return new OpenAI({
    apiKey: config.openaiApiKey,
    maxRetries: config.sttMaxRetries,
    timeout: config.sttTimeoutMs,
  });
}

/**
 * Câu chốt nhiệm vụ, đặt NGAY ĐẦU mọi system prompt sinh bản tiếng Việt.
 *
 * ĐÃ ĐO vì sao cần (video 7658103101886434560, 43 dòng, deepseek-chat): system
 * prompt cũ mở bằng "Bạn là dịch giả ... sang tiếng Việt." rồi đổ liền ~40 dòng quy
 * tắc, còn động từ "Dịch sang vi" nằm lẻ loi ở đầu user message, ngay trên 43 dòng
 * tiếng Trung. Model bỏ hẳn việc dịch và quay ra BIÊN TẬP bản tiếng Trung
 * (差点憋。/死。 → 差点憋死。), cả 3 lượt của deepseek-2pass đều thế. Không phải lỗi
 * context window: cụm chỉ 1180 ký tự, xa mọi trần.
 *
 * Nên nhiệm vụ phải được phát biểu như một mệnh lệnh riêng, có tiêu chí SAI rõ ràng
 * ("còn chữ Hán là sai"), thay vì chỉ ẩn trong mô tả vai diễn.
 */
export function translateTask({ hasPlaceholders }) {
  return [
    "NHIỆM VỤ DUY NHẤT: DỊCH đoạn thoại tiếng Trung dưới đây SANG TIẾNG VIỆT.",
    "- Đầu vào là tiếng Trung. Đầu ra BẮT BUỘC là tiếng Việt.",
    "- TUYỆT ĐỐI KHÔNG chép lại, chuẩn hoá, thêm dấu câu hay sửa lỗi cho bản tiếng",
    "  Trung rồi trả về. Một phần tử đầu ra còn chữ Hán là SAI" +
      (hasPlaceholders ? " — trừ ký hiệu ⟦số⟧." : "."),
    "- Cũng không phiên âm Hán-Việt cả câu (此物若是运作得当 → \"Tử vật nhược thị vận",
    "  tác đắc đương\" là SAI); phải dịch ra nghĩa tiếng Việt đọc hiểu được.",
  ].join("\n");
}

/**
 * Hai cờ prompt của MỘT lượt gọi, suy từ những gì translate.js gửi kèm — mọi
 * provider phải suy giống nhau nên để chung một chỗ.
 *
 * `hasGlossary`     — lượt này CÓ bảng thuật ngữ đính kèm (dạng nào cũng tính).
 * `hasPlaceholders` — trong text CÓ ký hiệu ⟦số⟧.
 *
 * Hai thứ này từng là một cờ duy nhất (`hasGlossary = Boolean(placeholderDict)`), và
 * đó là chỗ hỏng: tắt cơ chế placeholder thì prompt mất luôn mọi ràng buộc thuật
 * ngữ, nên `--no-glossary` không đo được riêng protect(). Chế độ `--no-protect` mới
 * rơi đúng vào ô hasGlossary=true, hasPlaceholders=false.
 */
export function glossaryFlags({ glossaryDict, hasPlaceholders }) {
  return {
    hasGlossary: Boolean(glossaryDict),
    hasPlaceholders: Boolean(glossaryDict) && Boolean(hasPlaceholders),
  };
}

/**
 * Khối bảng thuật ngữ nhét vào user message. `subject` là chỗ thuật ngữ xuất hiện
 * ("đoạn dưới đây" / "BẢN GỐC") vì các lượt hậu kỳ đưa bản gốc dưới một cái tên khác.
 */
export function glossaryBlock(glossaryDict, { hasPlaceholders, subject }) {
  if (!glossaryDict) return null;
  return hasPlaceholders
    ? `Placeholder trong ${subject} ứng với thuật ngữ đã khoá sẵn:\n${glossaryDict}`
    : `Thuật ngữ đã chốt sẵn bản dịch, gặp trong ${subject} thì PHẢI dùng đúng mặt chữ này:\n${glossaryDict}`;
}

/**
 * Quy tắc văn phong/dịch thuật genre tu tiên — dùng chung cho MỌI prompt sinh ra
 * bản tiếng Việt (dịch chính, nháp 2-pass, biên tập, dịch-có-tham-khảo), tách riêng
 * để 4 chỗ đó không chép tay rồi lệch nhau qua thời gian.
 *
 * Nguồn: md/glossary-system-prompt-tu-tien-cn-vi.md mục 1 (Nguyên tắc dịch chung) —
 * chỉ giữ lại phần chưa có sẵn ở STT-fix-lỗi-đồng-âm/giao thức đánh số bên dưới.
 *
 * Hai cờ, xem glossaryFlags(). Câu nhắc tới ⟦số⟧ chỉ được xuất hiện khi text THẬT
 * SỰ có ⟦số⟧ (`--no-glossary`, `--no-protect`, hoặc cụm không khớp thuật ngữ nào thì
 * không) — nhắc luật cho một ký hiệu không tồn tại là bắt model nhớ thừa, và làm
 * loãng đúng phần quy tắc đang có tác dụng.
 */
export function genreRules({ hasGlossary, hasPlaceholders }) {
  return [
    "- Tên riêng (nhân danh, địa danh, tông môn, pháp bảo có tên riêng) phiên âm Hán Việt, không phiên âm kiểu pinyin.",
    "- Xưng hô cổ trang: ta/ngươi/hắn/nàng/lão phu/tại hạ/tiền bối/vãn bối theo đúng vai vế nhân vật; tránh tôi/bạn hiện đại trừ khi nhân vật xuyên không cố tình nói giọng hiện đại.",
    "- Thành ngữ/tục ngữ Trung Quốc: dịch nghĩa hoặc tìm câu Hán Việt/cổ trang tương đương; tránh thành ngữ thuần Việt hiện đại làm lệch không khí truyện.",
    "- Đơn vị đo lường/thời gian cổ (dặm, trượng, thước, canh giờ, nén hương) giữ Hán Việt.",
    "- Số đếm lớn giữ nguyên đơn vị Hán Việt: 万 = vạn, 亿 = ức — không quy đổi sang",
    "  nghìn/triệu kiểu phương Tây (30万 = \"ba mươi vạn\", không phải \"ba trăm nghìn\").",
    "- Cụm định ngữ + danh từ theo trật tự tiếng Hán (định ngữ đứng trước) cần đảo về",
    "  trật tự tự nhiên của tiếng Việt (danh từ trước, định ngữ sau) khi dịch — VÍ DỤ",
    "  QUY TẮC (không phải thuật ngữ cố định, chỉ minh hoạ trật tự): \"tinh nhuệ tam",
    "  phẩm chiến sĩ\" → \"chiến sĩ tam phẩm tinh nhuệ\", không giữ nguyên thứ tự như",
    "  bản Hán." +
      (hasPlaceholders
        ? " Quy tắc trật tự này KHÔNG áp dụng đè lên một cụm đã có bản dịch ghim\n  sẵn trong placeholderDict — xem quy tắc ưu tiên placeholder ở trên."
        : hasGlossary
          ? " Quy tắc trật tự này KHÔNG áp dụng đè lên một cụm đã có bản dịch ghim\n  sẵn trong bảng thuật ngữ ở đề bài — xem quy tắc ưu tiên thuật ngữ ở trên."
          : ""),
    "- Một khi đã chọn cách dịch cho một cảnh giới/pháp bảo/tổ chức, giữ nhất quán xuyên suốt, kể cả khi bản gốc viết tắt.",
  ].join("\n");
}

/**
 * Quy tắc đối phó lỗi nhận dạng giọng nói (STT/ASR) — dùng chung như genreRules().
 *
 * Các dòng về placeholder ⟦số⟧ CHỈ xuất hiện khi `hasPlaceholders`; chế độ
 * `--no-protect` (có bảng thuật ngữ nhưng không có ⟦số⟧) nhận một luật ghim tương
 * đương, neo vào mặt chữ Hán thay vì vào chỉ số.
 *
 * Riêng luật 镜/境/期 cũng có HAI bản: bản placeholder neo vào ⟦số⟧ tên cảnh giới,
 * bản còn lại neo thẳng vào tên cảnh giới viết bằng chữ Hán — cùng một lỗi thật,
 * chỉ khác chỗ tên cảnh giới đã bị thay bằng ⟦số⟧ hay chưa.
 *
 * Bối cảnh 2 luật placeholder (bắt được trên video 7670837569118145855): 零食
 * "đồ ăn vặt" bị dịch mặt chữ dù ngữ cảnh là tiền tệ tu chân (đáng lẽ 灵石 "linh
 * thạch" — hai từ đọc giống hệt), và "⟦0⟧镜" bị dịch thành "Kim Đan kính" vì
 * placeholder ⟦0⟧ nuốt mất 金丹 trong cụm gốc, đáng lẽ là hậu tố giai đoạn tu luyện
 * (⟦0⟧期 = "Kim Đan Kỳ" — đúng quy ước glossary: Sơ Kỳ, Dẫn Khí Kỳ, Ngưng Khí Kỳ...).
 * Bản đầu từng ép về "cảnh giới X" — SAI, đã sửa lại đúng thành "X Kỳ".
 *
 * Dòng ưu tiên placeholder thêm sau khi bắt được lỗi thật khác trên CÙNG video:
 * glossary ghim ⟦0⟧ = 三界巅峰妖兽 (yêu thú tam phẩm đỉnh phong), nhưng model dịch
 * ra "yêu thú đỉnh phong tam giới" — bỏ qua bản ghim, theo đúng Y HỆT một ví dụ
 * minh hoạ cứng trong genreRules (quy tắc đảo trật tự định ngữ-danh từ) từng dùng
 * chính cụm 三界巅峰妖兽 làm ví dụ, viết TRƯỚC KHI glossary có mục ghim này. Gốc rễ:
 * một ví dụ minh hoạ cứng cho quy tắc chung vô tình đá hẳn placeholderDict của lượt
 * gọi — ví dụ cứng càng cụ thể càng dễ lấn át bảng tra cứu, đúng bài học đã thấy ở
 * chỗ bảng glossary 263 mục (xem buildSystemPrompt). Đã sửa ví dụ trong genreRules
 * sang cụm trung lập không trùng glossary, và thêm quy tắc ưu tiên tường minh ở đây
 * để chặn CẢ LỚP lỗi này về sau, không chỉ riêng ví dụ đã gặp.
 */
export function sttFixRules({ hasGlossary, hasPlaceholders }) {
  const placeholder = hasPlaceholders
    ? [
        "- Giữ nguyên mọi ký hiệu dạng ⟦số⟧ y hệt, không dịch và không đổi kiểu ngoặc.",
        "- Nếu vì lý do văn phong mà viết lại một placeholder ⟦số⟧ thành văn xuôi thay vì",
        "  giữ nguyên token, PHẦN THAY THẾ bắt buộc dùng ĐÚNG bản dịch đã ghim cho ⟦số⟧",
        "  đó trong placeholderDict — không tự suy nghĩa khác dù nghe hợp lý hơn, và bản",
        "  ghim này LUÔN thắng mọi quy tắc văn phong/ví dụ minh hoạ khác nếu có mâu thuẫn.",
      ]
    : hasGlossary
      ? [
          // Không còn ⟦số⟧ để neo, nên luật ghim neo vào chính mặt chữ Hán vẫn nằm
          // nguyên trong payload. Cùng mệnh lệnh, cùng thứ tự ưu tiên với bản
          // placeholder ở trên — khác cơ chế thì mới so được cơ chế.
          "- Cụm nào có mặt trong bảng thuật ngữ ở đề bài thì PHẢI dịch ĐÚNG bản đã ghim",
          "  cho cụm đó, không tự chọn cách dịch khác dù nghe hợp lý hơn — bản ghim này",
          "  LUÔN thắng mọi quy tắc văn phong/ví dụ minh hoạ khác nếu có mâu thuẫn.",
        ]
      : [];

  const realmSuffix = hasPlaceholders
    ? [
        "- Chữ Hán rời 镜/境/期 đứng NGAY SAU một placeholder ⟦số⟧ ứng với TÊN CẢNH GIỚI",
        "  (Luyện Khí/Trúc Cơ/Kim Đan/Nguyên Anh...) là hậu tố chỉ GIAI ĐOẠN tu luyện —",
        "  luôn dịch thành \"X Kỳ\", KHÔNG dịch \"镜\"/\"境\" theo nghĩa đen (gương/cảnh",
        "  giới) và KHÔNG bịa thêm chữ \"cảnh giới\". VÍ DỤ BẮT BUỘC THEO: nếu ⟦0⟧ = 金丹",
        "  (Kim Đan) thì \"⟦0⟧镜\", \"⟦0⟧境\", \"⟦0⟧期\" đều dịch giống nhau là \"Kim Đan Kỳ\".",
      ]
    : [
        "- Chữ Hán rời 镜/境/期 đứng NGAY SAU một TÊN CẢNH GIỚI (炼气/筑基/金丹/元婴...)",
        "  là hậu tố chỉ GIAI ĐOẠN tu luyện — luôn dịch thành \"X Kỳ\", KHÔNG dịch",
        "  \"镜\"/\"境\" theo nghĩa đen (gương/cảnh giới) và KHÔNG bịa thêm chữ \"cảnh",
        "  giới\": 金丹镜/金丹境/金丹期 đều là \"Kim Đan Kỳ\".",
      ];

  return [
    ...placeholder,
    "- Văn bản gốc đến từ nhận dạng giọng nói nên có lỗi đồng âm. Suy ra chữ đúng theo",
    "  ngữ cảnh rồi hãy dịch — có thể lệch 1 chữ trong từ (下瓶宝剑 → 下品宝剑) hoặc lệch",
    "  nguyên cụm cùng âm đọc (零食 \"đồ ăn vặt\" nghe nhầm từ 灵石 \"linh thạch\", đơn vị",
    "  tiền tệ tu chân — hai từ đọc giống hệt nhau).",
    // ĐO ĐƯỢC (2026-09-06, video 7658103101886434560, 22 dòng đầu): thêm đúng luật
    // này vào lượt nháp làm deepseek sửa 算计宝藏 từ "mưu tính bảo tàng" thành "mưu đồ
    // kho báu" — lỗi mà CẢ lượt review lẫn polish trước đó đều để lọt. Bạn giả là lớp
    // lỗi mà luật đồng âm ở trên KHÔNG bắt được: mặt chữ Hán đọc ra đúng, chỉ có nghĩa
    // tiếng Việt là đã trôi, nên model không thấy gì "vô lý" để mà nghi.
    "- Cảnh giác từ Hán-Việt là BẠN GIẢ: mặt chữ mượn thẳng sang tiếng Việt được nhưng",
    "  nghĩa đã trôi, dịch nguyên mặt chữ là sai. 宝藏 = \"kho báu\", KHÔNG phải \"bảo",
    "  tàng\" (tiếng Việt \"bảo tàng\" = viện trưng bày). Cùng loại: 表情, 大家, 工作,",
    "  写真, 检讨. Hỏi \"người Việt không biết tiếng Trung đọc câu này có hiểu đúng",
    "  không?\" — không thì phải dịch nghĩa, đừng bê mặt chữ.",
    ...realmSuffix,
    "- Nếu suy đoán theo âm đọc vẫn không ra nghĩa hợp lý trong bối cảnh tu tiên: đừng",
    "  bịa một câu tiếng Việt trôi chảy nhưng sai hẳn ý. Ưu tiên bản dịch sát nghĩa đen",
    "  nhất có thể suy luận được, thà hơi cứng còn hơn trôi chảy mà lạc đề.",
    "- Nguồn không có dấu câu (STT thô). Tự chấm câu hợp lý theo ranh giới ý — được",
    "  tách nhiều câu tiếng Việt trong CÙNG một dòng, không được đẩy nội dung sang",
    "  dòng khác.",
    // ASR cắt theo khoảng lặng chứ không theo câu, và bước gộp segment ở translate.js
    // chỉ gộp khi CÙNG người nói — nên một câu bị xẻ đúng chỗ diarize gán nhầm nhãn
    // thì không gộp lại được, hai nửa đi vào payload như hai dòng rời. ĐO ĐƯỢC (video
    // 7658103101886434560): 差点憋死 xẻ thành "差点憋。" + "死。" cách nhau 0.0 giây,
    // gán S0/S1, dịch ra "Suýt thì nghẹn thở." / "Chết mất." — nghe như hai người.
    // Model NHÌN THẤY cả hai dòng trong cùng payload nên thừa thông tin để ghép nghĩa;
    // thiếu là thiếu luật cho phép nó làm thế mà vẫn giữ đủ số dòng.
    "- Hai dòng liền kề có thể là MỘT câu bị cắt giữa chừng, kể cả khi nhãn người nói",
    "  ghi là hai người khác nhau (dấu hiệu: dòng trước cụt lửng, hoặc ghép lại mới",
    "  thành từ có nghĩa — 差点憋 + 死 = 差点憋死 \"suýt ngạt chết\"). Hiểu NGHĨA của cả",
    "  câu rồi RẢI bản dịch trở lại đúng từng dòng theo tỉ lệ nội dung. Vẫn giữ nguyên",
    "  số dòng: KHÔNG gộp, KHÔNG bỏ trống dòng nào.",
  ].join("\n");
}

/**
 * Giao thức đánh số cho các lượt gọi CHƯA ép JSON (google-*, và provider LLM nào
 * chưa kiểm chứng JSON Mode). Đường có JSON thì dùng `jsonOutputRules()` thay cho
 * khối này — hai khối mâu thuẫn nhau, gửi cả hai là dạy model hai giao thức output
 * cùng lúc.
 */
export const LINE_PROTOCOL_RULES = [
  "- Giữ nguyên cách đánh số ở đầu mỗi dòng. Vào bao nhiêu dòng, ra đúng bấy nhiêu dòng.",
  "- Không gộp dòng, không tách dòng, không thêm lời bình.",
].join("\n");

/**
 * System prompt dùng chung cho mọi provider dịch bằng LLM (xem chat.js) — đem so
 * chất lượng giữa các model thì phải cùng một prompt, khác prompt là so nhầm thứ.
 *
 * KHÔNG còn dump nguyên bảng glossary (263 mục) vào đây như trước — đo thực tế thấy
 * phản tác dụng: test A/B 5 lần trên cùng 1 câu có ⟦2⟧=筑基(Trúc Cơ), có bảng đầy đủ
 * thì model chọn NHẦM sang mục khác trong bảng ("Dẫn Khí Kỳ") 3/5 lần dù
 * `placeholderDict` (do translate.js gửi kèm mỗi lượt, xem buildUserPrompt) đã ghi rõ
 * ⟦2⟧ là gì — bảng càng dài càng dễ làm model "vớ nhầm" mục gần đó. Bỏ bảng, chỉ còn
 * placeholderDict đúng-của-đúng-cụm-này: 5/5 lần đúng, prompt còn ngắn hơn ~63%.
 *
 * `outputRules` là khối giao thức output của đường gọi cụ thể (JSON hay đánh số) —
 * bên gọi truyền vào, hàm này không đoán.
 */
export function buildSystemPrompt({ hasGlossary, hasPlaceholders, outputRules = LINE_PROTOCOL_RULES }) {
  return [
    "Bạn là dịch giả truyện tiên hiệp/huyền huyễn Trung Quốc sang tiếng Việt.",
    "Văn phong: lời kể truyện mạng, dùng từ Hán-Việt quen thuộc với độc giả Việt.",
    "",
    translateTask({ hasPlaceholders }),
    "",
    "Quy tắc BẮT BUỘC:",
    sttFixRules({ hasGlossary, hasPlaceholders }),
    genreRules({ hasGlossary, hasPlaceholders }),
    outputRules,
  ]
    .filter((part) => part !== null)
    .join("\n");
}

/**
 * Bản đồ người nói đi vào system prompt chứ không vào payload — nhét nhãn vào
 * từng dòng thì phải bóc ra khỏi output, thêm chỗ hỏng cho giao thức đánh số.
 */
export function speakerRules(hint) {
  if (!hint) return null;
  return [
    "",
    `Người nói từng dòng: ${hint}`,
    "- Chọn xưng hô đúng theo quan hệ giữa các nhân vật, và giữ nhất quán xuyên suốt.",
    "- Dòng ghi 'không xác định — khả năng là X': nhận dạng giọng KHÔNG gán được nhãn",
    "  cho dòng này, X chỉ là suy đoán từ mạch thoại. Coi đó là gợi ý, ưu tiên cách",
    "  dịch trung tính nếu chọn X mà thành sai xưng hô thì hỏng nghĩa.",
    "- Dòng ghi 'không xác định' trơ trọi: suy từ mạch hội thoại xung quanh, không tự",
    "  bịa quan hệ.",
  ].join("\n");
}

/**
 * Dựng user message, kèm dòng lân cận làm bối cảnh nếu có.
 *
 * Bối cảnh chỉ xuất hiện khi translate.js phải chia nhỏ cụm vì tách số hỏng. Cụm
 * nhỏ mà trơ trọi thì model mất mạch truyện và quay ra PHIÊN ÂM thay vì dịch —
 * 此物若是运作得当 từng ra "Tử vật nhược thị vận tác đắc đương". Các dòng lân cận
 * để nguyên chữ Hán và nói rõ là không dịch, nên không đụng vào số dòng phải trả về.
 *
 * Dùng chung với openai-2pass/deepseek-2pass (lượt nháp) để các provider cùng nhận
 * một dạng input.
 *
 * Chữ "placeholderDict" còn nằm trong VĂN BẢN prompt (xem sttFixRules/genreRules) là
 * tên cũ của tham số này, cố ý không sửa: nhánh có-bọc-placeholder phải giữ nguyên
 * từng byte thì mọi số đo cũ mới còn so được với nhánh mới.
 *
 * `glossaryDict`: CHỈ những thuật ngữ thực sự có trong `text` của lượt gọi này
 * (translate.js dựng từ `pairs` của protect()/matchedTerms()), không phải nguyên
 * bảng glossary. Hai dạng tuỳ cơ chế: "⟦0⟧ = 金丹 (Kim Đan); ..." khi có bọc
 * placeholder — không có bảng này thì model phải đoán mù ⟦n⟧ ứng với chữ nào, đã gây
 * lỗi thật (xem sttFixRules()) — và "金丹 = Kim Đan; ..." khi chạy `--no-protect`.
 *
 * Câu lệnh cuối nhắc lại NGÔN NGỮ ĐÍCH ngay sát payload: system prompt đã nói,
 * nhưng chỗ model bắt đầu sinh chữ là ngay sau dòng này — và đúng chỗ đó nó từng
 * quay ra biên tập tiếng Trung (xem translateTask()).
 */
export function buildUserPrompt(text, to, surrounding, glossaryDict, hasPlaceholders) {
  const before = surrounding?.before ?? [];
  const after = surrounding?.after ?? [];
  return [
    before.length ? `Các câu NGAY TRƯỚC đoạn cần dịch (chỉ để hiểu mạch, KHÔNG dịch):\n${before.join("\n")}` : null,
    after.length ? `Các câu NGAY SAU đoạn cần dịch (chỉ để hiểu mạch, KHÔNG dịch):\n${after.join("\n")}` : null,
    glossaryBlock(glossaryDict, { hasPlaceholders, subject: "đoạn dưới đây" }),
    `DỊCH ${text.split("\n").length} dòng tiếng Trung dưới đây sang ${to}. Đầu ra phải là ${to}, ` +
      `không được trả lại tiếng Trung:\n\n${text}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Ép output qua Structured Outputs của OpenAI (`response_format: json_schema`,
 * `strict: true`) thay vì tin model tự viết đúng "1. ...\n2. ..." — bỏ hẳn kiểu
 * lỗi model đổi "1." thành "1、"/"1)" hay quên đánh số một dòng.
 *
 * Riêng provider này dùng `json_schema` (OpenAI kiểm cả SCHEMA); DeepSeek chỉ có
 * `json_object` (kiểm cú pháp JSON thôi) nên bên đó phải tự kiểm hình dạng — xem
 * jsonOutput.js. Qwen chưa kiểm chứng, vẫn đi đường đánh số.
 *
 * KHÔNG đặt `minItems`/`maxItems` trong schema: từng có giai đoạn OpenAI từ chối
 * hẳn request (400) nếu schema chứa keyword strict mode chưa hỗ trợ — bản build cụ
 * thể đang dùng có hỗ trợ hay không thì không chắc, thà không đặt còn hơn model
 * này gãy cả bước dịch. Số dòng đúng/thiếu vẫn được biết bằng cách đếm phần tử sau
 * khi có response (parseTranslations nhận `expect`), dựng lại thành text "N. dòng"
 * để translate.js tái dùng nguyên `parsePayload()`/cơ chế chia đôi khi hỏng.
 */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      description:
        "Bản dịch TIẾNG VIỆT của từng dòng, ĐÚNG THỨ TỰ và ĐÚNG SỐ LƯỢNG với các dòng đã đánh số " +
        "trong đề bài. KHÔNG lặp lại số thứ tự trong chuỗi — vị trí trong mảng đã thay cho việc " +
        'đánh số, mỗi phần tử chỉ chứa bản dịch thuần (VD "Đây là thiên linh căn", không phải ' +
        '"1. Đây là thiên linh căn"). Không được trả lại nguyên văn tiếng Trung.',
      items: { type: "string" },
    },
  },
  required: ["translations"],
  additionalProperties: false,
};

export async function translateText(text, { to, speakerHint, surrounding, glossaryDict, hasPlaceholders, expectLines }) {
  const openai = client();
  const flags = glossaryFlags({ glossaryDict, hasPlaceholders });

  const model = config.translateModel;
  // Schema đã mô tả hợp đồng output, không kèm jsonOutputRules() nữa để khỏi dạy
  // hai giao thức chồng nhau — nhưng vẫn phải chặn kiểu đánh số trong chuỗi.
  const systemPrompt = buildSystemPrompt({
    ...flags,
    outputRules:
      "- Trả về đúng một phần tử cho mỗi dòng đánh số ở đầu vào, đúng thứ tự, và KHÔNG\n" +
      "  chép số thứ tự vào trong chuỗi.",
  });
  const messages = [
    { role: "system", content: [systemPrompt, speakerRules(speakerHint)].filter(Boolean).join("\n") },
    { role: "user", content: buildUserPrompt(text, to, surrounding, glossaryDict, flags.hasPlaceholders) },
  ];

  const params = {
    model,
    temperature: 0.3,
    messages,
    response_format: {
      type: "json_schema",
      json_schema: { name: "translated_lines", strict: true, schema: RESPONSE_SCHEMA },
    },
  };
  const t0 = Date.now();
  const res = await logApiCall(log, { url: `${OPENAI_V1}/chat/completions`, body: params }, () =>
    openai.chat.completions.create(params),
  );

  // Không dựng được mảng thì trả chuỗi rỗng — parsePayload() của translate.js coi
  // đây là hỏng và tự chia đôi cụm thử lại, y hệt đường xử lý cũ.
  const translations = parseTranslations(res.choices[0]?.message?.content, "openai", expectLines ?? null);
  if (!translations) return "";

  const out = toNumbered(translations);
  log.debug(`${text.length} → ${translations.length} dòng, ${out.length} ký tự (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return out;
}
