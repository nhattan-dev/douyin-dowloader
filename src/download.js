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
 * Tải 1 URL về file bằng fetch thuần, không qua Playwright.
 *
 * Trước đây dùng `context.request.get` để thừa hưởng cookie của browser context
 * (tránh 403 do thiếu cookie/Referer trên CDN Douyin). Đo lại: tự dựng header
 * `Cookie` từ `context.cookies()` chụp MỘT LẦN rồi đóng hẳn browser vẫn tải được
 * (200, đúng bytes) — CDN chỉ đòi cookie/Referer/User-Agent đúng, không đòi
 * context Playwright phải còn sống. Nhờ vậy browser đóng được ngay sau khi bắt
 * xong link, không phải đợi tải file xong (xem fetchAll).
 */
export async function downloadTo(cookieHeader, url, destPath) {
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  let lastErr;
  for (let attempt = 1; attempt <= config.downloadRetries; attempt += 1) {
    const headers = { Referer: `${DOUYIN_ORIGIN}/`, "User-Agent": USER_AGENT, Cookie: cookieHeader };
    logApiRequest(log, { method: "GET", url, headers });
    const t0 = Date.now();
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
      const body = Buffer.from(await res.arrayBuffer());
      // Response là media nhị phân — log cỡ + header thật, không log nội dung. Header
      // `content-type` mới là thứ phân biệt mp3/mp4 (xem CLAUDE.md: `mime_type` trong
      // query string không đáng tin), nên nó phải nằm trong log.
      logApiResponse(log, {
        method: "GET",
        url,
        status: res.status,
        ms: Date.now() - t0,
        body: { headers: Object.fromEntries(res.headers), bytes: body.length },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (body.length === 0) throw new Error("body rỗng");

      await fs.writeFile(destPath, body);
      return { bytes: body.length, contentType: res.headers.get("content-type") ?? null };
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
 * Bắt metadata cho 1 video: lọc tác giả khác, đòi phải có `audioUrl`.
 *
 * Đây là phần DUY NHẤT cần browser (mở trang, đọc network response). Không tải
 * file ở đây — tải là việc của giai đoạn sau, sau khi browser đã đóng.
 */
async function captureOne(context, userId, videoId, state, prefix) {
  const media = await captureMedia(context, videoId);

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
    return { videoId, outcome: "foreign" };
  }

  if (!media.audioUrl) {
    throw new Error("không bắt được link audio (chạy `npm run inspect` để xem response thật)");
  }

  return { videoId, media };
}

/**
 * Tải audio (+ video) của 1 video đã capture, ghi meta + state.
 *
 * Không đụng tới browser/context nữa — chỉ cần `cookieHeader` chụp một lần trước
 * khi đóng browser (xem fetchAll). Trả nhãn kết quả thay vì tự cộng biến đếm, để
 * bên gọi tổng hợp — chạy song song thì mỗi lượt phải là một đơn vị độc lập.
 */
async function downloadOne(cookieHeader, userId, videoId, media, prefix) {
  const dir = paths.videoDir(userId, videoId);
  const audioPath = path.join(dir, `audio${media.audioExt}`);
  const { bytes, contentType } = await downloadTo(cookieHeader, media.audioUrl, audioPath);

  // Video gốc: cần cho bước ghép audio đã dub trở lại. Nặng gấp ~45 lần audio
  // nên tách thành tuỳ chọn riêng, và lỗi ở đây không làm hỏng cả video —
  // audio (thứ bước STT cần) đã tải xong rồi.
  let videoBytes = null;
  let videoFile = null;
  if (config.downloadVideo && media.videoUrl) {
    try {
      const videoPath = path.join(dir, "video.mp4");
      const res = await downloadTo(cookieHeader, media.videoUrl, videoPath);
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

  const videoNote = videoBytes
    ? ` + video ${(videoBytes / 1048576).toFixed(1)} MB ${media.videoResolution ?? ""}`.trimEnd()
    : "";
  log.info(`${prefix}: OK (audio ${(bytes / 1024).toFixed(0)} KB ${media.audioKind}${videoNote})`);

  return {
    outcome: "ok",
    audioBytes: bytes,
    videoBytes: videoBytes ?? 0,
    audioFile: path.basename(audioPath),
    audioKind: media.audioKind,
    isOriginalSound: media.isOriginalSound,
    suspectBgm,
  };
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
 * Chia làm HAI giai đoạn tách biệt, không interleave như trước:
 * 1. Capture (cần browser, trần `captureConcurrency`) — bắt link cho cả lô.
 * 2. Download (không cần browser, trần `fetchConcurrency`) — tải bằng fetch thuần
 *    + cookie snapshot chụp ngay sau khi capture xong.
 * Browser đóng ngay sau giai đoạn 1, không phải đợi hết giai đoạn 2 — phần lớn
 * thời gian của một lượt fetch là chờ mạng tải file (mp4 ~30-45 MB một kết nối),
 * giữ cả cửa sổ Chromium sống suốt quãng đó chỉ tốn RAM/lộ diện vô ích.
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
  const downloadWorkers = Math.max(1, concurrency ?? config.fetchConcurrency);
  const captureWorkers = Math.max(1, Math.min(config.captureConcurrency, downloadWorkers));

  log.info(
    `${targets.length}/${pending.length} video sẽ tải` +
      (limit ? ` (giới hạn --limit ${limit})` : "") +
      `, capture song song ${captureWorkers}, tải song song ${downloadWorkers}` +
      `, video gốc: ${config.downloadVideo ? `CÓ (${config.videoQuality})` : "KHÔNG"}`,
  );

  let ok = 0;
  let failed = 0;
  let foreign = 0;
  let audioTotal = 0;
  let videoTotal = 0;

  // Giai đoạn 1: bắt link — cần browser.
  const captured = new Array(targets.length).fill(null);
  await pool(targets, captureWorkers, async (videoId, i) => {
    const prefix = `[${i + 1}/${targets.length}] ${videoId}`;
    try {
      captured[i] = { ...(await captureOne(context, userId, videoId, state, prefix)), prefix };
    } catch (err) {
      failed += 1;
      markVideo(state, videoId, { status: STATUS.FAILED, error: err.message });
      await saveState(state);
      log.error(`${prefix}: ${err.message}`);
    }
    await randomDelay();
  });

  for (const c of captured) {
    if (c?.outcome === "foreign") foreign += 1;
  }

  // Chụp cookie MỘT LẦN rồi đóng browser hẳn — giai đoạn tải không cần Playwright
  // nữa (đã đo thật, xem comment ở downloadTo).
  const cookieHeader = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  await context.close();
  log.info(`đã bắt xong link cho ${targets.length} video — đóng browser, chuyển sang tải file qua HTTP`);

  // Giai đoạn 2: tải file — không cần browser, chỉ tốn băng thông.
  const toDownload = captured.filter((c) => c?.media);
  await pool(toDownload, downloadWorkers, async (item) => {
    try {
      const res = await downloadOne(cookieHeader, userId, item.videoId, item.media, item.prefix);
      markVideo(state, item.videoId, {
        status: STATUS.FETCHED,
        audioSource: res.audioKind,
        audioFile: res.audioFile,
        isOriginalSound: res.isOriginalSound,
        suspectBgm: res.suspectBgm,
        error: null,
      });
      await saveState(state);
      ok += 1;
      audioTotal += res.audioBytes;
      videoTotal += res.videoBytes;
    } catch (err) {
      failed += 1;
      markVideo(state, item.videoId, { status: STATUS.FAILED, error: err.message });
      await saveState(state);
      log.error(`${item.prefix}: ${err.message}`);
    }
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
