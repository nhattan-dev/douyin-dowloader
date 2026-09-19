# Xưởng dịch — UI local

```bash
npm run ui            # http://127.0.0.1:5178  (--port 8080 để đổi cổng)
```

Chạy trong một terminal để yên (tmux/tab riêng): việc nền là tiến trình con của server, tắt
server là các việc đang chạy bị ngắt — mở lại UI thì chúng hiện "bị ngắt", bấm **Chạy lại** là đi
tiếp từ checkpoint, không trả tiền lại.

## Luồng

| Trang | Làm gì | Lệnh thật phía sau |
|---|---|---|
| Tác giả | dán link trang tác giả / link chia sẻ app → quét | `src/cli.js collect` |
| Video của tác giả | lọc, gợi ý gom theo 合集/hashtag, chọn → **Tải + STT** | `src/cli.js fetch <user> <ids…>` → `stt` |
| | chọn → **Tạo series** (tự tải phần thiếu rồi dựng bible) | `zhvi series init … --events` |
| Series › Duyệt bible | trang duyệt zhvi nhúng; nút gửi thẳng về UI | `zhvi series apply` |
| Series › các tập | **Dịch** từng tập / cả loạt; tiến độ từng bước con A1…E3 | `zhvi <transcript> --bible … --events` |
| Tập › Soát người nói | trang soát zhvi nhúng; gửi xong tự nạp nhãn + dịch tiếp | `zhvi --apply` → dịch lại |
| Tập › Bản dịch | video + phụ đề Việt đồng bộ bảng câu; lọc câu nên xem; **sửa tay** | — |
| Tập › Lồng tiếng | VieNeu v3/v4, 1 luồng; **clone từ mẫu** hoặc **giọng có sẵn** (chọn từng nhân vật); xem bản lồng / bản gốc; câu tràn khung | clone: `extract-voice.js` → `dub-video.mjs --voices series/<slug>/voices`; giọng có sẵn: `dub-video.mjs --synth preset --preset-map series/<slug>/preset-voices.json` |
| Chờ bạn | việc máy đợi người: duyệt bible, soát người nói, lỗi, tập làm tiếp được | — |

## Kiến trúc

- `server.js` — node:http, không dependency mới, chỉ nghe 127.0.0.1. SSE `/api/events` đẩy trạng thái việc + log.
- `jobs.js` — hàng đợi. **Làn** giới hạn song song (`browser` 1: chung .browser-profile; `tts` 1:
  VieNeu rate-limit; `zhvi` 2; `stt` 2). **Khoá** chặn hai việc đụng cùng tài nguyên (`user:<id>` vì
  state.json; `series:<slug>` chặn mọi `series:<slug>:epN`). Dừng = giết cả nhóm tiến trình.
  Lịch sử ở `data/_ui/jobs.json`, log đầy đủ `data/_ui/logs/<id>.log`.
- `recipes.js` — mỗi loại việc = đúng lệnh CLI. Sửa cách chạy thì sửa CLI/lib, không sửa ở đây.
- `scan.js` — **đĩa là nguồn sự thật**: trạng thái tập suy từ mốc thời gian file
  (review.html / translation.json / dub-vi.mp4). Chạy lệnh tay ngoài UI thì UI vẫn thấy đúng.
- Tiến độ zhvi: `--events` in thêm dòng `@@zhvi {json}` (`plan`, `sub` start/ran/reused/skipped/error,
  `call` kèm usd, `gate`, `review`, `done`; series init thêm `step`). Log chữ giữ nguyên.
- Trang soát zhvi vẫn là HTML tự chứa (mở file:// được). Server tiêm một đoạn script chặn cú tải
  `.json` của nút Xuất và POST thẳng về — áp được cả trang đã dựng từ trước.

## Dữ liệu UI tự ghi

| File | Là gì |
|---|---|
| `series/<slug>/series.json` | series tạo từ UI: tác giả + danh sách video theo thứ tự tập |
| `series/<slug>/ep<N>.vi-edits.json` | câu sửa tay — khoá theo số câu **và** câu gốc; zhvi chạy lại xong tự áp lại; câu gốc không khớp (pass A tách/gộp khác) thì không áp, UI báo "lệch" |
| `series/<slug>/voices/<nhân vật>/` | kho giọng series: tập đầu tiên lồng tiếng đặt giọng, các tập sau dùng chung |
| `series/<slug>/reviews/`, `draft/reviews/` | bản gửi từ trang soát/duyệt, giữ làm dấu vết |
| `data/_ui/` | lịch sử việc, log, ảnh thu nhỏ |

Hai chế độ giọng ở tab Lồng tiếng: **clone** cần mẫu giọng (tách bằng demucs) và bị VieNeu giới hạn theo
ngày/tháng/slot; **giọng có sẵn** dùng catalog của VieNeu (`GET /voices`, lọc theo engine — id trùng giữa v3/v4)
và cả giọng bạn đã clone trước đó (`kind: cloned`, chỉ v4), không tốn hạn mức clone, không cần mẫu. Lựa chọn lưu ở
`series/<slug>/preset-voices.json` (nhân vật → voiceId) nên các tập sau tự nhớ. Clip ghi kèm giọng đã dùng
(`dub/clips/voices.json`): đổi giọng rồi `--resume` chỉ làm lại đúng các câu của giọng đó.

Lồng tiếng lại sau khi dịch lại/sửa tay: clip nào có chữ hoặc người nói khác lần trước (so với
`dub/report.json`) thì xoá và tổng hợp lại; còn lại dùng lại (`--resume`).

## Chưa làm

- Đổi người nói của một câu ngay trong bảng bản dịch (hiện đi qua trang soát người nói).
- Thêm tập mới vào series **đã có bible** mà không dựng lại nháp (lib zhvi chưa có lệnh bổ sung).
- Xoá series / video từ UI.
- Nhân vật thoại quá ít không tách được mẫu giọng → dub-video dừng, báo tên nhân vật thiếu.
