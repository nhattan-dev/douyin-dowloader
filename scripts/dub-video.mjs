// Lồng tiếng cả video: clone giọng từng nhân vật bằng VieNeu, đặt lên timeline,
// trộn với nền nhạc gốc, ghép lại thành mp4 để review.
//
// ── Hai quyết định thiết kế, đều rút ra từ đo đạc ───────────────────────────
//
// 1. MẪU CLONE CHỌN THEO ĐỘ GIỐNG, KHÔNG THEO ĐỘ DÀI. Đây là biến ảnh hưởng lớn
//    nhất trong cả chuỗi — lớn hơn engine, lớn hơn TTS nguồn. Cùng một nhân vật,
//    clip mẫu dở cho ra 83% đọc đúng, clip mẫu tốt cho 97%. Nên với mỗi nhân vật,
//    script chấm cosine giữa từng clip và `all.wav` của chính nhân vật đó
//    (resemblyzer), rồi lấy clip điểm cao nhất trong khung 3-5.5s mà VieNeu khuyến
//    nghị.
//
// 2. KHÔNG ÉP CÂU TIẾNG VIỆT VỪA KHUNG TIẾNG TRUNG. Trọng âm và nhịp ngắt của hai
//    thứ tiếng khác nhau, không có ánh xạ 1:1 — co giãn audio cho khớp khung là tự
//    tay tạo ra giọng gượng, đúng thứ đang phải chữa. Nên mỗi câu được đặt đúng mốc
//    BẮT ĐẦU rồi cho chạy độ dài tự nhiên của nó. Chỉ khi câu đó lấn sang mốc bắt
//    đầu của câu kế tiếp mới nén, và nén có trần (`--max-tempo`, mặc định 1.15 —
//    quá ngưỡng này tai nghe ra ngay là bị tua). Câu nào nén hết trần vẫn lấn thì
//    KHÔNG cắt, mà báo ra để rút gọn bản dịch — sửa ở câu chữ luôn tốt hơn sửa ở
//    tín hiệu.
//
// Dùng:
//   node --env-file-if-exists=.env scripts/dub-video.mjs --dir <videoDir>
//   ... --engine v4        engine VieNeu (mặc định v4)
//   ... --speaker <tên>    chỉ làm một nhân vật (mặc định: tất cả)
//   ... --max-tempo 1.15   trần nén khi câu lấn sang câu sau
//   ... --no-bed           bỏ nền nhạc gốc, chỉ xuất giọng
//   ... --bed original     giữ cả tiếng Trung gốc: nhạc/hiệu ứng (0.7) + giọng Trung đã tách, hạ nhỏ dưới giọng Việt
//                          (nghe được cả hai, nhạc nền không mất). Mặc định `vocals-removed` = bỏ giọng Trung, chỉ
//                          giữ nhạc/hiệu ứng. Cả hai đều tách bằng demucs (cùng một lần chạy, `--resume` dùng lại)
//   ... --orig-db -8       khi --bed original: mức GIỌNG TRUNG so với giọng Việt, tính bằng dB (mặc định -8).
//                          Đo lại từng video vì giọng gốc Douyin thường to hơn giọng TTS rất nhiều (đo được
//                          -12.8 dB so với -20.5 dB) — hệ số cố định vẫn lấn át giọng Việt
//   ... --duck 6           khi --bed original: hạ thêm giọng Trung ~N dB đúng lúc giọng Việt đang nói, hết nói thì
//                          trở lại (mặc định 6; 0 = tắt). Giọng Trung lúc đó ~ orig-db - duck so với giọng Việt
//   ... --resume           dùng lại file đã tổng hợp trước đó, chỉ làm phần thiếu
//   ... --concurrency 5    số câu tổng hợp song song (mặc định 5)
//   ... --voices <dir>     kho giọng dùng chung cấp series, tra trước khi tự tách
//   ... --synth voice      (mặc định) enrol giọng nhân vật (POST /voices) rồi tổng hợp bằng job /tts
//   ... --synth clone      /clone zero-shot từng câu — gói Starter chỉ 9 lượt/ngày (429 CLONE_ONESHOT_DAILY_CAP)
//   ... --synth preset    giọng CÓ SẴN của VieNeu (catalog, hoặc giọng đã enrol trước đó) qua /tts:
//                          không cần mẫu, không đụng hạn mức clone (ngày/tháng/slot). Chọn giọng
//                          bằng --preset-map <file.json> ({"<nhân vật>": "<voiceId>"}) và/hoặc
//                          --preset <voiceId> cho nhân vật không có trong file. Danh sách: GET /voices.
//   ... --out <tên>        thư mục đầu ra trong videoDir (mặc định dub, hoặc dub-clone khi --synth clone)
//   ... --encoder auto     auto (mặc định) dò GPU một lần rồi nhớ | gpu | cpu. Xem lib/encoder.mjs:
//                          pipeline chạy trên nhiều máy, máy chỉ đổi TỐC ĐỘ chứ không đổi cỡ file ra.
//
// Viền đen sẵn trong video.mp4 (Douyin đóng khung sai tỉ lệ, không phải do trình phát): tự dò bằng
// cropdetect, có thật thì phủ nền mờ từ ảnh bìa Douyin (data/<user>/state.json → info.cover) đúng
// chỗ viền khi ghép audio-video ở bước cuối. Không có bìa thì rơi về giữ nguyên video gốc.
//
// Codec nguồn: nhiều video Douyin xuất HEVC (h265) — trình duyệt (Chrome/Chromium) không giải mã
// được trong thẻ <video> (canPlayType rỗng, videoWidth luôn 0): âm thanh vẫn phát, currentTime vẫn
// chạy (đồng hồ theo track audio) nhưng hình đứng im, dễ tưởng nhầm là video hỏng. Vì vậy chỉ giữ
// `-c:v copy` (rẻ) khi nguồn đã là h264, còn lại luôn encode lại sang h264 dù không có viền đen.
//
// Vì sao có `--synth voice`: /clone chịu rate-limit chặt tới mức song song còn chậm hơn
// tuần tự. /tts là hàng đợi job (submit trả jobId ngay, poll lấy kết quả) nên là đường
// còn lại để chạy song song — nhưng chỉ nhận voiceId đã enrol, không nhận clip mẫu.
// (/dialogue cũng từ chối giọng clone, đã thử.) Nhân vật nào không enrol được thì các
// câu của họ tự rơi về /clone.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { fetchBufferLogged, fetchLogged } from "../src/apiLog.js";
import { createLogger } from "../src/logger.js";
import { findAudioFile } from "../src/stt.js";
import { encoderArgs, pickEncoder } from "./lib/encoder.mjs";

const log = createLogger("DUB");
const run = promisify(execFile);
const sh = (cmd, args) => run(cmd, args, { maxBuffer: 1024 * 1024 * 64 });

const BASE = "https://api.vieneu.io/api/v1";
// resemblyzer sống trong venv của seed-vc; đổi bằng biến môi trường nếu cài chỗ khác.
const PY = process.env.RESEMBLYZER_PYTHON
  ?? path.join(os.homedir(), "WorkSpace/tools/seed-vc/.venv/bin/python");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next === undefined || next.startsWith("--") ? true : argv[++i];
  }
  return out;
}
const str = (v, fallback) => (v === undefined || v === true ? fallback : v);
const exists = (p) => fs.access(p).then(() => true, () => false);

/** mean_volume (dB) của file theo volumedetect — cân hai nguồn theo mức đo thật thay vì hệ số đoán. */
async function meanVolume(file) {
  const { stderr } = await sh("ffmpeg", ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"]);
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  if (!m) throw new Error(`không đo được âm lượng của ${file}`);
  return Number.parseFloat(m[1]);
}

/**
 * Chạy `fn` trên `items` với tối đa `limit` việc song song, worker tự bốc việc kế
 * tiếp — cùng khuôn `pool()` đã dùng ở src/download.js. Video dài (500+ câu) tổng
 * hợp tuần tự tốn hàng chục phút vì nút cổ chai là round-trip API (submit + tải
 * audio), không phải CPU; song song vài luồng rút ngắn đáng kể.
 */
async function pool(items, limit, fn) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const apiKey = () => {
  const k = process.env.VIENUE_KEY?.trim() || process.env.VIENEU_API_KEY?.trim();
  if (!k) throw new Error("thiếu VIENUE_KEY trong .env");
  return k;
};

let throttled = 0;

async function api(pathname, { method = "POST", body, form } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const { res, raw, json: parsed } = await fetchLogged(log, BASE + pathname, {
      method,
      headers: { Authorization: `Bearer ${apiKey()}`, ...(form || !body ? {} : { "Content-Type": "application/json" }) },
      body: form ?? (body ? JSON.stringify(body) : undefined),
    }, { logBody: form ?? body });
    const json = parsed && typeof parsed === "object" ? parsed : {};
    if (res.ok) return json;
    // Quota/nhịp gọi: lùi rồi thử lại thay vì bỏ dở cả mẻ dài. Backoff cũ (3s×lượt,
    // không jitter) đủ cho 1 luồng nhưng vài luồng song song cùng dính 429 thì lùi
    // GẦN NHƯ ĐỒNG BỘ, đâm lại cùng lúc, hết 4 lượt vẫn dính — đo thực tế ở
    // concurrency=2. Nới lên 8 lượt, tăng dần tới trần 20s, cộng jitter ngẫu nhiên để
    // các luồng tách nhịp thử lại ra khỏi nhau.
    if ((res.status === 429 || res.status >= 500) && attempt < 8) {
      if (res.status === 429) throttled += 1;
      const backoff = Math.min(20000, 2000 * 2 ** attempt) + Math.random() * 2000;
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    const err = new Error(`VieNeu ${res.status}: ${json.message ?? raw.slice(0, 200)}`);
    err.code = json.code;
    throw err;
  }
}

/**
 * Poll job /tts tới khi xong. Doc khuyên 2-3s một lần.
 *
 * Bẫy đã sập: ngay lúc chuyển `completed`, `audioUrl` có khi là đường dẫn NỘI BỘ tương
 * đối (`/api/tts/audio/<id>`, gọi vào thì 401 kể cả có key); poll lại vài giây sau mới
 * ra URL S3 đã ký. Cùng họ với bẫy S3 của /clone — URL chưa tuyệt đối thì coi như chưa xong.
 */
async function waitJob(jobId) {
  for (;;) {
    const job = await api(`/tts/${jobId}`, { method: "GET" });
    if (job.status === "completed" && /^https?:\/\//.test(job.audioUrl ?? "")) return job.audioUrl;
    if (job.status === "failed") throw new Error(`job ${jobId} failed: ${job.error ?? "?"}`);
    await new Promise((r) => setTimeout(r, 2500));
  }
}

/**
 * Enrol giọng một nhân vật (POST /voices) để dùng làm voiceId cho /tts. Kết quả cache ở
 * `vieneu-voice.json` cạnh manifest — kho giọng cấp series (`--voices`) enrol một lần
 * dùng cho mọi tập. Chỉ cache khi thành công, để thêm clip mới rồi chạy lại là thử lại.
 *
 * Hai ràng buộc của v4 quyết định chọn clip nào, cả hai đo được khi enrol thật:
 * - khung 6-15s (trần 15s bị chặn cứng);
 * - MẬT ĐỘ transcript: VieNeu đếm ký tự (tính cả dấu câu), đòi ~3.1-28 ký tự/giây, sai
 *   thì trả CLONE_TRANSCRIPT_DENSITY. Chữ Hán một chữ một âm tiết nên mẫu tiếng Trung
 *   thưa sẵn — câu gào/kéo dài không bao giờ qua. Lọc trước cho đỡ tốn lượt gọi.
 * Trong số clip qua lọc vẫn lấy theo độ giống, cùng luật với /clone.
 */
async function enrolVoice(speaker, voiceDir, scored) {
  const cacheFile = path.join(voiceDir, "vieneu-voice.json");
  const cached = await fs.readFile(cacheFile, "utf8").then(JSON.parse, () => null);
  if (cached?.voiceId) return cached;
  const density = (c) => [...c.text].length / c.duration;
  const dense = (c) => density(c) >= 3.2 && density(c) <= 27;
  const candidates = scored
    .filter((c) => c.duration >= 6 && c.duration <= 15 && dense(c))
    .sort((a, b) => b.score - a.score);
  // Nhân vật thoại ngắn (đối đáp nhanh) thường KHÔNG có clip nào dài tới 6s — đo được ở
  // 黑神话小钻风: 小钻风 16 clip, 铁扇公主 20 clip, không clip nào lọt. Ghép vài clip giống nhất
  // (theo thứ tự thời gian, cách nhau 0.3s) thành một mẫu 10-14.5s, text nối tương ứng.
  if (!candidates.length) {
    const picked = [];
    let total = 0;
    for (const c of scored.filter((x) => x.duration >= 1.5 && dense(x)).sort((a, b) => b.score - a.score)) {
      if (total + c.duration + 0.3 > 14.5) continue;
      picked.push(c);
      total += c.duration + 0.3;
      if (total >= 10) break;
    }
    if (total >= 6) {
      picked.sort((a, b) => a.start - b.start);
      const file = "vieneu-ref.wav";
      const inputs = picked.flatMap((c) => ["-i", path.join(voiceDir, c.file)]);
      const filter = picked.map((_, i) => `[${i}:a]aformat=sample_fmts=s16:channel_layouts=mono,apad=pad_dur=0.3[a${i}]`).join(";")
        + ";" + picked.map((_, i) => `[a${i}]`).join("") + `concat=n=${picked.length}:v=0:a=1[out]`;
      await sh("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[out]", path.join(voiceDir, file)]);
      candidates.push({
        file, duration: total, text: picked.map((c) => c.text).join(""),
        score: picked.reduce((s, c) => s + c.score, 0) / picked.length,
      });
      console.log(`  ${speaker}: không clip đơn nào đủ 6s, ghép ${picked.map((c) => c.file).join("+")} = ${total.toFixed(1)}s`);
    }
  }
  for (const c of candidates.slice(0, 3)) {
    const form = new FormData();
    form.append("reference", new Blob([await fs.readFile(path.join(voiceDir, c.file))], { type: "audio/wav" }), c.file);
    form.append("name", `${path.basename(path.dirname(path.dirname(voiceDir)))}-${speaker}`);
    form.append("refText", c.text);
    form.append("consent", "true");
    try {
      const json = await api("/voices", { form });
      const result = { voiceId: json.voiceId, engine: json.engine, clip: c.file, duration: c.duration,
        score: Number(c.score.toFixed(3)), text: c.text, createdAt: json.createdAt };
      await fs.writeFile(cacheFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      return result;
    } catch (err) {
      if (!String(err.code).startsWith("CLONE_REF") && err.code !== "CLONE_TRANSCRIPT_DENSITY") throw err;
      console.log(`  ${speaker}: ${c.file} bị từ chối (${err.code}), thử clip kế`);
    }
  }
  return { rejected: candidates.length ? "enrol-refused" : "không clip nào 6-15s đủ mật độ chữ" };
}

/**
 * Tải audio đã tổng hợp.
 *
 * `audioUrl` được ký TRƯỚC khi object ghi xong lên S3 — tải ngay thì nhận về một tài
 * liệu XML `NoSuchKey` mang status 200, và ffmpeg mãi bước sau mới báo "Invalid
 * argument". Kiểm 5 byte đầu để phát hiện ngay tại chỗ.
 */
async function download(url, tries = 6) {
  for (let i = 0; ; i += 1) {
    const { buf } = await fetchBufferLogged(log, url);
    if (buf.length > 1000 && buf.subarray(0, 5).toString() !== "<?xml") return buf;
    if (i >= tries) throw new Error(`audio chưa sẵn sàng sau ${tries} lần thử`);
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
}

const probeDuration = async (f) =>
  Number.parseFloat((await sh("ffprobe", ["-v", "error", "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1", f])).stdout);

const probeResolution = async (f) => {
  const { stdout } = await sh("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", f]);
  const [w, h] = stdout.trim().split("x").map(Number);
  return { w, h };
};

const probeVideoCodec = async (f) => {
  const { stdout } = await sh("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name", "-of", "csv=p=0", f]);
  return stdout.trim();
};

/**
 * Douyin đôi khi đóng khung video sai tỉ lệ, chèn thẳng viền đen vào trong chính video.mp4 (không
 * phải viền do trình phát) — dò bằng cropdetect trên một đoạn giữa video (né vài giây đầu hay có
 * khung chuyển cảnh/đen), lấy khung xuất hiện nhiều nhất trong mẫu. Viền dưới ~3% mỗi chiều thì bỏ
 * qua, coi là nhiễu do nội dung tối chứ không phải viền thật.
 */
async function detectBars(videoFile, W, H, ss, dur) {
  const { stderr } = await sh("ffmpeg", ["-ss", String(ss), "-t", String(dur), "-i", videoFile,
    "-vf", "cropdetect=24:2:0", "-f", "null", "-"]);
  const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!matches.length) return null;
  const counts = new Map();
  for (const m of matches) {
    const key = m.slice(1, 5).join(":");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [w, h, x, y] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(":").map(Number);
  if (w >= W * 0.97 && h >= H * 0.97) return null;
  return { w, h, x, y };
}

/**
 * Nền mờ từ ảnh bìa Douyin (state.json → info.cover) để phủ đúng chỗ viền đen phát hiện được ở
 * trên, thay vì để đen trơn — cùng cách ghép của ảnh chờ trình phát (src/ui/server.js buildPoster)
 * nhưng dựng ở đúng độ phân giải video thật, chỉ để làm phông chứ không đặt ảnh bìa nét lên trên.
 * Không có bìa hoặc tải hỏng → false, nơi gọi tự rơi về giữ nguyên video gốc (-c:v copy).
 */
async function buildBarBackground(dir, W, H, dst) {
  let st;
  try {
    st = JSON.parse(await fs.readFile(path.join(path.dirname(dir), "state.json"), "utf8"));
  } catch {
    return false;
  }
  const url = st?.videos?.[path.basename(dir)]?.info?.cover;
  if (!url) return false;
  const { res, buf } = await fetchBufferLogged(log, url);
  if (!res.ok || !String(res.headers.get("content-type") ?? "").startsWith("image/")) return false;
  const src = `${dst}.src.jpg`;
  await fs.writeFile(src, buf);
  await sh("ffmpeg", ["-v", "error", "-y", "-i", src, "-vf",
    `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:4,eq=brightness=-0.12`,
    "-frames:v", "1", "-q:v", "3", dst]);
  await fs.unlink(src).catch(() => {});
  return true;
}

/** Cosine giữa từng clip và `all.wav` của chính nhân vật, qua resemblyzer. */
async function rankClips(voiceDir, clips) {
  const script = `
import json,sys,pathlib
from resemblyzer import VoiceEncoder, preprocess_wav
import numpy as np
enc=VoiceEncoder("cpu")
e=lambda p: enc.embed_utterance(preprocess_wav(pathlib.Path(p)))
d=json.loads(sys.argv[1]); ref=e(d["all"])
print(json.dumps({f: float(np.dot(ref,e(f))) for f in d["files"]}))
`;
  const payload = JSON.stringify({
    all: path.join(voiceDir, "all.wav"),
    files: clips.map((c) => path.join(voiceDir, c.file)),
  });
  const { stdout } = await sh(PY, ["-c", script, payload]);
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

/** Trần nén: chuỗi atempo, vì mỗi atempo chỉ nhận 0.5-2.0. */
const atempoChain = (factor) => `atempo=${factor.toFixed(4)}`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(str(args.dir, ""));
  if (!args.dir) throw new Error("cần --dir <videoDir>");
  const engine = str(args.engine, "v4");
  const onlySpeaker = str(args.speaker, null);
  const maxTempo = Number.parseFloat(str(args["max-tempo"], "1.15"));
  const resume = Boolean(args.resume);
  const concurrency = Number.parseInt(str(args.concurrency, "5"), 10);
  // Kho giọng dùng chung cấp SERIES (vd. series/<tên>/voices/<nhân vật>/) — nhân vật
  // nào đã có mẫu ở đây thì dùng lại NGUYÊN clip đó, không tự tách/chọn lại từ video
  // này nữa. Mục đích: cùng 1 nhân vật đọc cùng 1 giọng xuyên suốt các tập trong series,
  // thay vì mỗi tập tự chọn "clip giống nhất" của riêng nó rồi lệch nhau. Video nào
  // KHÔNG có --voices, hoặc nhân vật chưa có trong kho, thì rơi về voice/ của video đó.
  const seriesVoices = args.voices ? path.resolve(str(args.voices, "")) : null;
  const synth = str(args.synth, "voice");
  if (!["clone", "voice", "preset"].includes(synth)) throw new Error("--synth phải là clone, voice hoặc preset");
  const presetMap = synth === "preset" && args["preset-map"]
    ? JSON.parse(await fs.readFile(path.resolve(str(args["preset-map"], "")), "utf8")) : {};
  const presetDefault = str(args.preset, null);
  const bedMode = args["no-bed"] ? "none" : str(args.bed, "vocals-removed");
  if (!["vocals-removed", "original", "none"].includes(bedMode)) throw new Error("--bed phải là vocals-removed hoặc original");
  // auto = dò GPU một lần rồi nhớ (lib/encoder.mjs). Ép cpu/gpu khi muốn so sánh hoặc khi máy
  // có card nhưng đang bận việc khác.
  const wantEncoder = str(args.encoder, "auto");
  if (!["auto", "gpu", "cpu"].includes(wantEncoder)) throw new Error("--encoder phải là auto, gpu hoặc cpu");
  const origDb = Number.parseFloat(str(args["orig-db"], "-8"));
  const duckDb = Number.parseFloat(str(args.duck, "6"));
  if (!Number.isFinite(origDb) || !Number.isFinite(duckDb) || duckDb < 0) throw new Error("--orig-db / --duck phải là số (duck >= 0)");

  // preset ghi vào `dub/` như clone — đó là chỗ UI (scan.js) đọc; clip đã làm bằng giọng khác thì
  // được nhận ra qua clips/voices.json (xem `voiceKey`), không lẫn vào nhau khi --resume.
  const outDir = path.join(dir, str(args.out, synth === "clone" ? "dub-clone" : "dub"));
  const clipDir = path.join(outDir, "clips");
  await fs.mkdir(clipDir, { recursive: true });

  const parsed = JSON.parse(await fs.readFile(path.join(dir, "translation.json"), "utf8"));
  // translation.json có hai dạng ngoài đời: bọc {segments:[…]} do src/translate.js ghi,
  // và mảng trần do các bước soát/sửa tay ghi đè. Nhận cả hai, và `index` có thể tên là
  // `id` — thiếu nó thì tên file clip sẽ là "undefined.wav".
  const translation = Array.isArray(parsed) ? { segments: parsed } : parsed;
  translation.segments = translation.segments.map((s, i) => ({ ...s, index: s.index ?? s.id ?? i }));
  const segments = translation.segments.filter((s) => s.vi && s.speaker
    && (!onlySpeaker || s.speaker === onlySpeaker));
  const speakers = [...new Set(segments.map((s) => s.speaker))];
  const videoFile = path.join(dir, "video.mp4");
  const audioFile = await findAudioFile(dir);
  const totalDuration = await probeDuration(audioFile);

  // ── chọn mẫu cho từng nhân vật ──────────────────────────────────────────
  const refs = {};
  if (synth === "preset") {
    // giọng có sẵn: khỏi mẫu, khỏi resemblyzer — chỉ cần biết nhân vật nào đọc giọng nào
    const missing = [];
    console.log("giọng có sẵn của VieNeu:");
    for (const speaker of speakers) {
      const voiceId = presetMap[speaker] ?? presetDefault;
      if (!voiceId) {
        missing.push(speaker);
        continue;
      }
      refs[speaker] = { voiceId, voiceEngine: engine };
      console.log(`  ${speaker.padEnd(14)} → ${voiceId}`);
    }
    if (missing.length) throw new Error(`chưa chọn giọng cho: ${missing.join(", ")} (--preset-map <file> hoặc --preset <voiceId>)`);
  } else {
    console.log("chọn mẫu clone (theo độ giống, khung 3-5.5s):");
  }
  for (const speaker of synth === "preset" ? [] : speakers) {
    // Tên thư mục phải khớp với sanitize của extract-voice.js: "/" trong tên nhân
    // vật (cụm giọng gộp nhiều tên) bị path.join hiểu thành phân cách thư mục.
    const folderName = speaker.replace(/[/\\]/g, "_").trim();
    const seriesDir = seriesVoices ? path.join(seriesVoices, folderName) : null;
    const fromSeries = seriesDir && (await exists(path.join(seriesDir, "manifest.json")));
    const voiceDir = fromSeries ? seriesDir : path.join(dir, "voice", folderName);
    if (!(await exists(path.join(voiceDir, "manifest.json")))) {
      throw new Error(`chưa có voice/${speaker} — chạy: npm run voice -- --dir <videoDir> --speaker "${speaker}"`);
    }
    if (fromSeries) console.log(`  ${speaker.padEnd(14)} <- kho series (${seriesDir})`);
    const manifest = JSON.parse(await fs.readFile(path.join(voiceDir, "manifest.json"), "utf8"));
    const scores = await rankClips(voiceDir, manifest.clips);
    const scored = manifest.clips.map((c) => ({ ...c, score: scores[path.join(voiceDir, c.file)] ?? 0 }));
    const inWindow = scored.filter((c) => c.duration >= 3 && c.duration <= 5.5);
    // Nhân vật ít thoại có thể không có clip nào lọt khung — lấy clip điểm cao nhất
    // còn lại còn hơn bỏ trắng cả vai.
    const best = (inWindow.length ? inWindow : scored).sort((a, b) => b.score - a.score)[0];
    refs[speaker] = { ...best, voiceDir };
    console.log(`  ${speaker.padEnd(14)} ${best.file}  ${best.duration.toFixed(2)}s  giống ${best.score.toFixed(3)}` +
      `${inWindow.length ? "" : "  (không clip nào lọt khung 3-5.5s)"}`);
    if (synth === "voice") {
      const v = await enrolVoice(speaker, voiceDir, scored);
      if (v.voiceId) {
        Object.assign(refs[speaker], { voiceId: v.voiceId, voiceEngine: v.engine });
        console.log(`  ${"".padEnd(14)} giọng enrol: ${v.clip} ${v.duration.toFixed(2)}s giống ${v.score} → ${v.voiceId}`);
      } else {
        console.log(`  ${"".padEnd(14)} KHÔNG enrol được (${v.rejected}) → câu của nhân vật này dùng /clone`);
      }
    }
  }

  for (const [speaker, r] of Object.entries(refs)) {
    if (r.voiceId) continue;
    const form = new FormData();
    const file = path.join(r.voiceDir, r.file);
    form.append("file", new Blob([await fs.readFile(file)], { type: "audio/wav" }), r.file);
    r.fileId = (await api("/upload", { form })).fileId;
  }

  // ── tổng hợp từng câu ───────────────────────────────────────────────────
  // Song song N luồng: nút cổ chai là round-trip API (submit + tải audio), không
  // phải CPU cục bộ. Ghi thẳng vào `rows[index]` (không push) để giữ ĐÚNG thứ tự
  // segments — bước đặt timeline dưới đây tính room/tempo so với câu kế tiếp, dựa
  // vào thứ tự này chứ không phải thứ tự hoàn thành.
  console.log(`\ntổng hợp ${segments.length} câu (${synth}, engine ${engine}, ${concurrency} luồng)…`);
  const rows = new Array(segments.length);
  let doneCount = 0;
  let synthesized = 0;
  const synthStart = Date.now();
  // Clip đặt tên theo số câu nên không nói được nó đọc bằng giọng nào; chạy lại với giọng khác mà
  // vẫn dùng clip cũ là một nhân vật lẫn hai giọng. Ghi kèm "giọng nào" cho từng clip: đổi giọng
  // thì làm lại đúng các câu đó. Clip cũ không có ghi chú vẫn dùng lại được ở clone/voice (như trước
  // đây), nhưng KHÔNG ở preset — nó gần như chắc chắn từ giọng khác.
  const voiceKey = (r) => (r.voiceId ? `${r.voiceEngine ?? engine}:${r.voiceId}` : `clone:${engine}`);
  const marksFile = path.join(clipDir, "voices.json");
  const marks = resume ? await fs.readFile(marksFile, "utf8").then(JSON.parse, () => ({})) : {};
  let saving = Promise.resolve(); // nối đuôi: nhiều luồng cùng ghi một file sẽ xé nhau
  const saveMarks = () => (saving = saving.then(() => fs.writeFile(marksFile, JSON.stringify(marks))));
  await pool(segments, concurrency, async (seg, i) => {
    const name = `${String(seg.index).padStart(3, "0")}.wav`;
    const file = path.join(clipDir, name);
    const r = refs[seg.speaker];
    const known = marks[seg.index];
    const reusable = resume && (await exists(file)) && (known ? known === voiceKey(r) : synth !== "preset");
    if (!reusable) {
      let url;
      if (r.voiceId) {
        const job = await api("/tts", { body: { text: seg.vi, voiceId: r.voiceId, engine: r.voiceEngine } });
        url = await waitJob(job.jobId);
      } else {
        const json = await api("/clone", {
          body: { text: seg.vi, refFileId: r.fileId, refText: r.text, engine },
        });
        url = json.audioUrl ?? json.url;
      }
      await fs.writeFile(file, await download(url));
      marks[seg.index] = voiceKey(r);
      await saveMarks();
      synthesized += 1;
    }
    rows[i] = { seg, file, natural: await probeDuration(file) };
    doneCount += 1;
    process.stdout.write(`\r  ${doneCount}/${segments.length}`);
  });
  const synthMinutes = (Date.now() - synthStart) / 60000;
  console.log(`\n  ${synthesized} câu mới trong ${(synthMinutes * 60).toFixed(0)}s` +
    `${synthesized ? ` (${(synthesized / synthMinutes).toFixed(1)} câu/phút)` : ""}, dính 429: ${throttled} lần`);

  // ── đặt lên timeline ────────────────────────────────────────────────────
  // Khung của một câu là từ mốc bắt đầu của nó tới mốc bắt đầu của câu SAU, chứ
  // không phải tới mốc kết thúc của chính nó: khoảng lặng giữa hai câu là chỗ dùng
  // được, và trong phim này nhiều chỗ lặng rất dài.
  const all = translation.segments;
  const placed = [];
  const overflow = [];
  for (const row of rows) {
    const idx = all.indexOf(row.seg);
    const nextStart = idx < all.length - 1 ? all[idx + 1].start : totalDuration;
    const room = nextStart - row.seg.start - 0.05; // chừa 50ms không dính câu sau
    let tempo = 1;
    if (row.natural > room && room > 0) tempo = Math.min(maxTempo, row.natural / room);
    const finalDur = row.natural / tempo;
    if (finalDur > room + 0.01) {
      overflow.push({ ...row, room, finalDur, over: finalDur - room });
    }
    placed.push({ ...row, tempo, finalDur, room });
  }

  // ── dựng track lời thoại ────────────────────────────────────────────────
  const inputs = [];
  const filters = [];
  placed.forEach((p, i) => {
    inputs.push("-i", p.file);
    const delayMs = Math.round(p.seg.start * 1000);
    const chain = [
      p.tempo > 1.0001 ? atempoChain(p.tempo) : null,
      "aresample=48000",
      `adelay=${delayMs}|${delayMs}`,
    ].filter(Boolean).join(",");
    filters.push(`[${i}:a]${chain}[d${i}]`);
  });
  const mixInputs = placed.map((_, i) => `[d${i}]`).join("");
  // `normalize=0`: amix mặc định chia biên độ cho số nhánh, mà ở đây các nhánh gần
  // như không chồng nhau về thời gian nên chia sẽ làm cả track nhỏ đi hàng chục lần.
  filters.push(`${mixInputs}amix=inputs=${placed.length}:normalize=0:dropout_transition=0[voice]`);
  const voiceTrack = path.join(outDir, "voice-track.wav");
  await sh("ffmpeg", ["-v", "error", "-y", ...inputs,
    "-filter_complex", filters.join(";"), "-map", "[voice]",
    "-t", String(totalDuration), "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", voiceTrack]);

  // ── nền: tách audio gốc thành nhạc/hiệu ứng (no_vocals) và giọng Trung (vocals) bằng demucs ──
  // Cả hai chế độ đều dùng no_vocals làm nền nhạc, cố định 0.7. `original` còn trộn thêm giọng Trung đã tách
  // (vocals) ở mức nhỏ dưới giọng Việt. Thử trộn thẳng audio gốc (nhạc + giọng Trung dính liền) rồi hạ cả cục
  // thì nhạc chìm mất: giọng Trung to hơn nhạc ~11 dB nên hạ giọng Trung xuống dưới giọng Việt là nhạc theo xuống luôn.
  let bed = null;
  let zhVoice = null;
  if (bedMode !== "none") {
    const demucsDir = path.join(outDir, "_demucs");
    const stem = path.basename(audioFile, path.extname(audioFile));
    const noVocals = path.join(demucsDir, "htdemucs", stem, "no_vocals.wav");
    const vocals = path.join(demucsDir, "htdemucs", stem, "vocals.wav");
    if (!(resume && (await exists(noVocals)) && (await exists(vocals)))) {
      console.log("tách nền nhạc khỏi audio gốc (demucs)…");
      await sh("demucs", ["--two-stems=vocals", "-n", "htdemucs", "-o", demucsDir, audioFile]);
    }
    bed = noVocals;
    if (bedMode === "original") zhVoice = vocals;
  }

  // giọng Trung: audio gốc Douyin thường to hơn giọng TTS cả chục dB nên cân theo mức ĐO được của giọng Việt
  // (voiceDb + origDb), không dùng hệ số cố định
  let zhGain = null;
  if (zhVoice) {
    const voiceDb = await meanVolume(voiceTrack);
    const zhDb = await meanVolume(zhVoice);
    zhGain = `${(voiceDb + origDb - zhDb).toFixed(1)}dB`;
    console.log(`giữ tiếng Trung: giọng Việt ${voiceDb} dB, giọng Trung tách ${zhDb} dB → ${zhGain} `
      + `(${origDb} dB so với giọng Việt${duckDb ? `, hạ thêm ~${duckDb} dB khi giọng Việt nói` : ""}); nhạc nền giữ nguyên 0.7`);
  }

  const finalAudio = path.join(outDir, "audio-vi.wav");
  if (bed) {
    // aformat stereo: file nguồn có thể là mono, amix không nhận các đầu vào khác kênh
    const stereo = "aresample=48000,aformat=channel_layouts=stereo";
    let inputs = ["-i", bed, "-i", voiceTrack];
    let mixGraph = `[0:a]volume=0.7,${stereo}[b];[b][1:a]amix=inputs=2:normalize=0:dropout_transition=0[a]`;
    if (zhVoice) {
      // duck: sidechaincompress hạ giọng Trung theo độ lớn của giọng Việt (ratio 20 → hạ ~16 dB trên video đã đo,
      // 13-16 tuỳ độ lớn giọng); `mix` pha bản đã hạ với bản nguyên để ra đúng ~duckDb thay vì hạ hết cỡ.
      // limiter: nhạc + hai giọng cộng lại dễ vượt 0 dBFS (level=disabled: đừng tự nâng lại)
      const FULL_DUCK_DB = 16;
      const duckMix = Math.min(1, (1 - 10 ** (-duckDb / 20)) / (1 - 10 ** (-FULL_DUCK_DB / 20)));
      inputs = ["-i", bed, "-i", zhVoice, "-i", voiceTrack];
      mixGraph = `[0:a]volume=0.7,${stereo}[m];[1:a]volume=${zhGain},${stereo}[z0];`
        + (duckDb > 0
          ? `[2:a]asplit=2[v][sc];[z0][sc]sidechaincompress=threshold=0.015:ratio=20:attack=30:release=350:makeup=1:mix=${duckMix.toFixed(2)}[z];`
          : "[2:a]anull[v];[z0]anull[z];")
        + "[m][z][v]amix=inputs=3:normalize=0:dropout_transition=0,alimiter=limit=0.95:level=disabled[a]";
    }
    await sh("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", mixGraph,
      "-map", "[a]", "-t", String(totalDuration), "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", finalAudio]);
  } else {
    await fs.copyFile(voiceTrack, finalAudio);
  }

  const outVideo = path.join(outDir, "dub-vi.mp4");
  const { w: fullW, h: fullH } = await probeResolution(videoFile);
  const ss = totalDuration > 10 ? 5 : 0;
  const bars = await detectBars(videoFile, fullW, fullH, ss, Math.max(1, Math.min(20, totalDuration - ss)));
  const barBg = path.join(outDir, "bar-bg.jpg");
  const hasBarBg = bars != null
    && (resume && (await exists(barBg)) ? true : await buildBarBackground(dir, fullW, fullH, barBg).catch(() => false));
  // Douyin hay xuất HEVC (h265) — Chrome/Chromium không giải mã được trong <video> (canPlayType rỗng,
  // videoWidth luôn 0): âm thanh vẫn chạy, currentTime vẫn nhích (đồng hồ theo track audio) nhưng
  // hình đứng im, coi như video hỏng dù file không lỗi gì. `-c:v copy` giữ nguyên codec nguồn nên
  // kế thừa luôn lỗi này — chỉ giữ copy khi nguồn đã là h264, còn lại luôn encode lại.
  const sourceCodec = await probeVideoCodec(videoFile);
  // Bộ mã hoá dò MỘT lần cho cả lượt chạy (xem lib/encoder.mjs: máy quyết định tốc độ, không
  // quyết định đầu ra). Chỉ dò khi thật sự phải encode — tập h264 không viền đen đi `-c:v copy`.
  const recoding = hasBarBg || sourceCodec !== "h264";
  const encoder = recoding ? await pickEncoder(wantEncoder, { log: console }) : null;
  if (hasBarBg) {
    console.log(`video có viền đen sẵn (khung ${fullW}x${fullH}, nội dung ${bars.w}x${bars.h} tại `
      + `${bars.x},${bars.y}) — phủ nền mờ từ ảnh bìa thay vì để đen trơn [${encoder}]`);
    const vf = `[2:v]scale=${fullW}:${fullH}[bg];[0:v]crop=${bars.w}:${bars.h}:${bars.x}:${bars.y}[fg];`
      + `[bg][fg]overlay=${bars.x}:${bars.y}[v]`;
    await sh("ffmpeg", ["-v", "error", "-y", "-i", videoFile, "-i", finalAudio, "-i", barBg,
      "-filter_complex", vf, "-map", "[v]", "-map", "1:a:0",
      ...encoderArgs(encoder), "-c:a", "aac", "-b:a", "192k",
      "-shortest", outVideo]);
  } else if (sourceCodec !== "h264") {
    console.log(`video.mp4 codec ${sourceCodec} — trình duyệt không phát được, encode lại sang h264 [${encoder}]`);
    await sh("ffmpeg", ["-v", "error", "-y", "-i", videoFile, "-i", finalAudio,
      "-map", "0:v:0", "-map", "1:a:0", ...encoderArgs(encoder),
      "-c:a", "aac", "-b:a", "192k", "-shortest", outVideo]);
  } else {
    await sh("ffmpeg", ["-v", "error", "-y", "-i", videoFile, "-i", finalAudio,
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-shortest", outVideo]);
  }

  await fs.writeFile(path.join(outDir, "report.json"), `${JSON.stringify({
    engine,
    synth,
    bed: bedMode,
    ...(bedMode === "original" ? { origDb, duck: duckDb } : {}),
    ...(hasBarBg ? { barBg: bars } : {}),
    sourceCodec, recoded: recoding, ...(encoder ? { encoder } : {}),
    refs: Object.fromEntries(Object.entries(refs).map(([k, v]) =>
      [k, { file: v.file, duration: v.duration, score: v.score === undefined ? undefined : Number(v.score.toFixed(3)),
        text: v.text, voiceId: v.voiceId }])),
    maxTempo,
    segments: placed.map((p) => ({
      index: p.seg.index, speaker: p.seg.speaker, start: p.seg.start,
      vi: p.seg.vi, natural: Number(p.natural.toFixed(2)),
      room: Number(p.room.toFixed(2)), tempo: Number(p.tempo.toFixed(3)),
    })),
  }, null, 2)}\n`, "utf8");

  const stretched = placed.filter((p) => p.tempo > 1.0001);
  console.log(`\nnén để tránh đè câu sau: ${stretched.length}/${placed.length} câu` +
    `${stretched.length ? ` (tối đa ${Math.max(...stretched.map((p) => p.tempo)).toFixed(2)}x)` : ""}`);
  if (overflow.length) {
    console.log(`\n${overflow.length} câu vẫn dài quá khung dù đã nén hết trần — RÚT GỌN BẢN DỊCH mấy câu này:`);
    for (const o of overflow.sort((a, b) => b.over - a.over)) {
      console.log(`  [${String(o.seg.index).padStart(2)}] ${o.seg.speaker.padEnd(12)} thừa ${o.over.toFixed(2)}s  ${o.seg.vi}`);
    }
  }
  console.log(`\n→ ${outVideo}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
