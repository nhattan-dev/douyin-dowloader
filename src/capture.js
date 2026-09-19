import { logApiRequest, logApiResponse } from "./apiLog.js";
import { randomDelay } from "./browser.js";
import { config, DOUYIN_ORIGIN } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("CAPTURE");

// API detail của Douyin — nguồn đáng tin nhất để phân biệt audio/video,
// vì nó tách bạch `video.play_addr` và `music.play_url`.
const DETAIL_URL_RE = /\/aweme\/v1\/web\/aweme\/detail/i;
// Fallback: CDN media. `mime_type` trong query string KHÔNG đáng tin (xem CLAUDE.md)
// nên chỉ phân loại bằng Content-Type thật của response.
const MEDIA_HOST_RE = /douyinvod\.com|douyinstatic\.com|amemv\.com/i;

const firstUrl = (list) => (Array.isArray(list) && list.length ? list[0] : null);

/**
 * Liệt kê mọi aweme có trong payload.
 *
 * Trang video của Douyin hiển thị nhiều video cùng lúc (1 cái chính + một loạt
 * gợi ý, kiểu YouTube), nên trong một phiên có thể bay về metadata của vài video
 * khác nhau. Trả về cả danh sách để bên gọi tự lọc theo aweme_id, không được vơ
 * đại cái đến trước.
 */
function listAwemes(payload) {
  if (!payload || typeof payload !== "object") return [];
  const out = [];
  if (payload.aweme_detail) out.push(payload.aweme_detail);
  for (const key of ["aweme_details", "aweme_list"]) {
    if (Array.isArray(payload[key])) out.push(...payload[key]);
  }
  if (out.length === 0 && (payload.video || payload.music)) out.push(payload);
  return out.filter(Boolean);
}

/**
 * Chọn track audio nhẹ nhất.
 *
 * `video.bit_rate_audio` là track audio tách sẵn từ CHÍNH video (DASH, AAC ~48kbps,
 * ~1.2MB cho video 3.5 phút) — vừa nhẹ hơn `music.play_url` 4 lần, vừa luôn đúng
 * tiếng trong video nên không dính chuyện nhạc nền. Đây là nguồn ưu tiên.
 *
 * `music.play_url` chỉ còn là dự phòng: 192kbps stereo (~4.8MB), và là track
 * "dùng âm thanh này" nên có thể là nhạc nền chứ không phải giọng nói.
 */
function pickAudio(aweme) {
  const variants = (aweme?.video?.bit_rate_audio ?? [])
    .map((v) => v?.audio_meta)
    .filter((m) => m?.url_list?.main_url || m?.url_list?.backup_url)
    .sort((a, b) => (a.bitrate ?? Infinity) - (b.bitrate ?? Infinity));

  if (variants.length > 0) {
    const best = variants[0];
    return {
      audioUrl: best.url_list.main_url ?? best.url_list.backup_url,
      audioKind: "video-track",
      audioExt: ".m4a",
      audioBitrate: best.bitrate ?? null,
      audioExpectedBytes: best.size ?? null,
    };
  }

  const music = aweme?.music ?? {};
  const musicUrl = firstUrl(music.play_url?.url_list) ?? music.play_url?.uri ?? null;
  return musicUrl
    ? {
        audioUrl: musicUrl,
        audioKind: "music",
        audioExt: ".mp3",
        audioBitrate: null,
        audioExpectedBytes: null,
      }
    : { audioUrl: null, audioKind: null, audioExt: null, audioBitrate: null, audioExpectedBytes: null };
}

/**
 * Chọn biến thể video theo chất lượng mong muốn.
 *
 * `video.bit_rate` liệt kê ~22 mức, từ 540p ~7MB tới 1080p ~55MB. KHÔNG dùng
 * `video.play_addr` mặc định: nó trả về một mức tầm trung (1024x576, ~40MB) —
 * vừa không phải nét nhất vừa không phải nhẹ nhất, tức là tệ ở cả hai chiều.
 *
 * quality: "best" (bitrate cao nhất) | "worst" (thấp nhất)
 */
function pickVideo(aweme, quality = "best") {
  const variants = (aweme?.video?.bit_rate ?? [])
    .filter((v) => firstUrl(v?.play_addr?.url_list))
    .sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0));

  const chosen = quality === "worst" ? variants.at(-1) : variants[0];
  if (chosen) {
    return {
      videoUrl: firstUrl(chosen.play_addr.url_list),
      videoGear: chosen.gear_name ?? null,
      videoBitrate: chosen.bit_rate ?? null,
      videoExpectedBytes: chosen.play_addr.data_size ?? null,
      videoResolution:
        chosen.play_addr.width && chosen.play_addr.height
          ? `${chosen.play_addr.width}x${chosen.play_addr.height}`
          : null,
      videoVariants: variants.length,
    };
  }

  // Không có danh sách bitrate thì đành lấy link mặc định.
  const video = aweme?.video ?? {};
  const fallback =
    firstUrl(video.play_addr?.url_list) ??
    firstUrl(video.play_addr_h264?.url_list) ??
    firstUrl(video.play_addr_265?.url_list) ??
    null;
  return {
    videoUrl: fallback,
    videoGear: fallback ? "play_addr (mặc định)" : null,
    videoBitrate: null,
    videoExpectedBytes: video.play_addr?.data_size ?? null,
    videoResolution: null,
    videoVariants: 0,
  };
}

/**
 * Video này dùng giọng gốc của tác giả hay nhạc nền có sẵn?
 *
 * Quan trọng vì file "mp3" của Douyin là track "dùng âm thanh này" — nếu tác giả
 * chọn một sound có sẵn thì mp3 là nhạc nền, KHÔNG phải giọng nói (CLAUDE.md).
 *
 * Không xác định được → trả false (thiên về báo động thừa hơn bỏ sót).
 */
export function detectOriginalSound(aweme) {
  const music = aweme?.music ?? {};
  const author = aweme?.author ?? {};

  const ownerId = music.owner_id ?? music.ownerId;
  if (ownerId && author.uid && String(ownerId) === String(author.uid)) {
    return { isOriginalSound: true, reason: "music.owner_id === author.uid" };
  }

  for (const key of ["is_original", "is_original_sound"]) {
    if (typeof music[key] === "boolean") {
      return { isOriginalSound: music[key], reason: `music.${key}` };
    }
  }

  const title = music.title ?? "";
  const nickname = author.nickname ?? "";
  if (nickname && title.includes(nickname)) {
    return { isOriginalSound: true, reason: "music.title chứa author.nickname" };
  }
  if (/原声/.test(title)) {
    return { isOriginalSound: true, reason: "music.title chứa '原声'" };
  }

  return { isOriginalSound: false, reason: "không xác định được — mặc định coi là nhạc nền" };
}

/**
 * Bước [3a] + [3b]: mở trang video, bắt link media từ network.
 *
 * Link media có `expire=` (~1 giờ) nên không cache được — mỗi lần chạy phải lấy mới.
 */
export async function captureMedia(context, videoId, { keepRaw = false } = {}) {
  const page = await context.newPage();

  let aweme = null; // metadata của ĐÚNG video đang hỏi
  let seenOtherIds = 0; // đếm metadata của video khác lọt vào (gợi ý cùng trang)
  const mediaResponses = []; // fallback: các response CDN kèm content-type thật
  const pending = [];

  // Thoát ngay khi metadata về, thay vì đợi hết nhịp poll — nhân với cả trăm video
  // thì mấy trăm ms chờ thừa mỗi lượt là đáng kể.
  let onFound;
  const found = new Promise((resolve) => {
    onFound = resolve;
  });

  const onResponse = (res) => {
    const url = res.url();

    if (DETAIL_URL_RE.test(url)) {
      pending.push(
        res
          .json()
          .then((json) => {
            // API nội bộ của Douyin: request do chính trang phát ra nên ta chỉ bắt
            // được, không tự dựng — log URL + response để soát khi metadata về thiếu
            // field (link media hết hạn, đổi cấu trúc payload…).
            logApiRequest(log, { method: res.request().method(), url, headers: res.request().headers() });
            logApiResponse(log, { method: res.request().method(), url, status: res.status(), body: json });
            for (const candidate of listAwemes(json)) {
              // Chỉ nhận metadata khớp đúng aweme_id. Trang video hiển thị cả một
              // loạt video gợi ý nên vơ đại cái đến trước là tải nhầm video khác.
              if (String(candidate.aweme_id) === String(videoId)) {
                aweme ??= candidate;
                onFound();
              } else seenOtherIds += 1;
            }
          })
          .catch(() => {
            /* response không phải JSON hợp lệ — bỏ qua, còn nhánh fallback */
          }),
      );
      return;
    }

    if (MEDIA_HOST_RE.test(url)) {
      // Lọc bằng Content-Type ngay tại đây: các host này phục vụ cả CSS/JS của trang
      // (lf-douyin-pc-web.douyinstatic.com), giữ hết thì nhánh fallback bị nhiễu nặng.
      const contentType = res.headers()["content-type"] ?? "";
      if (!/^(audio|video)\//i.test(contentType)) return;
      mediaResponses.push({ url, contentType, status: res.status() });
    }
  };

  let timer = null;
  try {
    page.on("response", onResponse);

    // ĐỪNG chặn ảnh/font/media bằng page.route("**/*") để tiết kiệm băng thông: đã đo
    // trên chính pipeline này (6 video, mp4 bật) — chặn thì 2 OK/4 lỗi trong 114s, không
    // chặn thì 5 OK/1 lỗi trong 20s. Mọi request phải vòng qua Node làm chậm đúng cái
    // XHR metadata đang chờ, và số lượt hết giờ tăng vọt. Băng thông không phải cổ chai
    // ở đây; số video chạy song song mới là.
    await page.goto(`${DOUYIN_ORIGIN}/video/${videoId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // Chờ tới khi có metadata (hoặc đủ media response để fallback), tối đa captureTimeoutMs.
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, config.captureTimeoutMs);
    });
    await Promise.race([found, timeout]);
    await Promise.all(pending.splice(0));
  } finally {
    // Không clear thì timer neo event loop, tiến trình treo thêm tới captureTimeoutMs.
    if (timer) clearTimeout(timer);
    page.off("response", onResponse);
    await page.close();
  }

  const audio = pickAudio(aweme);
  const video = pickVideo(aweme, config.videoQuality);
  let source = aweme ? "api-detail" : null;

  // Fallback khi không bắt được metadata của đúng video này: phân loại bằng
  // Content-Type thật. Kém tin cậy hơn hẳn — không biết được tác giả lẫn nguồn audio.
  if (!audio.audioUrl) {
    const ok = mediaResponses.filter((r) => r.status < 400);
    const hit = ok.find((r) => r.contentType.startsWith("audio/"));
    if (hit) {
      audio.audioUrl = hit.url;
      audio.audioKind = "content-type";
      audio.audioExt = hit.contentType.includes("mpeg") ? ".mp3" : ".m4a";
    }
    video.videoUrl ??= ok.find((r) => r.contentType.startsWith("video/"))?.url ?? null;
    source ??= "content-type";
    log.warn(
      `${videoId}: không bắt được metadata của đúng video này` +
        (seenOtherIds ? ` (chỉ thấy ${seenOtherIds} video khác trên trang)` : ""),
    );
  }

  const sound = detectOriginalSound(aweme);

  return {
    videoId,
    awemeId: aweme?.aweme_id ?? null,
    ...audio,
    ...video,
    source,
    isOriginalSound: sound.isOriginalSound,
    soundReason: sound.reason,
    desc: aweme?.desc ?? null,
    duration: aweme?.duration ?? aweme?.video?.duration ?? null,
    authorUid: aweme?.author?.uid ?? null,
    authorSecUid: aweme?.author?.sec_uid ?? null,
    authorNickname: aweme?.author?.nickname ?? null,
    musicTitle: aweme?.music?.title ?? null,
    mediaResponses,
    raw: keepRaw ? aweme : undefined,
  };
}

/**
 * Lệnh `inspect`: dump nguyên JSON + danh sách URL/Content-Type bắt được.
 *
 * Chạy lệnh này TRƯỚC khi tin vào logic parse ở trên — tên field trong response
 * Douyin đổi theo thời gian, và đây là cách duy nhất để xác nhận shape thật thay
 * vì đoán. Cũng là công cụ debug đầu tiên khi pipeline bỗng ngừng bắt được link.
 */
export async function inspectVideo(context, videoId) {
  await randomDelay();
  const result = await captureMedia(context, videoId, { keepRaw: true });
  return result;
}
