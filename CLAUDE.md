# Ghi chú kỹ thuật — douyind-downloader

`README.md` mô tả **kiến trúc** (cho người đọc). File này giữ **lý do và số đo**: phương án đã
loại, bẫy đã sập, con số làm căn cứ. Đọc mục liên quan trước khi định sửa một chỗ trông có vẻ lạ
— phần lớn chỗ lạ là kết quả của một lần đo.

## Mục tiêu và ràng buộc

Từ 1 Douyin `user_id` → thu thập video → audio → transcript → dịch zh→vi có ngữ cảnh cả bộ →
lồng tiếng giữ giọng nhân vật → mp4 tiếng Việt.

- **Máy chạy pipeline yếu**: không chạy nổi Whisper local hay model nặng → mọi bước nặng đẩy ra
  cloud API. Phần local chỉ còn ffmpeg, demucs (tách nhạc nền) và resemblyzer (chấm độ giống).
- **Tránh bot detection của Douyin** → không headless thuần.
- **fleex không đọc được tiếng Trung** → mọi trang cần người duyệt chỉ được hỏi phía tiếng Việt,
  và ghi lại `reviewedBy`.

## Bốn luật xuyên suốt

1. **Đĩa là nguồn sự thật.** Mọi lệnh hỏi đĩa trước khi làm, không hỏi state trong đầu. Ctrl-C
   giữa chừng rồi chạy lại là an toàn.
2. **Cache mọi lượt đã trả tiền.** `raw-*.json` cho ASR, `ckpt.json` cho zhvi. `--force` của
   `stt` chỉ căn lại trên cache chứ không gọi lại API.
3. **Đo bằng lời gọi thật rồi mới xây.** Dự án có tiền lệ này; các bảng số dưới đây là kết quả,
   không phải ước tính.
4. **Hỏng phải phân biệt được.** Một bản dịch giả trông như thật tệ hơn một lỗi parse.

---

## Thu thập danh sách video

- **yt-dlp KHÔNG có extractor liệt kê video theo user cho Douyin** (khác TikTok). Đã test:
  `douyin.com/user/<id>` trả "Unsupported URL" / rơi về generic extractor. → phải tự quét DOM.
- Ưu tiên DOM/href hơn bắt response API nội bộ: đơn giản hơn, ít vỡ khi Douyin đổi API.
- `collect` chỉ quét trong `[data-e2e="user-post-list"]`. Đo bằng `probe`: cả trang 44 link =
  36 trong post-list + 8 trong `page-footer`.
- Trang chỉ render sẵn ~36 video đầu → mỗi vòng scroll kéo item cuối vào tầm nhìn rồi **chờ tới
  khi có link mới** (`SCROLL_LOAD_TIMEOUT_MS`), không chờ cứng một nhịp ngắn.
- Đối chiếu với số tác phẩm Douyin tự khai ở tab 作品 (`[data-e2e="user-tab-count"]`), thiếu thì
  cảnh báo.

### Ba lớp chặn tải nhầm video người khác

Trang user có cả khu gợi ý ở footer; trang video hiển thị cả loạt video khác kiểu YouTube.

| Lớp | Cơ chế | Vỡ khi |
|---|---|---|
| `collect` | chỉ quét trong post-list | Douyin đổi `data-e2e` → cảnh báo rồi quét cả trang |
| `capture` | chỉ nhận metadata có `aweme_id` khớp video đang hỏi | không (dựa metadata) |
| `fetch` | so `author.sec_uid` với `user_id` CLI; lệch thì đánh `foreign`, bỏ **trước khi tải** | không (dựa metadata) |

## Nguồn audio: `video.bit_rate_audio`, không phải `music.play_url`

| | `music.play_url` | `video.bit_rate_audio` ← đang dùng |
|---|---|---|
| Bản chất | track "dùng âm thanh này" | audio tách từ **chính video** (DASH) |
| Kích thước (video 3.5 phút) | 4.8 MB | **1.2 MB** |
| Chất lượng | 192 kbps stereo mp3 | 48 kbps AAC HE v2 |
| Đúng tiếng trong video? | **không chắc** — có thể là nhạc nền | **luôn đúng** |

Vì `bit_rate_audio` luôn là tiếng của video nên **không cần tải mp4 rồi tách bằng ffmpeg** — đây
là lý do pipeline không có bước ffmpeg nào ở khâu tải. 48 kbps thừa sức cho STT (Whisper hạ về
16 kHz mono trước khi xử lý dù gửi chất lượng gì).

Chỉ khi metadata thiếu `bit_rate_audio` mới rơi về `music.play_url`; lúc đó `isOriginalSound`
tính từ (`music.owner_id` vs `author.uid`, `music.is_original`, `music.title`), nghi ngờ thì
đánh `suspectBgm: true`.

Link media có chữ ký `expire=` sống ~1 giờ → không cache/hardcode URL được. `mime_type` trong
query string **không đáng tin** để phân biệt mp3/mp4 (tag nội bộ của TOS) — phải dựa response
header thật hoặc field metadata.

`video.bit_rate` liệt kê ~22 mức; `VIDEO_QUALITY` chọn `best` (~55 MB/3.5 phút) hoặc `worst`
(~7 MB, 540p). **Không dùng `video.play_addr` mặc định** — nó trả mức tầm trung 1024x576 ~40 MB,
không nét nhất mà cũng chẳng nhẹ nhất. Tải video lỗi chỉ log cảnh báo, không đánh hỏng bản ghi.

### Tốc độ `fetch` (đo trên cùng 8 video, mp4 bật, quality best)

| Song song | Thời gian | Mỗi video |
|---|---|---|
| 1 (tuần tự) | 55s / 6 video | 9,2s |
| **6 (capture 3) — mặc định** | 24,5s | 3,1s |
| 8 (capture 4) | 20,1s | 2,5s |
| 12 (capture 6) | 23,8s | 3,0s |

Quá 8 thì hết cải thiện (băng thông bão hoà). Mặc định 6/3 chứ không phải mốc nhanh nhất vì mỗi
luồng giữ trọn file trong RAM lúc ghi, và mỗi luồng là thêm một nhịp request đập vào Douyin suốt
cả mẻ. Hai trần tách rời (`FETCH_CONCURRENCY` / `CAPTURE_CONCURRENCY`) vì mở trang tốn RAM và lộ
diện trước bot detection, còn tải file chỉ tốn băng thông.

**Đừng chặn ảnh/font bằng `page.route` để tiết kiệm băng thông.** Đã đo: chặn thì 2 OK/4 lỗi
trong 114s, không chặn thì 5 OK/1 lỗi trong 20s — mọi request phải vòng qua Node làm chậm đúng
cái XHR metadata đang chờ.

---

## STT

### Đường OpenAI: whisper-1 làm khung, diarize chỉ định danh

Phân công không lẫn vai: **whisper-1 là nguồn duy nhất cho text + timestamp**;
`gpt-4o-transcribe-diarize` **chỉ** gán người nói theo chồng lấn thời gian, text riêng của nó
không dùng. Số đo thật trên video 227s lấy từ `usage` — **không dùng bảng ước tính theo phút của
OpenAI, nó lệch gấp đôi với tiếng Trung**.

| Model | timestamp | speaker | 122 video |
|---|---|---|---|
| `whisper-1` | segment + **word**, phủ 100% | ❌ | $2.71 |
| `gpt-4o-transcribe-diarize` | segment, sót 18% | ✅ | $5.76 |

Vì sao whisper làm khung: diarize dừng ở **185.3s** trong khi audio dài 227.1s — bỏ hẳn 42 giây
cuối, đúng đoạn cao trào. Cắt riêng 42 giây đó gọi lại vẫn không ra. `ffmpeg silencedetect -30dB`
cũng không tìm được khoảng lặng nào ở vùng đó nên không suy ra ranh giới câu được.

Segment nào diarize không chồng lấn tới thì để `speaker: null` → hiện ra ở bước dịch là "không
xác định", không đoán. `SPEAKER_INFER=true` bật lại nhánh LLM suy nốt, mặc định **tắt**: đoán sai
giọng lồng tiếng còn tệ hơn một đoạn trung tính.

### Đường Qwen-ASR (`STT_MODEL=qwen:…`) — đường zhvi ăn vào

`src/asr-qwen.js` trả **đúng hình dạng kết quả của whisper-1** nên `stt.js` dùng thay mà không
phải sửa gì phía sau.

- **Phải dùng bản async `filetrans`**: bản sync chặn audio dài (~4 phút là trả 400 kèm text
  rỗng), trong khi video dạng truyện dài 10+ phút. Filetrans còn tính tiền theo **giây có tiếng
  nói** (`content_duration`) — nội dung nhiều nhạc đệm rẻ hơn ~2-3 lần — và trả sẵn `sentences[]`.
- **Vật cản "chỉ nhận URL công khai" đã vượt**: audio đi base64 trong body JSON. DashScope đóng
  kết nối (SSLEOF) khi base64 vượt ~10 MB → hạ mẫu mono 16 kHz MP3 32 kbps trước khi gửi (đo
  được text không đổi trên cả video 修真 lẫn 西游); video 10 phút còn ~3.5 MB. Dài bất thường thì
  tự cắt khúc.
- **Submit và poll ở hai host khác nhau.** Submit lên host workspace (`DASHSCOPE_BASE_URL`) được,
  nhưng hỏi trạng thái task ở đúng host đó trả 403 → phải poll qua host vùng công khai
  (`DASHSCOPE_POLL_URL`). Key cấp theo workspace nên host cũng riêng theo workspace.
- **Nghe đúng chữ hơn whisper-1 rõ rệt** trên nội dung 修真 (`灵石` vs "零食", `三阶` vs `三界`,
  `内丹` vs `内胆` — whisper sai dù đã mồi qua `STT_PROMPT`). Đổi lại timestamp trễ hơn ~0.35s.

**Cụm giọng của filetrans: "vỡ vụn" KHÔNG phải hỏng.** Comment cũ trong `.env.example` chê nó
"loạn" (10 cụm cho 3 vai) — đo lại trên hai tập 黑神话小钻风 thì sai ở chỗ quan trọng nhất:
**độ thuần cụm 92% và 95%**, gộp nhầm gần như không xảy ra; lỗi thật chỉ là một người bị tách
nhiều cụm, mà vỡ vụn thì vô hại (chỉ cần đặt tên cho từng mảnh). Chế độ hỏng duy nhất còn lại là
cụm 2 câu chứa đúng 2 người. Vì vậy cụm giọng là **xương sống** của khâu gán người nói.

### Nhãn người nói không cố định xuyên suốt cả bộ — chấp nhận

Diarize gán nhãn theo từng file. Từng thử `known_speaker_references` (đăng ký mẫu giọng để nhãn
trả về cố định — đã kiểm chứng chạy được thật) nhưng bỏ: cơ chế đó gắn với giọng của một bộ cụ
thể, đổi bộ là vô nghĩa, lại thêm bước thủ công mỗi lần đổi nguồn. Danh tính xuyên suốt giờ do
**bible của zhvi** lo, không do ASR lo.

### Tách vocal trước khi gửi diarize — đã thử, bỏ

Demucs `--two-stems=vocals` rồi gọi diarize lại: coverage **81.6% → 97.3%** (+35.7s), không tăng
chi phí API. Nhưng Demucs chạy CPU tốn vài phút mỗi video → nhân với hàng trăm video thành cổ
chai của cả pipeline, đổi lấy 15.7 điểm % coverage cho riêng nhãn người nói. `src/vocals.js` và
`scripts/compare-diarize-bgm.js` vẫn còn trong repo, không import ở flow chính.

### So engine (`npm run compare`)

**Căn cứ chính là phần diff, không phải bảng điểm.** In hai bức tường ~460 ký tự chữ Hán cạnh
nhau rồi tự nhìn thì đó là đoán, không phải so sánh. Lệnh chỉ hiện đúng chỗ hai engine nghe khác
nhau, kèm ngữ cảnh — video mẫu ra 35 điểm:

```
  …住了成了下⟨品⟩宝剑威力至…        …况掌柜有三⟨阶玉⟩寒袍吗前辈…
  　　　　　 ⟨瓶⟩   ← whisper-1     　　　　　 ⟨节御⟩   ← whisper-1
```

Điểm cuối là ví dụ hay: whisper nghe đúng `御寒袍` còn gpt-4o nghe đúng `三阶` — **hai model bù
nhau chứ không cái nào trội hẳn**.

**Điểm theo glossary là thước đo phụ, và đã đo là YẾU**: `glossary.json` 151 mục chỉ phủ 3/12 từ
phân định trên video mẫu, nên ra 14 vs 13 sát nút trong khi diff cho thấy hơn kém rõ ràng. Giữ
lại vì đó là con số tuyệt đối duy nhất có được mà không phải ngồi nghe lại 227 giây audio.

---

## Gán người nói — ba kênh

| Kênh | Dùng để | KHÔNG dùng để |
|---|---|---|
| cụm giọng (filetrans) | nhóm "cùng giọng", lan nhãn | biết ai — nó không biết |
| hình (VLM, vài lời gọi/tập) | **đặt tên cho cụm** | trả lời từng câu (một mình 59–70%) |
| text (pass B) | **tố cáo** câu nghi | gán nhãn (sai 6/20 ở câu khó) |

Nền (cụm + tên VLM) = **92% và 95%**; VLM đặt tên cụm **đúng 9/9** ở tập 9 cụm, kể cả cụm 2 câu.
Bật kênh hình đưa câu cần người soi từ **30/46 xuống 4/46**. Danh sách nghi ~15% số câu. Lỗi mù
(ba kênh cùng khớp mà vẫn sai): **0/6 câu đã kiểm** — mẫu còn mỏng.

Chi phí VLM (qwen-vl-max, ảnh 768px): 1.810 token/câu ở 4 khung, 3.162 ở 8 khung. Cấu hình sản
xuất (chỉ gọi mỏ neo + câu nghi) **~$0,02–0,03/tập, ~$0,35 cho series 13 tập**.

### Bốn bẫy

- **Số khung gửi VLM có ảnh hưởng thật**: 1 khung 23/50 → 4 khung 31/50 → 8 khung 34/50. Nhưng
  hỏi "một phán quyết cho cả 8 khung" thì cảnh chèn (tranh thuỷ mặc, cận vật) pha loãng khung tốt
  → VLM từ chối oan. Phải hỏi *"chỉ cần MỘT khung thấy mặt cử động miệng thì trả lời người đó"*.
- **Phiếu VLM lệch ở cụm TO không có nghĩa là cụm lẫn người** — đó là cảnh phản ứng (máy quay
  chiếu mặt người nghe). Chỉ kết luận `split` ở cụm ≤3 câu. Luật đầu tiên (á quân ≥2 phiếu) đẩy
  61% số câu cho người soi.
- **`look` phải tả chỗ KHÁC nhau.** 白骨夫人 và 玉面狐狸 đều "váy trắng" → VLM chia phiếu 3–2;
  sửa thành "có đuôi cáo trắng to" vs "đội mũ miện xương, không đuôi" → 4–1 và `confirmed`. Đòn
  bẩy rẻ nhất để tăng độ chính xác.
- **zhvi ăn lại đầu ra của chính nó.** `--data-dir` ghi tên nhân vật đè lên `transcript.json:
  speaker`; chạy lần hai thì pass A tưởng "小钻风" là một cụm giọng và xương sống pass B biến mất
  **không báo lỗi**. Vì thế `clusterLabels()` luôn lấy cụm từ `qwenSpeakerId` — trường của
  filetrans, không ai ghi đè lên.

**Nhãn do LLM suy từ text KHÔNG phải chuẩn vàng** (`speakerSource: "zhvi"` sai thật sự ở nhiều
câu đã soát). Chuẩn thật phải soi khung hình + nghe tiếng.

**Đã loại: chuỗi CV cục bộ.** InsightFace (SCRFD+ArcFace) + chấm khẩu hình: **0,8 khung/s trên
CPU = 53 phút/tập** (~11 tiếng cả series); onnxruntime-gpu không nạp được CUDA trên RTX 3050 của
máy này. Hướng 3 kênh vừa rẻ vừa chính xác hơn.

---

## zhvi — dịch cả bộ

Chi tiết cách dùng ở `src/zhvi/README.md`. Phần lý do:

- **Một prompt dịch thẳng không đạt**: qwen3-max lẫn chữ Hán vào 4/30 dòng tiếng Việt (`凭什么`,
  `围剿`, `认定`) và **dịch trung thành lỗi ASR** → phải tách pass repair zh→zh trước khi dịch.
- **qwen-mt-plus vs qwen3-max bù nhau, không thay nhau**: MT không bao giờ code-switch nhưng dịch
  từng câu rời nên thuật ngữ trôi (死劫 ra 3 kiểu); qwen3-max giữ mạch tốt nhưng code-switch.
- **Đơn vị công việc là TẬP, không phải file gộp.** Chạy trọn file 47 phút (11 tập) ra bản dịch
  tệ, nhưng code không thoái hoá: diarization gom cả 47 phút vào **3 cụm giọng cho ~20 nhân vật**
  → 263/542 nhãn thành chuỗi rác, bảng xưng hô chỉ phủ 1 cặp. STT lại từng tập ra 2–9 cụm/tập.
- **Lỗi còn lại sau v5 là dao động giữa các lần chạy, không phải lỗ hổng prompt.** Chữa bằng cách
  ghim `terms.json` (thắng cả glossary), không phải bằng cách thêm luật vào prompt.

### Pass A trả thao tác có kiểu, không trả bản viết lại

Hợp đồng "viết lại kịch bản" là lỗi **thiết kế**, không phải lỗi model: bản viết lại không có neo
cấu trúc nên mỗi kiểu hỏng lại phải thêm một bộ dò riêng (đã phải thêm 5 bộ), và cả 3 model đều
dính — `qwen-plus` từng **xoá trọn một câu 22 chữ** mà bất biến `zh_raw` vẫn khớp 100%; bản gộp
ra **101,3% chữ Hán**. Mọi benchmark pass A phải đo **tỉ lệ giữ chữ Hán**, không chỉ đếm "sửa
đúng mấy chỗ".

Đổi sang `{"ops":[…]}` (`split`/`merge`/`replace`/`punct`/`speaker`/`note`) để code áp lên nguồn:
mất câu, lặp câu, chèn bình luận thành **không thể xảy ra**. Đo trên `7658103101886434560`, ổn
định 3/3 lần: giữ chữ 100%, sửa đúng 6/6, **phá 0/8** chỗ vốn đúng, **540–614 token ra (cũ
7.542), 12s (cũ 138s)**.

- `replace` phải khai được kiểu: gần âm (so trên **phần khác nhau** sau khi cắt đầu/đuôi giống —
  so cả chuỗi thì `东西→宝物` được 0.79, cao hơn cả bản sửa đúng) hoặc đổi đại từ.
- Vòng rà bổ sung dùng `phon.suspects` lúc đầu **phá 6/8** chỗ đúng. Phải có ĐỒNG THỜI hai ràng
  buộc: vị trí ký tự giống nhau **và** ranh giới từ (jieba nạp sẵn từ vựng bible).
- Rào chắn `kindOf` loại 15/52 thao tác trong một lượt thật — không phải lỗi: `qwen-plus` đòi
  `哪里→何处`, `伙伴→臂助`, tức đổi nghĩa cho "cổ trang hơn", không phải sửa chỗ nghe nhầm.
- `qwen-flash` phát 40 op bịa → không dùng được cho pass A.

### Pass B: model phải trích số dòng làm bằng chứng

Code mở đúng dòng đó kiểm. Trước đó model tự luận ra đáp án đúng rồi tự cãi lại mình trong ô
`why`. Luật cú pháp code tự kiểm được: tên đứng đầu câu trước dấu phẩy («大王，计划出了意外») là
GỌI người khác, không phải tự xưng. **Đừng thêm luật "người bị gọi tên phải nói trong ±2 dòng"**
— đã thử, sai, người ta đáp muộn hơn.

### Cổng người soát (B.5)

Pass C ăn `sheet`, `sheet` dựng từ `speakerMap` → sai người nói ở đây thì tiền dịch mất trắng và
xưng hô sai lan ra cả tập. Vì vậy cổng mặc định BẬT.

- **Chưa có bible thì cổng luôn dừng**, kể cả khi máy không thấy gì đáng ngờ — đường không-bible
  không có kênh hình lẫn trang soát nên "không thấy gì" ở đó không có nghĩa là chắc. Trước đây
  chính chỗ này mở lặng lẽ.
- **Cổng chỉ chặn một lần** (có `ep<N>.speakers.json` là coi như người đã nhìn). Không có luật
  này thì cổng chặn mãi: đo trên tập 2, chốt 1 cụm + 1 câu đưa bảng xưng hô từ 0 lên 2 cặp và câu
  cần soi từ 8 xuống 6, **không về 0**.

### Checkpoint theo chữ ký nội dung

sha256 của đúng những đầu vào mỗi công đoạn khai. **Không có bảng phụ thuộc** — dây chuyền đổ
theo nội dung, nên chạy lại mà ra kết quả y hệt thì không kéo theo gì cả.

- **Công đoạn miễn phí không bao giờ checkpoint** → sửa bible, sửa nhãn xong chạy lại là thấy
  ngay, không phải nhớ xoá cache.
- **`load` được quyền từ chối cache dù chữ ký khớp.** `B1` dùng quyền đó để đối chiếu mốc thời
  gian từng câu đã hỏi — chỗ này đã sai lặng lẽ một lần: pass A tách lại câu làm id trôi, phán
  quyết của câu này bị gán cho câu khác, không lỗi nào nổ ra.
- Tên model nằm trong chữ ký → đổi `ZHVI_*` là công đoạn đó chạy lại; quên đặt biến một lần là
  trả tiền lại một lần.

### Model

- **Critic phải khác nhà với model dịch**: `qwen-max` chấm bản của `qwen3-max` 5.00/5 trong khi
  soát tay ra 8 lỗi thật; `deepseek-chat` chấm cùng bản đó 4.65 và trúng lỗi. Đo lại 2×2: critic
  nào cũng chấm gắt hơn với bản của nhà mình. (Hiện critic **cùng nhà** với render — có chủ ý, vì
  cấu hình DeepSeek rẻ hơn 5× và chấm mù không kém; biết là đang đánh đổi.)
- **DeepSeek thay Qwen cho C/D**: chạy trọn 4 tập, chấm mù 3 tập — **~$0,03/tập so với ~$0,17**
  mà không kém. Tiền nằm ở bước fix nên chỉ fix mới được nghĩ.
- **`max_tokens` của DeepSeek tính CẢ token nghĩ**; đặt thấp là nghĩ hết ngân sách rồi trả content
  **rỗng** — lỗi này đi đúng nhánh "giữ nguyên bản đưa vào", nhìn từ ngoài y hệt một lượt soát
  sạch sẽ. Sàn: tắt nghĩ ≥16k, bật nghĩ ≥128k. Rỗng → nhân đôi trần gọi lại; rỗng lần hai → hạ
  effort về `none`.
- **`reasoning_effort` phải ở cấp gốc request** — nhét trong object `thinking` thì DeepSeek bỏ
  qua lặng lẽ và vẫn nghĩ 37k token.
- 401/403 ném ngay, không gọi lại (gặp thật: `qwen-vl-max` hết quota free 2026-09-14 → `vision`
  chuyển sang `deepseek-flash`). Lượt hỏng vẫn ghi vào `usage.json` vì nó thật sự bị trừ tiền.
- **Provider `queue@…`** (hàng đợi task, bật bằng `ZHVI_CAST`/`ZHVI_FIX`): chạy trọn ep05 —
  chất lượng **hoà** với DeepSeek, chậm thêm ~12 phút/tập, tiết kiệm ~$0,08. Không bật mặc định.
  Không dùng được cho vision (không nhận ảnh).

### Bible / series init

- Lượt gộp nhân vật **không ổn định giữa hai lần chạy** (đo trên 4 tập: 10 vs 9 nhân vật, tên
  nhân vật chính khác) → phải cache trong `draft/`.
- Trang duyệt ghi **giá trị cuối của mọi ô** chứ không chỉ ô đã sửa → `apply` bao nhiêu lần cũng
  ra cùng một bible.
- `look` là bằng chứng gộp: đo được hai mục máy tách riêng mà look tả đúng đặc điểm của nhân vật
  khác ("có đuôi trắng lớn" = Ngọc Diện).
- Chưa làm: bổ sung tập mới vào bible **đã có** (`init` từ chối khi đã có `bible.json`).

### Trang duyệt bible: hỏi gì thì phải đưa đủ bằng chứng cho cái đó

Ba chỗ sửa 2026-09-19, đều là "hỏi mà không đưa đủ thứ để trả lời":

- **Câu mẫu lẻ không phán được gì.** Mỗi câu mẫu giờ mang theo 2 câu trước + 2 câu sau, cắt ở
  khoảng lặng > 6s (đã sang cảnh khác), dịch thô cả cảnh. Và chọn câu mẫu theo **câu gọi tên /
  nhắc tên** thay vì câu DÀI NHẤT: câu dài nhất gần như luôn là độc thoại. Đo trên hai series có
  sẵn — trước ra `听说你眼睛失明了，我恨自己…` (độc thoại 4 dòng), sau ra `冷清秋，你看看这份文件`,
  `青丘，你别激动…是你的好老公顾言`, `婉儿，顾言这个渣男…`, tức lộ ngay quan hệ.
- **Ảnh tĩnh không phân biệt được người NÓI với người NGHE** — đúng chỗ VLM tả nhầm (xem
  `lookGender`). Thêm nút xem đúng đoạn video. **Không nhúng video vào HTML**: trang đã 1,55–2,76 MB
  chỉ với ảnh + mp3 40 kbps. Phát thẳng `video.mp4` gốc, `file://` đi đường dẫn tương đối, qua UI
  đi `/media/…`; tập thiếu `video.mp4` thì không vẽ nút chết.
- **Máy bỏ sót một nhân vật là ngõ cụt thật**: trang soát người nói từng tập chỉ cho chọn trong
  `bible.cast` (`review.js`: `opts = bib.cast.map(c => c.zh) + ["ngoài khung","nhiều người","không rõ"]`),
  nên không thêm được ở bible thì cả loạt tập sau không có đường. Thêm mục "Thêm nhân vật" + bằng
  chứng (cụm giọng chưa ai nhận: nghe + xem cảnh) + danh sách tên bị gọi trong thoại để **chọn**,
  vì fleex không gõ được chữ Hán.

Hai ràng buộc phải giữ khi sửa tiếp trang này:

- **Bible KHÔNG giữ cụm giọng.** `applyReview` ghi cast gồm id/zh/vi/viShort/gender/role/alias/
  note/look — không có `clusters`; ánh xạ cụm→nhân vật là việc của pass B và cổng soát từng tập.
  Đừng đưa "gán cụm giọng" lên trang bible: cụm thuộc về TẬP, không thuộc về bộ.
- **Nhân vật thêm tay để trống tên chữ Hán thì khoá lấy luôn tên Việt.** Nó không bao giờ khớp
  chữ trong thoại → kênh "gọi tên" của pass B im lặng: không đúng thêm được gì, nhưng cũng không
  gán bừa. Luật "trang ghi giá trị cuối của MỌI ô" vẫn giữ (đã đo: áp hai lần ra cùng `version`),
  nên hàng thêm tay bỏ trống phải bị bỏ qua ở `applyReview` chứ không thành nhân vật rỗng.

### Bẫy prompt đã đo

Gửi block `ĐÃ DỊCH TRƯỚC ĐÓ (đừng dịch lại)` kèm nội dung rỗng kiểu `(đầu phim)` làm qwen3-max
tưởng các câu đầu danh sách đã dịch và **bỏ đúng id 0–11** (2/2 lần ở lô 49 và 24 câu, không lộ ở
lô 12 câu). Triệu chứng "model trả thiếu id" dễ bị chẩn đoán nhầm thành "phải chia lô nhỏ" —
chia lô chỉ che lỗi.

### `@node-rs/jieba`

Không có `insertWord`, và `loadDict` **thay** từ điển chính chứ không bổ sung — gọi thẳng thì mọi
thứ bị cắt thành từng chữ và danh sách nghi ngờ vỡ. Phải nối từ vựng phim vào sau `dict.txt` của
package rồi dựng lại Jieba.

---

## Đường dịch cũ (`npm run translate`)

Vẫn chạy được; giữ vì là nơi có các số đo về prompt/glossary/provider.

### Chia lại theo segment mà vẫn giữ ngữ cảnh

Đánh số từng dòng rồi gửi cả cụm trong một request. Tách hỏng thì tự chia đôi thử lại, cuối cùng
mới dịch từng dòng riêng — và ghi `alignmentWarnings`.

- **Segment rỗng phải loại trước khi gửi.** whisper thỉnh thoảng trả segment rỗng (đo 1/94).
  Dòng rỗng thì cơ chế tách theo số không bao giờ thoả được → kéo cả cụm vào chuỗi chia đôi tới
  tận 1 dòng. Đã xảy ra thật: `55 → 28 → 14 → 7 → 4 → 2`, tức **13 lời gọi API cho payload 630
  ký tự**, dòng rỗng nhận về câu từ chối của model và các segment lân cận ra **phiên âm Hán-Việt**.
- **Gộp segment liền mạch trước khi dịch.** whisper cắt theo chunk chứ không theo câu nên hay
  chặt đôi giữa từ (đo: `昨日` thành `…出事,作` + `日有…`, cách nhau đúng **0.00s**) — nửa chữ nằm
  ở dòng khác thì dòng này buộc phải dịch sai, thêm bao nhiêu ngữ cảnh cũng vô ích.
  `TRANSLATE_MERGE_MAX_GAP_SEC=0.2` để **chặt là chủ ý**: nới lên là gộp qua khoảng lặng thật,
  TTS đọc liền một hơi thì tiếng dub lệch khỏi hình. Nối text phải **không có dấu cách** khi hai
  bên là chữ Hán.
  Giới hạn: phép gộp chỉ tin nhãn diarize, hai người bị gán cùng nhãn thì vẫn bị gộp.
- **Cỡ cụm 4000 ký tự không tuỳ tiện.** Nó sinh ra từ giới hạn ô nhập translate.google.com,
  nhưng đo lại trên `deepseek-2pass` (179 đơn vị / 5715 ký tự) thì LLM còn chặt hơn:

  | Cỡ cụm | Dòng còn chữ Hán |
  |---|---|
  | 1 cụm / 179 dòng | **179/179** |
  | 2 cụm / 116+63 dòng | **0/179** |

  Gửi 179 dòng một lượt thì `deepseek-chat` **bỏ dịch và quay ra biên tập tiếng Trung**. Không
  phải context window (64K, thừa chỗ) — là mất bám nhiệm vụ khi danh sách đánh số quá dài. Vì thế
  trần tách làm hai: `TRANSLATE_MAX_CHARS` (ô nhập Google) và `TRANSLATE_MAX_CHARS_LLM` (sức chịu
  của model).
- **Cụm nhỏ phải mang theo bối cảnh**: cụm càng nhỏ càng trơ trọi, LLM mất mạch thì quay ra phiên
  âm. Khi chia đôi, mỗi cụm con nhận kèm tối đa 6 dòng lân cận (ghi rõ **không dịch**); cụm 1
  dòng ở đáy vẫn giữ đánh số.
- **Bản đồ người nói dựng lại theo từng cụm con** — hint ghi theo số dòng mà mỗi cụm đánh số lại
  từ 1. Thiếu một chỗ là gán người nói lệch dòng mà không có dấu hiệu gì.

### Model trả lại nguyên tiếng Trung, giao thức đánh số không phát hiện được

Video 43 dòng / 1180 ký tự, xa mọi trần: `deepseek-chat` trả đúng 43 dòng đánh số **toàn bộ bằng
tiếng Trung**, đã chuẩn hoá lại. Cả 3 lượt nháp → review → polish đều thế. Điều tệ nhất không
phải model làm sai mà là **pipeline không biết** — output "đúng định dạng" nên được nhận, chỉ để
lại một dòng cảnh báo lẫn giữa log.

Ba nguyên nhân, sửa cả ba:

1. **Prompt không có chỗ nào phát biểu nhiệm vụ** (mở bằng vai diễn rồi đổ ~40 dòng quy tắc văn
   phong; động từ duy nhất `Dịch sang vi` nằm lẻ loi). Giờ có `translateTask()` đặt ngay sau vai
   diễn, kèm **tiêu chí SAI rõ ràng**.
2. **Giao thức đánh số cho phép "y hệt input" là hợp lệ** → đổi sang JSON Mode. Không phải vì
   JSON hiểu tiếng Việt hơn, mà vì nó ép output ra khỏi hình dạng đầu vào và cho một lỗi **phân
   biệt được**.
3. **Hai lượt hậu kỳ không có luật xử lý bản nháp hỏng** → mở đầu bằng "nếu một dòng còn nguyên
   tiếng Trung thì DỊCH nó".

Kết quả cùng model, cùng cụm 43 dòng: trước 1180 → 1180 ký tự, 43/43 dòng chữ Hán; sau 1180 →
3616 ký tự, **0/43**.

⚠️ **`json_object` của DeepSeek KHÔNG nhận schema** (chỉ `text` hoặc `json_object`, không có
`json_schema` như OpenAI) — chỉ đảm bảo JSON hợp lệ cú pháp. Nên hình dạng chỉ tồn tại ở hai chỗ,
đều trong prompt: mô tả khoá, và cặp `EXAMPLE INPUT`/`EXAMPLE JSON OUTPUT`. Doc đòi đủ 3 điều
kiện mới chạy (bật `response_format`, prompt có chữ `json`, prompt có ví dụ JSON) — thiếu một là
content rỗng. Vì hình dạng chỉ định nghĩa bằng ví dụ nên **ví dụ phải cùng dạng với đầu vào thật
của lượt đó**. `jsonOutput.js` tự kiểm: có phải JSON không, có mảng `translations` không, đúng số
phần tử không.

Provider nào đi đường nào: `openai` dùng Structured Outputs (strict); `deepseek*` dùng JSON Mode;
`qwen` và `google-*` vẫn đi giao thức đánh số. **Qwen để nguyên là chủ ý**: DashScope
compatible-mode có thể lặng lẽ bỏ qua tham số lạ, mà bỏ qua thì mọi cụm parse hỏng và bước dịch
tự chia đôi tới đáy.

### ⚠️ Google phục vụ hai model qua cùng một giao diện

| Lần chạy | Cùng URL, cùng nội dung |
|---|---|
| Lần 1 | *"Giết người phóng hỏa mới mau giàu" — con đường đó chưa bao giờ dành cho ta* |
| Lần 2 | *"đai vàng giết người đốt lửa không thể kế vị được ta"* |

Model LLM (tốt) bị giới hạn tần suất, dùng vài request là tụt xuống NMT đời cũ. Đã loại trừ từng
giả thuyết: không phải `sl=auto` vs `sl=zh-CN`, không phải locale trình duyệt, không phải cỡ cụm
(3/5/10/20/39 dòng ra kết quả y hệt), không phải glossary, không phải inline marker.

Không có dấu hiệu nào trên trang → pipeline chèn **câu mồi vào đầu payload thật**. Câu mồi phải
đi **cùng** payload: đã thử hỏi riêng một request trước và hỏng — chính câu thăm dò đốt mất suất
model tốt, canary báo "ổn" trong khi bản dịch nhận về là bản tệ.

### Glossary

Thay thuật ngữ bằng placeholder `⟦n⟧` trước khi dịch rồi khôi phục sau, nên **dùng được với cả
provider không nhận chỉ dẫn**. Ba chỗ phải xử lý riêng, đều là bug đã gặp thật:

- Placeholder bọc trong dấu cách, không thì tiếng Trung viết liền làm thuật ngữ dính vào từ bên
  cạnh: `tiền bốiĐùa thôi`, `Kim Đanold`.
- Khi khôi phục phải nhận mọi kiểu ngoặc, vì LLM "chuẩn hoá" `⟦0⟧` thành `[0]` → lọt nguyên ra
  bản dịch: `cao thủ cấp [0] hậu kỳ`.
- Hoa/thường quanh chỗ thay: model không thấy chữ trong `⟦n⟧` nên viết hoa từ ngay sau —
  `前辈去而复返` ra `tiền bối Đi rồi lại về`. Placeholder **đầu câu** được viết hoa và chữ ngay
  sau hạ xuống; placeholder **giữa câu** để yên (chữ hoa ở đó có thể là tên riêng thật).

**Hai cờ, không phải một**: `hasGlossary` (có tri thức thuật ngữ) và `hasPlaceholders` (có cơ chế
bọc) tách riêng, để A/B được `protect()` mà vẫn giữ bảng thuật ngữ. Bản đầu gộp làm một nên tắt
cơ chế là mất luôn ràng buộc thuật ngữ, không quy được trách nhiệm.

**Bẫy đo đạc**: bật/tắt glossary lệch nhau 21/43 dòng, nhưng chạy **hai lần cùng cấu hình** cũng
lệch 22/43 — nhiễu của `deepseek-2pass` lớn ngang hiệu ứng cần đo, nên đếm số dòng khác nhau là
vô nghĩa. Phải so đúng những dòng **có chứa thuật ngữ**: ở đó 8/9 lần thuật ngữ vẫn ra đúng khi
TẮT, và 1 lần còn lại bản TẮT **đúng hơn** (`老朽` ghi hoa trong glossary nên bị nhét vào như tên
riêng, trong khi nó là đại từ tự xưng khiêm nhường).

Glossary 271 mục có lỗi thật: `一个时辰`="Nhất Thời Thần" (phải là "một canh giờ"), `乾坤袋`=
"càn khôn đại", `三阶`="tam phẩm" (阶=giai), và vài mục là từ thường (`明白`, `功能`) sẽ bẻ câu ở
ngữ cảnh khác. Có mục dùng glossary để vá lỗi ASR — việc đó thuộc pass repair.

### Provider và `deepseek-2pass`

Cột quyết định là **Speaker**: nhãn người nói đi vào system prompt, mà dịch máy không có system
prompt → chạy Google nghĩa là vứt toàn bộ kết quả diarize và mất xưng hô đúng (`前辈可去…` ra
"Bạn có thể…").

Ba lượt của `deepseek-2pass` dùng ba model khác nhau vì cần ba thứ khác nhau. Đo trên **cùng một
bản nháp cố định** (22 dòng, 4 lỗi nghĩa đã soát tay):

| Model làm lượt review | Thời gian | Đổi dòng | Ca đúng | Token nghĩ |
|---|---|---|---|---|
| `deepseek-chat` | 3.9s | **1/22** | 1/4 | 0 |
| `qwen3-max` | 9.6s | 4/22 | 1/4 | 0 |
| `deepseek-v4-flash` | — | — | — | 32.767 rồi trả **rỗng** |
| `deepseek-v4-pro` | 377.1s | 6/22 | **3/4** | 21.677 |

Lượt review chạy bằng model **không suy luận** thì gần như không làm gì. **Log giờ đếm số dòng
THỰC SỰ đổi** — trước đây chỉ in độ dài ký tự trước/sau, mà một lượt no-op hoàn toàn vẫn in ra
hai số bằng nhau trông rất bình thường; đó là lý do lượt review vô dụng suốt một thời gian dài
mà không ai thấy.

**Còn chưa giải được**: `差点憋` + `死` bị ASR xẻ đôi ở khoảng cách 0.0s rồi gán nhầm hai người
nói → bước gộp (chỉ gộp khi cùng người nói) không ghép lại được.

### Bản dịch lỗi thời sau khi transcribe lại

Có mặt file là chưa đủ: `stt --force` đặt status về `transcribed`, `translate` nhặt lại video đó
rồi thấy `translation.json` nằm sẵn là bỏ qua → transcript mới đi cùng bản dịch cũ. Giờ bước
chống trùng **đối chiếu nội dung**: số segment, từng `zh`, và cả `speaker`.

### `google-2pass` — giữ để so sánh, không dùng thật

Gửi cho Google **nguyên khối văn xuôi không chia dòng** (gửi kiểu đánh số khiến Google dịch rời
rạc từng dòng, mất mạch văn); bản dịch đó chỉ đóng vai **tham khảo**, OpenAI luôn tự dịch lại bản
gốc. Giảm anchoring bias so với polish-theo-dòng nhưng không loại bỏ hẳn. Cơ chế canary không
dùng được ở đây vì câu mồi bị gộp chung vào khối văn xuôi.

---

## Lồng tiếng

### Hai quyết định thiết kế

**1. Chọn clip mẫu theo ĐỘ GIỐNG, không theo độ dài.** Biến ảnh hưởng lớn nhất trong cả chuỗi —
lớn hơn engine, lớn hơn TTS nguồn, lớn hơn mọi núm của voice conversion. Cùng một nhân vật: clip
dở 83% đọc đúng, clip tốt 97%. Script chấm cosine giữa từng clip và `all.wav` của chính nhân vật
(resemblyzer) rồi lấy điểm cao nhất trong khung 3–5,5s.

Kết luận này đã **lật một kết luận trước đó**: lượt đo đầu (mẫu tiếng Trung 81–83% vs tiếng Việt
91–93%) khiến cả hai bên tin VieNeu không clone được từ mẫu tiếng Trung. Sai — probe khi đó chọn
clip theo độ dài và trúng clip không đặc trưng. Chọn lại theo độ giống: **97–99%**.

| mẫu + engine | đọc đúng | giống 悟空 |
|---|---|---|
| **`02.wav` + v3** ← chốt | **97%** | **0.898** |
| `13.wav` + v4 | 99% | 0.811 |
| mẫu vi (seed-vc) + v4 | 93% | 0.866 |
| seed-vc trực tiếp | 95% | 0.863 |

`v4` đổi âm sắc lấy phát âm; **`v3` giữ âm sắc tốt hơn**.

**2. KHÔNG ép câu tiếng Việt vừa khung tiếng Trung.** Trọng âm và nhịp ngắt của hai thứ tiếng
khác nhau, không có ánh xạ 1:1 — co giãn audio cho khớp khung là tự tay tạo ra giọng gượng, đúng
thứ đang phải chữa. Mỗi câu đặt đúng mốc **bắt đầu** rồi chạy độ dài tự nhiên; chỉ khi lấn sang
câu kế mới nén, có trần `--max-tempo` 1.15. Nén hết trần vẫn lấn thì **không cắt**, mà báo ra để
rút gọn bản dịch — sửa ở câu chữ luôn tốt hơn sửa ở tín hiệu.

Bài toán có thật: trên một bản dịch mẫu, trung vị **16,2 ký tự vi/giây**, 22/43 segment >16/s,
9/43 >19/s (max 25,7).

### Rate-limit: đã đo hai lần, đừng thử lại song song `/clone`

- `concurrency=5`: 429 dày tới mức hết retry budget → crash.
- backoff nới + `concurrency=2`: không crash nhưng **27 lần 429/194 câu**, tốc độ thực tế
  **~8 câu/phút, TỆ HƠN ~17 câu/phút của tuần tự** — phần lớn thời gian nằm ở chờ backoff.

Code `pool()` vẫn còn (cờ `--concurrency`), chỉ là phải để 1. Đường song song duy nhất là
`/tts` + giọng đã enrol: đo **35,1 câu/phút, 0 lần 429** — nhưng gói chỉ có **5 slot giọng
clone**, và clip enrol cần 6–15s (luật mật độ transcript ~3,1–28 ký tự/giây; câu gào/kéo dài
không bao giờ enrol được).

**`/dialogue` đã thử và LOẠI**: trả `400 Cloned voice … can only be used on POST /v1/tts` — chỉ
dùng được giọng preset. Nó cũng không mang ngữ cảnh giữa các turn như từng giả định (server
render từng turn rời rồi dán silence số 0 vào giữa; đo khoảng lặng 1.697 = pause 1.5 + đuôi
0.197). Đừng đề xuất lại cho dub có clone.

### Hai bẫy API, đều đã sập một lần

- `audioUrl` của `/clone` được ký **trước khi** object ghi xong lên S3 → tải ngay thì nhận XML
  `NoSuchKey` mang status 200, ffmpeg tới tận bước sau mới báo "Invalid argument". Phải kiểm 5
  byte đầu, thấy `<?xml` thì đợi rồi thử lại.
- `GET /tts/{jobId}` lúc vừa `completed` có thể trả `audioUrl` là **đường dẫn nội bộ tương đối**
  (401 kể cả có Bearer); poll lại vài giây sau mới ra URL S3 ký sẵn. Chỉ nhận `audioUrl` bắt đầu
  bằng `http`.

Khác doc: `GET /v1/engines` lúc đo cho v4 multiplier 2 (doc ghi 3.4), `globalMultiplier` 1.3;
v4 bỏ qua `emotion` và chỉ giữ 3 cue `[cười] [thở dài] [hắng giọng]`.

### Vì sao ghép hết rồi mới chạy demucs

demucs là neural net CPU, chi phí gần tỉ lệ **tổng số giây** và có overhead cố định mỗi lần gọi —
gộp 19 đoạn thành 1 file ~70s rẻ hơn nhiều so với 19 lần gọi, và rẻ hơn hẳn tách cả file gốc 10
phút rồi mới cắt.

### Các đường đã loại

| Đường | Vì sao |
|---|---|
| `qwen-audio-3.0-tts-plus` | đọc được tiếng Việt nhưng **chỉ 2 giọng hệ thống** — tập 8 nhân vật là giọng lặp |
| CosyVoice v3/v3-plus | **không có tiếng Việt**; bản v3.5 có thì `Model not exist` ở ap-southeast-1; `cosyvoice-v3-plus` trả `AccessDenied.Unpurchased` |
| `qwen3-tts-*`, `qwen-audio-3.0-tts-flash` | không có tiếng Việt. Kiểm bằng round-trip: cho ASR nghe lại bản TTS — `-plus` trả về nguyên câu đủ dấu, `-flash` trả về tiếng Trung vô nghĩa |
| Alibaba `voice-enrollment`, `qwen3-tts-vc` | 403 / không có tiếng Việt |
| seed-vc | trần âm sắc ~0,86 trong khi clip thật 0,90–0,95 — đúng khoảng cách nghe ra là "không giống nhân vật gốc". VieNeu clone thẳng đạt 0,898 mà bỏ được cả một tầng local. **V2 tệ hơn V1** (0,79–0,84 vs 0,855–0,861), đừng thử lại |
| TTS của OpenAI | không có voice cloning, 13 giọng cố định (đọc tiếng Việt tốt — vẫn là phương án nếu bỏ yêu cầu giống giọng gốc) |

**Độ tự nhiên: chưa đường nào giải được.** Chấm mù 5 lượt: giọng gốc **4,35**; VieNeu zh02-v3,
seed-vc và VieNeu vi-v4 **hoà nhau ở 3,2–3,3**. VieNeu thắng nhờ âm sắc và nhờ đơn giản, không
phải nhờ tự nhiên hơn.

**Gotcha chung của DashScope TTS**: voice không dùng lẫn giữa model được (`longanlufeng` sang
`-flash` trả `400 InvalidParameter` mà thông điệp **không hề nhắc tới voice**), và endpoint
**lặng lẽ nuốt field lạ** (`language_hints`, `word_timestamp_enabled` đều trả 200 không tác dụng)
— một cái 200 không phải bằng chứng tham số đã làm gì.

---

## Vận hành

### `src/apiLog.js` — mọi lời gọi ra ngoài đi qua đúng một chỗ

In request đầy đủ trước khi gọi và response đầy đủ sau khi gọi, **kể cả khi lời gọi ném lỗi**.
Mặc định ở mức `debug` (batch 122 video với `LOG_LEVEL=info` sẽ ẩn; không có cái này thì in ra
vài trăm nghìn dòng). Bật: `LOG_LEVEL=debug` hoặc `API_LOG_LEVEL=info`.

Ba thứ nó làm tập trung — đừng tự in JSON ở call site mới:

- **Che khoá** (`Authorization`, `*ApiKey`, cookie). Cố ý **KHÔNG** che `prompt_tokens`/
  `completion_tokens`: đó là số để tính tiền.
- **Cắt payload nặng, từng chuỗi một** nên chỉ chỗ nặng bị cụt. Khối **base64** luôn cắt còn 48
  ký tự **kể cả khi `API_LOG_MAX_CHARS=0`** (một lời gọi qwen-asr là 1.6 triệu ký tự).
- **Mô tả thứ không stringify được** (stream, Blob/File, FormData, Buffer) thành
  `⟨file audio.m4a, 1234 byte⟩` thay vì `{}`.

Không thấy log API khi chạy `stt --force` là **đúng thiết kế**: `--force` không gọi lại API.

### `npm run doctor` — chạy TRƯỚC KHI đoán

**`Connection error` của OpenAI SDK thường không phải lỗi mạng.** Khi request đầu nhận lỗi API
thật (429 hết credit, 401 key sai), các lần retry sau rớt kết nối và thứ nổi lên là
`APIConnectionError` — nguyên nhân thật bị chôn mất. Càng đặt `STT_MAX_RETRIES` cao càng lâu mới
báo lỗi và lỗi càng vô nghĩa.

`doctor` gọi thật endpoint transcription với 1 giây im lặng (ffmpeg tự tạo) và `maxRetries=0`.
`GET /v1/models` trả 200 **kể cả khi hết credit** nên không đủ để kết luận.

**Đừng bật VPN**: đi thẳng từ IP VN ra thì được 200; bật VPN thì Cloudflare trả 403 vì IP
datacenter bị gắn cờ.

### Batch

Lỗi STT **không** đổi `status` sang `failed` mà chỉ ghi `sttError`, vì lệnh `stt` chỉ nhặt video
ở `fetched` — đổi status là tự khoá đường retry của chính nó.

**Không dùng được Batch API của OpenAI**: nó chỉ hỗ trợ `/v1/responses`, `/chat/completions`,
`/embeddings`, `/completions`, `/moderations`, `/images/*`, `/videos`; trang model `whisper-1`
ghi thẳng `Batch | v1/batch | Not supported`. "Batch" ở đây là song song + retry phía client.

### Môi trường máy này (WSL2, `DESKTOP-BOK3JI8`)

- `/usr/bin/node` là v18 của apt — quá cũ (thiếu `--env-file-if-exists`, dưới `engines.node>=22`).
  Node thật ở nvm; **Bash tool không source `~/.bashrc`** nên phải
  `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"` trong cùng lệnh.
- Python PEP 668 externally-managed → dùng pipx. `pipx inject demucs numpy` là bắt buộc (venv của
  demucs không tự kéo numpy).
- `sudo apt install ffmpeg` cần mật khẩu tương tác — Claude không chạy được, phải để fleex chạy.

---

## Bảng tra nhanh: đã loại, đừng đề xuất lại

| Phương án | Vì sao loại |
|---|---|
| yt-dlp liệt kê video theo user Douyin | không có extractor, đã test |
| headless thuần | bot detection |
| Whisper local (kể cả tiny/faster-whisper) | máy yếu |
| Demucs trong flow STT chính | cổ chai batch, đổi lấy 15,7 điểm % coverage nhãn người nói |
| `known_speaker_references` giữ danh tính xuyên bộ | không generic giữa các bộ; bible lo việc này |
| Chuỗi CV cục bộ (InsightFace + khẩu hình) | 53 phút/tập trên CPU, CUDA không lên |
| Một prompt dịch thẳng zh→vi | code-switch + dịch trung thành lỗi ASR |
| Pass A "viết lại kịch bản" | mất câu/lặp câu không bắt được; ops có kiểu thay thế |
| qwen-mt-plus làm engine dịch chính | thuật ngữ trôi (chỉ làm cứu cánh) |
| Critic cùng nhà với model dịch | chấm nới cho bản nhà mình |
| `deepseek-v4-flash` cho lượt review | đốt sạch token nghĩ, trả content rỗng |
| Song song `/clone` của VieNeu | 429 dày, chậm hơn tuần tự |
| VieNeu `/dialogue` cho dub | từ chối giọng clone |
| seed-vc (V1 và V2) | trần âm sắc thấp hơn clone thẳng |
| CosyVoice, qwen3-tts-*, TTS OpenAI | không tiếng Việt / không clone |
| Batch API của OpenAI cho whisper | không hỗ trợ |
| VPN cho api.openai.com | Cloudflare 403 |
| Chặn ảnh/font bằng `page.route` | chậm hơn, lỗi nhiều hơn |
