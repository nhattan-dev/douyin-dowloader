// So sánh gpt-4o-transcribe-diarize trên audio GỐC (thoại + nhạc nền + SFX trộn
// chung) so với audio đã TÁCH VOCAL bằng Demucs.
//
// KHÔNG PHẢI pipeline chính — pipeline chính (src/stt.js) luôn gửi audio gốc, đã
// thử tách vocal và bỏ vì Demucs thành bottleneck khi chạy batch hàng trăm video.
// Script này giữ lại làm công cụ đo tay khi cần, không tự chạy tự động. Xem README
// mục "Tách vocal trước khi gửi diarize — đã thử, bỏ".
//
// Lý do từng test: đo được diarize bỏ hẳn 42s cuối (18%) của video mẫu, đúng đoạn
// cao trào — nghi ngờ nhạc nền/SFX dày lên ở đoạn đó làm model tách giọng kém đi.
//
// Log đủ từng bước + request/response của lời gọi API để soát bằng mắt, không chỉ
// tin số tổng kết ở cuối.
//
// Yêu cầu cài sẵn:
//   - ffmpeg
//   - demucs: `pipx install demucs` rồi `pipx inject demucs numpy` nếu thiếu numpy.
//     Lần đầu chạy tự tải model htdemucs (~80MB) — cần mạng.
//
// Dùng:
//   node --env-file-if-exists=.env scripts/compare-diarize-bgm.js <userId> <videoId>
//
// Không đụng vào state.json/transcript.json của video — chỉ đọc audio gốc và ghi
// file phụ (_demucs/, raw-diarize.json nếu chưa có, raw-diarize-vocals.json) cạnh
// nó để cache, tránh gọi lại API nếu chạy lại script.

import fs from "node:fs/promises";
import path from "node:path";

import { config, paths } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { separateVocals as demucsSeparate } from "../src/vocals.js";

const log = createLogger("BGM-TEST");

/** Đóng khung 1 bước: in header, đo giờ, in xong-trong-Ns. */
async function stage(title, fn) {
  console.log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
  const t0 = Date.now();
  const result = await fn();
  log.info(`xong trong ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return result;
}

async function findAudio(dir) {
  const entries = await fs.readdir(dir);
  const hit = entries.find((f) => /^audio\.(m4a|mp3|mp4|wav|webm)$/i.test(f));
  if (!hit) throw new Error(`không tìm thấy audio trong ${dir}`);
  return path.join(dir, hit);
}

/**
 * Gọi gpt-4o-transcribe-diarize trực tiếp — CÙNG logic với `diarizeAudio()` của
 * src/diarize.js (đúng tên file theo đuôi thật, đúng field gửi đi), chỉ khác là
 * in đủ request/response ra console để soát bằng mắt thay vì chỉ log tóm tắt.
 */
async function diarize(audioPath) {
  if (!config.openaiApiKey) throw new Error("thiếu OPENAI_API_KEY — thêm vào .env");

  const fileBuf = await fs.readFile(audioPath);
  const model = config.sttDiarizeModel || "gpt-4o-transcribe-diarize";
  const prompt = config.sttKeywords;

  // --- log request (không in nội dung file — quá dài không đọc được) ---
  console.log("--- REQUEST ---");
  console.log(`POST https://api.openai.com/v1/audio/transcriptions`);
  console.log(
    JSON.stringify(
      {
        model,
        response_format: "diarized_json",
        chunking_strategy: "auto",
        prompt: prompt || undefined,
        file: { name: path.basename(audioPath), sizeBytes: fileBuf.length },
      },
      null,
      2,
    ),
  );

  const form = new FormData();
  form.append("file", new Blob([fileBuf]), path.basename(audioPath));
  form.append("model", model);
  form.append("response_format", "diarized_json");
  form.append("chunking_strategy", "auto");
  if (prompt) form.append("prompt", prompt);

  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiApiKey}` },
    body: form,
    signal: AbortSignal.timeout(config.sttTimeoutMs),
  });
  const body = await res.text();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n--- RESPONSE (HTTP ${res.status}, ${elapsed}s) ---`);
  if (!res.ok) {
    console.log(body.slice(0, 2000));
    throw new Error(`diarize HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = JSON.parse(body);
  console.log(JSON.stringify(json, null, 2));
  return json;
}

function summarize(json, label) {
  const segments = json.segments ?? [];
  const speakers = [...new Set(segments.map((s) => s.speaker))];
  const covered = segments.length ? Math.max(...segments.map((s) => s.end)) : 0;
  const duration = json.duration ?? 0;
  const pct = duration ? ((covered / duration) * 100).toFixed(1) : "?";
  console.log(`\n--- ${label} ---`);
  console.log(`  segment: ${segments.length}`);
  console.log(`  người nói: ${speakers.length} (${speakers.join(", ") || "—"})`);
  console.log(`  phủ: ${covered.toFixed(1)}s / ${duration.toFixed(1)}s (${pct}%)`);
  return { segments, speakers, covered, duration };
}

/** Độ chồng lấn thời gian giữa 2 segment, tính bằng giây. */
function overlap(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * So 2 danh sách segment theo CHỒNG LẤN THỜI GIAN, không theo chỉ số mảng — hai
 * bản có số segment khác nhau (30 vs 32) nên ghép theo index sẽ lệch pha nặng ở
 * nửa sau, tưởng nhầm segment không hề tương ứng là "lệch nhãn".
 */
function diffSegments(base, test) {
  console.log(`\n--- so theo mốc thời gian thật (khớp segment chồng lấn nhiều nhất) ---`);
  const usedTest = new Set();
  let matched = 0;
  let speakerDiff = 0;

  for (const a of base.segments) {
    let best = null;
    let bestOverlap = 0;
    test.segments.forEach((b, j) => {
      if (usedTest.has(j)) return;
      const ov = overlap(a, b);
      if (ov > bestOverlap) {
        bestOverlap = ov;
        best = { seg: b, index: j };
      }
    });
    if (!best || bestOverlap === 0) {
      console.log(`  GỐC [${a.start.toFixed(1)}-${a.end.toFixed(1)}] ${a.speaker} — KHÔNG có segment tương ứng ở VOCAL`);
      continue;
    }
    usedTest.add(best.index);
    matched += 1;
    const b = best.seg;
    if (a.speaker !== b.speaker) {
      speakerDiff += 1;
      console.log(
        `  [${a.start.toFixed(1)}-${a.end.toFixed(1)}] GỐC=${a.speaker} vs VOCAL=${b.speaker} ` +
          `(chồng lấn ${bestOverlap.toFixed(1)}s)`,
      );
    }
  }
  const newInVocal = test.segments.length - usedTest.size;
  console.log(
    `  khớp được ${matched}/${base.segments.length} segment GỐC, lệch nhãn ${speakerDiff}, ` +
      `VOCAL có thêm ${newInVocal} segment không tương ứng bên GỐC (đoạn trước đây bị bỏ trắng)`,
  );
}

async function main() {
  const [userId, videoId] = process.argv.slice(2);
  if (!userId || !videoId) {
    console.error("dùng: node --env-file-if-exists=.env scripts/compare-diarize-bgm.js <userId> <videoId>");
    process.exit(1);
  }

  const dir = paths.videoDir(userId, videoId);
  const audioPath = await findAudio(dir);

  const cacheOrig = path.join(dir, "raw-diarize.json");
  const cacheVocals = path.join(dir, "raw-diarize-vocals.json");

  log.info(`video: ${videoId}`);
  log.info(`audio gốc: ${audioPath}`);
  log.info(`model diarize: ${config.sttDiarizeModel || "gpt-4o-transcribe-diarize"}`);

  const origJson = await stage("BƯỚC 1 — diarize audio GỐC", async () => {
    try {
      const cached = JSON.parse(await fs.readFile(cacheOrig, "utf8"));
      log.info(`dùng cache ${cacheOrig} — KHÔNG gọi API`);
      console.log(JSON.stringify(cached, null, 2));
      return cached;
    } catch {
      const json = await diarize(audioPath);
      await fs.writeFile(cacheOrig, JSON.stringify(json, null, 2), "utf8");
      return json;
    }
  });

  const vocalsPath = await stage("BƯỚC 2 — tách vocal bằng Demucs", async () => {
    if (await fs.access(cacheVocals).then(() => true).catch(() => false)) {
      log.info(`raw-diarize-vocals.json đã có sẵn — bỏ qua bước tách (không cần vocals.wav nữa)`);
      return null;
    }
    return demucsSeparate(audioPath, dir);
  });

  const vocalsJson = await stage("BƯỚC 3 — diarize audio ĐÃ TÁCH VOCAL", async () => {
    try {
      const cached = JSON.parse(await fs.readFile(cacheVocals, "utf8"));
      log.info(`dùng cache ${cacheVocals} — KHÔNG gọi API`);
      console.log(JSON.stringify(cached, null, 2));
      return cached;
    } catch {
      const json = await diarize(vocalsPath);
      await fs.writeFile(cacheVocals, JSON.stringify(json, null, 2), "utf8");
      return json;
    }
  });

  await stage("BƯỚC 4 — so sánh", async () => {
    const base = summarize(origJson, "GỐC (thoại + nhạc nền)");
    const test = summarize(vocalsJson, "ĐÃ TÁCH VOCAL");
    diffSegments(base, test);

    const gain = test.covered - base.covered;
    console.log(
      `\n${gain > 1 ? "✅ tách vocal PHỦ NHIỀU HƠN" : gain < -1 ? "❌ tách vocal PHỦ ÍT HƠN" : "≈ không đổi rõ rệt"} ` +
        `(${base.covered.toFixed(1)}s → ${test.covered.toFixed(1)}s, ${gain >= 0 ? "+" : ""}${gain.toFixed(1)}s)`,
    );
  });
}

main().catch((err) => {
  console.error("lỗi:", err.message);
  process.exit(1);
});
