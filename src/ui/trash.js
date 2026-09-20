/**
 * Xoá mềm một series. KHÔNG có `rm -rf` ở đây: mọi thứ chuyển sang `data/_trash/<ts>_<slug>/`
 * kèm `trash.json` ghi đúng đường dẫn cũ của từng thứ, nên khôi phục là chuyển ngược lại.
 *
 * Vì sao mềm: cả pipeline này chạy lại từ đĩa được (luật 1) nên hỏng gì cũng chữa được — trừ
 * `ep<N>.vi-edits.json` (câu người sửa tay) và mẫu giọng đã tách (demucs, vài phút/video). Hai
 * thứ đó không mua lại được bằng tiền. Đĩa thì rẻ: series to nhất hiện có là 35 MB + 5,7 MB,
 * toàn JSON và wav ngắn — phần nặng (video, audio) không bao giờ đi vào đây.
 *
 * Ranh giới sở hữu — đây mới là phần khó, không phải cái nút:
 *
 *   series/<slug>/    bible, nhãn, câu sửa tay, kho giọng   -> series sở hữu, chuyển đi
 *   out/<slug>/       mọi đầu ra LLM + ckpt.json            -> series sở hữu, BẮT BUỘC chuyển đi
 *   data/<user>/<v>/  video, audio, transcript, raw-*.json  -> TÁC GIẢ sở hữu, KHÔNG đụng
 *                     translation.json, dub/, voice/        -> series ghi ra, chỗ dùng chung
 *
 * Ba luật rút từ đúng dữ liệu đang nằm trên đĩa, đừng nới:
 *
 * - **Video dùng chung thì không đụng.** `fei-niao-pao-hui` và `fei-niao-pao-hui-2` giữ đúng
 *   cùng 2 videoId của cùng một tác giả. Quét `translation.json`/`dub/` theo series là móc ruột
 *   series kia. `seriesMembership()` biết ai nhận video nào — hỏi nó rồi BỎ QUA và kể tên ra,
 *   không im lặng.
 * - **Phải chuyển cả `out/<slug>/`, không chỉ `series/<slug>/`.** Chống trùng slug lúc tạo
 *   series chỉ hỏi `series/` (server.js), nên xoá nửa vời rồi đặt lại tên cũ là slug tái dụng.
 *   Mà `episodeState` suy trạng thái từ mtime trong `out/<slug>/ep<NN>/`, khoá theo SỐ TẬP chứ
 *   không theo videoId: series mới toanh hiện "đã dịch" ở ep01 với bản dịch của phim khác, và
 *   không lỗi nào nổ ra.
 * - **Giữ `transcript.json` và `raw-*.json` kể cả khi quét thư mục video.** Đó là lượt ASR đã
 *   trả tiền (luật 2). Người ta xoá series vì gom nhầm tập hay đặt sai tên, không phải để vứt
 *   audio đi.
 */
import fsp from "node:fs/promises";
import path from "node:path";

import * as scan from "./scan.js";

const R = (...p) => path.join(process.cwd(), ...p);
const BOX = () => R("data", "_trash");

/** Thứ series ghi ra nhưng nằm trong thư mục video. Chỉ chuyển khi không series nào khác nhận. */
const VIDEO_ARTIFACTS = ["translation.json", "translation.txt", "dub", "voice", "_demucs"];

/** Tên mục trong thùng rác đi thẳng vào đường dẫn -> chỉ nhận đúng hình dạng mình tự đặt. */
const safeName = (n) => (/^[0-9TZ:\-]{10,25}_[a-z0-9-]{1,60}$/i.test(n) ? n : null);

async function move(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch (ex) {
    if (ex.code !== "EXDEV") throw ex; // repo và data/ khác mount (hiếm, nhưng Windows/WSL có thể)
    await fsp.cp(from, to, { recursive: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

async function bytesOf(p) {
  let n = 0;
  const walk = async (q) => {
    let st;
    try {
      st = await fsp.stat(q);
    } catch {
      return;
    }
    if (!st.isDirectory()) return void (n += st.size);
    for (const d of await fsp.readdir(q)) await walk(path.join(q, d));
  };
  await walk(p);
  return n;
}

/** Tổng tiền đã trả cho series: `_costUSD` của mọi `usage.json` dưới out/<slug>/ (cả v1 lẫn v2). */
async function paidUsd(dir) {
  let usd = 0;
  const walk = async (q) => {
    let ents;
    try {
      ents = await fsp.readdir(q, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.isDirectory()) await walk(path.join(q, e.name));
      else if (e.name === "usage.json") usd += (await scan.readJson(path.join(q, e.name)))?._costUSD || 0;
    }
  };
  await walk(dir);
  return usd;
}

/** Số câu người sửa tay trong cả series — con số duy nhất trong bảng không mua lại được bằng tiền. */
async function handEdits(dir) {
  let n = 0;
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    if (!/^ep.*\.vi-edits\.json$/.test(f)) continue;
    n += Object.keys((await scan.readJson(path.join(dir, f))) || {}).length;
  }
  return n;
}

/**
 * Cái hộp xác nhận hỏi "xoá không" thì phải nói được xoá cái gì. Mọi số ở đây đọc từ đĩa, không
 * ước tính: tiền lấy từ `usage.json` đã ghi, câu sửa tay đếm trong `ep<N>.vi-edits.json`.
 */
export async function preview(slug) {
  const s = await scan.seriesInfo(slug);
  if (!s) return null;
  const dir = R("series", slug);
  const out = R("out", slug);
  const membership = await scan.seriesMembership();
  const videos = [];
  const shared = [];
  for (const vd of await scan.seriesVideoDirs(slug)) {
    const videoId = path.basename(vd);
    const has = [];
    for (const f of VIDEO_ARTIFACTS) if (await scan.mtime(path.join(vd, f))) has.push(f);
    if (!has.length) continue;
    const others = (membership[videoId] || []).filter((m) => m.slug !== slug);
    const row = { videoId, dir: path.relative(process.cwd(), vd), has, others: others.map((o) => o.title || o.slug) };
    (others.length ? shared : videos).push(row);
  }
  const used = s.episodes.filter((e) => e.state);
  return {
    slug, title: s.title, status: s.status,
    episodes: used.length,
    translated: used.filter((e) => ["translated", "dubbed"].includes(e.state.status)).length,
    dubbed: used.filter((e) => e.state.status === "dubbed").length,
    edits: await handEdits(dir),
    usd: Math.round((await paidUsd(out)) * 1e4) / 1e4,
    bytes: (await bytesOf(dir)) + (await bytesOf(out)),
    videos, sharedVideos: shared,
  };
}

export async function softDelete(slug, { purgeVideoArtifacts = false } = {}) {
  const p = await preview(slug);
  if (!p) throw Object.assign(new Error(`không có series ${slug}`), { code: 404 });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}_${slug}`;
  if (!safeName(name)) throw Object.assign(new Error(`slug lạ, không xoá: ${slug}`), { code: 400 });
  const box = path.join(BOX(), name);
  await fsp.mkdir(box, { recursive: true });
  // `moved` giữ đường dẫn TƯƠNG ĐỐI từ gốc repo, và trong hộp cũng nằm đúng đường đó -> khôi
  // phục chỉ là chuyển ngược, không cần biết thứ đang chuyển là loại gì.
  const moved = [];
  const rels = [path.join("series", slug), path.join("out", slug)];
  if (purgeVideoArtifacts) for (const v of p.videos) for (const f of v.has) rels.push(path.join(v.dir, f));
  for (const rel of rels) {
    if (!(await scan.mtime(R(rel)))) continue;
    await move(R(rel), path.join(box, rel));
    moved.push(rel);
  }
  const manifest = {
    name, slug, title: p.title, deletedAt: new Date().toISOString(),
    moved, keptShared: p.sharedVideos, stats: { episodes: p.episodes, translated: p.translated, dubbed: p.dubbed, edits: p.edits, usd: p.usd, bytes: p.bytes },
  };
  await fsp.writeFile(path.join(box, "trash.json"), JSON.stringify(manifest, null, 1));
  return manifest;
}

export async function list() {
  const out = [];
  for (const name of await fsp.readdir(BOX()).catch(() => [])) {
    const m = await scan.readJson(path.join(BOX(), name, "trash.json"));
    if (m) out.push({ ...m, bytes: await bytesOf(path.join(BOX(), name)) });
  }
  return out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
}

export async function restore(name) {
  const safe = safeName(name);
  const box = safe && path.join(BOX(), safe);
  const m = box && (await scan.readJson(path.join(box, "trash.json")));
  if (!m) throw Object.assign(new Error("không có mục này trong thùng rác"), { code: 404 });
  // Slug có thể đã bị dùng lại cho series khác trong lúc nằm thùng rác. Đè là mất cái đang sống.
  const clash = [];
  for (const rel of m.moved) if (await scan.mtime(R(rel))) clash.push(rel);
  if (clash.length) {
    throw Object.assign(new Error(`chỗ cũ đã có thứ khác, không đè: ${clash.join(", ")}`), { code: 409 });
  }
  for (const rel of m.moved) await move(path.join(box, rel), R(rel));
  await fsp.rm(box, { recursive: true, force: true });
  return m;
}

/** Lần xoá thật duy nhất trong cả UI — chỉ chạy khi người bấm đúng nút này trong thùng rác. */
export async function purge(name) {
  const safe = safeName(name);
  if (!safe || !(await scan.mtime(path.join(BOX(), safe, "trash.json")))) {
    throw Object.assign(new Error("không có mục này trong thùng rác"), { code: 404 });
  }
  await fsp.rm(path.join(BOX(), safe), { recursive: true, force: true });
  return { name: safe };
}
