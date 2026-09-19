# STT + Diarization: chuyển sang Fun-ASR (Alibaba Model Studio, Singapore)

> Tài liệu quyết định + hướng dẫn tích hợp cho khâu STT/diarization trong pipeline Douyin → dubbing.
> Cập nhật: 2026-09-03

---

## 1. Quyết định

**Chốt: `fun-asr` trên Alibaba Cloud Model Studio, region Singapore (international deployment).**

Thay thế `gpt-4o-transcribe-diarize` đang dùng, vì model này merge/nhầm speaker và drop segment trên nội dung Douyin tiếng Trung.

Model dự phòng cần benchmark song song: `qwen-audio-3.0-asr-flash-filetrans` (cùng region, cũng hỗ trợ diarization, mới hơn).

---

## 2. Bối cảnh: vì sao không chỉ đơn thuần đổi vendor

### Ý tưởng ban đầu bị đặt sai thứ tự

Flow đề xuất lúc đầu:

```
STT → xác định câu (start/end) → extract frame → LLM/VLM → gom nhóm theo object
```

Bốn vấn đề:

1. **Sentence boundary ≠ speaker turn boundary.** Nếu STT đã merge 2 người vào 1 segment thì lấy chính segment đó làm đơn vị atomic sẽ không cứu được — rác vào rác ra. Đây đúng là lỗi đang gặp.
2. **Mặt trên khung hình ≠ người đang nói.** Douyin có jump cut, B-roll, reaction shot, text overlay, voice-over không lên hình. Cần Active Speaker Detection (đồng bộ chuyển động môi với audio), không phải face detection đơn thuần.
3. **VLM làm identity matching là sai công cụ.** Mô tả kiểu "người mặc áo xanh" vỡ ngay khi đổi góc quay/ánh sáng/trang phục. Bài toán này thuộc về face embedding (ArcFace/InsightFace) + clustering: vài ms/mặt, deterministic, gần như free. 200 call VLM thì vừa chậm vừa tốn vừa không ổn định giữa các lần chạy.
4. **Vứt mất tín hiệu mạnh nhất** — speaker embedding từ audio vẫn là ground truth cho "ai đang phát ra âm thanh này".

### Kiến trúc đảo lại

```
[Douyin MP4]
     ↓
[1] Demucs --two-stems=vocals          ← BẮT BUỘC, làm trước mọi thứ
     ↓
[2] ffmpeg downmix mono 16kHz          ← diarization chỉ chạy mono
     ↓
[3] Fun-ASR (diarization_enabled=true) ← ra speaker_id + word timestamps
     ↓
[4] (tùy chọn) Lớp verify bằng visual  ← chạy trên GPU local
     ↓
[5] LLM soi mâu thuẫn lượt thoại + gán tên nhân vật
     ↓
[cast_voices → translate → TTS → mix]
```

**Bước 1 là bước ăn điểm nhiều nhất và miễn phí.** BGM/SFX của Douyin phá speaker embedding rất nặng. Benchmark trên mix gốc là đang đo khả năng chịu nhạc nền, không phải khả năng diarize.

**Bước 4 — ý tưởng visual vẫn giữ nguyên giá trị, chỉ đổi vị trí:** nằm *sau* output của SaaS thay vì thay thế nó.

```
Với mỗi speaker turn do Fun-ASR trả về:
  sample 3–5 frame
  → SCRFD detect face
  → Light-ASD / TalkNet lọc người thực sự đang nói
  → ArcFace embedding → cluster
Dựng ma trận co-occurrence: audio_cluster × face_cluster
→ Hungarian matching
→ Chỗ nào lệch = chỗ SaaS merge/chẻ nhầm
```

Giải quyết được đúng 2 lỗi cần: tách cụm bị merge, gộp cụm bị chẻ vụn. RTX 3050 thừa sức chạy phần này.

**Bước 5 — chỗ LLM thật sự có giá trị** không phải là nhìn ảnh mà là đọc transcript: soi mâu thuẫn logic lượt thoại (ai gọi tên ai, xưng hô 哥/姐, một người tự trả lời câu hỏi của chính mình). Tiếng Trung nhiều cue xưng hô nên ăn điểm cao. Một call mỗi scene. Đây cũng là bước gán tên nhân vật thật cho `SPEAKER_00`.

---

## 3. So sánh vendor

Giá batch/async, tính trên giờ audio.

| Provider | Model | Giá/giờ | Diarization | Tiếng Trung |
|---|---|---|---|---|
| **Alibaba (SG)** | `fun-asr` | **$0.126** | Có | Native, 8 phương ngữ |
| AssemblyAI | Universal-2 | $0.15 + $0.02 = $0.17 | Add-on | 99+ ngôn ngữ |
| ElevenLabs | Scribe v2 | $0.22 | Bao gồm | 90+ ngôn ngữ |
| Speechmatics | Enhanced | $0.24–0.80 (nguồn lệch) | Bao gồm | Native, claim 96% |
| OpenAI *(đang dùng)* | gpt-4o-transcribe-diarize | ~$0.36 | Bao gồm | Whisper lineage |

Alibaba SG: `$0.000035/giây`, free quota **36.000 giây (10 giờ)**, hạn 90 ngày.
Realtime SG: `$0.000047/giây`, không có free quota (không dùng đến vì làm batch).

### Ghi chú từng thằng

**Alibaba Fun-ASR** — rẻ nhất + mạnh nhất về tiếng Trung.
- Ưu: native Mandarin + Quảng Đông/Ngô/Mân Nam/Hakka/Gan/Xiang/Jin. **Singing recognition** — transcribe được nội dung có nhạc nền, chỉ có ở `fun-asr` và `fun-asr-2025-11-07`. VAD far-field mạnh. File tới 12h/2GB. Alibaba khuyến nghị chính model này cho *entertainment content analysis and caption generation*.
- Nhược: cần tài khoản Alibaba Cloud, cần public URL, doc phần lớn viết cho region Beijing, không có emotion recognition.

**AssemblyAI** — đã có trong stack langdub.
- Bẫy: Universal-2 phủ 99 ngôn ngữ nhưng Universal-3 Pro (model mặc định) chỉ 6 ngôn ngữ. Phải verify tiếng Trung nằm ở model nào. Diarization của họ vốn mạnh nhất ở tiếng Anh.

**ElevenLabs Scribe v2** — thực dụng nhất về vận hành.
- Ưu: gộp vendor với TTS, một API key. Batch hỗ trợ tới 48 speaker. Audio tagging (tiếng cười, bước chân). `use_speaker_library` + `detect_speaker_roles` đáng thử cho việc giữ nhất quán speaker **giữa các video của cùng creator** → khớp trực tiếp với cast_voices.
- Nhược: không chuyên tiếng Trung.

**Speechmatics** — đặt cược vào accuracy.
- Ưu: **character-level timestamp** cho tiếng Trung (hiếm), hợp với fit_timing. Có on-prem container.
- Nhược: đắt nhất, giá mờ. Speaker change detection đã bị gỡ từ 07/2024 — đừng đọc doc cũ.

### Kết luận về giá

Ở scale hiện tại, **giá không phải biến số**. 1.000 video × 3 phút = 50 giờ audio:

| | Chi phí |
|---|---|
| Alibaba | ~$6 (10h đầu free) |
| AssemblyAI | ~$8.5 |
| ElevenLabs | ~$11 |
| OpenAI (hiện tại) | ~$18 |
| Speechmatics | $12–40 |

Chênh lệch cả bảng là vài chục đô. Một lần diarization sai làm cast nhầm giọng thì phải nghe lại và sửa tay cả video — tính bằng giờ công, đắt hơn nhiều lần. **Tối ưu DER, không tối ưu giá.**

---

## 4. Tích hợp Fun-ASR

### 4.1 Chuẩn bị audio

```bash
# Tách vocals
python -m demucs --two-stems=vocals input.mp3

# Downmix mono 16kHz — diarization CHỈ hỗ trợ mono
ffmpeg -i separated/htdemucs/input/vocals.wav \
       -ac 1 -ar 16000 -sample_fmt s16 \
       vocals_mono.wav
```

Upload lên bucket, lấy public/signed URL. **Không đưa thẳng URL douyinvod** — signed URL của Douyin hết hạn ~1 tiếng.

### 4.2 Submit task

```bash
curl -X POST 'https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/asr/transcription' \
-H "Authorization: Bearer $DASHSCOPE_API_KEY" \
-H "Content-Type: application/json" \
-H "X-DashScope-Async: enable" \
-d '{
  "model": "fun-asr",
  "input": { "file_urls": ["{URL_VOCALS_MONO_WAV}"] },
  "parameters": {
    "channel_id": [0],
    "diarization_enabled": true,
    "special_word_filter": { "system_reserved_filter": false }
  }
}'
```

Trả về `output.task_id`.

### 4.3 Poll + lấy kết quả

```bash
curl -X GET 'https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/tasks/{task_id}' \
-H "Authorization: Bearer $DASHSCOPE_API_KEY"

# task_status: PENDING → RUNNING → SUCCEEDED / FAILED
# rồi download output.results[].transcription_url
curl -sS '{transcription_url}' -o transcription.json
```

### 4.4 Python SDK

```python
import os, json
from http import HTTPStatus
from urllib import request
import dashscope
from dashscope.audio.asr import Transcription

dashscope.base_http_api_url = 'https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1'
dashscope.api_key = os.getenv("DASHSCOPE_API_KEY")  # key Singapore, KHÁC key Beijing

task = Transcription.async_call(
    model='fun-asr',
    file_urls=['{URL_VOCALS_MONO_WAV}'],
    diarization_enabled=True,
    special_word_filter={"system_reserved_filter": False},
)

resp = Transcription.wait(task=task.output.task_id)

if resp.status_code == HTTPStatus.OK:
    for t in resp.output['results']:
        if t['subtask_status'] == 'SUCCEEDED':
            result = json.loads(request.urlopen(t['transcription_url']).read().decode('utf8'))
            print(json.dumps(result, indent=2, ensure_ascii=False))
```

### 4.5 Cấu trúc kết quả

```json
{
  "transcripts": [{
    "channel_id": 0,
    "sentences": [
      {
        "begin_time": 100,
        "end_time": 3820,
        "text": "你好，我们今天讨论一下项目进度。",
        "speaker_id": 0,
        "words": [
          { "begin_time": 100, "end_time": 596, "text": "你好", "punctuation": "，" }
        ]
      },
      {
        "begin_time": 3820,
        "end_time": 6500,
        "text": "好的，我先简单汇报一下。",
        "speaker_id": 1
      }
    ]
  }]
}
```

- `speaker_id` gắn ở cấp **sentence**
- Timestamp tính bằng **millisecond**, luôn bật với Fun-ASR (không tắt được), có cả sentence-level và word-level
- Đừng nhầm `sentences[].end_time` (ms, int) với `end_time` cấp task (string datetime kiểu `"2024-09-12 15:11:40.903"`)

---

## 5. Bẫy cần biết

| # | Bẫy | Xử lý |
|---|---|---|
| 1 | **WorkspaceId nằm trong hostname** — endpoint SG là `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com`, không phải `dashscope.aliyuncs.com` | Lấy Workspace ID từ console, nhét vào base URL |
| 2 | **API key SG ≠ API key Beijing** | Tạo key riêng ở console region Singapore |
| 3 | **Diarization chỉ hỗ trợ mono** | `ffmpeg -ac 1` |
| 4 | **Sensitive word filter mặc định BẬT** — từ khớp danh sách built-in bị thay bằng `*` dài bằng đúng số ký tự, nuốt chữ trong transcript mà không báo | `"special_word_filter": {"system_reserved_filter": false}` |
| 5 | **Bật diarization thì audio nên < 2 giờ** (không bật thì tới 12h) | Video Douyin ngắn, không ảnh hưởng |
| 6 | **`transcription_url` chỉ sống 24 giờ** | Download ngay, đừng lưu URL vào DB rồi mai fetch |
| 7 | **Query API mặc định 20 QPS, trần 100 QPS** — poll nhiều là dính throttle | Chạy batch lớn thì dùng EventBridge callback |
| 8 | **Paraformer KHÔNG có ở region quốc tế** — `paraformer-v2` chỉ tồn tại ở Beijing | Dùng `fun-asr`; Alibaba cũng đang khuyến nghị migrate khỏi Paraformer |
| 9 | Không nhận file local / base64 với async transcription | Bắt buộc public URL |

### Trade-off emotion vs diarization

| Model | Diarization | Emotion | Region SG |
|---|---|---|---|
| `fun-asr` | ✅ | ❌ | ✅ |
| `qwen-audio-3.0-asr-flash-filetrans` | ✅ | ❌ | ✅ |
| `qwen3-asr-flash-filetrans` | ❌ | ✅ (7 nhãn) | ✅ |

**Không có model nào cho cả hai trong một call.** Emotion tag (`surprised/neutral/happy/sad/disgusted/angry/fearful`) khá đáng giá cho khâu cast_voices và điều chỉnh prosody TTS. Nếu cần cả hai: chạy 2 pass, hoặc lấy emotion từ nguồn khác.

### EventBridge callback (khi lên batch lớn)

Task xong, Model Studio đẩy event `dashscope:System:AsyncTaskFinish` kèm luôn `transcription_url` trong body → không cần gọi lại query API.

- Path kết quả cho Fun-ASR: `data.output_result.output.results[].transcription_url`
- Latency giao message: ~1–90 giây
- **Event có thể bị gửi trùng** → làm idempotent theo `data.task_id`
- **Verify header `X-Eventbridge-Signature*`** trước khi consume, nếu không bất kỳ IP nào cũng forge được event và inject transcript giả
- Kiểm `data.task_status` trước rồi mới đọc result — khi fail thì `output` chứa `code`/`message` thay vì `results`

---

## 6. Kế hoạch benchmark

Chưa chốt cứng trước khi có số. Cách làm:

1. Chọn **3–5 video Douyin đại diện** (khác nhau về: số speaker, mức nhạc nền, giọng vùng miền)
2. Gán speaker + transcript bằng tay → ground truth
3. Chạy qua Demucs → mono 16k
4. Chạy song song:
   - `fun-asr`
   - `qwen-audio-3.0-asr-flash-filetrans` (đổi mỗi field `model`, gần như không tốn công)
   - ElevenLabs Scribe v2
5. Đo **DER** (diarization error rate) + **CER** (character error rate — dùng CER không dùng WER cho tiếng Trung)
6. Chạy thêm 1 lượt trên mix gốc (không Demucs) để xác nhận Demucs đáng giá bao nhiêu

Chi phí: dưới $1, và 10 giờ free quota chưa đụng tới.

**Tiêu chí chốt:** nếu Fun-ASR thắng rõ → nuốt cái phiền của Alibaba Cloud là đáng. Nếu sát nhau → lấy Scribe v2 cho gọn stack (chung vendor với TTS).

---

## 7. Tài liệu tham khảo

| Nội dung | Link |
|---|---|
| User guide chính (có mục Speaker diarization, Sensitive word filtering, Get timestamps, Apply in production) | https://www.alibabacloud.com/help/en/model-studio/non-realtime-speech-recognition-user-guide |
| Fun-ASR API reference (định nghĩa đầy đủ field) | https://www.alibabacloud.com/help/en/model-studio/fun-asr-recorded-speech-recognition-api-reference |
| Fun-ASR Python SDK (kèm bảng giá quốc tế) | https://www.alibabacloud.com/help/en/model-studio/funauidio-asr-recorded-speech-recognition-python-sdk |
| Lấy API key | https://www.alibabacloud.com/help/en/model-studio/get-api-key |
| Lấy Workspace ID | https://www.alibabacloud.com/help/en/model-studio/obtain-the-app-id-and-workspace-id |
| Hotwords + context enhancement (ghim tên nhân vật/tên riêng) | https://www.alibabacloud.com/help/en/model-studio/improve-asr-accuracy |
| EventBridge async callback | https://www.alibabacloud.com/help/en/model-studio/async-task-api |
| Danh sách model + region | https://www.alibabacloud.com/help/en/model-studio/asr-model |

Công cụ liên quan:

- Demucs — https://github.com/facebookresearch/demucs
- Light-ASD (active speaker detection) — https://github.com/Junhua-Liao/Light-ASD
- InsightFace (SCRFD + ArcFace) — https://github.com/deepinsight/insightface

---

## 8. Việc còn lại

- [ ] Tạo tài khoản Alibaba Cloud + API key region Singapore
- [ ] Lấy Workspace ID, dựng base URL
- [ ] Viết script benchmark (fun-asr vs qwen-audio-3.0 vs Scribe v2), đo DER + CER
- [ ] Quyết định nguồn lấy emotion tag, nếu cần cho cast_voices
- [ ] Dựng lớp verify visual (SCRFD + Light-ASD + ArcFace + Hungarian) trên RTX 3050
- [ ] Viết prompt LLM soi mâu thuẫn lượt thoại + gán tên nhân vật
- [ ] Chuyển từ poll sang EventBridge callback trước khi chạy batch lớn
