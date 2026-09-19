import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { openContext, waitForEnter } from "./browser.js";
import { inspectVideo } from "./capture.js";
import { collect } from "./collect.js";
import { config, DOUYIN_ORIGIN, paths } from "./config.js";
import { doctor } from "./doctor.js";
import { fetchAll } from "./download.js";
import { probeUserPage } from "./probe.js";
import { reviewSpeakers } from "./speakers.js";
import { probeTranslatePage } from "./probeTranslate.js";
import { prune } from "./prune.js";
import { compareModels, sttAll } from "./stt.js";
import { compareProviders, translateAll } from "./translate.js";
import { resolveProvider } from "./translators/index.js";
import { countByStatus, loadState } from "./state.js";

const USAGE = `
Douyin scraper → audio → STT

  npm run login                          Mở browser, đăng nhập thủ công, Enter để lưu phiên
  npm run doctor                         Chẩn đoán kết nối tới OpenAI (403 vùng? bị chặn? key sai?)
  npm run collect -- <user_id>            Quét trang user, lấy danh sách video ID mới
  npm run fetch   -- <user_id> [video_id...] [--limit N] [--concurrency N]
                                         Tải audio (+ video) cho video mới, mới nhất trước.
                                         Có video_id thì chỉ tải những video đó.
                                         Mặc định chạy song song FETCH_CONCURRENCY video
  npm run stt     -- <user_id> [video_id...] [--limit N] [--force]
                                         Transcribe audio đã tải. Bỏ qua video đã có transcript
                                         (tránh trả tiền hai lần); --force để chạy lại có chủ đích
  npm run review-speakers -- <user_id> [video_id]
                                         Soát các nhãn người nói do LLM suy ra
  npm run translate -- <user_id> [video_id] [--limit N] [--force] [--provider X]
                      [--no-protect] [--no-glossary]
                                         Dịch transcript theo segment, giữ timestamp.
                                         --no-protect: không bọc thuật ngữ bằng
                                         placeholder, vẫn gửi bảng thuật ngữ vào
                                         prompt (= GLOSSARY_PROTECT=false)
                                         --no-glossary: bỏ hẳn glossary, model không
                                         nhận thuật ngữ nào (= GLOSSARY=false)
  npm run translate-compare -- <user_id> <video_id>
                                         In bản dịch của các provider cạnh nhau
  npm run all     -- <user_id> [--limit N] collect → fetch → stt → translate
  npm run status  -- <user_id>            Thống kê state
  npm run probe   -- <user_id>            Khảo sát DOM trang user, tìm container danh sách tác phẩm
  npm run prune   -- <user_id> [--apply]  Xoá video của tác giả khác đã lỡ tải (mặc định chỉ xem trước)
  npm run inspect -- <video_id>           Dump JSON/URL bắt được của 1 video (khảo sát + debug)
  npm run compare -- <user_id> <video_id>
                                         So sánh các engine STT trên cùng file audio: bảng
                                         điểm + diff đúng những chỗ nghe khác nhau.
                                         Engine chọn bằng STT_COMPARE_MODELS, cú pháp
                                         dạng "engine:model" (openai | qwen | siliconflow)

Cấu hình qua .env — xem .env.example.
`.trim();

async function withBrowser(fn) {
  const context = await openContext();
  try {
    return await fn(context);
  } finally {
    await context.close();
  }
}

/**
 * Mở browser và đứng yên cho tới khi bấm Enter.
 *
 * Các lệnh khác chạy theo nhịp của script nên không đủ thời gian đăng nhập thủ công.
 * Lệnh này chỉ để làm việc đó một lần — cookie lưu trong .browser-profile/ và mọi
 * lệnh sau dùng lại.
 */
async function cmdLogin() {
  return withBrowser(async (context) => {
    const page = await context.newPage();
    await page.goto(DOUYIN_ORIGIN, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForEnter(
      "Đăng nhập Douyin trên cửa sổ trình duyệt vừa mở.\n" +
        "Xong xuôi thì quay lại đây bấm Enter để lưu phiên và đóng browser...",
    );
    console.log(`Đã lưu phiên vào ${config.browserProfileDir}`);
  });
}

async function cmdCollect(userId) {
  const state = await loadState(userId);
  return withBrowser((context) => collect(context, userId, state));
}

async function cmdFetch(userId, limit, concurrency = null, videoIds = null) {
  const state = await loadState(userId);
  return withBrowser((context) => fetchAll(context, userId, state, { limit, concurrency, videoIds }));
}

async function cmdStt(userId, { videoId = null, videoIds = null, limit = null, force = false } = {}) {
  const state = await loadState(userId);
  return sttAll(userId, state, { videoId, videoIds, limit, force });
}

/**
 * Chỉ mở browser khi provider thực sự cần — google-free và openai đi thẳng qua
 * HTTP, bật Chromium lên cho chúng là phí và còn chậm.
 */
async function cmdTranslate(
  userId,
  { videoId = null, limit = null, force = false, providerName = null, glossary } = {},
) {
  const state = await loadState(userId);
  const provider = await resolveProvider(providerName ?? config.translateProvider);
  const run = (context) =>
    translateAll(userId, state, { videoId, limit, force, context, providerName, glossary });
  return provider.needsBrowser ? withBrowser(run) : run(null);
}

async function cmdTranslateCompare(userId, videoId, names) {
  const providers = await Promise.all(names.map((n) => resolveProvider(n).catch(() => null)));
  const anyBrowser = providers.some((p) => p?.needsBrowser);
  const run = (context) => compareProviders(userId, videoId, names, context);
  return anyBrowser ? withBrowser(run) : run(null);
}

async function cmdAll(userId, limit, concurrency = null) {
  // Mỗi bước load lại state từ đĩa nên chạy riêng lẻ hay chạy `all` đều tương đương.
  await cmdCollect(userId);
  await cmdFetch(userId, limit, concurrency);
  await cmdStt(userId, { limit });
  await cmdTranslate(userId, { limit });
}

async function cmdStatus(userId) {
  const state = await loadState(userId);
  const counts = countByStatus(state);
  const total = Object.keys(state.videos).length;
  const suspect = Object.values(state.videos).filter((v) => v.suspectBgm).length;

  console.log(`user_id      : ${userId}`);
  console.log(`tổng video   : ${total}`);
  console.log(`lần quét cuối: ${state.lastCollectedAt ?? "chưa quét"}`);
  for (const [status, n] of Object.entries(counts).sort()) {
    console.log(`  ${status.padEnd(12)}: ${n}`);
  }
  if (suspect > 0) {
    console.log(`\n⚠ ${suspect} video nghi dùng nhạc nền (suspectBgm) — transcript có thể là rác.`);
    console.log("  Fallback tải mp4 + tách audio đang TẮT, xem README.");
  }
  const sttErrors = Object.entries(state.videos).filter(([, v]) => v.sttError);
  if (sttErrors.length > 0) {
    console.log(`\n${sttErrors.length} video lỗi ở bước STT (audio vẫn còn, chạy lại \`stt\` để thử lại):`);
    for (const [id, v] of sttErrors.slice(0, 5)) console.log(`  ${id}: ${v.sttError}`);
    if (sttErrors.length > 5) console.log(`  ... còn ${sttErrors.length - 5} video nữa`);
  }

  const failed = Object.entries(state.videos).filter(([, v]) => v.status === "failed");
  if (failed.length > 0) {
    console.log(`\n${failed.length} video lỗi (chạy lại lệnh tương ứng để retry):`);
    for (const [id, v] of failed.slice(0, 10)) console.log(`  ${id}: ${v.error}`);
    if (failed.length > 10) console.log(`  ... còn ${failed.length - 10} video nữa`);
  }
}

async function cmdInspect(videoId) {
  const result = await withBrowser((context) => inspectVideo(context, videoId));

  const dir = paths.inspectDir();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${videoId}.json`);
  await fs.writeFile(file, JSON.stringify(result, null, 2), "utf8");

  console.log(`\nmetadataSource : ${result.source ?? "(không bắt được)"}`);
  console.log(`desc           : ${result.desc ?? "-"}`);
  console.log(`author         : ${result.authorNickname ?? "-"} (uid ${result.authorUid ?? "-"})`);
  console.log(`music.title    : ${result.musicTitle ?? "-"}`);
  console.log(`originalSound  : ${result.isOriginalSound} — ${result.soundReason}`);
  console.log(`musicUrl       : ${result.musicUrl ?? "(không có)"}`);
  console.log(`videoUrl       : ${result.videoUrl ?? "(không có)"}`);
  console.log(`\nCác response CDN bắt được (${result.mediaResponses.length}):`);
  for (const r of result.mediaResponses) {
    console.log(`  [${r.status}] ${r.contentType || "(không có content-type)"}  ${r.url.slice(0, 110)}...`);
  }
  console.log(`\nJSON thô đã ghi: ${file}`);
  console.log("Đối chiếu tên field trong file này với logic parse ở src/capture.js.");
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
      limit: { type: "string" },
      apply: { type: "boolean" },
      force: { type: "boolean" },
      provider: { type: "string" },
      concurrency: { type: "string" },
      // Node parseArgs không tự hiểu tiền tố `--no-`, phải khai báo thành tên riêng.
      "no-glossary": { type: "boolean" },
      "no-protect": { type: "boolean" },
    },
  });
  const [command, ...rest] = positionals;
  const limit = values.limit ? Number.parseInt(values.limit, 10) : null;
  const concurrency = values.concurrency ? Number.parseInt(values.concurrency, 10) : null;

  const requireArg = (value, name) => {
    if (!value) {
      console.error(`Thiếu <${name}>.\n\n${USAGE}`);
      process.exit(1);
    }
    return value;
  };

  switch (command) {
    case "login":
      return cmdLogin();
    case "doctor":
      return doctor();
    case "probe":
      return withBrowser((context) => probeUserPage(context, requireArg(rest[0], "user_id")));
    case "probe-translate":
      return withBrowser((context) => probeTranslatePage(context));
    case "prune":
      return prune(requireArg(rest[0], "user_id"), { dryRun: !values.apply });
    case "collect":
      return cmdCollect(requireArg(rest[0], "user_id"));
    case "fetch":
      return cmdFetch(requireArg(rest[0], "user_id"), limit, concurrency, rest.length > 1 ? rest.slice(1) : null);
    case "stt":
      return cmdStt(requireArg(rest[0], "user_id"), {
        // một video: báo lỗi rõ nếu chưa sẵn sàng; nhiều video: lọc lặng lẽ
        videoId: rest.length === 2 ? rest[1] : null,
        videoIds: rest.length > 2 ? rest.slice(1) : null,
        limit,
        force: Boolean(values.force),
      });
    case "review-speakers": {
      const userId = requireArg(rest[0], "user_id");
      const state = await loadState(userId);
      const ids = rest[1] ? [rest[1]] : Object.keys(state.videos).sort((a, b) => (a < b ? 1 : -1));
      return reviewSpeakers(userId, ids);
    }
    case "translate":
      return cmdTranslate(requireArg(rest[0], "user_id"), {
        videoId: rest[1] ?? null,
        limit,
        force: Boolean(values.force),
        providerName: values.provider ?? null,
        // undefined (không truyền cờ) = để config quyết, đừng ép thành true ở đây.
        glossary: values["no-glossary"] ? false : undefined,
        // Cơ chế, KHÁC công tắc glossary ở trên: --no-protect vẫn gửi bảng thuật ngữ
        // vào prompt, chỉ thôi bọc ⟦n⟧ vào text.
        protectTerms: values["no-protect"] ? false : undefined,
      });
    case "translate-compare":
      return cmdTranslateCompare(
        requireArg(rest[0], "user_id"),
        requireArg(rest[1], "video_id"),
        values.provider ? [values.provider] : config.translateCompareProviders,
      );
    case "all":
      return cmdAll(requireArg(rest[0], "user_id"), limit, concurrency);
    case "status":
      return cmdStatus(requireArg(rest[0], "user_id"));
    case "inspect":
      return cmdInspect(requireArg(rest[0], "video_id"));
    case "compare":
      return compareModels(
        requireArg(rest[0], "user_id"),
        requireArg(rest[1], "video_id"),
        config.sttCompareModels,
      );
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`\nLỗi: ${err.message}`);
  if (config.logLevel === "debug") console.error(err);
  process.exit(1);
});
