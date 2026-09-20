# zhvi2 — dịch từng tập bằng todo LLM

Bản gọn của `src/zhvi/`. v1 có ~6.000 dòng, phần lớn để bù cho model yếu (phon/jieba chặn pass A
sửa bậy, `kindOf`, critic khác nhà, `decjk` vớt chữ Hán sót). zhvi2 đẩy toàn bộ phần suy nghĩ cho
**todo LLM** (Claude Sonnet web, qua hàng đợi task) và để code chỉ điều phối: gom đầu vào → gửi →
kiểm → sai thì hỏi lại kèm lỗi → áp.

**zhvi2 là lõi chính** (2026-09-20). v1 vẫn chạy nguyên và giữ làm dự phòng: hai bản dùng chung
bible, trang soát, export; thư mục ra và file nhãn soát tách riêng để bản v1 còn nguyên. Trên UI
**không có màn hình riêng cho v2** — `scan.engineOf()` quyết định tập nào chạy lõi nào và mọi tab
đọc theo đó (xem `src/ui/README.md`). Từ đây v2 cũng `--write-back` như v1, vì lồng tiếng đọc
`translation.json` trong thư mục video: UI hiện bản v2 mà dub đọc bản v1 là sai lệch không nhìn ra.

## Mỗi tập

| | công đoạn | ai làm | file |
|---|---|---|---|
| V | kênh hình: ai cử động miệng ở **mọi câu**, 3 khung/câu (v1: ≤30 mỏ neo × 8 khung) | VLM (`ZHVI_VISION`, như v1) | `vision.json` |
| U | **task 1 — hiểu tập**: sửa ASR nghe nhầm, tên từng cụm giọng, câu lệch cụm, tách câu gộp người (kèm mốc cắt), câu còn nghi, nhân vật/thuật ngữ mới, dịch thô | todo | `u.json` |
| — | cổng soát (`review.html` của v1, dịch thô lấy từ U) | người | `series/<slug>/ep<N>.v2.speakers.json` |
| T | **task 2 — dịch** cả tập, tự soát trong cùng task | todo | `t.json` |
| E | `translation.json` đúng schema douyind | code | `translation.json`, `vi.srt` |

```bash
node src/zhvi2/cli.js --series series/ai-qing --ep 1          # V + U rồi dừng ở cổng soát
xdg-open out/ai-qing/v2/ep01/review.html                       # soát, bấm Xuất JSON
node src/zhvi2/cli.js --apply ~/Downloads/speaker-review.json --series series/ai-qing
node src/zhvi2/cli.js --series series/ai-qing --ep 1          # U dùng lại -> T -> E
node src/zhvi2/cli.js --series series/ai-qing --ep 1 --write-back   # ghi vào thư mục video cho dub
```

Routine của todo cho từng task: `ZHVI2_U_ROUTINE` / `ZHVI2_T_ROUTINE` = `default` (Sonnet 5, mặc định)
hoặc `lite` (Haiku 4.5 — nhanh hơn, kém hơn). Routine nằm trong chữ ký: đổi là task đó chạy lại.

Đo 2026-09-19, ai-qing tập 1 (582s, 148 câu, Sonnet): task U nhận sau 59s, xong sau 719s, 0 lỗi
kiểm — 8 sửa ASR (小猫住→小卖部, tên 沈灵山, đại từ 他/她), 2 câu tách, 24 câu đổi người, 23 câu tự khai
nghi, 12/12 cụm có ý kiến; khớp cả 2 cờ lượt gộp series v1 (câu 80, 82 là Lâm Nhiên). Task ~41k ký tự.

`--force U,T`, `--review` (luôn dừng ở cổng), `--skip-review`, `--no-vision`, `--cps 4.5`, `--out`.
Transcript, video, glossary và thư mục ra đều suy từ `bible.json` (mặc định `<outRoot>/v2/epNN`).
Bible dựng bằng v1: `node src/zhvi/cli.js series init …`.

## Luật

- **Code kiểm, không sửa hộ.** Sửa ASR phải tìm thấy đúng một chỗ chữ gốc; mảnh tách ghép lại phải
  ra đúng nguyên văn, mốc cắt nằm trong câu và tăng dần; tên người nói phải có trong bible/`newCast`;
  bản dịch đủ id, không sót chữ Hán, đúng thuật ngữ đã chốt, không vượt trần âm tiết. Sai thì gửi task
  mới kèm câu trả lời cũ + danh sách lỗi (tối đa 3 lượt). Hết lượt vẫn sai: U bỏ đúng mục hỏng (ghi ở
  `align.json: rejected`), T đánh `needsReview`.
- **Mốc cắt câu do LLM chọn** theo mốc từng từ của ASR, code không nội suy.
- **Schema đi ô `output_format`** (JSON Schema, bắt buộc đủ id/cụm) nên server của hàng đợi chặn câu
  trả lời sai hình dạng ngay từ nguồn. Dữ liệu đi ô `context`, không trộn vào hướng dẫn.
- **Không có model dự phòng.** Task hỏng/quá 60 phút thì ném lỗi; chạy lại nhận đúng task cũ
  (`external_id` = hash nội dung task).
- **Tập đã soát thì U VÀ T đóng băng.** U: nhãn soát khoá theo số câu, U chạy lại có thể tách câu
  khác đi → nhãn trỏ nhầm câu. T: người soát sửa nhãn sau khi đã dịch thì **không** gọi lại LLM —
  bản của người là bản cuối (luật fleex 2026-09-20). Câu bị đổi người sau khi dịch được đánh dấu
  «người nói đổi sau khi dịch — xưng hô có thể lệch» để người tự sửa câu chữ; `--force T` khi muốn
  máy dịch lại cả tập. Bản dịch dùng lại khớp theo `sk`, KHÔNG theo id: cắt thêm một câu là id mọi
  câu sau đánh lại, khớp theo id sẽ dán câu dịch của câu khác (bẫy B1 của v1). Mảnh mới cắt chưa có
  bản dịch thì để rỗng + đánh dấu, không mượn câu bên cạnh.
- **Câu máy tự tách/tự đổi người nói mà người chưa chốt**: dịch theo máy nhưng `voiceSafe: false`.
- **Cụm `sure: false` thì U phải phán TỪNG câu** của cụm (`lines`, kể cả câu đúng là của chủ cụm) —
  code kiểm đủ. Có vậy phần "chia cụm" của trang soát mới điền sẵn được, người chỉ sửa chỗ sai. Ca
  gốc: ai-qing tập 1, cụm S10 13 câu của hai cô gái, U gán cả cụm một tên và gạt 3/3 phiếu hình.
- **Trang soát tách GIỌNG khỏi LLM.** U dời câu lệch sang cụm của người khác (`speaker`), nhưng cụm
  ASR gốc giữ ở `asrSpeaker` và phán quyết từng câu ở `align.llm`; bảng mỗi câu hiện ba dòng
  giọng / LLM / hình, lệch thì tô cam. Gộp giọng với LLM làm một ô thì 24 câu lệch trông như khớp.
- Chưa có bible thì không chạy (v1 còn đường không-bible; v2 bỏ).

## Chưa làm

- `series init` vẫn là của v1 (chạy qua todo bằng `ZHVI_PROFILE=queue@…`).
- UI (`npm run ui`) chưa có công thức cho zhvi2.
- Cờ `asr-flags.json` của lượt gộp series không đưa vào U — U tự tìm câu gộp người trong từng tập.
- Chưa so chất lượng với v1 trên tập đã soát.

### Cắt tay câu nhiều người (2026-09-20)

LLM là đề xuất (`splits` của U); người soát sửa được và **bản của người là cuối** — không gửi LLM
xác nhận lại. Ở mục "Từng câu", chọn «nhiều người» mở bộ cắt: bấm khe giữa hai chữ để cắt, mỗi
mảnh chọn người nói, ▶ xem đúng mảnh. Mốc điền sẵn chỉ khi khe trùng ranh giới từ ASR (không nội
suy); lệch thì người tự đặt. Xuất ra `cuts` trong `ep<N>.v2.speakers.json`; `U.apply` áp nhát cắt,
code chỉ kiểm hình dạng (ghép đúng nguyên văn, mốc tăng dần trong câu, tên có trong cast) — hỏng
thì bỏ nhát cắt, giữ câu nguyên, ghi vào `rejected`.

Nhãn câu v2 khoá bằng `sk` (`@18`, `@18.1` mảnh LLM, `@20/0` mảnh người cắt), không bằng `id`:
cắt một câu là `id` mọi câu sau đánh lại. Trang tự chuyển phán quyết cũ khoá `#id` sang `@sk`.

