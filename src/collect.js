import { randomDelay } from "./browser.js";
import { config, DOUYIN_ORIGIN } from "./config.js";
import { createLogger } from "./logger.js";
import { markVideo, saveState, STATUS } from "./state.js";

const log = createLogger("COLLECT");

const VIDEO_ID_RE = /\/video\/(\d+)/;

// Trang user không chỉ có tác phẩm của user — footer còn có khu vực gợi ý. Đo bằng
// `npm run probe`: cả trang 44 link = 36 trong user-post-list + 8 trong page-footer.
// Quét cả trang là nhặt luôn 8 video của tác giả khác, nên phải giới hạn container.
const POST_LIST_SELECTORS = [
  "[data-e2e='user-post-list']",
  "[data-e2e='user-detail'] [data-e2e='scroll-list']",
];

// Số tác phẩm Douyin tự khai ở tab 作品 — dùng làm mốc đối chiếu xem đã scroll hết chưa.
const TAB_COUNT_SELECTOR = "[data-e2e='user-tab-count']";

/**
 * Bước [1] + [2]: scroll trang user, quét DOM lấy video ID, lọc ra ID mới.
 *
 * Quét theo href thay vì bắt response API nội bộ — đơn giản hơn và ít vỡ hơn
 * khi Douyin đổi cấu trúc API (quyết định đã chốt trong CLAUDE.md).
 */
/** Thông tin kèm theo từ một mục aweme_list — để chọn video trước khi tải. */
function pickInfo(a) {
  const mix = a.mix_info;
  return {
    desc: a.desc ?? null,
    duration: Math.round((a.video?.duration ?? a.duration ?? 0) / 1000) || null,
    createTime: a.create_time ? new Date(a.create_time * 1000).toISOString() : null,
    cover: a.video?.cover?.url_list?.[0] ?? null,
    plays: a.statistics?.play_count ?? null,
    likes: a.statistics?.digg_count ?? null,
    // 合集 = series tác giả tự gom, kèm số tập — bằng chứng series mạnh nhất có sẵn
    mix: mix?.mix_id
      ? { id: String(mix.mix_id), name: mix.mix_name ?? null, ep: mix.statis?.current_episode ?? null }
      : null,
    author: a.author?.nickname ?? null,
  };
}

export async function collect(context, userId, state) {
  const page = await context.newPage();
  const seen = new Set();

  // ID vẫn lấy từ DOM (quyết định đã chốt). Tiêu đề/thời lượng/合集 bắt thêm từ response
  // danh sách tác phẩm trong lúc scroll — chỉ để người dùng chọn video trước khi tải;
  // bắt hụt (vd. lô đầu render sẵn trong HTML) thì thiếu tiêu đề, không hỏng gì.
  const info = {};
  const domText = {};
  page.on("response", async (res) => {
    if (!res.url().includes("/aweme/v1/web/aweme/post/")) return;
    try {
      const j = await res.json();
      for (const a of j.aweme_list || []) info[String(a.aweme_id)] = pickInfo(a);
    } catch { /* body không phải JSON hoặc trang đã đóng */ }
  });

  try {
    const url = `${DOUYIN_ORIGIN}/user/${userId}`;
    log.info(`mở ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Chờ danh sách video render xong rồi mới quét. Nếu vào thẳng vòng lặp thì
    // lần quét đầu ra 0 link, 3 vòng idle trôi qua trong vài giây và tưởng nhầm
    // là user không có video. Khoảng chờ này cũng là lúc xử lý captcha/đăng nhập.
    log.info(
      `chờ danh sách video hiện ra (tối đa ${config.pageReadyTimeoutMs / 1000}s) — ` +
        `nếu gặp captcha/đăng nhập thì xử lý ngay trên cửa sổ trình duyệt`,
    );
    try {
      await page.waitForSelector("a[href*='/video/']", { timeout: config.pageReadyTimeoutMs });
    } catch {
      throw new Error(
        "không thấy video nào trên trang sau khi chờ. Thường là do chưa đăng nhập " +
          "hoặc bị chặn — chạy `npm run login` để đăng nhập một lần rồi thử lại " +
          "(có thể tăng PAGE_READY_TIMEOUT_MS trong .env).",
      );
    }
    await randomDelay();

    // Chốt container danh sách tác phẩm. Không có thì vẫn chạy được nhưng sẽ nhặt
    // cả video gợi ý — cảnh báo to để biết mà kiểm tra lại selector.
    let listSelector = null;
    for (const candidate of POST_LIST_SELECTORS) {
      if (await page.$(candidate)) {
        listSelector = candidate;
        break;
      }
    }
    if (listSelector) {
      const [inside, all] = await Promise.all([
        page.$$eval(`${listSelector} a[href*='/video/']`, (els) => els.length),
        page.$$eval("a[href*='/video/']", (els) => els.length),
      ]);
      log.info(`dùng container ${listSelector} — ${inside}/${all} link nằm trong danh sách tác phẩm`);
    } else {
      log.warn(
        "không tìm thấy container danh sách tác phẩm — quét cả trang, có thể nhặt " +
          "nhầm video gợi ý. Bước fetch vẫn lọc lại bằng sec_uid nên không tải nhầm, " +
          "nhưng nên kiểm tra lại POST_LIST_SELECTORS trong src/collect.js.",
      );
    }
    const linkSelector = listSelector ? `${listSelector} a[href*='/video/']` : "a[href*='/video/']";

    // Douyin tự khai số tác phẩm ở tab 作品 — mốc để biết đã scroll hết hay chưa.
    const expected = await page
      .$eval(TAB_COUNT_SELECTOR, (el) => Number.parseInt(el.textContent.replace(/\D/g, ""), 10))
      .catch(() => null);
    if (expected) log.info(`tab 作品 khai ${expected} tác phẩm`);

    const scanLinks = async () => {
      const links = await page.$$eval(linkSelector, (els) => els.map((el) => [
        el.getAttribute("href"),
        (el.querySelector("img")?.getAttribute("alt") || el.textContent || "").trim().slice(0, 200),
      ]));
      for (const [href, text] of links) {
        const m = href?.match(VIDEO_ID_RE);
        if (!m) continue;
        seen.add(m[1]);
        if (text) domText[m[1]] = text;
      }
      return seen.size;
    };

    let idleRounds = 0;
    let round = 0;
    await scanLinks();

    while (idleRounds < config.scrollIdleRounds && round < config.scrollMaxRounds) {
      round += 1;
      const before = seen.size;

      // Kéo item cuối vào tầm nhìn là cách trigger infinite scroll ăn chắc nhất:
      // đúng cả khi trang cuộn bằng window lẫn khi danh sách nằm trong div cuộn riêng.
      // Kèm thêm một nhịp wheel với con trỏ đặt giữa màn hình cho giống thao tác thật.
      await page.$$eval(linkSelector, (els) =>
        els.at(-1)?.scrollIntoView({ block: "end", behavior: "instant" }),
      );
      const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      await page.mouse.wheel(0, viewport.height * 0.9);

      // Chờ tới khi có link mới, chứ không chờ cứng một nhịp ngắn rồi kết luận là hết.
      // Lazy-load của Douyin mất vài giây, delay 0.8–2.5s trước đây quá ngắn nên
      // vòng lặp thoát sớm khi mới thấy 36/122 video.
      const deadline = Date.now() + config.scrollLoadTimeoutMs;
      while (Date.now() < deadline) {
        await randomDelay();
        if ((await scanLinks()) > before) break;
      }

      if (seen.size === before) {
        idleRounds += 1;
        log.info(
          `vòng ${round}: không có ID mới (${idleRounds}/${config.scrollIdleRounds}) — ${seen.size} video`,
        );
      } else {
        idleRounds = 0;
        log.info(`vòng ${round}: ${seen.size}${expected ? `/${expected}` : ""} video ID`);
      }
    }

    if (expected && seen.size < expected) {
      log.warn(
        `mới lấy được ${seen.size}/${expected} tác phẩm — trang chưa load hết. ` +
          `Thử tăng SCROLL_IDLE_ROUNDS hoặc SCROLL_LOAD_TIMEOUT_MS trong .env.`,
      );
    }

    if (round >= config.scrollMaxRounds) {
      log.warn(`chạm trần ${config.scrollMaxRounds} vòng scroll — có thể chưa lấy hết video`);
    }
  } finally {
    await page.close();
  }

  // Chỉ ID chưa từng có trong state mới được đánh dấu collected → đây là bước lọc "video mới".
  // seenAt = lượt quét gần nhất còn thấy video trên trang; video không mang mốc của lượt mới nhất là đã bị ẩn/xoá
  const now = new Date().toISOString();
  let added = 0;
  for (const videoId of seen) {
    const old = state.videos[videoId];
    // API thắng chữ DOM; chữ DOM chỉ lấp chỗ chưa có tiêu đề
    const extra = info[videoId] ?? (domText[videoId] && !old?.info?.desc ? { desc: domText[videoId] } : null);
    if (old) {
      if (extra) old.info = { ...old.info, ...extra };
      old.seenAt = now;
      continue;
    }
    markVideo(state, videoId, { status: STATUS.COLLECTED, error: null, seenAt: now, ...(extra ? { info: extra } : {}) });
    added += 1;
  }
  const author = Object.values(info).find((x) => x.author)?.author;
  if (author) state.author = author;

  state.lastCollectedAt = now;
  await saveState(state);

  log.info(`tổng ${seen.size} video trên trang, ${added} video mới, state có ${Object.keys(state.videos).length}`
    + ` — có tiêu đề từ API ${[...seen].filter((id) => info[id]).length}/${seen.size}`);
  return { total: seen.size, added };
}
