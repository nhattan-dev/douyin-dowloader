import fs from "node:fs/promises";
import path from "node:path";

import { logApiRequest, logApiResponse, logApiError } from "./apiLog.js";
import { randomDelay, sleep } from "./browser.js";
import { captureMedia } from "./capture.js";
import { config, DOUYIN_ORIGIN, paths, USER_AGENT } from "./config.js";
import { createLogger } from "./logger.js";
import { markVideo, saveState, STATUS, videosByStatus } from "./state.js";

const log = createLogger("FETCH");

/**
 * Tải 1 URL về file.
 *
 * Dùng APIRequestContext của Playwright (`context.request`) chứ không phải fetch
 * trần: nó thừa hưởng cookie của browser context, nên tránh được 403 do thiếu
 * cookie/Referer trên CDN của Douyin.
 */
export async function downloadTo(context, url, destPath) {
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  let lastErr;
  for (let attempt = 1; attempt <= config.downloadRetries; attempt += 1) {
    const headers = { Referer: `${DOUYIN_ORIGIN}/`, "User-Agent": USER_AGENT };
    logApiRequest(log, { method: "GET", url, headers });
    const t0 = Date.now();
    try {
      const res = await context.request.get(url, { headers, timeout: 120_000 });

      const body = await res.body();
      // Response là media nhị phân — log cỡ + header thật, không log nội dung. Header
      // `content-type` mới là thứ phân biệt mp3/mp4 (xem CLAUDE.md: `mime_type` trong
      // query string không đáng tin), nên nó phải nằm trong log.
      logApiResponse(log, {
        method: "GET",
        url,
        status: res.status(),
        ms: Date.now() - t0,
        body: { headers: res.headers(), bytes: body.length },
      });
      if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
      if (body.length === 0) throw new Error("body rỗng");

      await fs.writeFile(destPath, body);
      return { bytes: body.length, contentType: res.headers()["content-type"] ?? null };
    } catch (err) {
      logApiError(log, { method: "GET", url, ms: Date.now() - t0, error: err });
      lastErr = err;
      const wait = 1000 * 2 ** (attempt - 1);
      log.warn(`tải lỗi (lần ${attempt}/${config.downloadRetries}): ${err.message} — chờ ${wait}ms`);
      if (attempt < config.downloadRetries) await sleep(wait);
    }
  }
  throw new Error(`tải thất bại sau ${config.downloadRetries} lần: ${lastErr?.message}`, {
    cause: lastErr,
  });
}

/**
 * Chạy `fn` trên từng phần tử, tối đa `limit` việc cùng lúc.
 *
 * Không dùng `Promise.all` trên cả mảng: 200 video sẽ mở 200 trang Chromium và 200
 * kết nối một lúc. Worker tự bốc việc kế tiếp nên video ngắn không phải chờ video dài
 * cùng lô — khác hẳn kiểu chia mảng thành các chunk cố định.
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

/**
 * Trần riêng cho một loại tài nguyên bên trong pool.
 *
 * Cần vì hai nửa của một lượt fetch tốn thứ khác nhau: mở trang Douyin tốn RAM và dễ
 * bị soi, còn tải file chỉ tốn băng thông. Không có cái này thì phải hạ cả pool xuống
 * theo giới hạn của nửa nặng hơn, tức là bỏ phí băng thông ở nửa còn lại.
 */
function createSemaphore(limit) {
  let active = 0;
  const waiting = [];

  return async function withSlot(fn) {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      // Chuyển thẳng chỗ cho người đang chờ (active giữ nguyên), tránh khe hở để
      // một luồng khác chen vào giữa lúc nhả và lúc cấp lại.
      if (next) next();
      else active -= 1;
    }
  };
}

/**
 * Tải trọn 1 video: bắt link → tải audio (+ video) → ghi meta + state.
 *
 * Trả về nhãn kết quả thay vì tự cộng biến đếm, để bên gọi tổng hợp — chạy song song
 * thì mỗi lượt phải là một đơn vị độc lập, không đụng vào trạng thái chung giữa chừng.
 */
async function fetchOne(context, userId, videoId, state, prefix, capture) {
  const media = await capture(() => captureMedia(context, videoId));

  // Chặn TRƯỚC khi tải: video của tác giả khác thì bỏ hẳn, không tính là lỗi
  // và không retry ở lần chạy sau.
  if (media.authorSecUid && media.authorSecUid !== userId) {
    markVideo(state, videoId, {
      status: STATUS.FOREIGN,
      authorNickname: media.authorNickname,
      error: null,
    });
    await saveState(state);
    log.info(`${prefix}: bỏ qua — của "${media.authorNickname}", không phải user này`);
    return { outcome: "foreign", audioBytes: 0, videoBytes: 0 };
  }

  if (!media.audioUrl) {
    throw new Error("không bắt được link audio (chạy `npm run inspect` để xem response thật)");
  }

  const dir = paths.videoDir(userId, videoId);
  const audioPath = path.join(dir, `audio${media.audioExt}`);
  const { bytes, contentType } = await downloadTo(context, media.audioUrl, audioPath);

  // Video gốc: cần cho bước ghép audio đã dub trở lại. Nặng gấp ~45 lần audio
  // nên tách thành tuỳ chọn riêng, và lỗi ở đây không làm hỏng cả video —
  // audio (thứ bước STT cần) đã tải xong rồi.
  let videoBytes = null;
  let videoFile = null;
  if (config.downloadVideo && media.videoUrl) {
    try {
      const videoPath = path.join(dir, "video.mp4");
      const res = await downloadTo(context, media.videoUrl, videoPath);
      videoBytes = res.bytes;
      videoFile = "video.mp4";
    } catch (err) {
      log.warn(`${prefix}: tải video lỗi (audio vẫn OK): ${err.message}`);
    }
  } else if (config.downloadVideo && !media.videoUrl) {
    log.warn(`${prefix}: không bắt được link video (audio vẫn OK)`);
  }

  const suspectBgm = media.audioKind === "music" && !media.isOriginalSound;
  if (suspectBgm) {
    log.warn(
      `${prefix}: phải dùng track "music" và nghi là nhạc nền (${media.soundReason}) — ` +
        `đánh dấu suspectBgm, transcript có thể là rác`,
    );
  }

  const meta = {
    videoId,
    userId,
    desc: media.desc,
    duration: media.duration,
    authorUid: media.authorUid,
    authorSecUid: media.authorSecUid,
    authorNickname: media.authorNickname,
    musicTitle: media.musicTitle,
    isOriginalSound: media.isOriginalSound,
    soundReason: media.soundReason,
    suspectBgm,
    audioSource: media.audioKind,
    audioBitrate: media.audioBitrate,
    metadataSource: media.source,
    audioFile: path.basename(audioPath),
    audioBytes: bytes,
    audioContentType: contentType,
    videoFile,
    videoBytes,
    videoGear: media.videoGear,
    videoBitrate: media.videoBitrate,
    videoResolution: media.videoResolution,
    // Link có expire= nên không dùng lại được — giữ chỉ để debug trong phiên.
    capturedAudioUrl: media.audioUrl,
    capturedVideoUrl: media.videoUrl,
    fetchedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

  markVideo(state, videoId, {
    status: STATUS.FETCHED,
    audioSource: media.audioKind,
    audioFile: path.basename(audioPath),
    isOriginalSound: media.isOriginalSound,
    suspectBgm,
    error: null,
  });
  await saveState(state);

  const videoNote = videoBytes
    ? ` + video ${(videoBytes / 1048576).toFixed(1)} MB ${media.videoResolution ?? ""}`.trimEnd()
    : "";
  log.info(`${prefix}: OK (audio ${(bytes / 1024).toFixed(0)} KB ${media.audioKind}${videoNote})`);

  return { outcome: "ok", audioBytes: bytes, videoBytes: videoBytes ?? 0 };
}

/**
 * Bước [3]: với mỗi video chưa tải — bắt link rồi tải audio.
 *
 * Nguồn audio là track tách sẵn từ chính video (`video.bit_rate_audio`, AAC ~48kbps),
 * nên luôn đúng tiếng trong video và nhẹ hơn track "music" khoảng 4 lần. Nhánh
 * fallback tải mp4 + ffmpeg vì thế không còn cần thiết (xem README).
 *
 * `userId` truyền vào chính là `sec_uid` — dùng để loại video của tác giả khác lọt
 * vào danh sách từ khu vực gợi ý của trang.
 *
 * Chạy song song `config.fetchConcurrency` video: phần lớn thời gian mỗi lượt là chờ
 * mạng (mp4 ~30-45 MB trên MỘT kết nối, CDN Douyin bóp tốc độ từng kết nối chứ không
 * bóp tổng), nên xếp hàng tuần tự là bỏ trống băng thông gần như suốt.
 */
export async function fetchAll(context, userId, state, { limit = null, concurrency = null, videoIds = null } = {}) {
  let pending = videosByStatus(state, [STATUS.COLLECTED, STATUS.FAILED]);
  // Chọn tay từng video (UI): chỉ tải những video được chọn mà còn chưa tải xong.
  if (videoIds?.length) {
    const skipped = videoIds.filter((id) => !pending.includes(id));
    if (skipped.length) log.info(`bỏ qua ${skipped.length} video đã tải rồi hoặc không có trong state`);
    const want = new Set(videoIds);
    pending = pending.filter((id) => want.has(id));
  }
  if (pending.length === 0) {
    log.info("không có video nào cần tải");
    return { ok: 0, failed: 0, foreign: 0 };
  }

  // Video mới nhất trước — chạy thử với --limit thì lấy được nội dung đang thời sự,
  // và các lần chạy sau cứ thế lấn dần xuống dưới.
  pending.sort((a, b) => (a < b ? 1 : -1));
  const targets = limit ? pending.slice(0, limit) : pending;
  const workers = Math.max(1, concurrency ?? config.fetchConcurrency);
  const capture = createSemaphore(Math.max(1, Math.min(config.captureConcurrency, workers)));

  log.info(
    `${targets.length}/${pending.length} video sẽ tải` +
      (limit ? ` (giới hạn --limit ${limit})` : "") +
      `, song song ${workers} (capture ${Math.min(config.captureConcurrency, workers)})` +
      `, video gốc: ${config.downloadVideo ? `CÓ (${config.videoQuality})` : "KHÔNG"}`,
  );
  let ok = 0;
  let failed = 0;
  let foreign = 0;
  let audioTotal = 0;
  let videoTotal = 0;

  await pool(targets, workers, async (videoId, i) => {
    const prefix = `[${i + 1}/${targets.length}] ${videoId}`;
    try {
      const res = await fetchOne(context, userId, videoId, state, prefix, capture);
      if (res.outcome === "foreign") foreign += 1;
      else {
        ok += 1;
        audioTotal += res.audioBytes;
        videoTotal += res.videoBytes;
      }
    } catch (err) {
      failed += 1;
      markVideo(state, videoId, { status: STATUS.FAILED, error: err.message });
      await saveState(state);
      log.error(`${prefix}: ${err.message}`);
    }

    await randomDelay();
  });

  const mb = (n) => (n / 1048576).toFixed(0);
  log.info(
    `xong: ${ok} OK, ${failed} lỗi, ${foreign} bỏ qua (tác giả khác) — ` +
      `audio ${mb(audioTotal)} MB` +
      (videoTotal ? ` + video ${mb(videoTotal)} MB` : ""),
  );
  if (ok > 0) {
    const remaining = pending.length - targets.length;
    if (remaining > 0) {
      const perVideo = (audioTotal + videoTotal) / ok;
      log.info(
        `còn ${remaining} video chưa tải, ước tính thêm ~${mb(perVideo * remaining)} MB. ` +
          `Chạy lại lệnh này để tải tiếp.`,
      );
    }
  }
  return { ok, failed, foreign };
}
