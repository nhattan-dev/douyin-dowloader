# Douyin Scraper → Audio Extraction → STT Pipeline

## Mục tiêu
Từ 1 Douyin user_id, tự động thu thập toàn bộ video của user đó, tải audio, và chuyển thành text (STT) — phục vụ downstream cho pipeline dubbing ([langdub](../langdub)).

## Ràng buộc môi trường
- Máy chạy pipeline có cấu hình yếu (không chạy nổi Whisper local, không chạy nổi các model nặng khác) → mọi bước xử lý nặng phải đẩy ra cloud/API, hoặc dùng thao tác nhẹ (network capture thay vì tải + convert file lớn).
- Cần tránh bị Douyin chặn do bot detection → tránh headless mode thuần túy.

## High-level flow

```
Input: douyin user_id
  │
  ▼
[1] Playwright mở trang user (headed hoặc stealth mode, KHÔNG dùng headless thuần)
  │   → scroll trang nhiều lần để trigger load thêm (infinite scroll)
  │   → mỗi lần scroll, query lại các thẻ <a href*="/video/"> để lấy video ID
  │   → dừng khi số lượng video ID không tăng thêm nữa
  ▼
[2] So khớp với danh sách video ID đã tải trước đó (lưu local, ví dụ 1 file .txt/.json)
  │   → lọc ra chỉ những video ID mới, chưa từng tải
  ▼
[3] Với mỗi video ID mới:
  │   a. Playwright/network capture vào trang video đó
  │   b. Bắt được 2 link media từ response mạng (domain douyinvod.com):
  │        - link "mp3" (music/sound track riêng biệt — ĐÃ XÁC NHẬN nội dung
  │          khớp với audio gốc trong video, không phải nhạc nền)
  │        - link "mp4" (video kèm audio track)
  │   c. Tải link mp3 về (ưu tiên, nhẹ hơn nhiều so với mp4)
  │      Tải thêm mp4 nếu cần video gốc để ghép lại sau dubbing
  │   d. Ghi nhận video ID này vào danh sách đã tải
  ▼
[4] STT: gửi từng file mp3 lên cloud STT API
  │   → nhận về transcript text
  ▼
Output: transcript (+ audio file, + video file nếu cần) sẵn sàng cho bước dịch/dub tiếp theo
```

## Các quyết định kỹ thuật đã chốt

### Thu thập danh sách video của 1 user
- **yt-dlp KHÔNG có extractor liệt kê video theo user/channel cho Douyin** (khác TikTok, TikTok có `tiktok:user`). Đã test trực tiếp, yt-dlp trả về lỗi "Unsupported URL" / fallback generic extractor khi đưa link dạng `douyin.com/user/<id>`.
- → Phải tự thu thập link video bằng Playwright, quét DOM theo pattern `href*="/video/"`, kết hợp scroll để load hết danh sách (infinite scroll).
- Ưu tiên cách lấy qua DOM/href hơn là bắt response API nội bộ — vì đơn giản hơn, ít rủi ro vỡ khi Douyin đổi cấu trúc API response.

### Lấy audio/video của từng video
- Mỗi video Douyin có **2 nguồn media riêng biệt**: video (mp4, có audio track) và "sound"/music (mp3 riêng, phục vụ tính năng "dùng âm thanh này" của Douyin).
- Đã kiểm chứng thủ công: với video test, nội dung audio của bản "mp3" và audio trong "mp4" **giống hệt nhau** → xác nhận người đăng dùng giọng gốc, không chèn nhạc nền có sẵn. (Lưu ý: điều này không đảm bảo đúng với mọi video — cần thiết kế pipeline có bước validate lại, vì nếu người đăng dùng sound có sẵn thì file "mp3" sẽ là nhạc nền, không phải giọng nói thật.)
- Link media có **chữ ký kèm thời hạn** (`expire=` trong query string, hiệu lực khoảng 1 giờ) → không thể cache/hardcode URL, phải lấy mới mỗi lần chạy.
- `mime_type` trong query string của URL **không đáng tin** để phân biệt mp3/mp4 — đây chỉ là tag nội bộ của hệ thống lưu trữ (TOS), không phản ánh Content-Type thật. Phải dựa vào response header thật hoặc field từ API metadata (`video.play_url` vs `music.play_url`) để phân biệt chính xác.

### Chống bot detection
- Không dùng headless mode thuần túy (`headless=True`) — dễ bị Douyin phát hiện qua fingerprint (navigator.webdriver, thiếu API, v.v.).
- Các hướng giảm rủi ro, ưu tiên theo thứ tự chi phí thấp → cao:
  1. `headless: "new"` (Chromium mode mới, ít bị phát hiện hơn headless cũ)
  2. Chạy headed nhưng trên virtual display (xvfb) hoặc minimize cửa sổ
  3. Dùng `playwright-stealth` hoặc patch tương đương để che dấu hiệu tự động hóa
  4. Set User-Agent thật + thêm delay ngẫu nhiên giữa các action, tránh pattern quá đều/quá nhanh

### STT (Speech-to-Text)
- Máy yếu → loại bỏ phương án chạy Whisper local (kể cả bản `tiny`/`faster-whisper`), chuyển hẳn sang cloud API.
- Lựa chọn cloud API (giá tại thời điểm viết plan, 08/2026):

| Model | Giá/phút | Ghi chú |
|---|---|---|
| `whisper-1` | $0.006 | Ổn định, đã kiểm chứng nhiều với tiếng Trung — khuyên dùng để bắt đầu |
| `gpt-4o-transcribe` | $0.006 | Độ chính xác cải tiến so với whisper-1 |
| `gpt-transcribe` | $0.0045 | OpenAI khuyến nghị cho batch file transcription |
| `gpt-4o-mini-transcribe` | $0.003 | Rẻ nhất, cần test thêm độ chính xác với tiếng Trung/giọng địa phương |

- Nội dung Douyin thường có giọng địa phương, tốc độ nói nhanh, tiếng lóng — nên test thử vài file trước khi chạy batch lớn để chọn model phù hợp.
- Phương án thay thế nếu cần độ chính xác cao hơn cho tiếng Trung: iFlytek (讯飞), Tencent Cloud ASR, Baidu STT — chuyên biệt cho tiếng Trung nhưng tích hợp phức tạp hơn.

## Việc cần làm khi implement (gợi ý cho Claude Code)
1. Script Playwright thu thập danh sách video URL từ 1 user_id (có cơ chế scroll + dedupe + dừng khi hết).
2. Cơ chế lưu trạng thái "đã tải" (file local đơn giản, ví dụ JSON/txt danh sách video ID).
3. Script vào từng video, bắt đúng 2 link media (mp3 + mp4), phân biệt chính xác qua metadata/response header (không dựa vào `mime_type` param trong URL).
4. Downloader tải file (ưu tiên mp3, mp4 optional) với retry + delay giữa các lần tải để giảm rủi ro rate-limit.
5. Tích hợp cloud STT API (bắt đầu với `whisper-1`), input mp3 → output transcript text, lưu kèm theo video ID tương ứng.
6. (Optional, cân nhắc sau) Cơ chế chạy định kỳ để tự phát hiện video mới của user thay vì chỉ chạy 1 lần.