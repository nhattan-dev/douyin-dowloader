# Douyin Downloader

Từ 1 Douyin `user_id` → thu thập video → tải audio → transcript. Output dùng cho pipeline dubbing [LangDub](../LangDub).

Thiết kế và các quyết định kỹ thuật: xem [CLAUDE.md](CLAUDE.md).

## Cài đặt

```bash
npm install
npx playwright install chromium
cp .env.example .env      # rồi điền OPENAI_API_KEY
```

Bước STT còn cần `ffmpeg`:

```bash
sudo apt install -y ffmpeg
```

`demucs` **không còn cần cho pipeline chính** (xem mục "Tách vocal — đã thử, bỏ"). Chỉ cần nếu muốn tự chạy `scripts/compare-diarize-bgm.js` để thử nghiệm lại:

```bash
pipx install demucs
pipx inject demucs numpy   # venv của pipx đôi khi thiếu numpy, cần bơm tay
```

## Chạy

```bash
npm run login                           # mở browser, đăng nhập thủ công, Enter để lưu phiên
npm run doctor                          # chẩn đoán kết nối tới OpenAI
npm run collect -- <user_id>            # quét trang user, lấy video ID mới
npm run fetch   -- <user_id>            # bắt link media + tải audio.mp3 (song song, xem dưới)
npm run stt     -- <user_id>            # transcribe
npm run all     -- <user_id>            # cả 3 bước tuần tự
npm run status  -- <user_id>            # xem tiến độ

npm run probe   -- <user_id>            # khảo sát DOM trang user, chốt selector danh sách tác phẩm
npm run prune   -- <user_id> [--apply]  # xoá video của tác giả khác đã lỡ tải (mặc định chỉ xem trước)
npm run inspect -- <video_id>           # dump JSON/URL bắt được của 1 video
npm run compare -- <user_id> <video_id> # so sánh transcript giữa các STT model
```

Ba bước tách rời và đều đọc lại `state.json` từ đĩa, nên chạy lại lệnh nào cũng chỉ xử lý phần còn thiếu — Ctrl-C giữa chừng rồi chạy lại là an toàn. Video `failed` sẽ tự được retry ở lần chạy sau.

## STT tổng thể (whisper) + định danh người nói (diarize)

Phân công rõ ràng, không lẫn vai trò: **whisper-1 làm STT tổng thể** — text lẫn timestamp, là nguồn duy nhất và cuối cùng cho cả hai, không bị model nào khác đè lên. **`gpt-4o-transcribe-diarize` chỉ để định danh người nói**, gán theo chồng lấn thời gian; text riêng của diarize không dùng tới. Số liệu đo thật trên video 227s, lấy từ `usage` — **không dùng bảng ước tính theo phút của OpenAI, nó lệch gấp đôi với tiếng Trung**.

| Model | timestamp | speaker | 122 video | Vai trò |
|---|---|---|---|---|
| `whisper-1` | segment + **word**, phủ 100% | ❌ | $2.71 | **STT tổng thể** (text + timestamp) |
| `gpt-4o-transcribe-diarize` | segment, sót 18% | ✅ | $5.76 | **chỉ** định danh người nói |

Tổng **$8.47** cho 122 video. Tắt nhánh diarize bằng cách để trống `STT_DIARIZE_MODEL` — vẫn ra transcript đầy đủ, chỉ không có nhãn người nói.

### Vì sao whisper-1 làm khung, không phải diarize

Đã đo trên video mẫu: diarize dừng ở **185.3s** trong khi audio dài 227.1s — **bỏ hẳn 42 giây cuối (18%)**, đúng đoạn cao trào. Cắt riêng 42 giây đó gọi lại vẫn không ra. `ffmpeg silencedetect -30dB` cũng không tìm được khoảng lặng nào ở vùng đó (nhạc và hiệu ứng chạy liên tục), nên không suy ra ranh giới câu được. whisper-1 là nguồn duy nhất có mốc thời gian và phủ hết thoại.

Segment nào diarize không chồng lấn tới thì để `speaker: null` — hiện ra ở bước dịch là **"không xác định"** (xem `buildSpeakerHint` trong `src/translate.js`), không đoán.

Trước đây có bước LLM suy nốt nhãn còn thiếu từ mạch hội thoại (đánh dấu `speakerSource: "inferred"`), giờ mặc định **tắt** (`SPEAKER_INFER=false`) — đoán sai giọng đọc lồng tiếng còn tệ hơn một đoạn trung tính "không xác định". Bật lại bằng `SPEAKER_INFER=true`; khi đó soát nhãn suy đoán bằng:

```bash
npm run review-speakers -- <user_id> [video_id]
```

### Tách vocal trước khi gửi diarize — đã thử, bỏ

Giả thuyết: nhạc nền/SFX chạy liên tục (đúng đoạn diarize bỏ) làm model khó tách giọng. Kiểm chứng bằng [Demucs](https://github.com/facebookresearch/demucs) (`--two-stems=vocals`) tách vocal ra khỏi audio rồi gọi diarize lại trên bản đã tách — xem `scripts/compare-diarize-bgm.js`, vẫn giữ trong repo để ai cần thử lại.

**Kết quả đúng như giả thuyết**: coverage video mẫu 81.6% → 97.3% (185.2s → 220.9s, +35.7s), không tăng chi phí API (giá theo thời lượng audio, không đổi dù input gốc hay đã tách).

**Nhưng không đưa vào pipeline chính**: Demucs là neural net chạy CPU, tốn vài phút mỗi video — nhân với hàng trăm video trong 1 batch thì trở thành **bottleneck cổ chai** của cả pipeline, đổi lấy 15.7 điểm % coverage cho riêng nhãn người nói (đã có "không xác định" làm phương án chấp nhận được cho phần thiếu). Không đáng đánh đổi tốc độ batch lấy việc đó. `src/vocals.js` vẫn còn trong repo (không import ở đâu trong flow chính) nếu sau này muốn cân nhắc lại — ví dụ chạy riêng cho một mẻ nhỏ cần chất lượng cao thay vì default cho cả batch.

### Nhãn người nói không cố định xuyên suốt cả bộ — chấp nhận

Diarize gán nhãn **theo từng file** — "A" của tập 1 không liên quan tới "A" của tập 2. Từng thử giải bằng `known_speaker_references` (đăng ký mẫu giọng qua `npm run speaker-add` để nhãn trả về cố định, ví dụ `protagonist`/`shopkeeper`/`merchant` thay vì A/B/C — đã kiểm chứng chạy được thật) nhưng bỏ: cơ chế đó gắn với giọng của **một bộ truyện cụ thể**, đổi sang `user_id`/bộ truyện khác là vô nghĩa, lại thêm bước thủ công (nghe, xác định, đăng ký từng nhân vật) phải làm lại mỗi lần đổi nguồn — không đáng để giữ cho một pipeline generic.

Giờ chấp nhận nhãn A/B/C không ổn định giữa các tập; segment nào không xác định được thì để "không xác định" (xem mục "Vì sao whisper-1 làm khung" ở trên) thay vì cố ép danh tính xuyên suốt.

### Cache response — chỉnh thuật toán không tốn tiền

Cả 2 response thô lưu cạnh `transcript.json`: `raw-whisper.json`, `raw-diarize.json`. `--force` chỉ **căn lại**, không gọi lại API. Muốn nhận dạng lại thật thì xoá file `raw-*.json` tương ứng.

Đây là phần đắt nhất của pipeline nên đừng bỏ cache — và cũng tránh được cái bẫy đã gặp: căn lại trên `transcript.json` đã enrich là đang căn text đã căn với chính nó.

## Dịch — và cái bẫy hai model của Google

`npm run translate -- <user_id>` dịch transcript sang tiếng Việt **theo từng segment, giữ nguyên timestamp** — đúng thứ LangDub cần để căn tiếng dub.

### Chia lại theo segment mà vẫn giữ ngữ cảnh

Dịch rời từng câu thì lạc quẻ; dịch cả cụm thì không biết đường chia lại theo mốc thời gian. Cách giải: **đánh số từng dòng rồi gửi cả cụm trong một request**. Bản dịch có đủ ngữ cảnh, số thứ tự cho phép tách lại chính xác. Tách hỏng thì tự chia đôi thử lại, cuối cùng mới dịch từng dòng riêng — và ghi cảnh báo vào `alignmentWarnings`, không im lặng ghi ra bản lệch segment.

**Segment rỗng phải loại trước khi gửi.** whisper thỉnh thoảng trả segment rỗng (`text: ""`, `start == end`) — đo được 1/94 segment. Dòng rỗng thì cơ chế tách theo số **không bao giờ** thoả được, nên nó kéo cả cụm vào chuỗi chia đôi tới tận 1 dòng. Đã xảy ra thật trên `7670837569118145855`: `alignmentWarnings` ghi đúng từng mức `55 → 28 → 14 → 7 → 4 → 2`, tức **13 lời gọi API cho một payload 630 ký tự**, dòng rỗng nhận về câu từ chối của model (*"Xin vui lòng cung cấp văn bản bạn muốn dịch"*) và các segment lân cận ra **phiên âm Hán-Việt** thay vì bản dịch (`此物若是运作得当` → *"Tử vật nhược thị vận tác đắc đương"*). Giờ segment rỗng bị bỏ khỏi payload và ghép lại `""` ở cuối.

**Gộp segment liền mạch trước khi dịch.** whisper cắt theo chunk của nó chứ không theo câu, nên hay **chặt đôi giữa từ**. Đo được trên `7671277280118852883`:

```
segment 23  139.04-143.08  merchant  最近极北之地不太平,据说有上动物出事,作
segment 24  143.08-147.08  merchant  日有四个金丹往北去了,道友可得小心些,
                ↑ gap = 0.00s, cùng người nói — 昨日 bị xẻ làm hai
```

Bản dịch nhận về *"…gặp chuyện, **làm**"* rồi *"**Ngày hôm đó** có bốn Kim Đan…"*. Thêm bao nhiêu ngữ cảnh cũng vô ích: nửa chữ nằm ở dòng khác thì dòng này **buộc phải** dịch sai.

`TRANSLATE_MERGE_MAX_GAP_SEC` (mặc định `0.2`) gộp các segment liền mạch cùng người nói thành một đơn vị dịch — video mẫu: 39 segment → 36 đơn vị. Ngưỡng chặt là **chủ ý**: cả 3 chỗ gộp đều có khoảng cách đúng `0.000s`, tức không nuốt mất khoảng lặng thật nào. Nới ngưỡng lên (ví dụ `1.5` như `SPEAKER_MERGE_MAX_GAP_SEC`) sẽ gộp qua cả những quãng im lặng có thật, và lúc TTS đọc đơn vị đó thành một hơi liền thì tiếng dub lệch khỏi hình.

Nối text phải **không có dấu cách** khi hai bên là chữ Hán — nối bằng dấu cách thì ra `作 日`, cả hai nửa đều vô nghĩa. Lỗi này cũng ảnh hưởng trường `turns` trong `transcript.json`; chạy `npm run stt -- <user_id> --force` để dựng lại (đọc từ `raw-*.json`, không gọi API).

Giới hạn đã biết: phép gộp chỉ tin vào nhãn của diarize. Ở video mẫu, `先破禁制,再各凭本事,联手,` và `凭什么?` rõ ràng là hai người nhưng diarize gán cùng `shopkeeper` nên vẫn bị gộp. Không có tín hiệu nào trong dữ liệu để tách — chỉ sửa được ở khâu nhãn.

**Cỡ cụm: 4000 ký tự, và con số đó KHÔNG phải tuỳ tiện.** Nó vốn sinh ra từ giới hạn ô nhập của translate.google.com — một ràng buộc chẳng liên quan gì tới LLM. Nhưng đo lại trên `deepseek-2pass` (video `7663643779055766836`, 179 đơn vị dịch / 5715 ký tự) thì hoá ra LLM còn chặt hơn thế:

| Cỡ cụm | Dòng còn chữ Hán | Cảnh báo |
|---|---|---|
| 1 cụm / 179 dòng | **179/179** | 1 |
| 2 cụm / 116+63 dòng | **0/179** | 0 |

Gửi cả 179 dòng trong một request thì `deepseek-chat` **bỏ hẳn việc dịch và quay ra biên tập tiếng Trung** (`差点憋死你们…` → `差点憋死我们，你们…`), nháp 5715 → 5732 ký tự. Không phải chuyện context window — deepseek-chat có 64K, thừa chỗ; đây là chuyện model mất bám nhiệm vụ khi danh sách đánh số quá dài. Ngưỡng gãy nằm giữa 116 và 179 dòng.

Vì vậy trần tách làm hai: `TRANSLATE_MAX_CHARS` cho provider Google (ô nhập/URL), `TRANSLATE_MAX_CHARS_LLM` cho provider LLM (sức chịu của model), mỗi provider tự khai qua `export const maxChars`. Hai ràng buộc khác hẳn nhau nên **đừng nâng cái nào lên mà chưa đo lại trên chính model đang dùng**.

Nhưng chia nhỏ cụm chỉ là **giảm xác suất**, không phải cách chữa — xem mục ngay dưới.

### Model trả lại nguyên tiếng Trung, và giao thức đánh số không phát hiện được

Cùng lỗi trên tái diễn ở quy mô nhỏ hơn hẳn: video `7658103101886434560`, **43 dòng / 1180 ký tự**, xa mọi trần. `deepseek-chat` (server trả `deepseek-v4-flash`) trả về đúng 43 dòng đánh số — **toàn bộ bằng tiếng Trung**, đã được nó chuẩn hoá lại (`差点憋。`/`死。` → `差点憋死。`, `巡山小肖` → `巡山小妖`). Cả 3 lượt nháp → review → polish đều thế: lượt 2 và 3 không cứu được gì vì prompt của chúng mặc định bản nháp *đã* là tiếng Việt.

Điều tệ nhất không phải model làm sai, mà là **pipeline không biết**. Output "đúng định dạng" nên `parsePayload()` nhận, `translation.json` được ghi ra bình thường, chỉ để lại một dòng cảnh báo *"43 dòng còn chữ Hán"* lẫn giữa log. Chạy batch 122 video thì lọt.

Ba nguyên nhân, sửa cả ba:

1. **Prompt không có chỗ nào phát biểu nhiệm vụ.** System prompt mở bằng vai diễn (*"Bạn là dịch giả…"*) rồi đổ liền ~40 dòng quy tắc *văn phong*; động từ duy nhất là `Dịch sang vi` nằm lẻ loi ở đầu user message, ngay trên 43 dòng tiếng Trung. Giờ có khối `translateTask()` đặt ngay sau vai diễn, phát biểu nhiệm vụ như mệnh lệnh kèm **tiêu chí SAI rõ ràng** (*"một phần tử đầu ra còn chữ Hán là SAI"*), và câu lệnh sát payload cũng nhắc lại ngôn ngữ đích.
2. **Giao thức đánh số cho phép "y hệt input" là hợp lệ.** Đã đổi sang **JSON Mode** của DeepSeek (`response_format: {"type":"json_object"}`) với dạng `{"translations": [...]}`. Không phải vì JSON hiểu tiếng Việt hơn — mà vì nó ép output ra khỏi hình dạng đầu vào, và cho chỗ này một lỗi **phân biệt được** (JSON hỏng → chia cụm thử lại) thay vì một bản dịch giả trông như thật.

   ⚠️ **`json_object` KHÔNG nhận schema.** `response_format` của DeepSeek chỉ chấp nhận `text` hoặc `json_object` — không có `json_schema` như OpenAI. Nó chỉ đảm bảo output là **JSON hợp lệ về cú pháp**, chứ không đảm bảo đúng hình dạng. Nên cấu trúc chỉ tồn tại ở đúng hai chỗ, cả hai đều trong prompt và đều bắt buộc:

   - **mô tả khoá** — `"translations"` là mảng chuỗi, phần tử thứ i ứng với dòng số i;
   - **cặp `EXAMPLE INPUT` / `EXAMPLE JSON OUTPUT`** — đúng khuôn mẫu trong doc.

   Doc đòi đủ 3 điều kiện mới chạy: bật `response_format`, prompt có chữ `json`, **và** prompt có ví dụ JSON — thiếu một là API trả content rỗng. Vì hình dạng chỉ được định nghĩa bằng ví dụ nên **ví dụ phải cùng dạng với đầu vào thật của lượt gọi đó**: lượt nháp nhận một khối, review/polish nhận hai khối (bản gốc + bản dịch), nên `jsonOutputRules()` nhận `exampleInput`/`exampleOutput` riêng cho từng lượt thay vì dùng chung một ví dụ. Ví dụ của review/polish còn được chọn để dạy luôn hành vi khó: review giữ nguyên dòng đã đúng nhưng dịch dòng còn tiếng Trung; polish giữ nguyên dòng trôi chảy nhưng chữa `理当先奉给高僧` từ *"lẽ ra nên"* thành *"đương nhiên phải… mới phải"*.

   Vì `json_object` không kiểm hình dạng, `jsonOutput.js` tự kiểm: có phải JSON không, có mảng `translations` không, đúng số phần tử không — sai bất kỳ điều nào thì coi như lượt gọi hỏng.
3. **Hai lượt hậu kỳ không có luật xử lý bản nháp hỏng.** `review` và `polish` giờ mở đầu bằng *"nếu một dòng còn nguyên tiếng Trung thì DỊCH nó"* — hàng rào thứ hai, không thay cho việc sửa lượt nháp.

Kết quả trên đúng video đó, cùng model, cùng 1 cụm 43 dòng:

| | Nháp | Dòng còn chữ Hán | Cảnh báo |
|---|---|---|---|
| Trước | 1180 → **1180** ký tự (tiếng Trung) | **43/43** | 1 |
| Sau | 1180 → **3616** ký tự (tiếng Việt) | **0/43** | 0 |

`max_tokens` (`TRANSLATE_MAX_TOKENS`, mặc định 8192) là bắt buộc với JSON Mode: JSON bị cắt giữa chừng là **mất trắng cả cụm**, không phải mất dòng cuối như giao thức đánh số.

Provider nào đi đường nào: `openai` dùng Structured Outputs (`json_schema`, strict — OpenAI kiểm cả schema nên không cần ví dụ); `deepseek`/`deepseek-2pass` dùng JSON Mode như trên; `qwen` và `google-*` vẫn đi giao thức đánh số. Qwen để nguyên là **chủ ý**: DashScope compatible-mode có thể lặng lẽ bỏ qua tham số lạ, mà bỏ qua thì mọi cụm parse hỏng và bước dịch tự chia đôi tới đáy — hỏng đắt hơn hẳn giữ nguyên đường cũ. Muốn bật thì đo trước.

### Prompt có glossary và không glossary là hai prompt khác nhau

Chạy `--no-glossary` (hoặc cụm không khớp thuật ngữ nào) thì payload **không có ký hiệu `⟦số⟧` nào**, nhưng prompt cũ vẫn gửi đủ 4 quy tắc dạy model phải làm gì với `⟦số⟧` — bắt nó nhớ luật cho một ký hiệu không tồn tại, và làm loãng đúng phần quy tắc đang có tác dụng.

`genreRules()`, `sttFixRules()`, `translateTask()` nhận cờ và bỏ hẳn phần placeholder khi không cần. Luật `镜/境/期` có **hai bản** chứ không bị bỏ đi: bản có placeholder neo vào `⟦số⟧` tên cảnh giới, bản còn lại neo thẳng vào chữ Hán (`金丹镜`/`金丹境`/`金丹期` đều là *"Kim Đan Kỳ"*) — cùng một lỗi thật, chỉ khác chỗ tên cảnh giới đã bị thay bằng `⟦số⟧` hay chưa.

**Cờ đó là HAI cờ, không phải một.** Bản đầu chỉ có `hasGlossary = Boolean(placeholderDict)`, tức "có placeholder" và "có glossary" là cùng một biến — nên tắt cơ chế placeholder là mất luôn mọi ràng buộc thuật ngữ trong prompt, không đo được riêng `protect()`. Giờ `glossaryFlags()` (trong `translators/openai.js`) trả về hai cờ và mọi provider suy giống nhau:

| | `hasGlossary` | `hasPlaceholders` | prompt nhận được |
|---|---|---|---|
| mặc định | ✓ | ✓ | luật giữ `⟦số⟧` + bảng `⟦0⟧ = 金丹 (Kim Đan)` |
| `--no-protect` | ✓ | ✗ | luật ghim neo vào mặt chữ + bảng `金丹 = Kim Đan` |
| `--no-glossary` | ✗ | ✗ | không nhắc gì tới thuật ngữ |

Nhánh **có bọc** giữ nguyên từng byte so với bản cũ — mọi số đo trước đó vẫn so được với chế độ mới. Vì thế chữ `placeholderDict` còn nằm trong văn bản prompt dù tham số trong code đã đổi tên thành `glossaryDict`.

Đo trên cụm 3 dòng, `deepseek-2pass` (3 lượt gọi), system prompt:

| Lượt | Không glossary | Có glossary |
|---|---|---|
| nháp | 3317 ký tự | 4002 |
| review | 4571 | 6120 |
| polish | 4392 | 5143 |

**Cụm nhỏ phải mang theo bối cảnh.** Nguyên nhân của phần phiên âm ở trên: cụm càng nhỏ càng trơ trọi, LLM mất mạch truyện thì quay ra phiên âm. Khi chia đôi, mỗi cụm con nhận kèm tối đa 6 dòng lân cận (để nguyên chữ Hán, ghi rõ **không dịch**), và cụm 1 dòng ở đáy vẫn giữ đánh số như mọi cụm khác — bỏ số đi thì model không còn coi đây là cùng một việc.

**Bản đồ người nói dựng lại theo từng cụm con.** Hint ghi theo số dòng (`Dòng 1-4: protagonist`), mà mỗi cụm đánh số lại từ 1 — nên cả lúc chia cụm theo `TRANSLATE_MAX_CHARS`, lúc chia đôi khi tách hỏng, lẫn lúc chèn câu mồi vào đầu payload đều phải đánh số lại. Thiếu một chỗ là gán người nói lệch dòng mà không có dấu hiệu gì.

**Nhãn suy đoán được ghi rõ là suy đoán.** Diarize bỏ trống ~23% segment, phần đó do LLM suy từ mạch hội thoại (`speakerSource: "inferred"`). Trong hint gửi đi dịch, chúng hiện ra là `không xác định — khả năng là merchant` chứ không trộn lẫn với nhãn nhận dạng giọng, kèm chỉ dẫn coi đó là gợi ý và ưu tiên cách dịch trung tính nếu đoán sai thì hỏng nghĩa. Gộp một nhãn chắc chắn với một nhãn suy đoán thì cả đơn vị tính là suy đoán — lấy theo mức kém tin cậy nhất.

### ⚠️ Google phục vụ hai model qua cùng một giao diện

Đây là phát hiện quan trọng nhất của bước này, đo được bằng thực nghiệm:

| Lần chạy | Cùng URL, cùng nội dung |
|---|---|
| Lần 1 | *"Giết người phóng hỏa mới mau giàu" — con đường đó chưa bao giờ dành cho ta* |
| Lần 2 | *"đai vàng giết người đốt lửa không thể kế vị được ta"* |

Model LLM (tốt) bị **giới hạn tần suất**, dùng vài request là tụt xuống NMT đời cũ. Đã loại trừ từng giả thuyết: không phải `sl=auto` vs `sl=zh-CN`, không phải locale trình duyệt, không phải cỡ cụm (3/5/10/20/39 dòng ra kết quả y hệt), không phải glossary, không phải inline marker.

Không có dấu hiệu nào trên trang cho biết đang chạy model nào, nên pipeline **chèn một câu mồi vào đầu payload thật** — một thành ngữ mà NMT luôn dịch trần thành "đai vàng…". Bản dịch câu đó chứa `TRANSLATE_CANARY_BAD` nghĩa là đang bị model kém → tự chờ `TRANSLATE_COOLDOWN_MS` rồi dịch lại, tối đa `TRANSLATE_COOLDOWN_TRIES` lần.

Câu mồi phải đi **cùng** payload, không được hỏi riêng: đã thử hỏi riêng một request trước và hỏng — chính câu thăm dò đốt mất suất model tốt, canary báo "ổn" trong khi bản dịch nhận về là bản tệ.

Chờ mãi vẫn kém thì vẫn ghi file nhưng gắn cờ `degradedModel: true`; chạy lại `--force` sau để dịch lại đúng những video đó.

### Bản dịch lỗi thời sau khi transcribe lại

Chống trùng dựa vào đĩa chứ không vào state, nhưng **có mặt file là chưa đủ**. `stt --force` đặt status về `transcribed`, nên `translate` nhặt lại video đó — rồi thấy `translation.json` nằm sẵn là bỏ qua: transcript mới đi cùng bản dịch cũ, `zh`/`start`/`end` lệch hẳn mà không cảnh báo gì. Giờ bước chống trùng **đối chiếu nội dung**: số segment, từng `zh`, và cả `speaker` (biết ai nói thì xưng hô dịch ra khác). Lệch chỗ nào thì in ra chỗ đó rồi dịch lại, không cần `--force`.

### Glossary

`glossary.json` ở gốc project (không gitignore), dạng `{"金丹": "Kim Đan"}`. Mục đích là **nhất quán giữa 122 tập** — không có nó thì tập 1 ra "Kim Đan", tập 5 ra "Kim Đơn".

Cách áp dụng: thay thuật ngữ bằng placeholder `⟦n⟧` trước khi dịch rồi khôi phục sau, nên **dùng được với cả provider không nhận chỉ dẫn** như Google. Ba chỗ phải xử lý riêng, đều là bug đã gặp thật:
- Placeholder được bọc trong dấu cách, không thì tiếng Trung viết liền làm thuật ngữ dính vào từ bên cạnh: `tiền bốiĐùa thôi`, `Kim Đanold`.
- Khi khôi phục phải nhận mọi kiểu ngoặc, vì model LLM "chuẩn hoá" `⟦0⟧` thành `[0]` — không nhận thì lọt nguyên ra bản dịch: `cao thủ cấp [0] hậu kỳ`.
- Hoa/thường quanh chỗ thay: model không thấy được chữ trong `⟦n⟧` nên coi nó không phải chữ và viết hoa từ ngay sau — `前辈去而复返` ra `tiền bối Đi rồi lại về`, còn `极品宝器` đứng đầu câu thì ra `cực phẩm bảo khí` không hoa. Khi khôi phục, placeholder **đầu câu** được viết hoa và chữ ngay sau nó hạ xuống. Placeholder **giữa câu** thì để yên: chữ hoa ở đó có thể là tên riêng thật (`đi tới cực bắc Trung Châu`), nên thà bỏ sót vài chỗ còn hơn phá tên riêng.

**Tắt để A/B, hai nấc — vì có hai thứ khác nhau cần đo:**

| chế độ | `protect()` | model nhận được |
|---|---|---|
| mặc định | có, bọc `⟦n⟧` | `⟦0⟧ = 金丹 (Kim Đan)` |
| `--no-protect` / `GLOSSARY_PROTECT=false` | không, text nguyên vẹn | `金丹 = Kim Đan` (chỉ thuật ngữ có trong cụm) |
| `--no-glossary` / `GLOSSARY=false` | không | không gì cả |

Cả hai cờ được ghi vào `translation.json` (`"glossary"`, `"glossaryProtect"`) để các bản nằm cạnh nhau còn phân biệt được. Hai chế độ đầu quét thuật ngữ bằng **cùng một hàm** (`scan()` trong `glossary.js`) nên thấy đúng cùng một tập — khác nhau đúng ở chỗ text có bị đụng vào hay không.

Cần tắt riêng `protect()` vì nó là nghi phạm khi bản dịch sót chữ Hán hoặc cụt câu — dòng ngắn mà placeholder chiếm gần hết thì model có vẻ bỏ dịch phần còn lại (đo trên case `乾坤袋`: có placeholder ~40% sót chữ Hán, không có 0/5). **Nhưng bản đo đó dùng `--no-glossary` cũ nên đổi 2 biến cùng lúc** (nhánh tắt mất luôn bản dịch ghim), không quy được trách nhiệm cho riêng cơ chế placeholder — đó chính là lý do có `--no-protect`.

**Nhưng đo lại trên video `7673825419585408302` (三打白骨精) thì không tái hiện được**, và số liệu ở đó cảnh báo một cái bẫy đo đạc: bật/tắt glossary lệch nhau **21/43 dòng**, nhưng chạy **hai lần cùng cấu hình** (đều tắt) cũng đã lệch **22/43** — nhiễu của `deepseek-2pass` lớn ngang hiệu ứng cần đo, nên đếm số dòng khác nhau là vô nghĩa. Phải so đúng những dòng **có chứa thuật ngữ**: ở đó 8/9 lần thuật ngữ vẫn ra đúng mặt chữ khi TẮT (`长老`, `师兄`, `师弟`, `老夫`, `心魔` — đều là từ phổ thông model tự dịch đúng), và 1 lần còn lại thì bản TẮT **đúng hơn**: `老朽` trong `glossary.json` ghi `"Lão Hủ"` viết hoa nên bị nhét vào như tên riêng (`một Lão Hủ như hắn`), trong khi nó là đại từ tự xưng khiêm nhường — bản tắt ra `một lão già như hắn`. Cả hai bản đều 0 chữ Hán sót, 0 placeholder sót.

### Đổi provider

`TRANSLATE_PROVIDER` trong `.env`, hoặc `--provider` cho một lần chạy:

| Provider | Chất lượng | Speaker | Chi phí | Ghi chú |
|---|---|---|---|---|
| `openai` | ổn định | ✅ | ~$0.03 / 122 video | **mặc định**; sửa được lỗi đồng âm của STT (`下瓶宝剑` → `下品宝剑`) |
| `openai-2pass` | mượt hơn `openai` | ✅ | ~gấp đôi `openai` | dịch nháp rồi tự biên tập lại văn phong — xem mục dưới |
| `google-web` | tốt nhất **khi không bị bóp** | ❌ | miễn phí | Playwright lái translate.google.com |
| `google-free` | kém | ❌ | miễn phí | endpoint `translate_a/single` đời cũ; hợp để kiểm thử phần chia segment |
| `google-2pass` | không ổn định | ✅ | ~bằng `openai-2pass` | **chỉ để so sánh**, không khuyến nghị dùng thật — xem mục dưới |

Cột **Speaker** là lý do mặc định là `openai` chứ không phải `google-web` dù Google dịch hay hơn khi không bị bóp: nhãn người nói đi vào **system prompt**, mà dịch máy không có system prompt. Chạy Google nghĩa là vứt toàn bộ kết quả diarize — phần đắt nhất của bước STT ($5.76/122 video) — và mất luôn xưng hô đúng (`前辈可去…` ra *"Bạn có thể…"* thay vì *"tiền bối có thể…"*). Pipeline in cảnh báo khi rơi vào tình huống này thay vì im lặng bỏ qua. `google-2pass` vẫn dùng được vì lượt dịch chính do OpenAI làm, chỉ lượt tham khảo là Google.

`npm run translate-compare -- <user_id> <video_id>` in bản dịch của các provider trong `TRANSLATE_COMPARE_PROVIDERS` cạnh nhau trên cùng nội dung.

### Model Trung Quốc

Nội dung là truyện tiên hiệp tiếng Trung nên model TQ là ứng viên hợp lý. Hai provider `deepseek` và `qwen` dùng chung API tương thích OpenAI, nên cả hai chỉ là `baseURL` + key + tên model khác — thân chung ở [src/translators/chat.js](src/translators/chat.js), **dùng lại đúng system prompt của `openai`** để `translate-compare` so đúng thứ cần so.

Đo độ trễ bắt tay TLS từ VN (tất cả đều trả 401 đúng, tức endpoint sống):

| Endpoint | TLS |
|---|---|
| `dashscope-intl.aliyuncs.com` (Singapore) | 0.31s |
| `api.deepseek.com` | 0.33s |
| `api.siliconflow.cn` | 0.78s |
| `ark.cn-beijing.volces.com` (Volcengine) | 1.70s |
| `dashscope.aliyuncs.com` (Bắc Kinh) | 1.55s |
| `api.openai.com` | 0.18s *(nhưng chập chờn — xem `HTTPS_PROXY` trong `.env.example`)* |

Lý do đổi **không phải tiền**: dịch 122 tập bằng `gpt-4o-mini` chỉ ~$0.03. Lý do là đường mạng ổn định hơn và thuật ngữ 玄幻.

**Rủi ro nằm ở chiều ngược lại.** Điểm yếu không phải phần hiểu tiếng Trung mà phần **viết tiếng Việt**. Lỗi từng gặp là model bí thì quay ra phiên âm Hán-Việt (`此物若是运作得当` → *"Tử vật nhược thị vận tác đắc đương"*); model thạo tiếng Trung mà yếu tiếng Việt dễ rơi vào đó hơn chứ không ít hơn. Đo trước khi đổi, đừng đổi theo cảm tính:

```
npm run translate-compare -- <user_id> <video_id>
```

Hai thước đo khách quan có sẵn:
- **Chữ Hán còn sót trong bản tiếng Việt** — pipeline đếm và ghi vào `alignmentWarnings`. Mốc của `openai`: **2/36 đơn vị**, cả hai đều là `玉寒袍` (chính là chỗ STT nghe sai `御寒袍`, model không tra ra từ nên bỏ nguyên). Chữ Hán lọt sang TTS tiếng Việt là đọc ra rác.
- **Sửa được lỗi đồng âm của STT không** — `作日` phải ra *"hôm qua"* chứ không phải *"làm ngày"*.

### So engine STT

```bash
npm run compare -- <user_id> <video_id>
```

Engine chọn bằng `STT_COMPARE_MODELS`, cú pháp `engine:model` (thiếu engine thì mặc định `openai`):

| Engine | Key | Timestamp | Ghi chú |
|---|---|---|---|
| `openai:whisper-1` | `OPENAI_API_KEY` | ✅ | nguồn duy nhất có word-level timestamp |
| `openai:gpt-4o-transcribe` | `OPENAI_API_KEY` | ❌ | text chuẩn hơn whisper |
| `qwen:qwen3-asr-flash` | `DASHSCOPE_API_KEY` | ❌ | nhận file local qua base64 |
| `siliconflow:<model>` | `SILICONFLOW_API_KEY` | ❌ | host SenseVoice / Fun-ASR mã nguồn mở |

**Căn cứ chính là phần diff, không phải bảng điểm.** In hai bức tường ~460 ký tự chữ Hán cạnh nhau rồi tự nhìn thì đó không phải so sánh, đó là đoán. Lệnh chỉ hiện ra **đúng những chỗ hai engine nghe khác nhau**, kèm ngữ cảnh — video mẫu ra 35 điểm:

```
gpt-4o-transcribe ↔ whisper-1 — trùng 88.0%, 35 điểm khác
────────────────────────────────────────────────────────
  …住了成了下⟨品⟩宝剑威力至…
  　　　　　 ⟨瓶⟩   ← whisper-1

  …越冷了听说⟨极北⟩深处出了异…
  　　　　　 ⟨我脊背⟩   ← whisper-1

  …况掌柜有三⟨阶玉⟩寒袍吗前辈…
  　　　　　 ⟨节御⟩   ← whisper-1
```

Điểm cuối là ví dụ hay: whisper nghe đúng `御寒袍` còn gpt-4o nghe đúng `三阶` — **hai model bù nhau chứ không cái nào trội hẳn**. Đây là bảng so sánh để CHỌN model cho `STT_MODEL`, không phải cơ chế ghép nguồn trong pipeline chính — pipeline hiện tại chỉ dùng đúng 1 model cho text (`whisper-1`), diarize chỉ định danh người nói chứ không đóng góp text (xem mục "STT tổng thể (whisper) + định danh người nói (diarize)").

**Điểm theo glossary là thước đo phụ, và đã đo là YẾU.** `glossary.json` 151 mục chỉ phủ **3/12** từ phân định trên video mẫu (`灵石`, `禁制`, `洞府` có; `下品宝剑`, `三阶`, `极北`, `四阶`, `御寒袍`, `玄黄钟`… đều không), nên nó ra 14 vs 13 sát nút trong khi diff cho thấy hơn kém rõ ràng. Giữ lại vì đó là con số tuyệt đối duy nhất có được mà không phải ngồi nghe lại 227 giây audio — nhưng đừng chốt model bằng riêng nó. Thấy từ nào hay bị nghe sai thì bổ sung vào `glossary.json`, lần sau đo được.

Bảng này **không** trả lời câu hỏi timestamp và nhãn người nói — xem mục dưới.

### STT bằng model Trung Quốc — khảo sát, CHƯA làm

Đây mới là chỗ đáng tiền ($8.47/122 video, so với $0.03 cho dịch) và đáng công: kiến trúc 2 nguồn tồn tại *chỉ vì* OpenAI không có model nào vừa cho timestamp vừa cho speaker vừa nghe đúng tiếng Trung. Bên Alibaba, cả ba nằm trong **một lời gọi** — nếu đúng thì phần lớn [src/align.js](src/align.js) thành thừa.

| Biến thể | Input | Timestamp | Speaker | Hotword |
|---|---|---|---|---|
| `fun-asr` / `paraformer-v2` (async) | **URL công khai** | câu + từ | `speaker_id` | `vocabulary_id` |
| `qwen3-asr-flash-filetrans` (async) | **URL công khai** | câu + từ | `speaker_id` | ? |
| `qwen3-asr-flash` (đồng bộ, ≤5 phút) | file local, base64 | ❌ | ❌ | ❌ |

**Một vật cản, chưa vượt:**

**Bản có timestamp + speaker chỉ nhận URL công khai**, không nhận upload file. Bản nhận file local (`qwen3-asr-flash`) lại không có timestamp lẫn speaker — mà timestamp là thứ cả pipeline dựng lên quanh nó. Nghĩa là phải đẩy audio lên OSS, hoặc chuyền thẳng link CDN `douyinvod.com` mà `capture.js` đã bắt được (link có chữ ký, sống ~1 giờ — hiện `stt` chạy tách rời `fetch` nên hay quá hạn).

(Trước đây còn vật cản thứ hai — thiếu cơ chế tương đương `known_speaker_references` để giữ danh tính nhân vật xuyên suốt cả bộ bằng `speaker_id` đánh theo từng file. Hết áp dụng: đã bỏ hẳn mục tiêu đó, xem "Nhãn người nói không cố định xuyên suốt cả bộ" ở trên — không generic giữa các bộ truyện khác nhau.)

Chưa viết code cho hướng này: chưa có key để chạy thử, và dự án này có tiền lệ đo bằng lời gọi thật rồi mới xây. Bước tiếp theo là một lời gọi thật trên `7671277280118852883` để đối chiếu với mốc đã có: 39 segment, `alignScore` 0.837, `下品宝剑` đúng, 39/39 có speaker.

### `deepseek-2pass`: mỗi lượt một model, và vì sao lượt review phải là model suy luận

`deepseek-chat` **không còn nằm trong `GET /models`** (2026-09-06 chỉ chào ra `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`). Nó vẫn resolve được như một alias cũ, và đo thật thì chạy **không suy luận** (`reasoning_tokens: 0`, ~3s/cụm). Alias `deepseek-reasoner` cũng còn sống nhưng vô dụng: 8192 token suy luận cho **2 dòng** input rồi trả `content` rỗng.

Ba lượt dùng ba biến khác nhau vì chúng cần ba thứ khác nhau:

| Lượt | Biến | Mặc định | Vì sao |
|---|---|---|---|
| 1 nháp | `DEEPSEEK_MODEL` | `deepseek-chat` | cần nhanh + rẻ, phần khó đã dời sang lượt 2 |
| 2 review | `TRANSLATE_REVIEW_MODEL` | `deepseek-v4-pro` | cần **suy luận** để bắt lỗi đồng âm ASR |
| 3 polish | `DEEPSEEK_REVIEW_MODEL` | `deepseek-chat` | chỉ chữa văn phong trên bản đã đúng nghĩa |

Đo trên **cùng một bản nháp cố định** (video `7658103101886434560`, 22 dòng đầu, 4 lỗi nghĩa đã soát tay: `面修`→`面首` "nam sủng", `宝藏`→"kho báu", `从前进来`→"cố ý tìm đến", `小肖`→`小妖` "tiểu yêu"):

| Model làm lượt review | Thời gian | Đổi dòng | Ca đúng | Token suy luận |
|---|---|---|---|---|
| `deepseek-chat` | 3.9s | **1/22** | 1/4 | 0 |
| `qwen3-max` | 9.6s | 4/22 | 1/4 | 0 |
| `deepseek-v4-flash` | — | — | — | 32.767 rồi trả **rỗng** |
| `deepseek-v4-pro` | 377.1s | 6/22 | **3/4** | 21.677 |

Kết luận: lượt review chạy bằng model **không suy luận** thì gần như không làm gì — đo hai lần đều ra 0-1/22 dòng thay đổi. Trả tiền cho một lượt không đóng góp gì còn tệ hơn là trả nhiều tiền cho một lượt có tác dụng, nên mặc định đổi sang `deepseek-v4-pro`, chấp nhận ~6 phút/cụm. Chạy batch gấp thì hạ về `deepseek-chat` qua `.env`.

**Cái bẫy: trần token giết model suy luận một cách IM LẶNG.** Token suy luận tính chung hạn ngạch `max_tokens`. Hết quota giữa lúc đang nghĩ thì `content` về **rỗng** (không phải JSON cụt), mà output rỗng lại đi đúng nhánh fallback "giữ nguyên bản đưa vào" của `runPass()` — nhìn từ ngoài y hệt một lượt review sạch sẽ không tìm thấy lỗi nào. `TRANSLATE_MAX_TOKENS` 8192 và 18192 đều đo được là rỗng với `v4-pro`; vì thế lượt review có trần riêng `TRANSLATE_REVIEW_MAX_TOKENS` (32768) và `runPass()` log `error` khi bắt được `finish_reason: "length"` + `content` rỗng. Đừng đổi sang `deepseek-v4-flash` để "cho nhanh": nó đốt sạch mọi trần mà không viết ra dòng JSON nào.

**Log giờ đếm số dòng THỰC SỰ đổi.** Trước đây mỗi lượt chỉ in độ dài ký tự trước/sau, mà một lượt no-op hoàn toàn vẫn in ra hai số bằng nhau trông rất bình thường — đó là lý do lượt review vô dụng suốt một thời gian dài mà không ai thấy. Giờ `đổi 0/22 dòng` kèm một dòng `warn` nói thẳng lượt đó không đóng góp gì.

**Còn lại chưa giải được:** `差点憋` + `死` bị ASR xẻ đôi ở khoảng cách 0.0 giây rồi gán nhầm hai người nói, nên bước gộp segment (chỉ gộp khi CÙNG người nói) không ghép lại được và hai nửa vào payload như hai dòng rời. Model nhìn thấy cả hai dòng nên thừa thông tin để ghép nghĩa — đã thêm luật cho phép "hiểu cả câu rồi rải lại đúng từng dòng" vào `sttFixRules()`, nhưng chưa model nào sửa đúng ca này trong lúc đo.

### Dịch 2 lượt (nháp + biên tập)

`openai` dịch đúng nghĩa nhưng văn phong khô, không "ra chất" tiên hiệp/huyền huyễn. `openai-2pass` giải quyết bằng MTPE (Machine Translation Post-Editing): lượt 1 dịch sát nghĩa (nháp), lượt 2 đưa cả bản gốc lẫn bản nháp cho OpenAI đóng vai biên tập viên, viết lại cho mượt mà không lệch ý — LLM "sửa bài có sẵn" bám sát nghĩa gốc hơn hẳn "viết lại từ đầu". Muốn phối model rẻ cho nháp + model xịn cho biên tập thì set `TRANSLATE_POLISH_MODEL` (để trống = dùng lại `TRANSLATE_MODEL` cho cả 2 lượt).

Từng thử phương án rẻ hơn — dùng chính `google-web` dịch nháp (miễn phí) thay vì tốn thêm một lượt gọi OpenAI — nhưng bỏ, giữ lại dưới tên `google-2pass` chỉ để so sánh chứ không dùng thật.

`google-2pass` gửi cho Google **nguyên một khối văn xuôi không chia dòng, không đánh số** (đúng định dạng `translation.txt`, không phải payload `1. dòng một / 2. dòng hai` như các provider khác) — gửi kiểu đánh số khiến Google dịch rời rạc từng dòng, mất mạch văn; dịch cả đoạn tự nhiên mượt hơn hẳn. Bản dịch đó chỉ đóng vai **tham khảo**: OpenAI luôn tự dịch lại bản gốc (vẫn đánh số, để còn tách theo segment/timestamp), được phép bỏ qua tham khảo nếu thấy sai chứ không bị bắt "sửa bài" theo từng dòng như `openai-2pass`. Cách này giảm bớt anchoring bias so với thiết kế polish-theo-dòng ban đầu (không còn bị ép bám câu chữ của một bản nháp đã cố định cấu trúc dòng), nhưng không loại bỏ hẳn — tham khảo tệ vẫn có thể dắt sai nghĩa ở chỗ mơ hồ, đây cũng là lý do vẫn xếp loại "không ổn định". Cơ chế canary phát hiện Google tụt model cũng không dùng được ở đây: câu mồi bị gộp chung vào khối văn xuôi cùng nội dung thật nên không tách ra để soi riêng được, và bản dịch cuối cùng dù sao cũng do OpenAI tự dịch lại chứ không phải Google.

Selector của translate.google.com là hash sinh theo build nên sẽ đổi — `npm run probe-translate` dump lại cấu trúc DOM để chốt selector mới.

## Output

```
data/<user_id>/
  state.json                 # video nào đã xử lý tới đâu
  <video_id>/
    audio.m4a                # .mp3 nếu phải rơi về track "music"
    video.mp4                # khi DOWNLOAD_VIDEO=true
    meta.json                # desc, duration, authorSecUid, audioSource, videoGear, ...
    raw-whisper.json         # cache 2 nguồn STT — --force chỉ căn lại, không gọi API
    raw-diarize.json         # cả text chuẩn (field `text`) lẫn nhãn người nói
    transcript.txt
    transcript.json          # segment thô của whisper + words + turns
    translation.json         # ĐƠN VỊ ĐÃ GỘP, không phải segment thô — xem dưới
    translation.txt
```

`translation.json` không ánh xạ 1-1 với `transcript.json`: các segment liền mạch cùng người nói đã được gộp lại trước khi dịch (xem mục dưới). Mỗi mục mang `segmentIndexes` để lần ngược về segment gốc và word-level timestamp; `unit`/`mergeMaxGapSec`/`sourceSegments` ở cấp trên ghi lại cách gộp. Mốc thời gian vẫn là mốc thật của whisper, không nội suy.

## Chạy lần đầu — thứ tự nên làm

1. `npm run login` — trình duyệt mở ra (headed, cố ý: headless thuần dễ bị Douyin chặn) và **đứng yên chờ bạn**. Đăng nhập xong thì bấm Enter ở terminal. Phiên lưu vào `.browser-profile/`, các lệnh sau dùng lại nên chỉ phải làm một lần.
2. `npm run collect -- <user_id>` với 1 user thật. Lệnh này chờ tối đa `PAGE_READY_TIMEOUT_MS` (mặc định 2 phút) cho danh sách video hiện ra, nên vẫn kịp xử lý captcha nếu bị chặn giữa chừng.
3. `npm run inspect -- <video_id>` với 1 video bất kỳ. **Đối chiếu tên field trong file dump với logic parse ở `src/capture.js`** — cấu trúc response của Douyin đổi theo thời gian, `inspect` là cách duy nhất để xác nhận thay vì đoán. Đây cũng là công cụ debug đầu tiên khi pipeline ngừng bắt được link.
4. `npm run fetch -- <user_id>`, nghe thử vài file `audio.mp3`.
5. `npm run compare -- <user_id> <video_id>` để chọn model, ghi vào `STT_MODEL` trong `.env`, rồi `npm run stt -- <user_id>`.

## Nguồn audio: `video.bit_rate_audio`, không phải `music.play_url`

Mỗi video Douyin có hai nguồn audio khác nhau, và chọn đúng cái thì giải quyết luôn cả vấn đề chất lượng lẫn vấn đề nhạc nền:

| | `music.play_url` | `video.bit_rate_audio` ← đang dùng |
|---|---|---|
| Bản chất | track "dùng âm thanh này" | audio tách từ **chính video** (DASH) |
| Kích thước (video 3.5 phút) | 4.8 MB | **1.2 MB** |
| Chất lượng | 192 kbps stereo mp3 | 48 kbps AAC HE v2 |
| Có đúng tiếng trong video? | **không chắc** — có thể là nhạc nền | **luôn đúng** |
| Số mức chất lượng | chỉ 1 | chọn được (lấy mức thấp nhất) |

Vì `bit_rate_audio` luôn là tiếng của video nên **không cần tải mp4 rồi tách bằng ffmpeg**. Đây là lý do pipeline không có bước ffmpeg nào.

Chỉ khi metadata thiếu `bit_rate_audio` mới rơi về `music.play_url`; lúc đó `isOriginalSound` được tính từ (`music.owner_id` vs `author.uid`, `music.is_original`, `music.title`) và nếu nghi ngờ thì đánh dấu `suspectBgm: true` để lọc lại sau.

48 kbps nghe không hay nhưng thừa sức cho STT — Whisper hạ về 16 kHz mono trước khi xử lý dù bạn gửi chất lượng gì.

## Video gốc

`DOWNLOAD_VIDEO=true` (mặc định) tải kèm `video.mp4` để sau này ghép audio đã dub trở lại.

`video.bit_rate` liệt kê ~22 mức, `VIDEO_QUALITY` chọn `best` (bitrate cao nhất, 1080p ~55 MB cho video 3.5 phút) hoặc `worst` (~7 MB, 540p). **Không dùng `video.play_addr` mặc định** — nó trả về mức tầm trung 1024x576 ~40 MB, không nét nhất mà cũng chẳng nhẹ nhất.

Video nặng gấp ~45 lần audio, nên tải video lỗi thì chỉ log cảnh báo chứ không đánh hỏng cả bản ghi — audio (thứ STT cần) đã xong trước đó. Chỉ cần transcript thì đặt `DOWNLOAD_VIDEO=false`.

## Tốc độ của `fetch`

`fetch` chạy `FETCH_CONCURRENCY` video **song song** (mặc định 6), với trần riêng `CAPTURE_CONCURRENCY` (mặc định 3) cho số trang Chromium mở cùng lúc. Tách hai trần vì hai nửa của một lượt fetch tốn thứ khác nhau: mở trang Douyin tốn RAM và là phần lộ diện nhất trước bot detection, còn tải file chỉ tốn băng thông.

Đo trên cùng 8 video (mp4 bật, `VIDEO_QUALITY=best`):

| Song song | Thời gian | Mỗi video |
|---|---|---|
| 1 (kiểu cũ, tuần tự) | 55s / 6 video | 9,2s |
| 6 (capture 3) — mặc định | 24,5s | 3,1s |
| 8 (capture 4) | 20,1s | 2,5s |
| 12 (capture 6) | 23,8s | 3,0s |

Quá 8 thì hết cải thiện — băng thông đã bão hoà. Mặc định để 6/3 chứ không phải mốc nhanh nhất vì mỗi luồng giữ trọn file trong RAM lúc ghi, và mỗi luồng là thêm một nhịp request đập vào Douyin suốt cả mẻ vài trăm video. Đổi cho một lần chạy:

```bash
npm run fetch -- <user_id> --concurrency 8
```

**Đừng chặn ảnh/font bằng `page.route` để tiết kiệm băng thông.** Đã thử và đo: chặn thì 2 OK/4 lỗi trong 114s, không chặn thì 5 OK/1 lỗi trong 20s — mọi request phải vòng qua Node làm chậm đúng cái XHR metadata đang chờ, số lượt hết giờ tăng vọt. Cổ chai ở đây là số video chạy song song, không phải băng thông của trang.

Muốn nhanh hơn nữa mà chấp nhận 540p: `VIDEO_QUALITY=worst` (~7MB thay vì ~40MB/video). Chỉ cần transcript thì `DOWNLOAD_VIDEO=false` — nhanh gấp bội vì audio chỉ ~1,3MB.

## Soát request/response của mọi lời gọi API

Mọi lời gọi ra ngoài — STT (whisper, qwen-asr, SiliconFlow), diarize, dịch (OpenAI, DeepSeek, Qwen, Google), TTS/clone giọng, suy nhãn người nói, và cả lượt tải media từ CDN Douyin cùng API `aweme/detail` mà trang tự gọi — đều in **request đầy đủ trước khi gọi** và **response đầy đủ sau khi gọi, kể cả khi lời gọi ném lỗi**. Tất cả đi qua đúng một chỗ: `src/apiLog.js`.

```
--- API REQUEST POST https://api.openai.com/v1/audio/transcriptions ---
{ "body": { "file": "…/audio.m4a", "model": "whisper-1", "language": "zh" } }
--- API RESPONSE POST https://api.openai.com/v1/audio/transcriptions (2.41s) ---
{ "text": "…", "segments": [ … ] }
```

Bật lên bằng một trong hai cách:

```bash
LOG_LEVEL=debug npm run stt -- <user_id>      # debug của mọi module
API_LOG_LEVEL=info npm run stt -- <user_id>   # chỉ nổi riêng phần API
```

Mặc định các dòng này ở mức `debug` nên chạy batch hàng trăm video với `LOG_LEVEL=info` thì chúng ẩn — không có cái này thì một mẻ 122 video in ra vài trăm nghìn dòng.

**Không thấy log API khi chạy `stt --force`?** Vì `--force` KHÔNG gọi lại API: response thô nằm ở `raw-<engine>.json` cạnh `transcript.json`, và `--force` chỉ căn lại nhãn/timestamp trên cache đó (xem `cachedCall` trong `src/stt.js`) — đúng như thiết kế, phần nhận dạng là phần đắt nhất của pipeline. Log sẽ nói thẳng `dùng lại raw-qwen.json, không gọi API`. Muốn nhận dạng lại thật thì xoá `raw-*.json` của video đó.

Ba thứ `src/apiLog.js` làm tập trung, đừng tự in JSON ở call site mới:

- **Che khoá** — `Authorization`, `*ApiKey`, cookie… ra `⟨đã che⟩`. Log hay bị dán vào issue/chat. Cố ý KHÔNG che `prompt_tokens`/`completion_tokens`: đó là số để tính tiền, che đi là mất đúng phần đáng đọc nhất.
- **Cắt payload nặng** — cắt **từng chuỗi một** nên chỉ chỗ nặng bị cụt, phần còn lại của request vẫn đọc trọn. Hai luật khác nhau:
  - Khối **base64** (data URI audio của qwen-asr, audio trong message của `voice-judge`, mẫu wav gửi voice-enrollment) luôn cắt còn 48 ký tự đầu + độ dài, **kể cả khi `API_LOG_MAX_CHARS=0`**. Không ai đọc base64 để soát request, mà một lời gọi qwen-asr là 1.6 triệu ký tự — để trần 20000 thì vẫn đủ phủ kín màn hình.
  - Chuỗi thường cắt theo `API_LOG_MAX_CHARS` (mặc định 20000, `0` = in đủ). Prompt dịch dài nhất cũng chỉ vài nghìn ký tự nên không bị đụng tới.
- **Mô tả thứ không stringify được** — stream, `Blob`/`File`, `FormData`, Buffer thành `⟨file audio.m4a, 1234 byte⟩` thay vì `{}`.

Thêm call site mới thì dùng sẵn helper, đừng viết `fetch` trần:

```js
import { fetchLogged, logApiCall, OPENAI_V1 } from "./apiLog.js";

const { res, raw, json } = await fetchLogged(log, url, { method: "POST", headers, body });
const out = await logApiCall(log, { url: `${OPENAI_V1}/chat/completions`, body: params },
  () => openai.chat.completions.create(params));
```

## Khi STT lỗi: chạy `npm run doctor` TRƯỚC KHI đoán

**`Connection error` của OpenAI SDK thường không phải lỗi mạng.** Khi request đầu nhận lỗi API thật (429 hết credit, 401 key sai), các lần retry sau rớt kết nối và thứ nổi lên là `APIConnectionError` — nguyên nhân thật bị chôn mất. Càng đặt `STT_MAX_RETRIES` cao thì càng lâu mới báo lỗi và lỗi càng vô nghĩa.

`npm run doctor` phá cái vỏ đó bằng cách gọi thật endpoint transcription với 1 giây im lặng (ffmpeg tự tạo) và `maxRetries=0`, nên lỗi thật hiện nguyên hình:

```
api.openai.com : HTTP 200 sau 1577ms
Đường mạng ổn. Thử luôn một lượt transcribe thật:
  ❌ RateLimitError status=429: You have no credits remaining...
  → Tài khoản hết credit. Nạp tại: https://platform.openai.com/settings/organization/billing
```

`GET /v1/models` trả 200 **kể cả khi hết credit**, nên nó không đủ để kết luận là chạy được — đó là lý do phải gọi thật endpoint transcription.

**Đừng bật VPN.** Đi thẳng từ IP VN ra thì được 200; bật VPN thì Cloudflare trả 403 vì IP datacenter bị gắn cờ. VPN chỉ làm mọi thứ tệ hơn.

## Batch: song song + quét lại nhiều lượt

Bước `stt` chạy được cả mẻ mà không cần ngồi canh:

1. **Chạy song song** `STT_CONCURRENCY=3` video — nút cổ chai là độ trễ mạng chứ không phải băng thông (file chỉ ~1.5 MB, upload đo được 831 KB/s).
2. **Quét lại nhiều lượt** — hết một lượt thì nghỉ `STT_PASS_DELAY_MS` rồi làm lại với các video còn lỗi, tối đa `STT_RETRY_PASSES=4` lượt.
3. **SDK tự thử lại** `STT_MAX_RETRIES=3` lần mỗi request — cố tình để thấp, xem mục dưới.

Lỗi STT **không** đổi `status` sang `failed` mà chỉ ghi `sttError`, vì lệnh `stt` chỉ nhặt video ở `fetched` — đổi status là tự khoá đường retry của chính nó. Audio vẫn nằm nguyên trên đĩa, chạy lại lệnh là thử tiếp.

Chạy nền cho khỏi phải canh:

```bash
npm run stt -- <user_id> > stt.log 2>&1 &
```

**Không dùng được Batch API của OpenAI cho việc này.** Batch API giảm 50% giá và chạy async trong 24h, nhưng chỉ hỗ trợ `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/completions`, `/v1/moderations`, `/v1/images/*`, `/v1/videos`. Trang model `whisper-1` ghi thẳng `Batch | v1/batch | Not supported`. Nên "batch" ở đây là song song + retry phía client, không phải batch của OpenAI.

## Chạy thử trước khi tải cả loạt

`--limit N` giới hạn số video mỗi lần `fetch`, ưu tiên **video mới nhất trước**:

```bash
npm run fetch -- <user_id> --limit 5
```

Chạy xong nó in tổng dung lượng thực tế và ước tính phần còn lại, nên đo được chi phí thật trước khi mở hết. Chạy lại lệnh không kèm `--limit` để tải tiếp phần còn lại — state đã ghi cái nào xong rồi.

## Chống tải nhầm video của người khác

Trang user có cả tác phẩm của user lẫn khu vực gợi ý ở footer; trang video thì hiển thị một video chính kèm cả loạt video khác, kiểu YouTube. Ba lớp chặn, độc lập nhau:

1. **`collect`** chỉ quét trong `[data-e2e="user-post-list"]`, không quét cả trang. Đo bằng `npm run probe`: cả trang 44 link = 36 trong post-list + 8 trong `page-footer`.
2. **`capture`** chỉ nhận metadata có `aweme_id` khớp video đang hỏi — trang trả metadata của nhiều video cùng lúc nên không được vơ cái đến trước.
3. **`fetch`** so `author.sec_uid` với `user_id` truyền vào CLI (hai giá trị này bằng nhau khi đúng người). Lệch thì đánh dấu `foreign` và bỏ hẳn, **trước khi tải**, không retry ở lần sau.

Lớp 2 và 3 dựa trên metadata nên không vỡ khi Douyin đổi giao diện. Lớp 1 phụ thuộc selector — nếu Douyin đổi `data-e2e` thì `collect` cảnh báo và quét cả trang, lúc đó lớp 3 vẫn đỡ được. Chạy `npm run probe` để chốt lại selector, `npm run prune` để dọn dữ liệu đã lỡ tải nhầm.

## Kiểm tra đã scroll hết chưa

`collect` đọc số tác phẩm Douyin tự khai ở tab 作品 (`[data-e2e="user-tab-count"]`) và đối chiếu với số ID lấy được, cảnh báo nếu thiếu. Trang chỉ render sẵn ~36 video đầu, phần còn lại phải scroll mới load — nên mỗi vòng lặp kéo item cuối vào tầm nhìn rồi **chờ tới khi có link mới** (tối đa `SCROLL_LOAD_TIMEOUT_MS`) thay vì chờ cứng một nhịp ngắn.

## Bàn giao sang LangDub

Ngoài scope của tool này (quyết định giữ 2 project tách rời). Upload thủ công: `POST /api/v1/sources` của LangDub, multipart field `file`, gửi thẳng `audio.mp3`.
