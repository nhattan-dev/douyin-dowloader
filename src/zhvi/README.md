# zhvi — dịch transcript phim ngắn tiên hiệp Trung → Việt

Bản JS của `Projects/temp/zhvi` (Python). Lý do thiết kế + số đo nằm ở `DESIGN.md` bên đó;
file này chỉ nói **cách dùng** và **những chỗ bản JS khác bản Python**.

Lib **tự chứa**: chỉ phụ thuộc `pinyin-pro`, `@node-rs/jieba` và `fetch` sẵn có của Node.
Không import gì của douyind-downloader — bê nguyên thư mục `src/zhvi/` đi chỗ khác là chạy.

## Dùng như lib

```js
import { runPipeline } from "./src/zhvi/index.js";

const { ctx, report, usage } = await runPipeline({
  transcript,                        // object đã parse của transcript.json
  glossary,
  biblePath: "series/<slug>/bible.json",
  ep: "2", epTitle: "…",             // số tập + tên tập tác giả đặt
  outDir: "out/ep02",
  video: ".../video.mp4",            // có video mới bật được kênh hình ở pass B
  dataDir: ".../<videoId>",          // ghi ngược translation.json + speaker
  cps: 4.5, rounds: 2,
  force: [], stopAfter: null,
  skipReview: false,                 // true = không dừng ở cổng người soát
  log: console,
});
```

`runPipeline` trả `ctx` (mọi trạng thái trung gian: `utts`, `align`, `sheet`, `vi`,
`translation`), `report` (mỗi công đoạn chạy hay dùng lại, `report.review` cho biết có
dừng ở cổng người soát không) và `usage` (token theo model).

## Dùng như CLI

```bash
node src/zhvi/cli.js <transcript.json> --glossary g.json --bible series/x/bible.json \
     --ep 2 --out out/ep02 --video .../video.mp4 --cps 4.5 --rounds 2

node src/zhvi/cli.js --stages          # in bảng stage/substage
```

## Stage / substage

| | công đoạn | tốn tiền? | file |
|---|---|---|---|
| **A** | `A1` clusters · `A2` ops · `A3` scan · `A4` apply | A2, A3 | `a2-ops.json`, `a3-scan.json` |
| **B** | `B1` vision · `B2` align · `B2b` cast · `B3` vocative · `B4` arbitrate · `B5` human · `B6` sheet | B1, B2, B2b | `vision.json`, `b2-align.json` |
| **C** | `C1` plan · `C2` translate | C2 | `c2-vi.json` |
| **D** | `D2.n` critic · `D3.n` fix · `D1` check · `D4` decjk | D2, D3, D4 | `d2-critic<n>.json`, … |
| **E** | `E1` srt · `E2` voices · `E3` translation | — | — |

`B2b` chỉ chạy khi KHÔNG có bible (đường cũ: tự suy dàn nhân vật).
`D2/D3` lặp theo `rounds`, mỗi vòng một checkpoint riêng.

## Checkpoint: đĩa là nguồn sự thật

Cùng luật với `src/stt.js` ("Hỏi đĩa, không hỏi state"): **mặc định dùng lại mọi thứ đã trả
tiền.** Bản Python thì ngược — `--stage all` là mặc định và nó trả tiền lại từ đầu.

Nhưng "có file trên đĩa" chưa đủ để tin. Mỗi công đoạn khai đầu vào của nó; chữ ký là
sha256 của đúng những thứ đó (`ckpt.json`). Đầu vào đổi → chữ ký đổi → tự chạy lại, và
mọi công đoạn phía sau cũng tự chạy lại vì đầu vào của CHÚNG vừa đổi.

**Không có bảng phụ thuộc nào.** Dây chuyền đổ theo nội dung, không theo khai báo — nên
một lần chạy lại mà ra kết quả y hệt thì KHÔNG kéo theo gì cả, đúng như mong muốn.

Hai luật đi kèm:

- **Công đoạn miễn phí không bao giờ checkpoint.** Sửa bible, sửa nhãn người soát xong
  chạy lại là thấy ngay, không phải nhớ xoá cache.
- **`load` được quyền từ chối cache dù chữ ký khớp.** `B1` dùng quyền đó để đối chiếu mốc
  thời gian từng câu đã hỏi — đây là chỗ đã sai lặng lẽ một lần: pass A tách lại câu làm id
  trôi, phán quyết của câu này bị gán cho câu khác, không lỗi nào nổ ra.

```bash
--force C          # chạy lại pass C (tính tiền lại)
--force A2         # chạy lại đúng một công đoạn
--force all
--stop-after B     # dừng sau pass B — đúng chỗ cổng người soát nằm
```

Tên model nằm trong chữ ký. Đổi `ZHVI_*` là công đoạn đó chạy lại — đúng, vì kết quả của model
khác là kết quả khác; nhưng nhớ đặt biến cho nhất quán, quên một lần là trả tiền lại một lần.

## Cổng người soát (giữa B và C) — mặc định BẬT

Hết pass B, nếu còn **cụm chưa chắc** (mức khác `confirmed`/`human`) hoặc còn **câu cần
soi** thì pipeline **dừng** và dựng luôn `out/<tập>/review.html`. Không hỏi, không dịch
tiếp: pass C ăn `sheet`, mà `sheet` dựng từ `speakerMap` — sai người nói ở đây thì tiền
dịch mất trắng và xưng hô sai lan ra cả tập.

```bash
node src/zhvi/cli.js … --video …             # còn chỗ chưa chắc -> dừng ở B, in đường đi tiếp
xdg-open out/ep02/review.html                # soát, bấm Xuất JSON
node src/zhvi/cli.js --apply ~/Downloads/speaker-review.json --series series/<slug>
node src/zhvi/cli.js …                       # chạy lại: A/B dùng lại checkpoint, chạy thẳng tới E

node src/zhvi/cli.js … --skip-review         # kệ, dịch thẳng (vẫn cảnh báo còn gì chưa chắc)
node src/zhvi/cli.js … --review              # luôn dừng ở B, kể cả khi máy đã chắc
```

Trong lib: `skipReview: true`, và `report.review = { need, weak, suspects, why, stopped }`.

**Chưa có bible thì cổng luôn dừng** (`noBible: true`) và CLI in lệnh `series init` — xem mục
"Bible cho series mới". Đường không-bible không có kênh hình lẫn trang soát, nên "máy không thấy gì
đáng ngờ" ở đó không có nghĩa là chắc.

**Cổng chỉ chặn một lần.** Có `series/<slug>/ep<N>.speakers.json` là coi như người đã
nhìn — không có luật này thì cổng chặn mãi, vì soát xong vẫn còn câu nghi là chuyện bình
thường: đo trên tập 2, chốt 1 cụm + 1 câu làm bảng xưng hô từ **0 lên 2 cặp** và câu cần
soi từ **8 xuống 6**, không về 0.

Nhãn đã chốt là **dính**: lần chạy sau `B5` tự đè lên phán quyết của máy.

`media.json` và `rough_vi.json` là cache riêng, khoá theo nội dung (`id@mốc-thời-gian`
và câu Hán) chứ không qua `ckpt.json` — chúng sống sót qua cả việc id câu bị trôi.

## Bible cho series mới — `series init` / `series apply`

Không có bible thì pass B chỉ còn đường "tự đoán từng tập" (B2b): không kênh hình, không trang
soát, mỗi tập tự đặt tên nhân vật một kiểu. Vì vậy **không có bible là cổng soát luôn dừng**
(`report.review.noBible`), kể cả khi máy "không thấy gì đáng ngờ" — trước đây chính chỗ này mở
lặng lẽ. Chữa đúng là dựng bible, không phải soát tay từng tập.

```bash
# 0. STT các tập (douyind): npm run stt -- <user_id> <video_id>
# 1. nháp bible cho cả series — thứ tự video = thứ tự tập
node src/zhvi/cli.js series init data/<user>/<vid1> data/<user>/<vid2> ... \
     --series series/<tên> --glossary glossary.json [--terms terms.json] [--out out/<tên>]
# 2. mở series/<tên>/bible-review.html, soát phía tiếng Việt, bấm Xuất JSON
# 3. nạp -> series/<tên>/bible.json, in sẵn lệnh dịch từng tập
node src/zhvi/cli.js series apply ~/Downloads/bible-review.json --series series/<tên>
```

`init` làm năm việc, mỗi việc máy đề xuất còn code kiểm:

| | việc | ai làm | code kiểm gì |
|---|---|---|---|
| 1 | bản đồ tập | `meta.json` | video < 60s bị gạt (`--min-sec`); thiếu STT thì gạt |
| 2 | sửa ASR từng tập | pass A qua `runPipeline` | — (cùng `--out` với lượt dịch sau, nên A2 chỉ trả tiền một lần) |
| 3 | B2b chạy MỘT lần trên thoại mọi tập (glossary + cụm lặp lại + kịch bản), ra thẳng dàn nhân vật | `models.profile` | tên/biệt danh phải có nguyên văn trong thoại; cụm giọng phải có thật; một cụm một chủ; thuật ngữ phải có trong thoại |
| 4 | `look` | `models.vision` tả từ khung hình của chính các câu nhân vật đó nói, rồi `models.cast` viết lại cho nổi chỗ KHÁC nhau | khung nào VLM bảo có người này thì trang duyệt viền xanh |
| 5 | trang duyệt | — | ảnh + tiếng + **cảnh** (mấy câu quanh câu mẫu, dịch thô) + nút xem đúng đoạn video; chữ Hán chỉ hiện nhỏ |

Thứ code loại không biến mất lặng lẽ: nó thành dòng ⚠ trên trang duyệt. Thuật ngữ trong `--terms`
đi thẳng vào bible dạng đã duyệt (ghim tay thắng máy).

Trang duyệt hỏi ba thứ và đưa đủ bằng chứng cho từng thứ:

- **Cảnh, không phải câu lẻ.** Mỗi câu mẫu mang theo 2 câu trước + 2 câu sau (cắt ở khoảng lặng
  > 6s vì đã sang cảnh khác), cả cảnh đều có bản dịch thô. Câu mẫu cũng chọn khác trước: ưu tiên
  câu **gọi tên / nhắc tên** thay vì câu dài nhất — câu dài nhất thường là độc thoại, đọc xong
  vẫn không biết người này là ai của ai.
- **Xem video đúng đoạn** (`▶ Xem cảnh`). Ảnh tĩnh không phân biệt được người đang NÓI với người
  đang NGHE — mà đó chính là chỗ VLM tả nhầm. Video **không nhúng** vào HTML (trang đã ~1,6–2,7 MB
  chỉ với ảnh + tiếng): phát thẳng `video.mp4` gốc, đường dẫn tương đối khi mở `file://`, `/media/…`
  khi mở qua UI. Tập không có `video.mp4` thì không vẽ nút.
- **Thêm nhân vật máy bỏ sót** (cuối trang). Thiếu một người ở bible là ngõ cụt: trang soát người
  nói từng tập chỉ cho chọn trong `bible.cast`. Kèm bằng chứng — các **cụm giọng chưa ai nhận**
  (nghe + xem cảnh) — và danh sách **tên bị gọi trong thoại** mà dàn nhân vật chưa có, để chọn
  thay vì phải gõ chữ Hán. Bỏ trống ô tên gốc thì khoá dữ liệu lấy luôn tên Việt (không khớp chữ
  trong thoại, tức kênh "gọi tên" im lặng chứ không gán bừa). Bible **không** giữ cụm giọng: việc
  gán cụm cho nhân vật vẫn là của cổng soát từng tập.

Trang duyệt ghi **giá trị cuối của mọi ô** chứ không chỉ ô đã sửa, nên `apply` bao nhiêu lần cũng ra
cùng một bible (đo lại sau khi thêm hàng "thêm nhân vật": áp hai lần ra cùng một `version`). Gộp hai mục ("Là cùng một người với") thì tên của mục bị gộp thành biệt danh, và
xưng hô trỏ tới nó được chuyển sang mục đích rồi khử trùng. `apply` lần hai giữ bản cũ ở `bible.json.prev`.

File: `series/<tên>/draft/bible.draft.json` (nháp), `bible-review.html`, `bible.json`. Cache trong
`draft/`: `merge.json` (lượt gộp), `looks.json` (VLM, chỉ lượt thành công), `contrast.json` (viết lại look),
`rough_vi.json` (MT). Chạy lại `init` thì chỉ bước nào đổi đầu vào mới gọi lại — cần vì lượt gộp
**không ổn định giữa hai lần chạy** (đo trên 4 tập Tiểu Toản Phong: 10 vs 9 nhân vật, tên nhân vật chính khác).

Hai kiểm tra rẻ gắn ⚠ lên thẻ nhân vật: look tự nói giới tính ngược hồ sơ ("Nữ…" cho nhân vật nam — VLM
tả nhầm người đang nghe, hoặc hồ sơ sai giới tính); VLM hết quota / lỗi thì cả trang có dòng ⚠ đầu tiên.
Look còn là bằng chứng gộp: đo được hai mục máy tách riêng mà look tả đúng đặc điểm của nhân vật khác
("có đuôi trắng lớn" = Ngọc Diện) — người duyệt dùng ô "Là cùng một người với".

Chưa làm: bổ sung tập mới vào bible **đã có** (`init` từ chối khi đã có `bible.json`; `--force` dựng lại
nháp từ đầu). Pass B của tập sau vẫn ghi `proposals.json` như cũ, chỉ chưa có lệnh nạp.

## Model và độ ổn định

| vai | mặc định | biến môi trường |
|---|---|---|
| sửa ASR (A2, A3) | `qwen-plus` | `ZHVI_REPAIR` |
| kênh hình (B1) + `look` ở series init | `deepseek-flash` | `ZHVI_VISION` |
| gán tên cụm (B2, B2b) | `qwen3.8-max` | `ZHVI_CAST` |
| lượt gộp của series init | theo `ZHVI_CAST` | `ZHVI_PROFILE` (vd `queue@qwen3.8-max`) |
| dịch (C2) | `deepseek-flash@none` | `ZHVI_RENDER` |
| chấm điểm (D2) | `deepseek-flash@none` | `ZHVI_CRITIC` |
| dịch lại câu lỗi (D3, D4) | `deepseek-flash@low` | `ZHVI_FIX` |
| MT tham chiếu | `qwen-mt-plus` | `ZHVI_MT` |

**Tên model mang luôn chế độ**, provider tự suy theo tên (`deepseek-*` đi DeepSeek):

- `deepseek-flash@none|low|high|max` → `reasoning_effort` ở **cấp gốc** request. Không hậu tố = `none`.
  (Nhét trong object `thinking` thì DeepSeek bỏ qua lặng lẽ — `none` lồng bên trong vẫn nghĩ 37k token.)
- `qwen3.7-max@nothink|think` → `enable_thinking`. Không hậu tố = mặc định DashScope, với 3.7-max là **có nghĩ**.

Vì sao render/critic/fix sang DeepSeek: đo C+D chạy trọn trên 4 tập và chấm mù 3 tập — không kém cấu hình
qwen3.7-max cũ mà rẻ ~5× (~$0,03 so với ~$0,17/tập, giá peak). Tiền nằm ở bước fix nên chỉ fix được nghĩ.
Critic cùng nhà với render là CÓ CHỦ Ý: đo 2×2, critic nào cũng chấm gắt hơn với bản của nhà mình.

**Luật ổn định** (đều nằm trong `llm.js`, mọi pass cùng hưởng):

- `max_tokens` của DeepSeek tính CẢ token suy nghĩ; đặt thấp là nghĩ hết ngân sách rồi trả content **rỗng**.
  Nên có sàn: tắt nghĩ ≥16k, bật nghĩ ≥128k (trần API 384k). Trần là giới hạn trên — không dùng thì không mất tiền.
- Content rỗng hoặc `finish=length` → nhân đôi trần rồi gọi lại; rỗng lần thứ hai → hạ effort về `none`.
- `jsonMode` mà JSON không đọc được → gọi lại.
- Timeout 900s (qwen3.7-max có lượt trả sau 706s). Lỗi 429 thì chờ lâu hơn.
- 401/403 (hết quota, sai key) thì ném ngay, không gọi lại — gọi lại không bao giờ khá lên. Gặp thật:
  `qwen-vl-max` "Free quota exhausted" ngày 2026-09-14, nên `vision` mặc định đã sang `deepseek-flash`.
- Lượt hỏng vẫn được ghi vào `usage.json` và vẫn tính tiền — vì nó thật sự bị trừ tiền.

`usage.json` và dòng `[$]` cuối lệnh có token suy nghĩ và tiền ước tính (giá peak; DeepSeek ngoài giờ
cao điểm chỉ ½ — cao điểm là 8–11h và 13–17h giờ VN, thứ 2 đến thứ 6).

## Khác bản Python

| | Python | JS |
|---|---|---|
| mặc định chạy lại | trả tiền lại từ đầu | dùng lại checkpoint |
| C và D | ghi file ra rồi không đọc lại | có checkpoint thật |
| chữ ký đầu vào | không có | sha256 nội dung |
| dịch / chấm / sửa | qwen3-max / deepseek-chat / qwen3-max | deepseek-flash @none / @none / @low |
| cổng người soát | phải nhớ gọi `--stage review` | mặc định dừng khi còn chỗ chưa chắc |
| cắt từ (jieba) | `jieba.add_word` | `Jieba.withDict(dict gốc + từ vựng phim)` |
| `vote` trong translation.json | `1.0` | `1` (JSON đọc ra bằng nhau) |

`@node-rs/jieba` không có `insertWord`, và `loadDict` **thay** từ điển chính chứ không bổ
sung — gọi thẳng nó thì mọi thứ bị cắt thành từng chữ và danh sách nghi ngờ vỡ. Phải nối
từ vựng phim vào sau `dict.txt` của package rồi dựng lại Jieba.

## Đã đối chiếu với bản Python

Chạy cùng đầu vào, so từng byte:

- `phon.sim` — 5/5 cặp khớp tới 4 chữ số; `suspects` khớp cả kết quả lẫn thứ tự.
- `ops.applyOps` — 12 thao tác (kể cả 3 thao tác hỏng phải bị loại) trên 7 segment: đơn vị,
  span, edits, speaker, note khớp hết. Chỉ khác kiểu nháy trong thông điệp lỗi tiếng Trung.
- 7 prompt — khớp nguyên văn từng byte.
- Pass B thuần code (`verifyAlign` / `arbitrate` / `suspectLines` / `sheetFromBible`) trên
  dữ liệu thật 4 tập (ep02v, ep03, ep07, ep11) — `speakerMap`, mức tin từng cụm, danh sách
  câu nghi, bảng xưng hô: khớp tuyệt đối. Gồm cả `align.json` định dạng cũ không có `clusters`.
- Pass C/D/E thuần code (`sheetText`, `check`, `exportTranslation`, `toSrt`) trên ep02v —
  khớp tuyệt đối, kể cả nguyên khối hồ sơ phim gửi cho model.

Phần do model quyết thì không so byte được: `qwen-plus` ở pass A lệch giữa các lần chạy
ngay cả ở temperature 0. Chạy thật tập 2 (31 lượt, 135k token) ra 47 câu / 3 cụm, trong khi
lượt Python hôm trước ra 46 câu / 3 cụm — pass A cắt câu khác nên thành phần cụm khác, kéo
theo kênh hình hỏi ở những mỏ neo khác. Đưa JS pass B đúng `utts.json` + `vision.json` của
lượt Python thì nó trả lại kết quả của lượt Python từng chữ, nên đây là model lệch chứ
không phải port lệch.

Cũng lượt đó, `applyOps` loại 15/52 thao tác — không phải lỗi, mà là rào chắn `kindOf` bắt
đúng thứ nó sinh ra để bắt: `qwen-plus` đòi sửa 换新手机→换新衣裳, 哪里→何处, 伙伴→臂助,
怜悯→恩惠. Đổi nghĩa cho "cổ trang hơn", không phải sửa chỗ nghe nhầm.
