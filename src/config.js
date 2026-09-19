import path from "node:path";

// Mọi field đều có default để chạy được ngay mà không cần .env
// (trừ OPENAI_API_KEY — chỉ bước stt mới bắt buộc).

const str = (key, fallback) => process.env[key]?.trim() || fallback;
const int = (key, fallback) => {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
};
// Ngưỡng dạng số thực (0.6, 1.5…) — `int` làm tròn mất phần thập phân.
const num = (key, fallback) => {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isNaN(n) ? fallback : n;
};
const bool = (key, fallback) => {
  const raw = process.env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
};

const root = process.cwd();

export const config = {
  // STT
  openaiApiKey: str("OPENAI_API_KEY", ""),
  // Cú pháp `engine:model` như STT_COMPARE_MODELS; thiếu `engine:` là openai.
  // `qwen:qwen-audio-3.0-asr-flash-filetrans` chạy được cả text lẫn timestamp, chịu
  // được audio dài, tính tiền theo giây có tiếng — xem asr-qwen.js.
  sttModel: str("STT_MODEL", "whisper-1"),
  sttLanguage: str("STT_LANGUAGE", "zh"),
  // Mồi từ vựng cho whisper (tối đa 224 token) — kéo model về đúng mặt chữ khi gặp
  // từ đồng âm. Để trống nếu nội dung là ngôn ngữ đời thường.
  sttPrompt: str("STT_PROMPT", ""),
  // whisper-1 làm STT tổng thể (text + timestamp); diarize CHỈ để định danh người
  // nói qua chồng lấn thời gian, text của diarize không dùng nữa. Để trống = tắt,
  // segment nào cũng không có nhãn người nói.
  sttDiarizeModel: str("STT_DIARIZE_MODEL", "gpt-4o-transcribe-diarize"),
  // Mồi từ vựng — hiện KHÔNG dùng trong flow chính (diarize chỉ định danh, không
  // lấy text nên prompt sửa mặt chữ vô nghĩa với nó). Giữ lại cho lệnh `compare`
  // và `scripts/compare-diarize-bgm.js` khi cần thử nghiệm riêng.
  sttKeywords: str(
    "STT_KEYWORDS",
    "以下是修真玄幻小说的旁白：金丹、元婴、渡劫、下品宝剑、灵石、极北、三阶、寒衣阁、御寒袍、破铜烂铁",
  ),
  // Mồi từ vựng cho engine TQ (qwen3-asr-flash). CHƯA KIỂM CHỨNG field này được
  // chấp nhận — để trống thì không gửi, điền vào mà API trả 400 là biết không hỗ trợ.
  sttContext: str("STT_CONTEXT", ""),
  // Số điểm bất đồng in ra cho mỗi cặp engine ở lệnh `compare`.
  sttCompareMaxDiffs: int("STT_COMPARE_MAX_DIFFS", 25),
  speakerMergeMaxGapSec: num("SPEAKER_MERGE_MAX_GAP_SEC", 1.5),
  // Trước đây để LLM suy nốt nhãn còn thiếu từ mạch thoại (đánh dấu inferred).
  // Đổi hướng: diarize không xác định được thì để NGUYÊN "không xác định" thay vì
  // đoán — đoán sai giọng đọc lồng tiếng còn tệ hơn một đoạn trung tính. Bật lại
  // nếu muốn quay về hành vi cũ.
  speakerInfer: bool("SPEAKER_INFER", false),

  // Mạng tới OpenAI từ VN chập chờn — thử lại nhiều hơn mặc định của SDK (2).
  // Đừng để cao: khi request đầu nhận lỗi API thật (429/401), các lần retry rớt kết
  // nối sẽ đè lên và chỉ còn "Connection error" — retry càng nhiều, nguyên nhân thật
  // càng bị chôn sâu và càng lâu mới biết.
  sttMaxRetries: int("STT_MAX_RETRIES", 3),
  sttTimeoutMs: int("STT_TIMEOUT_MS", 180000),
  // Chạy song song + quét lại nhiều lượt để một nhịp nhiễu mạng không chặn cả mẻ.
  // segment | word | segment,word | (rỗng để tắt). CHỈ whisper-1 hỗ trợ.
  sttTimestamps: str("STT_TIMESTAMPS", "segment,word")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean),
  sttConcurrency: int("STT_CONCURRENCY", 3),
  sttRetryPasses: int("STT_RETRY_PASSES", 4),
  sttPassDelayMs: int("STT_PASS_DELAY_MS", 15000),
  sttCompareModels: str(
    "STT_COMPARE_MODELS",
    // Cú pháp `engine:model`; thiếu engine thì mặc định openai. Mặc định xếp hai
    // model OpenAI tốt nhất cạnh ứng viên TQ.
    "whisper-1,gpt-4o-transcribe,qwen:qwen3-asr-flash",
  )
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean),

  // Browser
  headless: bool("HEADLESS", false),
  browserProfileDir: path.resolve(root, str("BROWSER_PROFILE_DIR", ".browser-profile")),

  // Scraping
  dataDir: path.resolve(root, str("DATA_DIR", "data")),
  scrollIdleRounds: int("SCROLL_IDLE_ROUNDS", 3),
  scrollMaxRounds: int("SCROLL_MAX_ROUNDS", 500),
  // Chờ tối đa bao lâu cho lazy-load ra link mới sau mỗi lần scroll.
  scrollLoadTimeoutMs: int("SCROLL_LOAD_TIMEOUT_MS", 8000),
  minDelayMs: int("MIN_DELAY_MS", 800),
  maxDelayMs: int("MAX_DELAY_MS", 2500),
  downloadRetries: int("DOWNLOAD_RETRIES", 3),
  // Tải kèm video gốc — cần khi muốn ghép audio đã dub trở lại video.
  // Tắt đi nếu chỉ cần transcript: video nặng gấp ~45 lần audio.
  downloadVideo: bool("DOWNLOAD_VIDEO", true),
  // "best" = bitrate cao nhất (1080p) | "worst" = thấp nhất (540p)
  videoQuality: str("VIDEO_QUALITY", "best"),
  captureTimeoutMs: int("CAPTURE_TIMEOUT_MS", 20000),
  // Số video xử lý song song ở bước fetch. Cổ chai là mp4 (~30-45 MB/video) tải trên
  // một kết nối duy nhất — chạy nhiều video cùng lúc ăn đứt mọi cách tối ưu từng lượt.
  // Đo trên 8 video cùng bộ: tuần tự 9,2s/video → 6/3 còn 3,1s → 8/4 còn 2,5s → 12/6
  // KHÔNG nhanh thêm (băng thông bão hoà). Lấy 6/3 vì hai lý do ngoài tốc độ: mỗi luồng
  // giữ trọn file trong RAM lúc ghi, và mỗi luồng là một nhịp request nữa đập vào Douyin
  // suốt cả mẻ vài trăm video. Máy khoẻ + mạng rộng thì đẩy lên 8/4.
  fetchConcurrency: int("FETCH_CONCURRENCY", 6),
  // Trần riêng cho số trang Chromium mở CÙNG LÚC, luôn thấp hơn fetchConcurrency:
  // trang Douyin nặng RAM và đây cũng là phần lộ diện nhất trước bot detection.
  // Phần còn lại của luồng (tải file) chỉ là HTTP nên không tính vào trần này.
  captureConcurrency: int("CAPTURE_CONCURRENCY", 3),
  // Thời gian chờ danh sách video render — cũng là khoảng thời gian để xử lý
  // captcha/đăng nhập thủ công trước khi collect bỏ cuộc.
  pageReadyTimeoutMs: int("PAGE_READY_TIMEOUT_MS", 120000),

  // Translation
  // Mặc định là openai chứ không phải google-web dù Google dịch hay hơn: nhãn người
  // nói đi vào system prompt, mà dịch máy không có system prompt — chạy Google là
  // vứt cả bước diarize. Xem README, mục "Đổi provider".
  translateProvider: str("TRANSLATE_PROVIDER", "openai"),
  // Provider dịch bằng LLM ngoài OpenAI. Đều nói giao thức /chat/completions nên
  // dùng chung src/translators/chat.js, chỉ khác baseURL + key + tên model.
  deepseekApiKey: str("DEEPSEEK_API_KEY", ""),
  deepseekBaseUrl: str("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
  // `deepseek-chat` KHÔNG còn nằm trong `GET /models` (2026-09-06 chỉ chào ra
  // deepseek-v4-flash, deepseek-v4-pro, deepseek-v4-flash-vision-exp) — nó là alias
  // cũ vẫn resolve được, và đo thật thì nó chạy KHÔNG suy luận (reasoning_tokens = 0,
  // ~3s/cụm). Giữ nó cho lượt NHÁP là có chủ ý: lượt nháp cần nhanh và rẻ, phần khó
  // đã dời sang lượt review.
  deepseekModel: str("DEEPSEEK_MODEL", "deepseek-chat"),
  // Model cho lượt REVIEW (soát nghĩa) — lượt 2 của deepseek-2pass.
  //
  // ĐO ĐƯỢC (2026-09-06, video 7658103101886434560, 22 dòng đầu, cùng MỘT bản nháp
  // cố định), số ca sửa đúng trên 4 lỗi nghĩa đã soát tay:
  //   deepseek-chat    3.9s     đổi 1/22 dòng    1/4   ← gần như no-op, đo 2 lần đều vậy
  //   qwen3-max        9.6s     đổi 4/22 dòng    1/4
  //   deepseek-v4-flash  —      content RỖNG      —    ← đốt hết 32.767 token suy luận
  //   deepseek-v4-pro  377.1s   đổi 6/22 dòng    3/4   ← sửa được cả 面修→nam sủng
  //
  // Chọn v4-pro là đổi 3s lấy ~6 phút/cụm và ~21.700 token suy luận. Đắt, nhưng lượt
  // review chạy bằng deepseek-chat thì gần như không sửa gì — trả tiền cho một lượt
  // không làm gì mới là khoản phí tệ hơn. Hạ về `deepseek-chat` qua .env nếu cần chạy
  // batch gấp và chấp nhận bỏ lượt soát nghĩa.
  translateReviewModel: str("TRANSLATE_REVIEW_MODEL", "deepseek-v4-pro"),
  // Model cho lượt POLISH (biên tập mạch lạc) — lượt 3, chạy sau lượt review.
  // Giữ deepseek-chat: lượt này chỉ chữa văn phong trên bản đã đúng nghĩa. Từng thử
  // deepseek-reasoner cho lượt 3 (hồi nó còn là "review lần 2") và đo thật ~30.000
  // token/lượt, có lần 216s, mà phần lớn KHÔNG đổi gì thêm.
  deepseekReviewModel: str("DEEPSEEK_REVIEW_MODEL", "deepseek-chat"),
  dashscopeApiKey: str("DASHSCOPE_API_KEY", ""),
  // Host của DashScope native (đường DUY NHẤT gọi được Qwen-ASR — xem asr-qwen.js).
  // Không có default dùng được: key cấp theo workspace thì host cũng riêng theo
  // workspace (`https://<workspaceId>.<region>.maas.aliyuncs.com`), lấy đúng chuỗi
  // trong file apiKey CSV tải từ console (hoặc `npm run apikey-csv`).
  dashscopeBaseUrl: str("DASHSCOPE_BASE_URL", ""),
  // Host để POLL trạng thái task filetrans. KHÁC dashscopeBaseUrl: submit task lên
  // host workspace được, nhưng hỏi task ở host đó trả 403 — phải qua host vùng công
  // khai. Mặc định cho region Singapore; đổi thành https://dashscope.aliyuncs.com
  // nếu workspace ở Bắc Kinh.
  dashscopePollUrl: str("DASHSCOPE_POLL_URL", "https://dashscope-intl.aliyuncs.com"),
  dashscopePollIntervalMs: int("DASHSCOPE_POLL_INTERVAL_MS", 4000),
  // Bật diarize của filetrans (trả speaker_id). Mặc định TẮT: đo được nó tách loạn
  // trên nội dung một-người-lồng-nhiều-giọng, kể cả khi ép speaker_count. Xem asr-qwen.js.
  qwenDiarize: bool("QWEN_DIARIZE", false),
  qwenSpeakerCount: int("QWEN_SPEAKER_COUNT", 0),
  siliconflowApiKey: str("SILICONFLOW_API_KEY", ""),
  siliconflowBaseUrl: str("SILICONFLOW_BASE_URL", "https://api.siliconflow.cn/v1"),
  // Bản quốc tế (Singapore). Đổi sang dashscope.aliyuncs.com nếu mở tài khoản nội
  // địa TQ — key của hai bên KHÔNG dùng lẫn được.
  qwenBaseUrl: str("QWEN_BASE_URL", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
  qwenModel: str("QWEN_MODEL", "qwen-plus"),
  // auto = để Google tự nhận ngôn ngữ. Transcript Douyin đôi khi lẫn tiếng khác,
  // và đây cũng là cấu hình đã kiểm chứng cho ra bản dịch tốt nhất.
  translateFrom: str("TRANSLATE_FROM", "auto"),
  translateTo: str("TRANSLATE_TO", "vi"),
  // Ngôn ngữ giao diện translate.google.com (tham số hl). Context trình duyệt để
  // locale zh-CN phục vụ việc scrape Douyin, nên phải ép riêng ở đây.
  translateUiLang: str("TRANSLATE_UI_LANG", "vi"),
  // Google phục vụ 2 model: bản LLM (tốt) và NMT đời cũ (tệ), tụt xuống NMT khi
  // dùng nhiều. Câu mồi này dịch ra chứa `canaryBad` nghĩa là đang bị model tệ.
  translateCanary: str("TRANSLATE_CANARY", "杀人放火金腰带,果然成不起我。"),
  translateCanaryBad: str("TRANSLATE_CANARY_BAD", "đai vàng"),
  translateCooldownMs: int("TRANSLATE_COOLDOWN_MS", 120000),
  translateCooldownTries: int("TRANSLATE_COOLDOWN_TRIES", 3),
  // Trần cho provider WEB/NMT: dưới giới hạn ~5000 ký tự của ô nhập
  // translate.google.com. Đây là ràng buộc CỦA GOOGLE, không phải của việc dịch —
  // xem `translateMaxCharsLlm` ngay dưới.
  translateMaxChars: int("TRANSLATE_MAX_CHARS", 4000),
  // Trần cho provider LLM (openai/deepseek/qwen + các bản 2pass). Tách khỏi trần
  // Google ở trên vì hai thứ đó là hai ràng buộc KHÁC HẲN NHAU, chỉ tình cờ gần
  // bằng nhau — trần Google là kích thước ô nhập, trần này là sức chịu của model.
  //
  // ĐÃ ĐO (2026-09-06, deepseek-2pass, video 7663643779055766836, 179 đơn vị dịch
  // / 5715 ký tự payload). Giới hạn KHÔNG phải context window — deepseek-chat có
  // 64K, thừa sức chứa:
  //   1 cụm  / 179 dòng  → 179/179 dòng TRẢ VỀ NGUYÊN TIẾNG TRUNG. Model bỏ hẳn
  //                        việc dịch, quay ra BIÊN TẬP tiếng Trung (差点憋死你们…
  //                        → 差点憋死我们，你们…). Nháp 5715 → 5732 ký tự, tức
  //                        không dịch gì. Hỏng 100%, im lặng.
  //   2 cụm / 116+63 dòng → 0/179 dòng còn chữ Hán, 0 cảnh báo. Dịch sạch.
  // Nên ngưỡng gãy nằm đâu đó giữa 116 và 179 dòng. 4000 ký tự (~116 dòng) là mức
  // đã đo là an toàn — ĐỪNG nâng lên nếu chưa đo lại trên chính model đang dùng.
  //
  // Cụm nhỏ có cái giá của nó (mất mạch truyện, xem README) nhưng cái giá đó nhỏ
  // hơn nhiều so với việc nhận về nguyên bản tiếng Trung.
  translateMaxCharsLlm: int("TRANSLATE_MAX_CHARS_LLM", 10000),
  // Trần token đầu ra cho các lượt gọi LLM ép JSON. Doc JSON Mode của DeepSeek dặn
  // đặt max_tokens "đủ rộng" vì JSON bị cắt giữa chừng là JSON HỎNG — mất trắng cả
  // cụm chứ không phải mất một dòng cuối như giao thức đánh số. Mốc để ước lượng:
  // cụm 43 dòng / 1180 ký tự tiếng Trung tốn 784 token đầu ra, nên 8192 dư sức cho
  // cụm dài nhất mà TRANSLATE_MAX_CHARS_LLM cho phép.
  translateMaxTokens: int("TRANSLATE_MAX_TOKENS", 18192),
  // Trần RIÊNG cho lượt review, vì model suy luận tính token suy luận VÀO CÙNG hạn
  // ngạch completion — hết quota giữa lúc đang nghĩ thì `content` về RỖNG, không phải
  // JSON cụt. Và output rỗng lại đi đúng nhánh fallback "giữ nguyên bản đưa vào" của
  // runPass(), nên hỏng kiểu này KHÔNG ồn ào: nó hiện ra y như một lượt review không
  // tìm thấy lỗi nào. Đây chính là cách `deepseek-reasoner` từng "chạy êm mà vô dụng".
  //
  // ĐO ĐƯỢC (2026-09-06, cụm 22 dòng): deepseek-v4-pro tiêu 21.677 token suy luận rồi
  // mới viết JSON — trần 8192 và 18192 đều trả rỗng. 32768 là mốc đã chạy thật thành
  // công. deepseek-v4-flash thì đốt sạch 32.767 token mà vẫn không viết gì: model đó
  // không dùng được cho lượt này ở BẤT KỲ trần nào, đừng đổi sang nó để "cho nhanh".
  translateReviewMaxTokens: int("TRANSLATE_REVIEW_MAX_TOKENS", 32768),
  // Gộp segment liền mạch cùng người nói trước khi dịch. Ngưỡng CHẶT là chủ ý: chỉ
  // gộp đúng chỗ whisper tự cắt giữa câu (đo được: khoảng cách 0.00s), không nuốt
  // khoảng lặng thật — nuốt rồi thì TTS phải kéo giọng lấp vào, tiếng dub lệch.
  translateMergeMaxGapSec: num("TRANSLATE_MERGE_MAX_GAP_SEC", 0.2),
  // Chờ bản dịch trên web UI đứng yên (nó cập nhật dần khi nhập).
  translateTimeoutMs: int("TRANSLATE_TIMEOUT_MS", 45000),
  translateComparePreview: int("TRANSLATE_COMPARE_PREVIEW", 10),
  translateCompareProviders: str(
    "TRANSLATE_COMPARE_PROVIDERS",
    // Mặc định so đúng các ứng viên đang cân nhắc cho zh→vi. google-web giữ lại làm
    // mốc đối chiếu vì đó là bản chất lượng bạn đã tự đánh giá bằng tay.
    "openai,deepseek,deepseek-2pass,qwen,google-web",
  )
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean),
  translateModel: str("TRANSLATE_MODEL", "gpt-4o-mini"),
  // Model riêng cho lượt biên tập của provider openai-2pass/google-2pass — để trống
  // thì dùng lại translateModel. Cho phép phối nháp rẻ + biên tập bằng model xịn hơn.
  translatePolishModel: str("TRANSLATE_POLISH_MODEL", ""),
  glossaryFile: path.resolve(root, str("GLOSSARY_FILE", "glossary.json")),
  // Có dùng glossary hay không, ở BẤT KỲ dạng nào. Tắt bằng GLOSSARY=false hoặc
  // `--no-glossary`: model không nhận placeholder lẫn bảng thuật ngữ, tự bịa mặt chữ.
  glossaryEnabled: bool("GLOSSARY", true),
  // Cơ chế đưa glossary tới model. Bật = bọc placeholder ⟦n⟧ trước khi dịch (xem
  // protect() trong glossary.js). Tắt bằng GLOSSARY_PROTECT=false hoặc `--no-protect`:
  // text đi nguyên vẹn, thuật ngữ khớp được gửi kèm dưới dạng bảng "Hán tự = bản dịch".
  //
  // Tách riêng khỏi glossaryEnabled vì protect() là nghi phạm khi bản dịch sót chữ
  // Hán hoặc cụt câu, mà tắt bằng `--no-glossary` thì mất luôn tri thức thuật ngữ —
  // đổi 2 biến cùng lúc, không quy được trách nhiệm cho riêng cơ chế placeholder.
  glossaryProtect: bool("GLOSSARY_PROTECT", true),

  // Logging
  logLevel: str("LOG_LEVEL", "info"),
  // Mức log của request/response API (xem src/apiLog.js). Mặc định `debug` để chạy
  // batch không bị ngập; đặt `info` khi cần soát từng lời gọi mà không muốn bật
  // debug của toàn bộ module khác.
  apiLogLevel: str("API_LOG_LEVEL", "debug"),
  // Trần độ dài mỗi chuỗi trong log API (0 = in đủ). Chốt chặn cho audio base64
  // ~3.5 MB mà qwen-asr nhét vào body; prompt dịch dài nhất cũng chỉ vài nghìn ký
  // tự nên mặc định này không cắt mất nội dung cần soát.
  apiLogMaxChars: int("API_LOG_MAX_CHARS", 20000),
};

// UA Chrome thật trên Windows — dùng chung cho browser context và request tải file,
// để header của lượt tải khớp với header của lượt duyệt.
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const DOUYIN_ORIGIN = "https://www.douyin.com";

// Đường dẫn output
export const paths = {
  userDir: (userId) => path.join(config.dataDir, userId),
  stateFile: (userId) => path.join(config.dataDir, userId, "state.json"),
  videoDir: (userId, videoId) => path.join(config.dataDir, userId, videoId),
  inspectDir: () => path.join(config.dataDir, "_inspect"),
};
