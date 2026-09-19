# Douyin Downloader

Douyin `user_id` ─▶ bản lồng tiếng Việt. Node ≥22 · ESM · máy yếu nên mọi bước nặng đi cloud API.

> Lý do từng quyết định, số đo, phương án đã loại: [CLAUDE.md](CLAUDE.md)

---

## Chuỗi xử lý

```
                     user_id
                        │
          ┌─────────────▼─────────────┐
          │  collect                  │  Playwright (không headless thuần)
          │  src/collect.js           │  [data-e2e="user-post-list"] + scroll
          └─────────────┬─────────────┘  ─▶ state.json
                        │
          ┌─────────────▼─────────────┐
          │  fetch                    │  XHR aweme/detail + CDN douyinvod
          │  src/capture.js           │  (chữ ký sống ~1h)
          │  src/download.js          │  ─▶ audio.m4a · video.mp4 · meta.json
          └─────────────┬─────────────┘
                        │
          ┌─────────────▼─────────────┐
          │  stt                      │  whisper-1 + diarize  ─┐
          │  src/stt.js               │        HOẶC            ├─ STT_MODEL
          │  src/asr-qwen.js          │  Qwen-ASR filetrans   ─┘
          └─────────────┬─────────────┘  ─▶ transcript.json
                        │                    text · mốc từng TỪ · cụm giọng
          ┌─────────────▼─────────────┐
          │  zhvi                     │  A→B→[cổng người]→C→D→E
          │  src/zhvi/                │  ─▶ translation.json · vi.srt
          └─────────────┬─────────────┘
                        │
          ┌─────────────▼─────────────┐
          │  dub                      │  VieNeu clone ─▶ timeline ─▶ trộn nhạc nền
          │  scripts/dub-video.mjs    │  ─▶ dub-vi.mp4
          └───────────────────────────┘
```

Mỗi bước hỏi đĩa trước khi làm → Ctrl-C lúc nào cũng được, chạy lại là đi tiếp.

---

## Ba cấp dữ liệu

```
CẤP VIDEO  data/<user_id>/                                       ghi bởi
  state.json                         tiến độ từng video          collect·fetch·stt
  <video_id>/
    meta.json                        desc·duration·authorSecUid  fetch
    audio.m4a                        tách từ CHÍNH video         fetch
    video.mp4                        cần cho B1 + bản dub        fetch
    raw-{whisper,diarize,qwen}.json  ★ cache ASR — đắt nhất      stt
    transcript.json                  text·mốc·cụm giọng          stt
    translation.json                 bản dịch theo segment       zhvi E3
    voice/<nhân vật>/                01.wav…·all.wav·reference   extract-voice
    dub/ · dub-vi.mp4                clips·report.json           dub-video

CẤP SERIES  series/<slug>/
  series.json                        tác giả + thứ tự tập        UI
  draft/bible.draft.json             bible MÁY đề xuất           series init
  draft/{merge,looks,contrast,…}     cache (lượt gộp không ổn định giữa 2 lần chạy)
  bible-review.html                  trang duyệt, chỉ hỏi phía vi
  bible.json                         ★ BIBLE ĐÃ DUYỆT            series apply
  ep<N>.speakers.json                nhãn người nói đã chốt      zhvi --apply
  ep<N>.vi-edits.json                câu dịch sửa tay            UI
  voices/<nhân vật>/                 kho giọng cả bộ             UI

CẤP TẬP  out/<tập>/
  ckpt.json · a2-ops · a3-scan · vision · b2-align · c2-vi · d2-critic* · d3-fix*
  review.html · align.final.json · sheet.json · vi.srt · usage.json ($)
```

`stt --force` căn lại trên `raw-*.json`, **không** gọi lại API.

---

## Series nuôi các tập

```
 series init ─▶ draft/bible.draft.json ─▶ bible-review.html ─▶ người duyệt
                                                                     │
                                                     series apply ◀──┘
                                                           │
                                                           ▼
                                                      bible.json
                                                           │
                    ┌──────────┬──────────┬────────────────┼──────────┐
                    ▼          ▼          ▼                ▼          ▼
                  tập 1      tập 2      tập 3             …         tập N
```

```
 bible.json
   ├─ series{}    titleZh · titleVi
   ├─ episodes[]  ep · videoId · videoDir · title · use · approved · reviewedBy
   ├─ cast[]      id · zh · vi · alias[] · gender · role · note · look
   │                 .look ──────────▶ B1  VLM nhận mặt trong khung hình
   │                 .zh/.vi/.alias ─▶ B2  gán tên cụm · B3 regex ai BỊ GỌI tên
   ├─ address[]   from→to · self · other · why
   │                              ───▶ C2  xưng hô đúng theo từng CẶP nhân vật
   ├─ terms{}     zh → {vi, approved, source}
   │                              ───▶ C2 · D4
   └─ version     sha256 · merge chỉ-thêm · xung đột thì TỪ CHỐI
                                  ───▶ chữ ký checkpoint của B2
                  (đề xuất mới của từng tập rơi ra out/<tập>/proposals.json)

 ep<N>.speakers.json ─▶ B5       nhãn người ĐÈ lên mọi kênh máy
 ep<N>.vi-edits.json ─▶ sau E3   áp lại câu sửa tay (khoá: số câu + câu gốc)
 voices/<nhân vật>/  ─▶ dub      tra trước khi tự tách → giọng không đổi giữa các tập
```

---

## Bible — dựng và duyệt

```bash
node src/zhvi/cli.js series init data/<user>/<vid1> data/<user>/<vid2> … \
     --series series/<slug> --glossary glossary.json \
     [--terms t.json] [--out out/<slug>] [--min-sec 60] [--no-looks] [--force]
```

```
                                                              $     cache / ra
init ─┬─ 1 episodeMap     meta.json ─▶ bản đồ tập             –
      │                   gạt video < --min-sec · gạt tập thiếu STT
      │
      ├─ 2 pass A ×tập    sửa ASR từng tập                    LLM   out/<tập>/a2-ops.json
      │                   (runPipeline --stop-after A → lượt dịch sau
      │                    dùng lại checkpoint, A2 chỉ trả tiền MỘT lần)
      │
      ├─ 3 merge          B2b MỘT lượt trên thoại MỌI tập     LLM   draft/merge.json
      │   │               ─▶ dàn nhân vật · thuật ngữ · xưng hô     ⟨ZHVI_PROFILE⟩
      │   └─ validateDraft   code kiểm lại đề xuất của model  –
      │
      ├─ 4 look ×nhân vật VLM tả ngoại hình, 4 câu × 3 khung  VLM   draft/looks.json
      │   │                                                        ⟨ZHVI_VISION⟩
      │   └─ contrast     viết lại look cho NỔI chỗ KHÁC nhau LLM   draft/contrast.json
      │                                                            ⟨ZHVI_CAST⟩
      ├─ 4b unassigned    cụm giọng ≥2 câu chưa ai nhận, lấy 6 cụm nhiều câu nhất
      │                   ─▶ kèm tiếng + cảnh + link video
      ├─ 4c candidates    tên BỊ GỌI ≥2 lần trong thoại mà chưa thành nhân vật (tối đa 12)
      │
      └─ 5 rough          dịch thô mọi cảnh mẫu (MT)          LLM   draft/rough_vi.json
                                                                   ⟨ZHVI_MT⟩
        ─▶ draft/bible.draft.json  +  bible-review.html
```

`--no-looks` bỏ bước 4 (nhanh, nhưng kênh hình lúc dịch sẽ yếu). VLM trả 401/403 → bỏ look cho
các nhân vật còn lại, **không cache lượt hỏng**. `init` từ chối chạy khi đã có `bible.json`
(`--force` dựng lại nháp từ đầu).

### Code kiểm gì ở bước 3 — máy đề xuất, code phủ quyết

```
 model ─▶ validateDraft ─┬─ tên chữ Hán KHÔNG có trong thoại  ─▶ giữ + ⚠ "có thể máy bịa"
                         ├─ biệt danh không có trong thoại    ─▶ bỏ  + ⚠ đếm số đã bỏ
                         ├─ cụm giọng không có trong tập đó   ─▶ bỏ
                         ├─ một cụm gán cho HAI người         ─▶ giữ người đầu + ⚠
                         ├─ thuật ngữ không có trong thoại    ─▶ bỏ  + ⚠
                         ├─ thuật ngữ trùng tên nhân vật      ─▶ bỏ
                         ├─ xưng hô trỏ id không tồn tại /    ─▶ bỏ
                         │  from == to / thiếu self·other
                         └─ cụm ≥2 câu KHÔNG ai nhận          ─▶ unassigned[] (lên trang duyệt)

 --terms (ghim tay) ─────────────────────────▶ vào thẳng, approved:true, THẮNG đề xuất máy
 look tự nói giới tính ngược hồ sơ ──────────▶ ⚠ trên thẻ nhân vật (lookGender)
```

Thứ code loại **không biến mất lặng lẽ** — nó thành dòng ⚠ trên trang duyệt.

### Trang duyệt → `series apply`

```
 bible-review.html
  ├ ⚠ Máy không chắc (doubts)
  ├ Tên phim               series.titleVi
  ├ Tập                    ep.<videoId>.ep  ·  .use
  ├ Nhân vật (thẻ)         vi · viShort · gender · role · note · look
  │    │                   + [bỏ]  + [là cùng một người với →]
  │    └ bằng chứng: 4 CẢNH (±2 câu, cắt ở khoảng lặng >6s) · nghe mp3
  │                  · xem đúng đoạn video · ảnh khung VLM (viền xanh = khung có người này)
  │       câu mẫu chọn theo câu GỌI TÊN / NHẮC TÊN (không phải câu dài nhất — câu dài
  │       nhất gần như luôn là độc thoại), bỏ câu < 1,2s; mọi câu đều có dịch thô
  ├ Thêm nhân vật máy bỏ sót   new.<i>.{vi, zh, viShort, gender, role, note, look}
  │    └ bằng chứng: unassigned[] (nghe + xem)  ·  candidates[] (tên bị gọi, có dịch thô)
  ├ Xưng hô                addr.<i>.{self, other, drop}
  └ Thuật ngữ              term.<zh>.{vi, drop}      (mục ghim tay không cho xoá)
             │
             │ Xuất JSON   ← trang ghi GIÁ TRỊ CUỐI của MỌI ô, không chỉ ô đã sửa
             ▼              → apply bao nhiêu lần cũng ra cùng một bible
 series apply ─┬─ gộp: tên mục bị gộp thành alias của mục đích, xưng hô trỏ theo, khử trùng
               ├─ thêm tay: bỏ trống tên Việt = hàng trống, bỏ qua
               ├─ kiểm: tập dùng mà thiếu số tập / số tập trùng ─▶ NÉM LỖI
               ├─ bible.json cũ ─▶ bible.json.prev
               └─▶ bible.json  +  in sẵn lệnh dịch từng tập (translateCommands)
```

### Hai ràng buộc khi sửa phần này

```
 bible KHÔNG giữ cụm giọng      cụm thuộc về TẬP, không thuộc về bộ — ánh xạ cụm→nhân vật
                                là việc của pass B + cổng soát từng tập.
                                (draft có `clusters` chỉ để validate; applyReview KHÔNG ghi ra)

 thêm tay bỏ trống chữ Hán      khoá lấy luôn tên Việt → không bao giờ khớp chữ trong thoại
                                → kênh "gọi tên" của B3 im lặng: không đúng thêm được gì,
                                  nhưng cũng KHÔNG gán bừa
```

---

## zhvi — dịch cả bộ

Lib tự chứa: chỉ cần `pinyin-pro`, `@node-rs/jieba`, `fetch`. → [src/zhvi/README.md](src/zhvi/README.md)

```
 transcript.json
      │
 ┌────▼──────────────────────────────────────────────────────────┐
 │ A  sửa ASR (zh→zh)      model khai thao tác, CODE áp lên nguồn│
 │ B  gán người nói        3 kênh ─▶ trọng tài ─▶ 4 mức tin cậy  │
 └────┬──────────────────────────────────────────────────────────┘
      │
 ═════╪══ CỔNG NGƯỜI SOÁT (mặc định BẬT) ═════════════════════════
      │   còn cụm chưa chắc / chưa có bible → DỪNG, dựng review.html
      │   người soát ─▶ speaker-review.json ─▶ ep<N>.speakers.json
      │   chạy lại: A/B dùng checkpoint, không trả tiền lại
 ═════╪══════════════════════════════════════════════════════════
      │   pass C ăn bảng xưng hô dựng từ nhãn người nói
      │   → sai ở đây thì tiền dịch mất trắng, xưng hô sai lan cả tập
 ┌────▼──────────────────────────────────────────────────────────┐
 │ C  dịch                 hồ sơ phim + xưng hô + glossary + cps │
 │ D  tự chấm rồi sửa      critic ─▶ fix ─▶ check ─▶ quét CJK    │ ×rounds
 │ E  xuất                 vi.srt · translation.json về data/    │
 └───────────────────────────────────────────────────────────────┘
```

### Công đoạn con — `npm run zhvi -- --stages`

```
                                                              $     file
A ─┬─ A1 clusters   cụm giọng từ qwenSpeakerId + chia lô      –
   ├─ A2 ops        model khai split/merge/replace/punct/…    LLM   a2-ops.json
   ├─ A3 scan       quét phiên âm, trên văn bản SAU A2        LLM   a3-scan.json
   └─ A4 apply      CODE áp thao tác + gắn lại mốc thời gian  –     utts.json

B ─┬─ B1 vision     VLM chọn nhân vật từ khung hình           VLM   vision.json    ⟨cần video+bible⟩
   ├─ B2 align      model gán tên cụm, PHẢI trích số dòng     LLM   b2-align.json  ⟨cần bible⟩
   ├─ B2b cast      tự suy dàn nhân vật                       LLM   sheet.json     ⟨khi KHÔNG bible⟩
   ├─ B3 vocative   regex: ai BỊ GỌI tên                      –
   ├─ B4 arbitrate  3 nguồn → confirmed/single/conflict/split –
   ├─ B5 human      nhãn người ĐÈ lên mọi kênh máy            –     utts.json
   └─ B6 sheet      hồ sơ dịch + bảng xưng hô từ bible        –     sheet.json
                                                                    align.final.json

C ─┬─ C1 plan       cắt lô theo ngân sách token ĐẦU RA        –
   └─ C2 translate  dịch cả lô                                LLM   c2-vi.json

D ─┬─ D2.n critic   chấm điểm từng câu                        LLM   d2-critic<n>.json
   ├─ D3.n fix      dịch lại câu ≤3đ hoặc trượt luật code     LLM   d3-fix<n>.json
   │                (chỉ lưu phần THAY ĐỔI)
   ├─ D1  check     luật thuần code, vòng chốt                –
   └─ D4  decjk     cứu câu còn sót chữ Hán (fix + MT)        LLM   d4-decjk.json  ⟨khi còn CJK⟩

E ─┬─ E1 srt        phụ đề                                    –     vi.srt · vi.json
   ├─ E2 voices     khớp tên nhân vật với voice/, báo thiếu   –
   └─ E3 translation ghi về thư mục video                     –     translation.json
```

Mỗi vòng D là một checkpoint riêng → vòng 2 hỏng không phải trả tiền lại vòng 1.

### Checkpoint

```
  đầu vào công đoạn khai ──sha256──▶ chữ ký ──▶ khớp ckpt.json?
                                                   │
                                     ┌── khớp ─────┴───── lệch ──┐
                                     ▼                           ▼
                              dùng lại, $0              chạy lại ─▶ đầu vào của
                                     │                              mọi bước SAU
                              B1 vẫn được quyền                     cũng đổi theo
                              từ chối cache: nó đối
                              chiếu lại mốc thời gian
                              từng câu đã hỏi
```

Không có bảng phụ thuộc — dây chuyền đổ theo nội dung. Công đoạn miễn phí không bao giờ
checkpoint. Tên model nằm trong chữ ký.

```bash
--force C  /  --force A2  /  --force all      # chạy lại, tính tiền lại
--stop-after B                                # dừng đúng chỗ cổng người soát
```

### Gán người nói — 3 kênh

```
  cụm giọng (ASR)           hình (VLM)             text (LLM)
  nhóm "cùng một giọng"     đặt TÊN cho cụm        TỐ CÁO câu đáng ngờ
  độ thuần 92–95%           đúng 9/9 cụm           (không gán nhãn)
         │                        │                       │
         └───────────┬────────────┘                       │
                     ▼                                    │
              NỀN = cụm + tên   ◀──── kênh nào cãi NỀN? ───┘
              (92–95% đúng)                 │
                     │                      │
               không ai cãi            ~15% số câu
                     ▼                      ▼
                  pass C             cổng người soát
```

---

## Lồng tiếng

```
 transcript.json (nhãn người nói đã soát)
        │
        ▼
 ┌──────────────────┐  cắt đoạn của 1 nhân vật ─▶ ghép ─▶ demucs MỘT lần
 │ extract-voice.js │  ─▶ voice/<nhân vật>/ : 01.wav … all.wav
 └────────┬─────────┘
          │  resemblyzer: cosine từng clip vs all.wav
          │  ─▶ lấy clip GIỐNG NHẤT trong khung 3–5,5s   ← biến quan trọng nhất cả chuỗi
          ▼                                                 (clip dở 83% vs clip tốt 97%)
 ┌──────────────────┐  VieNeu /clone từng câu ─▶ dub/clips/
 │ dub-video.mjs    │  (hoặc /tts với giọng đã enrol)
 └────────┬─────────┘
          │  đặt đúng mốc BẮT ĐẦU, chạy độ dài tự nhiên
          │  lấn sang câu sau ─▶ nén, trần 1.15× ─▶ vẫn lấn thì BÁO RA
          │  (không ép câu vi vừa khung zh: sửa ở bản dịch, không sửa ở tín hiệu)
          ▼
   audio-vi.wav  +  nền nhạc gốc (demucs no_vocals)  ─▶  dub-vi.mp4
```

---

## Xưởng dịch — UI local

```bash
npm run ui            # http://127.0.0.1:5178
```

```
  Tác giả ─▶ Video của tác giả ─▶ Tạo series ─▶ Duyệt bible ─▶ Dịch từng tập
                    │                                                │
                    └─ Tải + STT                                     ▼
                                                             Soát người nói
                                                                     │
            Lồng tiếng ◀── Bản dịch (xem + sửa tay) ◀─────────────────┘

  "Chờ bạn" = mọi việc máy đang đợi người: duyệt bible · soát người nói · lỗi · tập làm tiếp được

  server ─spawn─▶ đúng lệnh CLI (recipes.js)     log giống hệt chạy tay
  trạng thái ◀─mtime─ review.html/translation.json/dub-vi.mp4   (scan.js)
  làn: browser 1 · tts 1 · zhvi 2 · stt 2        khoá: user:<id> · series:<slug>
  tắt server = việc bị ngắt ─▶ bấm Chạy lại, đi tiếp từ checkpoint
```

→ [src/ui/README.md](src/ui/README.md)

---

## Cài đặt

```bash
npm install && npx playwright install chromium
cp .env.example .env
sudo apt install -y ffmpeg

# chỉ cần khi LỒNG TIẾNG:
pipx install demucs && pipx inject demucs numpy      # tách nhạc nền
# resemblyzer: mặc định lấy từ venv seed-vc → đổi bằng RESEMBLYZER_PYTHON
```

| Key | Cho bước |
|---|---|
| `OPENAI_API_KEY` | stt (whisper + diarize) · doctor · provider dịch `openai*` |
| `DASHSCOPE_API_KEY` + `DASHSCOPE_BASE_URL` | Qwen-ASR · các vai `qwen-*` của zhvi |
| `DEEPSEEK_API_KEY` | zhvi mặc định: dịch · chấm · sửa · kênh hình |
| `VIENUE_KEY` | lồng tiếng (tên biến đánh máy lệch — **đừng sửa**) |
| `SILICONFLOW_API_KEY` · `TODO_URL`+`TODO_TOKEN` | chỉ `compare` · provider `queue@…` |

Key DashScope cấp theo workspace → host cũng riêng: tải apiKey CSV về `secret/` rồi
`node scripts/apikey-csv-to-env.js --write`. Biến khác: [.env.example](.env.example), `ZHVI_*`
xem [src/zhvi/README.md](src/zhvi/README.md).

**Secret khi chuyển máy** — `.env` + `secret/` nằm trong `secrets.tar.gz.gpg` (AES-256):

```bash
gpg -d secrets.tar.gz.gpg | tar xz && chmod 600 .env
npm run login                 # .browser-profile/ không backup — đăng nhập lại
# đổi key xong:
rm -f secrets.tar.gz.gpg && tar cz .env secret | gpg -c --cipher-algo AES256 -o secrets.tar.gz.gpg
```

---

## Lệnh

```bash
# ── thu thập → tải → STT ──────────────────────────────────────────────────
npm run login                            # đăng nhập thủ công một lần
npm run collect -- <user_id>
npm run fetch   -- <user_id> [<id>…] [--limit N] [--concurrency 8]
npm run stt     -- <user_id> [<id>] [--force]
npm run all     -- <user_id>             # cả ba bước · npm run status -- <user_id>

# ── dịch ──────────────────────────────────────────────────────────────────
node src/zhvi/cli.js series init data/<user>/<vid1> … --series series/<slug> \
     --glossary glossary.json
node src/zhvi/cli.js series apply ~/Downloads/bible-review.json --series series/<slug>

npm run zhvi -- data/<user>/<vid>/transcript.json --bible series/<slug>/bible.json \
     --glossary glossary.json --ep 2 --out out/ep02 \
     --video data/<user>/<vid>/video.mp4 --data-dir data/<user>/<vid>

node src/zhvi/cli.js --apply ~/Downloads/speaker-review.json --series series/<slug>

# ── lồng tiếng ────────────────────────────────────────────────────────────
npm run voice -- --dir data/<user>/<vid> --speaker <tên nhân vật>
node --env-file-if-exists=.env scripts/dub-video.mjs --dir data/<user>/<vid> \
     --voices series/<slug>/voices --concurrency 1

# ── chẩn đoán ─────────────────────────────────────────────────────────────
npm run doctor                           # gọi THẬT endpoint transcription
npm run probe   -- <user_id>             # dump DOM trang user, chốt selector
npm run inspect -- <video_id>            # dump JSON/URL bắt được của 1 video
npm run compare -- <user_id> <video_id>  # diff giữa các engine STT
npm run prune   -- <user_id> [--apply]   # dọn video tác giả khác lỡ tải
```

`npm run translate` là đường dịch **cũ** (1 lượt LLM theo segment, không ngữ cảnh cả bộ) — dùng
cho video lẻ hoặc so provider. `voice-convert` · `voice-judge` · `vieneu-probe` ·
`tts-voice-scan` là công cụ thăm dò.

---

## Bản đồ mã nguồn

| Đường dẫn | Vai trò |
|---|---|
| `src/cli.js` | điểm vào lệnh thu thập / STT / dịch cũ |
| `src/collect.js` · `browser.js` · `probe.js` | quét danh sách video, phiên Playwright |
| `src/capture.js` · `download.js` | bắt metadata + link CDN, tải có retry |
| `src/stt.js` · `asr-qwen.js` · `stt-engines.js` | STT, cache `raw-*.json`, chọn engine |
| `src/diarize.js` · `align.js` · `speakers.js` | nhãn người nói đường OpenAI |
| `src/translate.js` · `translators/` | đường dịch cũ, mỗi provider một file |
| `src/zhvi/` | pipeline dịch chính — `stages.js` là xương sống |
| `src/ui/` | server · hàng đợi việc · quét đĩa · recipes |
| `src/apiLog.js` | **mọi** lời gọi ra ngoài: log · che khoá · cắt payload |
| `src/vocals.js` · `scripts/compare-diarize-bgm.js` | thí nghiệm tách vocal, ngoài flow chính |
| `glossary.json` | thuật ngữ cho đường dịch cũ và `series init` |

`speakers.json` + `speakers/` ở gốc repo là tàn dư của cơ chế đăng ký mẫu giọng đã bỏ.

---

## Chạy lần đầu

```
1  npm run login                    browser mở HEADED (cố ý) và đứng chờ → Enter
2  npm run collect -- <user_id>     chờ tối đa 2 phút, đủ thời gian xử lý captcha
3  npm run inspect -- <video_id>    đối chiếu field trong dump với src/capture.js
                                    ← công cụ debug ĐẦU TIÊN khi ngừng bắt được link
4  npm run fetch -- <user_id> --limit 5      nghe thử, xem ước tính dung lượng
5  npm run stt -- <user_id>  ─▶  zhvi series init
```
