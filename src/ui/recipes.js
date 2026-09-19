/**
 * Mỗi loại việc của UI = đúng lệnh CLI người vẫn chạy tay. Đổi cách chạy một bước thì sửa
 * CLI/lib, không sửa ở đây — ở đây chỉ ghép đối số.
 *
 *   plan(params)  -> tên hiển thị, làn, khoá (tính lúc xếp hàng)
 *   steps(params) -> các lệnh (tính lúc BẮT ĐẦU chạy, vì phụ thuộc đĩa lúc đó)
 *   next(params)  -> việc tự xếp tiếp khi xong (vd. nạp nhãn soát xong thì dịch tiếp)
 */
import fs from "node:fs/promises";
import path from "node:path";

import { translateArgs } from "../zhvi/series.js";
import { applyEdits } from "./edits.js";
import * as scan from "./scan.js";

const rel = (p) => path.relative(process.cwd(), p) || ".";
const withEnv = (...a) => ["node", "--env-file-if-exists=.env", ...a];
const zhvi = (...a) => ["node", "src/zhvi/cli.js", ...a];
const short = (id) => (id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-5)}` : id);

async function userName(userId) {
  const st = await scan.readJson(path.join("data", userId, "state.json"));
  return st?.author || short(userId);
}

async function seriesTitle(slug) {
  return (await scan.seriesInfo(slug))?.title || slug;
}

export const recipes = {
  login: {
    plan: () => ({ title: "Đăng nhập Douyin", lane: "browser", meta: { interactive: true } }),
    steps: () => [{ label: "mở trình duyệt để đăng nhập", argv: withEnv("src/cli.js", "login") }],
  },

  collect: {
    plan: async ({ userId }) => ({ title: `Quét danh sách video — ${await userName(userId)}`, lane: "browser", locks: [`user:${userId}`], meta: { userId } }),
    steps: ({ userId }) => [{ label: "quét trang tác giả", argv: withEnv("src/cli.js", "collect", userId) }],
  },

  fetch: {
    plan: async ({ userId, videoIds }) => ({
      title: `Tải ${videoIds.length} video — ${await userName(userId)}`, lane: "browser", locks: [`user:${userId}`], meta: { userId },
    }),
    steps: ({ userId, videoIds }) => [{ label: `tải audio + video`, argv: withEnv("src/cli.js", "fetch", userId, ...videoIds) }],
    // tải xong thì STT luôn: không có transcript thì chưa làm được gì tiếp
    next: ({ userId, videoIds, then = null }) => ({ type: "stt", params: { userId, videoIds, then } }),
  },

  stt: {
    plan: async ({ userId, videoIds }) => ({
      title: `STT ${videoIds.length} video — ${await userName(userId)}`, lane: "stt", locks: [`user:${userId}`], meta: { userId },
    }),
    async steps({ userId, videoIds }) {
      const todo = [];
      for (const v of videoIds) {
        const has = await scan.mtime(path.join("data", userId, v, "transcript.json"));
        const got = await scan.mtime(path.join("data", userId, v, "meta.json"));
        if (!has && got) todo.push(v);
      }
      return todo.length ? [{ label: `chuyển giọng nói thành chữ ${todo.length} video`, argv: withEnv("src/cli.js", "stt", userId, ...todo) }] : [];
    },
    next: ({ then = null }) => then,
  },

  seriesInit: {
    plan: async ({ slug }) => ({ title: `Dựng bible nháp — ${await seriesTitle(slug)}`, lane: "zhvi", locks: [`series:${slug}`], meta: { slug } }),
    async steps({ slug, force = false }) {
      const dirs = await scan.seriesVideoDirs(slug);
      const missing = [];
      for (const d of dirs) if (!(await scan.mtime(path.join(d, "transcript.json")))) missing.push(path.basename(d));
      if (missing.length) throw new Error(`${missing.length} video chưa có transcript (${missing.join(", ")}) — tải + STT trước`);
      const bibleExists = await scan.mtime(path.join("series", slug, "bible.json"));
      return [{
        label: "sửa ASR + suy nhân vật từng tập, gộp, tả ngoại hình",
        argv: zhvi("series", "init", ...dirs.map(rel), "--series", `series/${slug}`, "--glossary", "glossary.json",
          "--out", `out/${slug}`, "--events", ...(force || bibleExists ? ["--force"] : [])),
      }];
    },
  },

  bibleApply: {
    plan: async ({ slug }) => ({ title: `Áp dụng bible đã duyệt — ${await seriesTitle(slug)}`, lane: "zhvi", locks: [`series:${slug}`], meta: { slug } }),
    steps: ({ slug, file }) => [{ label: "ghi bible.json", argv: zhvi("series", "apply", file, "--series", `series/${slug}`) }],
  },

  translate: {
    plan: async ({ slug, ep }) => ({
      title: `Dịch tập ${ep} — ${await seriesTitle(slug)}`, lane: "zhvi", locks: [`series:${slug}:ep${ep}`], meta: { slug, ep: String(ep) },
    }),
    async steps({ slug, ep, force = null }) {
      const biblePath = path.join("series", slug, "bible.json");
      const bible = await scan.readJson(biblePath);
      if (!bible) throw new Error("series chưa có bible đã duyệt — duyệt bible trước");
      const e = bible.episodes.find((x) => String(x.ep) === String(ep) && x.use);
      if (!e) throw new Error(`bible không có tập ${ep}`);
      return [
        {
          label: "sửa ASR → người nói → dịch → soát → xuất",
          argv: zhvi(...translateArgs(bible, biblePath, e), "--events", ...(force ? ["--force", force] : [])),
        },
        // zhvi vừa ghi đè translation.json -> áp lại các câu người đã sửa tay
        { label: "áp lại các câu đã sửa tay", run: () => applyEdits(slug, ep) },
      ];
    },
  },

  speakerApply: {
    plan: async ({ slug, ep }) => ({
      title: `Nạp nhãn người nói tập ${ep} — ${await seriesTitle(slug)}`, lane: "zhvi", locks: [`series:${slug}:ep${ep}`], meta: { slug, ep: String(ep) },
    }),
    steps: ({ slug, file }) => [{ label: "nạp nhãn đã soát", argv: zhvi("--apply", file, "--series", `series/${slug}`) }],
    next: ({ slug, ep }) => ({ type: "translate", params: { slug, ep: String(ep) } }),
  },

  tts: {
    // mode "preset": giọng có sẵn của VieNeu (chọn từng nhân vật) thay vì clone từ mẫu — không tốn
    // hạn mức clone (ngày/tháng/slot), không cần tách mẫu. `presets` = { "<nhân vật>": "<voiceId>" }.
    plan: async ({ slug, ep, engine = "v3", mode = "clone" }) => ({
      title: `Lồng tiếng tập ${ep} (VieNeu ${engine}${mode === "preset" ? ", giọng có sẵn" : ""}) — ${await seriesTitle(slug)}`,
      lane: "tts", locks: [`series:${slug}:ep${ep}`], meta: { slug, ep: String(ep) },
    }),
    async steps({ slug, ep, engine = "v3", reextract = false, mode = "clone", presets = {} }) {
      const preset = mode === "preset";
      const p = await scan.ttsPlan(slug, ep, { reextract, preset });
      const cast = p.core.bible?.cast || [];
      const vi = (zh) => cast.find((c) => c.zh === zh)?.vi || zh;
      const presetFile = scan.presetsPath(p.core.dir);
      const dub = {
        label: p.resume
          ? `tổng hợp giọng Việt (dùng lại clip cũ${p.dropped ? `, làm lại ${p.dropped} câu đã đổi` : ""}) + trộn nền + ghép video`
          : "tổng hợp giọng Việt + trộn nền nhạc + ghép video",
        // --concurrency 1: VieNeu rate-limit, song song đã thử và chậm hơn — đừng tăng
        argv: withEnv("scripts/dub-video.mjs", "--dir", rel(p.videoDir), "--engine", engine, "--concurrency", "1",
          ...(preset ? ["--synth", "preset", "--preset-map", rel(presetFile)] : ["--voices", rel(p.bank)]),
          ...(p.resume ? ["--resume"] : [])),
      };
      if (preset) return [{ label: "lưu giọng đã chọn cho series", run: () => savePresets(presetFile, presets) }, dub];
      return [
        // nhân vật thoại quá ít có thể không cắt được mẫu: cho qua, dub-video sẽ báo đúng tên thiếu
        ...p.extract.map((sp) => ({
          label: `tách giọng mẫu: ${vi(sp)}`, optional: true,
          argv: ["node", "scripts/extract-voice.js", "--dir", rel(p.videoDir), "--speaker", sp],
        })),
        {
          label: "cập nhật kho giọng series (một nhân vật một giọng suốt các tập)",
          run: () => syncVoiceBank(p, { replace: reextract ? p.extract : [] }),
        },
        dub,
      ];
    },
  },
};

/** Gộp vào lựa chọn cũ: nhân vật của các tập khác trong series giữ nguyên giọng đã chọn. */
async function savePresets(file, presets) {
  const old = (await scan.readJson(file)) || {};
  await fs.writeFile(file, `${JSON.stringify({ ...old, ...presets }, null, 1)}
`, "utf8");
}

/** Nhân vật chưa có trong kho series thì lấy mẫu của tập này làm giọng chung; `replace` = thay giọng kho. */
async function syncVoiceBank(p, { replace = [] } = {}) {
  for (const sp of p.speakers) {
    const src = path.join(p.videoDir, "voice", scan.folderOf(sp));
    const dst = path.join(p.bank, scan.folderOf(sp));
    if (!(await scan.mtime(path.join(src, "manifest.json")))) continue;
    if ((await scan.mtime(path.join(dst, "manifest.json"))) && !replace.includes(sp)) continue;
    await fs.rm(dst, { recursive: true, force: true });
    await fs.mkdir(p.bank, { recursive: true });
    await fs.cp(src, dst, { recursive: true });
  }
}

/** File trình duyệt gửi về — lưu kèm mốc thời gian để còn dấu vết, rồi đưa đường dẫn cho CLI. */
export async function saveSubmission(dir, name, body) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(file, JSON.stringify(body, null, 1), "utf8");
  return rel(file);
}
