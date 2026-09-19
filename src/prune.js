import fs from "node:fs/promises";
import path from "node:path";

import { paths } from "./config.js";
import { createLogger } from "./logger.js";
import { loadState, saveState, STATUS } from "./state.js";

const log = createLogger("PRUNE");

/**
 * Dọn video của tác giả khác đã lỡ tải về.
 *
 * Bản `collect` đầu tiên quét cả trang nên nhặt luôn video ở khu vực gợi ý; lệnh này
 * đọc `meta.json` của những gì đã tải, đối chiếu `authorSecUid` với user_id, xoá
 * thư mục lạc và đánh dấu lại state. Video chưa tải (chưa có meta.json) thì không
 * kết luận được từ đĩa — cứ để bước `fetch` tự lọc bằng sec_uid.
 *
 * `dryRun` mặc định true: chạy để xem trước, thêm --apply mới thực sự xoá.
 */
export async function prune(userId, { dryRun = true } = {}) {
  const state = await loadState(userId);
  const userDir = paths.userDir(userId);

  let dirs = [];
  try {
    const entries = await fs.readdir(userDir, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const foreign = [];
  const unknown = [];

  for (const videoId of dirs) {
    const metaPath = path.join(userDir, videoId, "meta.json");
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    } catch {
      unknown.push(videoId);
      continue;
    }
    // meta.json của bản cũ chưa có authorSecUid — đối chiếu qua authorUid nếu cần.
    const secUid = meta.authorSecUid ?? null;
    if (secUid && secUid !== userId) {
      foreign.push({ videoId, nickname: meta.authorNickname ?? "?" });
    } else if (!secUid) {
      unknown.push(videoId);
    }
  }

  // Bản meta cũ không có sec_uid — suy ra uid của user từ chính các video hợp lệ.
  if (unknown.length > 0) {
    const uidCount = new Map();
    for (const videoId of dirs) {
      try {
        const meta = JSON.parse(await fs.readFile(path.join(userDir, videoId, "meta.json"), "utf8"));
        if (meta.authorUid) uidCount.set(meta.authorUid, (uidCount.get(meta.authorUid) ?? 0) + 1);
      } catch {
        /* bỏ qua thư mục không đọc được meta */
      }
    }
    const [ownerUid] = [...uidCount.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (ownerUid) {
      log.info(`suy ra uid của user = ${ownerUid} (xuất hiện nhiều nhất trong meta đã tải)`);
      for (const videoId of unknown) {
        try {
          const meta = JSON.parse(
            await fs.readFile(path.join(userDir, videoId, "meta.json"), "utf8"),
          );
          if (meta.authorUid && meta.authorUid !== ownerUid) {
            foreign.push({ videoId, nickname: meta.authorNickname ?? "?" });
          }
        } catch {
          /* không có meta thì không kết luận được — để fetch xử lý */
        }
      }
    }
  }

  if (foreign.length === 0) {
    log.info("không có video lạc nào trong dữ liệu đã tải");
  } else {
    console.log(`\n${foreign.length} video của tác giả khác:`);
    for (const f of foreign) console.log(`  ${f.videoId}  ${f.nickname}`);
  }

  if (dryRun) {
    console.log(
      `\nĐây mới là xem trước. Thêm --apply để xoá thư mục và đánh dấu ${STATUS.FOREIGN} trong state.`,
    );
    return { foreign: foreign.length, removed: 0 };
  }

  for (const { videoId } of foreign) {
    await fs.rm(path.join(userDir, videoId), { recursive: true, force: true });
    state.videos[videoId] = {
      status: STATUS.FOREIGN,
      error: null,
      updatedAt: new Date().toISOString(),
    };
  }
  await saveState(state);

  log.info(`đã xoá ${foreign.length} thư mục và đánh dấu ${STATUS.FOREIGN} trong state`);
  return { foreign: foreign.length, removed: foreign.length };
}
