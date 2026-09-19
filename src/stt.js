import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import OpenAI from "openai";

import { assignSpeakers, mergeSpeakerTurns } from "./align.js";
import { logApiCall, OPENAI_V1 } from "./apiLog.js";
import { transcribeQwenAsr } from "./asr-qwen.js";
import { config, paths } from "./config.js";
import { diarizeAudio } from "./diarize.js";
import { createLogger } from "./logger.js";
import { inferMissingSpeakers } from "./speakers.js";
import { markVideo, saveState, STATUS, videosByStatus } from "./state.js";
import { compareStt } from "./stt-compare.js";
import { parseSpec } from "./stt-engines.js";

const log = createLogger("STT");

// Giới hạn upload của OpenAI transcription API.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// USD mỗi phút audio, theo bảng giá trong CLAUDE.md (08/2026). Chỉ để ước tính —
// model không có trong bảng thì bỏ qua chứ không đoán giá.
const PRICE_PER_MIN = {
  "whisper-1": 0.006,
  "gpt-4o-transcribe": 0.006,
  "gpt-transcribe": 0.0045,
  "gpt-4o-mini-transcribe": 0.003,
  "qwen-audio-3.0-asr-flash": 0.0021,
};

/**
 * Chạy `worker` trên `items` với tối đa `limit` việc song song.
 *
 * Mỗi file audio chỉ ~1.5 MB nên nút cổ chai là độ trễ mạng chứ không phải băng
 * thông — chạy song song vài luồng rút ngắn thời gian đáng kể, và một luồng dính
 * nhịp nhiễu mạng không chặn các luồng còn lại.
 */
async function runPool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      await worker(queue.shift());
    }
  });
  await Promise.all(runners);
}

// Ghi state tuần tự dù worker chạy song song: saveState ghi cả file qua một đường
// tmp dùng chung, hai lượt ghi chồng nhau là hỏng file.
let saveChain = Promise.resolve();
function queueSave(state) {
  saveChain = saveChain.then(() => saveState(state));
  return saveChain;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Video này đã trả tiền transcribe chưa? Hỏi đĩa, không hỏi state. */
async function hasTranscript(userId, videoId) {
  try {
    const { size } = await fs.stat(path.join(paths.videoDir(userId, videoId), "transcript.txt"));
    return size > 0;
  } catch {
    return false;
  }
}

/** Tổng thời lượng (phút) của các video, đọc từ meta.json. */
async function totalMinutes(userId, videoIds) {
  let ms = 0;
  let unknown = 0;
  for (const videoId of videoIds) {
    try {
      const meta = JSON.parse(
        await fs.readFile(path.join(paths.videoDir(userId, videoId), "meta.json"), "utf8"),
      );
      if (meta.duration) ms += meta.duration;
      else unknown += 1;
    } catch {
      unknown += 1;
    }
  }
  return { minutes: ms / 60000, unknown };
}

/** In ước tính chi phí trước khi gọi API — để còn kịp đổi ý. */
async function reportCost(userId, videoIds, models) {
  const { minutes, unknown } = await totalMinutes(userId, videoIds);
  console.log(`\n${videoIds.length} video, tổng ${minutes.toFixed(1)} phút audio`);
  if (unknown > 0) console.log(`  (${unknown} video không đọc được duration — chưa tính vào)`);
  for (const model of models) {
    const price = PRICE_PER_MIN[model];
    console.log(
      `  ${model.padEnd(24)} ${price ? `$${(minutes * price).toFixed(3)}` : "(chưa có giá trong bảng)"}`,
    );
  }
  console.log("");
}

/**
 * Tìm file audio trong thư mục video.
 *
 * Đuôi file phụ thuộc nguồn audio: `.m4a` khi lấy track tách từ video (mặc định),
 * `.mp3` khi phải rơi về track "music". State ghi lại tên file, nhưng vẫn dò thư mục
 * để dữ liệu tải từ bản cũ vẫn dùng được.
 */
export async function findAudioFile(dir, known) {
  if (known) {
    try {
      const p = path.join(dir, known);
      await fs.access(p);
      return p;
    } catch {
      /* state ghi tên cũ — rơi xuống nhánh dò thư mục */
    }
  }
  const entries = await fs.readdir(dir);
  const hit = entries.find((f) => /^audio\.(m4a|mp3|mp4|wav|webm)$/i.test(f));
  if (!hit) throw new Error(`không tìm thấy file audio trong ${dir}`);
  return path.join(dir, hit);
}

function client() {
  if (!config.openaiApiKey) {
    throw new Error("thiếu OPENAI_API_KEY — thêm vào .env (xem .env.example)");
  }
  // Đường tới api.openai.com từ VN bị chặn chập chờn: cùng một đường truyền, lúc
  // TLS xong rồi treo, lúc trả 200 trong 0.8s. Mặc định SDK chỉ thử lại 2 lần nên
  // một nhịp nhiễu là hỏng cả video — nới rộng để tự vượt qua.
  return new OpenAI({
    apiKey: config.openaiApiKey,
    maxRetries: config.sttMaxRetries,
    timeout: config.sttTimeoutMs,
  });
}

async function transcribeFile(openai, audioPath, model) {
  const { size } = await fs.stat(audioPath);
  if (size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `file ${(size / 1024 / 1024).toFixed(1)} MB vượt giới hạn 25 MB của API — cần cắt nhỏ trước`,
    );
  }

  const params = {
    file: createReadStream(audioPath),
    model,
    language: config.sttLanguage,
  };

  // Mồi từ vựng chuyên ngành. Whisper nghe đúng âm nhưng hay chọn sai chữ đồng âm —
  // với nội dung 玄幻 đã thấy 下品宝剑 → 下瓶宝剑, 燃料 → 饶料. Liệt kê đúng chữ ở đây
  // kéo model về đúng mặt chữ. Giới hạn 224 token, chỉ nhận phần đầu nếu dài hơn.
  if (config.sttPrompt) params.prompt = config.sttPrompt;

  // Timestamp chỉ có ở whisper-1 — tài liệu OpenAI ghi rõ "The timestamp_granularities[]
  // parameter is only supported for whisper-1". Gửi kèm cho model khác là lỗi request,
  // nên phải kiểm tra chứ không gửi vô điều kiện.
  const wantsTimestamps = config.sttTimestamps.length > 0;
  if (wantsTimestamps && model === "whisper-1") {
    params.response_format = "verbose_json";
    params.timestamp_granularities = config.sttTimestamps;
  }

  const res = await logApiCall(
    log,
    { url: `${OPENAI_V1}/audio/transcriptions`, body: { ...params, file: audioPath } },
    () => openai.audio.transcriptions.create(params),
  );
  return {
    text: res.text ?? "",
    // verbose_json mới có các field này; response_format mặc định chỉ trả text.
    segments: res.segments ?? null,
    words: res.words ?? null,
    duration: res.duration ?? null,
    detectedLanguage: res.language ?? null,
    hasTimestamps: Boolean(res.segments || res.words),
  };
}

/**
 * Chọn đường transcribe theo `STT_MODEL`, kèm tên file cache riêng cho từng engine.
 *
 * File cache tách theo engine là bắt buộc chứ không phải cho gọn: đổi STT_MODEL sang
 * engine khác mà vẫn đọc `raw-whisper.json` thì `cachedCall` trả lại kết quả whisper
 * cũ, và bạn tưởng engine mới đang chạy trong khi nó chưa hề được gọi.
 *
 * Client OpenAI chỉ dựng khi thật sự cần: `client()` ném lỗi nếu thiếu OPENAI_API_KEY,
 * mà chạy engine qwen thì không cần key đó.
 */
function resolveEngine(spec) {
  const { engine, model } = parseSpec(spec);

  if (engine === "openai") {
    const openai = client();
    return {
      engine,
      model,
      cacheFile: "raw-whisper.json",
      transcribe: (audioPath) => transcribeFile(openai, audioPath, model),
    };
  }
  if (engine === "qwen") {
    return {
      engine,
      model,
      cacheFile: "raw-qwen.json",
      transcribe: (audioPath) => transcribeQwenAsr(audioPath, model),
    };
  }
  throw new Error(`STT_MODEL: engine "${engine}" không chạy được ở flow chính — chọn openai hoặc qwen`);
}

/**
 * Bước [4]: transcribe video đã có audio.
 *
 * `videoId` — chỉ chạy đúng một video (để thử nghiệm).
 * `limit`   — chỉ chạy N video đầu, mới nhất trước.
 */
/**
 * Đọc file JSON đã lưu, hoặc gọi API rồi lưu lại.
 *
 * Response thô nằm cạnh transcript.json để chỉnh thuật toán alignment rồi chạy lại
 * mà không phải trả tiền API lần nữa — đây là phần đắt nhất của cả pipeline.
 * Vì vậy `--force` chỉ căn lại, KHÔNG gọi lại API đã có kết quả.
 */
async function cachedCall(file, fn) {
  try {
    const cached = JSON.parse(await fs.readFile(file, "utf8"));
    // Nói rõ là KHÔNG gọi API. Không có dòng này thì `--force` in ra "OK, N ký tự"
    // y hệt lượt nhận dạng thật, và người chạy tưởng vừa gọi API (mà log API im
    // lặng vì đúng là chẳng có request nào để in).
    log.info(`dùng lại ${path.basename(file)}, không gọi API — xoá file này nếu muốn nhận dạng lại`);
    return cached;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const json = await fn();
  await fs.writeFile(file, JSON.stringify(json, null, 2), "utf8");
  return json;
}

/**
 * Đắp nhãn người nói vào khung segment của whisper.
 *
 * Phân công rõ: whisper-1 làm STT tổng thể (text + timestamp, KHÔNG đổi bằng bất
 * cứ nguồn nào khác — audio gốc, không tách vocal). diarize CHỈ để định danh người
 * nói qua chồng lấn thời gian; text riêng của diarize không dùng, tránh việc tách
 * vocal (Demucs) làm nghẽn batch xử lý hàng trăm video.
 *
 * Segment nào diarize không chồng lấn được thì `speaker: null` → hiện ra là
 * "không xác định" ở bước dịch (không suy đoán, trừ khi bật `SPEAKER_INFER`).
 */
async function enrichTranscript(dir, audioPath, sttSegments, engine) {
  const out = { segments: sttSegments, speakers: [], turns: [], diarizeModel: null };
  if (!sttSegments?.length) return out;

  let segments = sttSegments.map((s, index) => ({ ...s, index }));

  // Nguồn 1: speaker_id do chính Qwen-ASR filetrans trả (khi QWEN_DIARIZE bật). Đo
  // được là tách loạn trên nội dung một-người-lồng-nhiều-giọng — để người dùng tự xem,
  // không phải nguồn tin cậy.
  if (segments.some((s) => s.qwenSpeakerId != null)) {
    segments = segments.map((s) => ({
      ...s,
      speaker: s.qwenSpeakerId != null ? `S${s.qwenSpeakerId}` : null,
      speakerSource: s.qwenSpeakerId != null ? "qwen" : null,
    }));
    out.speakers = [...new Set(segments.map((s) => s.speaker).filter((v) => v != null))];
    out.diarizeModel = `${config.sttModel}#diarization_enabled`;
    out.turns = mergeSpeakerTurns(segments, { maxGapSec: config.speakerMergeMaxGapSec });
    out.segments = segments;
    return out;
  }

  // Nguồn 2: model diarize riêng của OpenAI — CHỈ cho engine openai. Engine qwen mà
  // không bật QWEN_DIARIZE thì để "không xác định", KHÔNG gọi sang OpenAI: khác vendor,
  // chậm + treo trên file dài, và đã đo là không đáng tin cho nội dung này.
  if (engine === "openai" && config.sttDiarizeModel) {
    try {
      const raw = await cachedCall(path.join(dir, "raw-diarize.json"), () => diarizeAudio(audioPath));

      const assigned = assignSpeakers(segments, raw.segments ?? []);
      segments = segments.map((s, i) => ({ ...s, ...assigned[i] }));
      // Trước đây để LLM suy nốt nhãn còn thiếu — giờ mặc định TẮT (SPEAKER_INFER),
      // để nguyên "không xác định" thay vì đoán. Xem config.js.
      if (config.speakerInfer) segments = await inferMissingSpeakers(segments);
      out.speakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
      out.diarizeModel = config.sttDiarizeModel;
      out.turns = mergeSpeakerTurns(segments, { maxGapSec: config.speakerMergeMaxGapSec });
    } catch (err) {
      // Nhãn người nói là cải thiện, không bắt buộc — hỏng thì vẫn còn bản STT
      // dùng được, không đánh hỏng cả video.
      log.warn(`không lấy được nhãn người nói từ diarize (giữ bản STT): ${err.message}`);
    }
  }

  out.segments = segments;
  return out;
}

export async function sttAll(userId, state, { videoId = null, videoIds = null, limit = null, force = false } = {}) {
  // force cho phép nhặt cả video đã transcribe hoặc đã dịch — dùng khi đổi model,
  // đổi STT_KEYWORDS, hoặc bật thêm nguồn (text chuẩn / nhãn người nói).
  // Phải có cả TRANSLATED: bước dịch đẩy status lên, mà transcribe lại một video
  // đã dịch là việc hoàn toàn hợp lệ (dịch lại sau đó là được).
  const forceStatuses = [STATUS.FETCHED, STATUS.TRANSCRIBED, STATUS.TRANSLATED];
  let targets = videosByStatus(state, force ? forceStatuses : STATUS.FETCHED);

  if (videoId) {
    if (!targets.includes(videoId)) {
      const known = state.videos[videoId];
      throw new Error(
        !known
          ? `video ${videoId} không có trong state của user này`
          : forceStatuses.includes(known.status)
            ? `video ${videoId} đã transcribe rồi — thêm --force nếu muốn chạy lại (tốn tiền lại)`
            : `video ${videoId} đang ở trạng thái "${known.status}", chưa sẵn sàng để transcribe`,
      );
    }
    targets = [videoId];
  } else {
    // nhiều video chọn tay (UI): lặng lẽ bỏ video chưa tải/đã có transcript, không ném lỗi như khi chỉ định một video
    if (videoIds?.length) {
      const want = new Set(videoIds);
      targets = targets.filter((id) => want.has(id));
    }
    targets.sort((a, b) => (a < b ? 1 : -1));
    if (limit) targets = targets.slice(0, limit);
  }

  // Chốt chặn thứ hai, dựa vào đĩa chứ không chỉ state: state có thể bị xoá/sửa,
  // còn transcript.txt nằm đó là bằng chứng chắc chắn đã trả tiền cho video này rồi.
  if (!force) {
    const before = targets.length;
    const kept = [];
    for (const id of targets) {
      if (await hasTranscript(userId, id)) {
        // State lệch với đĩa — sửa lại state cho khớp thay vì để lần sau hỏi lại.
        markVideo(state, id, { status: STATUS.TRANSCRIBED });
        continue;
      }
      kept.push(id);
    }
    if (kept.length < before) {
      await queueSave(state);
      log.info(`bỏ qua ${before - kept.length} video đã có transcript (dùng --force để chạy lại)`);
    }
    targets = kept;
  }

  if (targets.length === 0) {
    log.info("không có video nào cần transcribe");
    return { ok: 0, failed: 0 };
  }

  if (force) log.warn(`--force: sẽ transcribe lại ${targets.length} video, tính tiền lại từ đầu`);

  const stt = resolveEngine(config.sttModel);
  await reportCost(userId, targets, [stt.model]);
  // Chỉ whisper-1 (openai) và Qwen-ASR trả timestamp. Các model transcribe khác của
  // OpenAI thì không — cảnh báo trước, vì thiếu mốc thời gian là bước dub mất chỗ căn.
  if (config.sttTimestamps.length > 0 && stt.engine === "openai" && stt.model !== "whisper-1") {
    log.warn(
      `model ${stt.model} KHÔNG hỗ trợ timestamp (chỉ whisper-1 có) — ` +
        `transcript sẽ không có mốc thời gian, bước dub không căn tiếng được. ` +
        `Đặt STT_MODEL=whisper-1 nếu cần timestamp.`,
    );
  }
  log.info(
    `${targets.length} video cần transcribe (model=${stt.engine}:${stt.model}, ` +
      `${config.sttConcurrency} luồng, tối đa ${config.sttRetryPasses} lượt, ` +
      `timestamp=${config.sttTimestamps.join("+") || "tắt"})`,
  );

  const total = targets.length;
  let ok = 0;
  let done = 0;
  let remaining = targets;

  // Nhiều lượt quét: mạng tới OpenAI chập chờn nên video lỗi ở lượt này thường chạy
  // được ở lượt sau. Chỉ bỏ cuộc sau khi đã quét hết số lượt cho phép.
  for (let pass = 1; pass <= config.sttRetryPasses && remaining.length > 0; pass += 1) {
    if (pass > 1) {
      log.info(`lượt ${pass}: thử lại ${remaining.length} video còn lỗi sau ${config.sttPassDelayMs}ms`);
      await sleep(config.sttPassDelayMs);
    }

    const stillFailing = [];
    await runPool(remaining, config.sttConcurrency, async (videoId) => {
      const dir = paths.videoDir(userId, videoId);
      try {
        const audioPath = await findAudioFile(dir, state.videos[videoId]?.audioFile);
        // Video quá dài để hạ mẫu/base64 local (vd. bản merge nhiều tập) có thể khai
        // báo sẵn 1 URL công khai (Drive, S3, ...) trong state — engine qwen dùng
        // thẳng URL đó qua file_urls của DashScope thay vì đọc file local, tránh trần
        // base64 10MB (xem [[douyind-downloader-aliyun-asr]]). File local vẫn dùng cho
        // enrichTranscript ở dưới.
        const transcribeInput = state.videos[videoId]?.remoteAudioUrl ?? audioPath;
        // Cache cả lượt nhận dạng: chỉnh thuật toán alignment rồi chạy lại `--force`
        // thì chỉ căn lại chứ không gọi API. Muốn nhận dạng lại thật thì xoá raw-*.json.
        const result = await cachedCall(path.join(dir, stt.cacheFile), () =>
          stt.transcribe(transcribeInput),
        );

        // Engine STT là KHUNG và cũng là nguồn text duy nhất. Diarize chỉ đắp nhãn
        // người nói vào khung đó — xem enrichTranscript().
        const enriched = result.hasTimestamps
          ? await enrichTranscript(dir, audioPath, result.segments, stt.engine)
          : null;

        // Hai file: .txt để đọc bằng mắt, .json giữ timestamp cho bước dub căn tiếng.
        await fs.writeFile(path.join(dir, "transcript.txt"), result.text, "utf8");
        if (result.hasTimestamps) {
          await fs.writeFile(
            path.join(dir, "transcript.json"),
            JSON.stringify(
              {
                videoId,
                model: `${stt.engine}:${stt.model}`,
                textModel: enriched?.textModel ?? null,
                diarizeModel: enriched?.diarizeModel ?? null,
                language: result.detectedLanguage,
                duration: result.duration,
                text: result.text,
                speakers: enriched?.speakers ?? [],
                segments: enriched?.segments ?? result.segments,
                turns: enriched?.turns ?? [],
                words: result.words,
              },
              null,
              2,
            ),
            "utf8",
          );
        }

        markVideo(state, videoId, {
          status: STATUS.TRANSCRIBED,
          sttModel: `${stt.engine}:${stt.model}`,
          hasTimestamps: result.hasTimestamps,
          speakers: enriched?.speakers ?? [],
          sttError: null,
          error: null,
        });
        await queueSave(state);

        ok += 1;
        done += 1;
        const suspect = state.videos[videoId]?.suspectBgm ? " (suspectBgm — có thể là rác)" : "";
        const stamps = result.hasTimestamps
          ? `, ${result.segments?.length ?? 0} segment/${result.words?.length ?? 0} từ`
          : ", KHÔNG có timestamp";
        const spk = enriched?.speakers?.length ? `, ${enriched.speakers.length} người nói` : "";
        log.info(`[${done}/${total}] ${videoId}: OK, ${result.text.length} ký tự${stamps}${spk}${suspect}`);
      } catch (err) {
        stillFailing.push(videoId);
        // APIConnectionError hay là vỏ bọc che mất lỗi thật: lần gọi đầu nhận 4xx/5xx,
        // các lần retry sau rớt kết nối, và thứ nổi lên là "Connection error". Gợi ý
        // sang `doctor` để lấy nguyên nhân thật thay vì đi chẩn đoán nhầm lỗi mạng.
        if (err.constructor?.name === "APIConnectionError") {
          err.message = `${err.message} (có thể đang che lỗi thật — chạy \`npm run doctor\`)`;
        }
        // Giữ nguyên status FETCHED chứ không đổi sang FAILED: lệnh này chỉ nhặt video
        // đang ở FETCHED, đổi status là tự khoá đường retry và bắt phải sửa tay state.
        // Audio vẫn còn nguyên trên đĩa nên chạy lại lệnh là thử lại được ngay.
        markVideo(state, videoId, { sttError: err.message });
        await queueSave(state);
        log.warn(`${videoId}: lỗi lượt ${pass} — ${err.message}`);
      }
    });

    remaining = stillFailing;
  }

  const failed = remaining.length;
  for (const videoId of remaining) log.error(`${videoId}: vẫn lỗi sau ${config.sttRetryPasses} lượt`);

  log.info(`xong: ${ok} OK, ${failed} lỗi` + (failed ? " — chạy lại lệnh để thử lại" : ""));
  return { ok, failed };
}

/**
 * Đường gọi OpenAI dùng cho lệnh `compare`.
 *
 * Bọc lại `transcribeFile` thay vì để stt-compare.js tự dựng client: giới hạn upload,
 * mồi từ vựng và nhánh timestamp riêng cho whisper-1 đã đúng ở đây rồi, chép sang
 * chỗ khác là mời hai đường lệch nhau.
 */
export async function openaiTranscribe(audioPath, model) {
  return transcribeFile(client(), audioPath, model);
}

export async function compareModels(userId, videoId, specs = config.sttCompareModels) {
  const audioPath = await findAudioFile(paths.videoDir(userId, videoId));
  await reportCost(
    userId,
    [videoId],
    specs.map((s) => parseSpec(s)).filter((s) => s.engine === "openai").map((s) => s.model),
  );
  return compareStt(userId, videoId, specs, { audioPath, openaiTranscribe });
}
