# Spec: Chinese STT + Diarization cho Douyin pipeline

> Thay thế `gpt-4o-transcribe-diarize` trong `batch-stt.js`. Mục tiêu: fix sót đoạn, có diarization, và speaker ID nhất quán xuyên suốt các video của cùng một kênh.

---

## 1. Bối cảnh

Pipeline hiện tại:

```
Douyin user_id → Playwright scrape video URLs → download mp3/mp4
  → batch-stt.js (VAD pre-filter + SHA-256 cache + STT)
  → langdub (dubbing)
```

Vấn đề đang gặp:

1. STT hiện tại sót một số đoạn không nhận diện được.
2. Audio là tiếng Trung, video có **nhiều người nói**.
3. Speaker ID (nếu có) chỉ đúng trong phạm vi một file — không dùng lại được ở video khác.

Điểm 3 là lỗi chí mạng với langdub: cùng một nhân vật của kênh sẽ bị gán hai giọng clone khác nhau ở hai video khác nhau.

---

## 2. Stack đã chọn

| Thành phần | Tool | Ghi chú |
|---|---|---|
| Background separation | Demucs | Tách vocal khỏi BGM trước khi diarize |
| ASR + diarization | `fun-asr` (Alibaba Model Studio, filetrans async) | Cloud |
| Speaker embedding | CAM++ / 3D-Speaker (FunASR) | Local, RTX 3050 |
| Cache | SHA-256 (giữ nguyên cơ chế hiện có) | |

### Vì sao `fun-asr`

- Dòng Fun-ASR (`fun-asr`, `fun-asr-mtl`) là dòng **chắc chắn** hỗ trợ tách người nói trên Model Studio. Docs có chỗ ghi thêm `qwen3-asr-flash-filetrans` và Paraformer cũng hỗ trợ, nhưng thông tin lệch nhau giữa các trang → bám Fun-ASR cho chắc.
- `fun-asr` transcribe được cả lời hát trên nền BGM — Douyin đầy nhạc nền.
- Có timestamp **cấp câu và cấp từ**. Cấp từ là thứ langdub cần để khớp dub.
- Có bản triển khai quốc tế (endpoint + data ở Singapore) → dùng được bằng tài khoản Alibaba Cloud quốc tế, **không cần thực danh TQ đại lục**.

### Đã loại

- `qwen3-asr-flash` (bản sync qua OpenRouter): rẻ và mạnh nhưng **không có diarization**.
- Volcengine / Doubao Seed-ASR: domain khớp nhất (cùng nhà với Douyin), rẻ nhất (~0.8 tệ/giờ), có sẵn `enable_speaker_info`. Loại vì cần tài khoản đại lục + thực danh.
- Self-host FireRedASR2 + pyannote: xem mục Fallback.

---

## 3. Pipeline mới

```
[1] Download audio (mp3)
     ↓
[2] Demucs --two-stems=vocals  →  vocals.wav
     ↓
[3] Normalize: mono 16kHz
     ↓
[4] Upload lên object storage, ký URL tạm
     ↓
[5] Submit filetrans job (async)
     ↓
[6] Poll task cho tới khi xong
     ↓
[7] Parse segments {start, end, text, speaker_id}
     ↓
[8] Speaker embedding + cluster ở tầng KÊNH
     ↓
[9] Map speaker_id (local) → global_voice_id
     ↓
[10] Output JSON → langdub
```

### Step 1 — Download

Signed URL của Douyin (`douyinvod.com`) hết hạn sau **~1 tiếng**. Phải tải file về đĩa trước; **không** đưa URL gốc của Douyin cho ASR API.

### Step 2 — Background separation

```bash
python -m demucs --two-stems=vocals input.mp3
# → vocals.wav + no_vocals.wav
```

Dùng `vocals.wav` cho toàn bộ các bước sau. Giữ lại `no_vocals.wav` để mix lại ở bước dubbing.

Bước này quan trọng: BGM to là một trong những nguyên nhân khiến diarization sai và ASR sót đoạn.

### Step 3 — Normalize (BẮT BUỘC)

```bash
ffmpeg -i vocals.wav -ac 1 -ar 16000 normalized.wav
```

**Diarization chỉ chạy trên mono.** File stereo sẽ bị bỏ qua `speaker_id` mà **không báo lỗi** — im lặng trả về kết quả thiếu. Verify:

```bash
ffprobe -i normalized.wav -show_entries stream=channels -of default=noprint_wrappers=1
```

Assert `channels=1` trước khi submit.

### Step 4 — Upload

Filetrans API nhận audio qua **URL public**. Cần upload lên OSS/S3/bucket rồi ký presigned URL.

> ⚠️ Đây là bước **mới** so với pipeline hiện tại. Cần chốt dùng storage nào (OSS cùng region Singapore sẽ nhanh nhất) trước khi code.

### Step 5 — Submit job

```
POST /api/v1/services/audio/asr/transcription
Header: X-DashScope-Async: enable
```

Params:

| Param | Value | Ghi chú |
|---|---|---|
| `model` | `fun-asr` | |
| `diarization_enabled` | `true` | |
| `speaker_count` | số thật nếu biết trước | Range hợp lệ **2–100**. Để tự đoán thì kết quả kém ổn định hơn rõ rệt |
| word-level timestamp | bật | langdub cần |
| hotwords | thuật ngữ/tên riêng của kênh | Optional nhưng nên có |

Giới hạn: file ≤ 12 giờ / 2GB. Khi bật diarization thì khuyến nghị ≤ 2 giờ. Video Douyin không chạm ngưỡng.

### Step 6 — Poll

```
GET /api/v1/tasks/{task_id}
```

Exponential backoff, đừng poll dày. Có timeout và retry limit.

### Step 7 — Parse

Mỗi câu trả về kèm `speaker_id`. Chuẩn hoá về:

```json
{
  "video_id": "...",
  "segments": [
    {
      "start": 1.24,
      "end": 3.80,
      "text": "...",
      "speaker_id": "speaker_0",
      "words": [{"word": "...", "start": 1.24, "end": 1.41}]
    }
  ]
}
```

### Step 8–9 — Speaker registry xuyên video

**Đây là phần quan trọng nhất và cũng là phần dễ bị bỏ sót.**

Diarization chỉ cluster trong phạm vi một file. `speaker_0` của video A và `speaker_0` của video B **không** đảm bảo là cùng một người.

Thuật toán:

1. Với mỗi segment, cắt audio và trích speaker embedding (CAM++ / 3D-Speaker trong FunASR — model nhẹ, 3050 chạy thoải mái).
2. Gộp embedding theo `speaker_id` cục bộ → 1 centroid / speaker / video.
3. Với mỗi centroid, match vào registry của **kênh** đó:
   - Cosine similarity > threshold → gán `global_voice_id` đã có, update centroid (running average).
   - Dưới threshold → tạo `global_voice_id` mới.
4. Ghi mapping `speaker_id (local) → global_voice_id` vào output.

Schema registry:

```json
{
  "channel_id": "douyin_user_xxx",
  "voices": [
    {
      "global_voice_id": "voice_001",
      "centroid": [0.12, -0.03, ...],
      "sample_count": 47,
      "total_speech_sec": 812.5,
      "source_videos": ["vid_a", "vid_b"]
    }
  ]
}
```

`total_speech_sec` để langdub biết speaker nào đủ audio để clone giọng — cần **tối thiểu 30 giây** audio sạch cho một voice clone tốt. Dưới ngưỡng thì fallback sang generic voice.

Threshold similarity cần tune bằng tay trên data thật. Bắt đầu ~0.7 rồi chỉnh.

### Step 10 — Cache

Giữ nguyên SHA-256 caching. Key theo hash của file **đã normalize** (sau Demucs + mono 16k), không phải mp3 gốc.

---

## 4. Bỏ VAD pre-filter

VAD pre-filter hiện tại trong `batch-stt.js` là **nghi phạm số một** cho việc sót đoạn. Nếu ngưỡng hơi cao, hoặc audio có BGM to / giọng nhỏ / giọng thì thầm, VAD cắt mất đoạn trước khi model kịp nghe.

Việc cần làm:

- Bỏ VAD pre-filter (Demucs + ASR nội bộ đã xử lý tốt hơn).
- Nếu vẫn giữ, **bắt buộc** log metric: `tổng thời lượng speech gửi đi / thời lượng audio gốc`.

Không đo thì không biết. Metric này cũng chính là thước đo nghiệm thu ở mục 5.

---

## 5. Nghiệm thu

Chạy song song trên **~10 video đại diện** (phải có cả video nhiều người nói và video có BGM to). So sánh pipeline mới vs pipeline cũ theo 2 số:

1. **Tổng thời lượng speech thu được** (giây)
2. **Số turn** (số segment sau khi merge các turn liền kề cùng speaker)

Đây là cách rẻ và nhanh nhất để biết có thật sự cải thiện hay không. Đừng ngồi đánh giá bằng cảm tính.

Thêm một check thủ công: nghe lại 2–3 đoạn mà pipeline cũ sót, xác nhận pipeline mới bắt được.

---

## 6. Giới hạn đã biết

- **Overlapping speech** (hai người nói chồng nhau — rất hay gặp ở Douyin) sẽ vẫn sai. Không model nào xử lý ngon cái này. Đừng kỳ vọng, đừng tốn thời gian tune cho nó.
- Video có cut nhanh, nhiều nhân vật xuất hiện thoáng qua → speaker có < 30s audio, không clone giọng được. Cần fallback rõ ràng.
- Diarization vẫn sẽ noisy trên short-video format nói chung, kể cả sau khi tách BGM.

---

## 7. Fallback (nếu cloud không ổn)

Self-host trên RTX 3050:

- **ASR:** FireRedASR2-AED (~1.1B params, fp16 vừa 3050). Đời đầu đạt CER trung bình 3.18% trên benchmark Mandarin công khai, giảm CER 24–40% ở đúng kịch bản video ngắn / livestream / auto-caption so với baseline open-source và giải pháp thương mại. Bản LLM 8.3B thì quên đi, không đủ VRAM.
- **Diarization:** pyannote, hoặc FunASR VAD + diarization.
- **Alternative:** Qwen3-ASR open weights (0.6B / 1.7B) + Qwen3-ForcedAligner-0.6B cho timestamp — aligner này chính xác hơn WhisperX và Nemo-Forced-Aligner.

Ưu điểm: kiểm soát hoàn toàn khâu phân đoạn, không có black box. Nhược điểm: nặng hơn, phải tự lo diarization.

---

## 8. Quan hệ với skill `audio-dubbing-pipeline`

Spec này **thay thế Step 2** (WhisperX diarization + transcription) của skill đó, cho case tiếng Trung. Các step còn lại giữ nguyên:

- Step 1 (Demucs) → đã đưa vào spec này ở bước 2
- Step 3–7 (concat per speaker → clone → translate → TTS → mix) giữ nguyên
- Khác biệt: Step 3 giờ group theo `global_voice_id` chứ không phải `speaker_id` cục bộ

---

## 9. Checklist cho implementer

- [ ] Chốt object storage cho presigned URL (bước 4)
- [ ] Tài khoản Alibaba Cloud quốc tế + API key, chọn region Singapore
- [ ] Demucs chạy được trên máy target
- [ ] Assert `channels == 1` trước mỗi lần submit
- [ ] `speaker_count` truyền đúng, trong range 2–100
- [ ] Speaker registry persist được (file/DB), có versioning
- [ ] Similarity threshold để config được, không hardcode
- [ ] Log metric speech-duration-ratio cho mọi file
- [ ] Chạy A/B trên 10 video đại diện trước khi rollout
