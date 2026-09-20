/**
 * Đọc trạng thái từ đĩa cho UI. ĐĨA LÀ NGUỒN SỰ THẬT — cùng luật với stt.js và zhvi: UI không
 * giữ database riêng; chạy lệnh tay ngoài UI thì UI vẫn thấy đúng.
 *
 * Trạng thái một tập suy từ mốc thời gian file, không từ cờ nào:
 *   review.html mới hơn translation.json và mới hơn nhãn đã soát  -> chờ soát người nói
 *   translation.json mới hơn review.html                            -> đã dịch
 *   dub/dub-vi.mp4 mới hơn translation.json                         -> đã lồng tiếng
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { epDir } from "../zhvi/series.js";

const run = promisify(execFile);
const R = (...p) => path.join(process.cwd(), ...p);

/** Codec video track — Douyin hay xuất HEVC, Chrome/Chromium không giải mã được trong <video>
 * (canPlayType rỗng, videoWidth luôn 0): âm thanh chạy nhưng hình đứng im. Lỗi probe (file hỏng,
 * ffprobe thiếu) → null, coi như phát thẳng được, đừng chặn oan. */
async function videoCodec(f) {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name", "-of", "csv=p=0", f]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function readJson(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

export async function mtime(p) {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}

const exists = async (p) => (await mtime(p)) > 0;

async function dirs(p) {
  try {
    return (await fs.readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** Đường dẫn cho /media — chỉ trong data/, out/, series/. */
export const mediaUrl = (abs) => {
  // Windows: relative() trả về dấu `\` → regex dưới không khớp → null (src="null?v=…"). Tách theo cả hai kiểu dấu.
  const parts = path.relative(process.cwd(), abs).split(/[\\/]/);
  return ["data", "out", "series"].includes(parts[0]) ? "/media/" + parts.map(encodeURIComponent).join("/") : null;
};

export const tagsOf = (desc) => [...String(desc || "").matchAll(/#([^\s#@]+)/g)].map((m) => m[1]);
export const titleOf = (desc) => String(desc || "").replace(/#[^\s#]+/g, " ").replace(/\s+/g, " ").trim();
export const editsPath = (seriesDir, ep) => path.join(seriesDir, `ep${ep}.vi-edits.json`);
/** Giọng có sẵn của VieNeu đã chọn cho từng nhân vật: { "<nhân vật>": "<voiceId>" } — dùng chung mọi tập của series. */
export const presetsPath = (seriesDir) => path.join(seriesDir, "preset-voices.json");
/** Phải khớp sanitize của extract-voice.js / dub-video.mjs. */
export const folderOf = (speaker) => String(speaker).replace(/[/\\]/g, "_").trim();

/** aweme_id của Douyin: 32 bit cao là Unix time lúc đăng — ngày đăng có sẵn kể cả khi chưa tải. */
export function idTime(id) {
  try {
    const s = Number(BigInt(id) >> 32n);
    return s > 1.3e9 && s < 2.5e9 ? new Date(s * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

const authorCache = new Map();
async function authorOf(userId, state) {
  if (state.author) return state.author;
  if (authorCache.has(userId)) return authorCache.get(userId);
  for (const [vid, v] of Object.entries(state.videos || {})) {
    if (v.status === "collected" || v.status === "foreign") continue;
    const m = await readJson(R("data", userId, vid, "meta.json"));
    if (m?.authorNickname) {
      authorCache.set(userId, m.authorNickname);
      return m.authorNickname;
    }
  }
  return null;
}

export async function listUsers() {
  const out = [];
  for (const id of await dirs(R("data"))) {
    if (id.startsWith("_")) continue;
    const st = await readJson(R("data", id, "state.json"));
    if (!st) continue;
    const vids = Object.values(st.videos || {});
    const counts = {};
    for (const v of vids) counts[v.status] = (counts[v.status] || 0) + 1;
    out.push({
      id, author: await authorOf(id, st), total: vids.length - (counts.foreign || 0), counts,
      lastCollectedAt: st.lastCollectedAt ?? null,
    });
  }
  return out.sort((a, b) => String(b.lastCollectedAt).localeCompare(String(a.lastCollectedAt)));
}

export async function userDetail(id) {
  const st = await readJson(R("data", id, "state.json"));
  if (!st) return null;
  const member = await seriesMembership();
  // chỉ phán "không còn trên trang" khi đã có ít nhất một lượt quét ghi seenAt
  const tracked = Object.values(st.videos || {}).some((v) => v.seenAt);
  const videos = [];
  for (const [vid, v] of Object.entries(st.videos || {})) {
    if (v.status === "foreign") continue;
    const dir = R("data", id, vid);
    const meta = v.status === "collected" ? null : await readJson(path.join(dir, "meta.json"));
    const desc = meta?.desc ?? v.info?.desc ?? null;
    videos.push({
      id: vid, status: v.status, error: v.error || v.sttError || null, suspectBgm: Boolean(v.suspectBgm),
      title: titleOf(desc), tags: tagsOf(desc),
      duration: meta?.duration ? Math.round(meta.duration / 1000) : v.info?.duration ?? null,
      createTime: v.info?.createTime ?? idTime(vid),
      cover: v.info?.cover ?? null, mix: v.info?.mix ?? null, plays: v.info?.plays ?? null,
      hasVideo: await exists(path.join(dir, "video.mp4")),
      hasTranscript: await exists(path.join(dir, "transcript.json")),
      series: member[vid] || [],
      gone: Boolean(tracked && v.seenAt !== st.lastCollectedAt),
      dir: path.relative(process.cwd(), dir),
    });
  }
  videos.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
  return { id, author: await authorOf(id, st), lastCollectedAt: st.lastCollectedAt ?? null, videos };
}

export async function seriesMembership() {
  const map = {};
  for (const slug of await dirs(R("series"))) {
    const s = await seriesCore(slug);
    if (!s) continue;
    for (const e of s.episodes) (map[e.videoId] ||= []).push({ slug, title: s.title, ep: e.ep, use: e.use });
    for (const vid of s.extra) (map[vid] ||= []).push({ slug, title: s.title, ep: "", use: true });
  }
  return map;
}

/** Phần đọc nhanh của một series: nguồn tập, trạng thái bible. Không đọc trạng thái từng tập. */
async function seriesCore(slug) {
  const dir = R("series", slug);
  if (!(await exists(dir))) return null;
  const meta = await readJson(path.join(dir, "series.json"));
  const bible = await readJson(path.join(dir, "bible.json"));
  const draft = await readJson(path.join(dir, "draft", "bible.draft.json"));
  const src = bible || draft;
  if (!meta && !src) return null;
  const outRoot = src?.series?.inputs?.outRoot || R("out", slug);
  const userOf = (videoDir) => path.basename(path.dirname(videoDir));
  let episodes;
  if (src) {
    episodes = src.episodes.map((e) => ({ ...e, ep: String(e.ep ?? "") }));
  } else {
    episodes = (meta.videoIds || []).map((vid) => ({
      ep: "", videoId: vid, videoDir: R("data", meta.userId, vid), use: true, title: null, duration: null, why: "",
    }));
  }
  const known = new Set(episodes.map((e) => e.videoId));
  const extra = (meta?.videoIds || []).filter((v) => !known.has(v));
  return {
    slug, dir, meta, bible, draft, outRoot, episodes, extra,
    status: bible ? "approved" : draft ? "draft" : "new",
    title: bible?.series?.titleVi || draft?.series?.titleVi || meta?.name || slug,
    titleZh: bible?.series?.titleZh || draft?.series?.titleZh || null,
    userId: meta?.userId || (episodes[0] ? userOf(episodes[0].videoDir) : null),
  };
}

export async function episodeState(core, e) {
  const d = path.join(core.outRoot, epDir(e.ep));
  const vd = e.videoDir;
  const [ckpt, usage] = await Promise.all([readJson(path.join(d, "ckpt.json")), readJson(path.join(d, "usage.json"))]);
  const m = {
    review: await mtime(path.join(d, "review.html")),
    translation: await mtime(path.join(d, "translation.json")),
    labels: await mtime(path.join(core.dir, `ep${e.ep}.speakers.json`)),
    dub: await mtime(path.join(vd, "dub", "dub-vi.mp4")),
    transcript: await mtime(path.join(vd, "transcript.json")),
    video: await mtime(path.join(vd, "video.mp4")),
  };
  let status;
  if (!m.transcript) status = "no-stt";
  else if (m.translation && m.translation >= m.review) status = m.dub > m.translation ? "dubbed" : "translated";
  else if (m.review && m.labels < m.review) status = "review";
  else if (m.review) status = "reviewed";
  else if (ckpt && Object.keys(ckpt).length) status = "partial";
  else status = "idle";
  return {
    status,
    outDir: path.relative(process.cwd(), d),
    paid: ckpt ? Object.keys(ckpt) : [],
    lastCost: usage?._costUSD ?? null,
    hasVideo: Boolean(m.video),
    labelsStale: Boolean(m.labels && m.translation && m.labels > m.translation),
    dubStale: Boolean(m.dub && m.translation && m.dub < m.translation),
    times: m,
  };
}

export async function seriesInfo(slug) {
  const core = await seriesCore(slug);
  if (!core) return null;
  const episodes = [];
  for (const e of core.episodes) {
    const meta = e.title && e.duration ? null : await readJson(path.join(e.videoDir, "meta.json"));
    episodes.push({
      ep: e.ep, videoId: e.videoId,
      title: e.title || titleOf(meta?.desc) || null,
      duration: e.duration ?? (meta?.duration ? Math.round(meta.duration / 1000) : null),
      use: e.use, why: e.why,
      dir: path.relative(process.cwd(), e.videoDir),
      hasTranscript: await exists(path.join(e.videoDir, "transcript.json")),
      state: e.use && e.ep ? await episodeState(core, e) : null,
    });
  }
  // tập mới: video cùng 合集 với các tập của series mà chưa nằm trong series (tác giả vừa đăng thêm)
  let mixNews = [];
  if (core.userId) {
    const st = await readJson(R("data", core.userId, "state.json"));
    const inSeries = new Set([...core.episodes.map((e) => e.videoId), ...core.extra]);
    const mixIds = new Set([...inSeries].map((v) => st?.videos?.[v]?.info?.mix?.id).filter(Boolean));
    mixNews = Object.entries(st?.videos || {})
      .filter(([vid, v]) => !inSeries.has(vid) && v.info?.mix?.id && mixIds.has(v.info.mix.id))
      .map(([vid, v]) => ({ id: vid, ep: v.info.mix.ep ?? null, title: titleOf(v.info.desc), duration: v.info.duration ?? null, status: v.status }))
      .sort((a, b) => (a.ep ?? 0) - (b.ep ?? 0));
  }
  const b = core.bible;
  const d = core.draft;
  return {
    slug, title: core.title, titleZh: core.titleZh, status: core.status, userId: core.userId,
    // ảnh bìa Douyin của tập đầu — đại diện cho cả series ở trang danh sách (xem /api/cover)
    cover: core.userId && core.episodes[0]
      ? `/api/cover/${encodeURIComponent(core.userId)}/${encodeURIComponent(core.episodes[0].videoId)}` : null,
    meta: core.meta, extra: core.extra, mixNews, episodes,
    outRoot: path.relative(process.cwd(), core.outRoot),
    bible: b ? {
      version: b.version, approvedAt: new Date(await mtime(path.join(core.dir, "bible.json"))).toISOString(),
      cast: b.cast.map(({ id, zh, vi, viShort, gender, role, look, note, alias }) => ({ id, zh, vi, viShort, gender, role, look, note, alias })),
      terms: Object.entries(b.terms || {}).map(([zh, t]) => ({ zh, vi: t.vi, approved: t.approved })),
      address: b.address?.length ?? 0,
    } : null,
    draft: d ? {
      version: d.version, createdAt: d.createdAt, cast: d.cast.length, doubts: d.doubts || [],
      page: await exists(path.join(core.dir, "bible-review.html")),
      stale: Boolean(b && (await mtime(path.join(core.dir, "draft", "bible.draft.json"))) > (await mtime(path.join(core.dir, "bible.json")))),
    } : null,
  };
}

export async function listSeries() {
  const out = [];
  for (const slug of await dirs(R("series"))) {
    const s = await seriesInfo(slug);
    if (s) out.push(s);
  }
  return out;
}

/** Thư mục video của series theo thứ tự: bible/nháp nếu có (giữ số tập đã chốt), không thì series.json. */
export async function seriesVideoDirs(slug) {
  const core = await seriesCore(slug);
  if (!core) throw new Error(`không có series ${slug}`);
  const dirsList = [...core.episodes.map((e) => e.videoDir), ...core.extra.map((v) => R("data", core.userId, v))];
  return [...new Set(dirsList)];
}

export async function episodeCore(slug, ep) {
  const core = await seriesCore(slug);
  if (!core) return null;
  const e = core.episodes.find((x) => String(x.ep) === String(ep) && x.use);
  return e ? { core, e } : null;
}

export async function episodeDetail(slug, ep) {
  const hit = await episodeCore(slug, ep);
  if (!hit) return null;
  const { core, e } = hit;
  const state = await episodeState(core, e);
  const d = path.join(core.outRoot, epDir(e.ep));
  const tr = await readJson(path.join(d, "translation.json"));
  const segs = tr?.segments || [];
  const cast = core.bible?.cast || core.draft?.cast || [];
  const nameOf = (zh) => {
    const c = cast.find((x) => x.zh === zh || (x.alias || []).includes(zh));
    return c ? c.vi || c.zh : zh;
  };
  const genderOf = (zh) => {
    const g = cast.find((x) => x.zh === zh || (x.alias || []).includes(zh))?.gender;
    return g === "male" || g === "female" ? g : null;
  };
  const report = await readJson(path.join(e.videoDir, "dub", "report.json"));
  const overflow = (report?.segments || [])
    .map((s) => ({ ...s, over: Number((s.natural / s.tempo - s.room).toFixed(2)) }))
    .filter((s) => s.over > 0.01)
    .sort((a, b) => b.over - a.over);
  const speakers = [...new Set(segs.filter((s) => s.vi && s.speaker).map((s) => s.speaker))];
  const bank = path.join(core.dir, "voices");
  const voices = [];
  for (const sp of speakers) {
    const inBank = await exists(path.join(bank, folderOf(sp), "manifest.json"));
    const inEp = await exists(path.join(e.videoDir, "voice", folderOf(sp), "manifest.json"));
    const ref = report?.refs?.[sp] ?? null;
    const refDir = inBank ? path.join(bank, folderOf(sp)) : path.join(e.videoDir, "voice", folderOf(sp));
    voices.push({
      speaker: sp, name: nameOf(sp), gender: genderOf(sp),
      lines: segs.filter((s) => s.speaker === sp && s.vi).length,
      source: inBank ? "series" : inEp ? "episode" : null,
      // lần lồng tiếng bằng giọng có sẵn không có clip mẫu (ref.file) — chỉ có voiceId
      refUrl: ref?.file ? mediaUrl(path.join(refDir, ref.file)) : null,
      preset: report?.synth === "preset" ? ref?.voiceId ?? null : null,
    });
  }
  const edits = (await readJson(editsPath(core.dir, e.ep))) || {};
  const staleEdits = Object.entries(edits)
    .filter(([idx, ed]) => !segs.some((s, i) => String(s.index ?? s.id ?? i) === idx && s.zh === ed.zh))
    .map(([index, ed]) => ({ index, zh: ed.zh, vi: ed.vi }));
  const api = `/api/series/${encodeURIComponent(slug)}/ep/${encodeURIComponent(e.ep)}`;
  // video.mp4 gốc mã hoá HEVC thì trình duyệt không phát được (xem preview.mp4 dựng riêng, nhẹ hơn) —
  // không đụng tới video.mp4 vì còn dùng cho demucs, dub-video…
  let videoUrl = null;
  let needsPreview = false;
  if (state.hasVideo) {
    const videoFile = path.join(e.videoDir, "video.mp4");
    const previewFile = path.join(e.videoDir, "preview.mp4");
    const codec = await videoCodec(videoFile);
    const unplayable = codec && codec !== "h264";
    if (unplayable && !(await exists(previewFile))) needsPreview = true;
    else videoUrl = mediaUrl(unplayable ? previewFile : videoFile);
  }
  return {
    slug, seriesTitle: core.title, seriesStatus: core.status,
    ep: e.ep, videoId: e.videoId, title: e.title, duration: e.duration, dir: path.relative(process.cwd(), e.videoDir),
    state, needsPreview,
    cps: tr?.cps ?? 4.5,
    segments: segs.map((s, i) => ({
      i: String(s.index ?? s.id ?? i), start: s.start, end: s.end, zh: s.zh, vi: s.vi,
      speaker: s.speaker, name: s.speaker ? nameOf(s.speaker) : null,
      needsReview: Boolean(s.needsReview), suspect: s.speakerSuspect ?? null, edited: Boolean(s.editedByHand),
    })),
    staleEdits,
    speakerReviewed: Boolean(tr?.speakerReviewed),
    voices,
    presets: (await readJson(presetsPath(core.dir))) || {}, // giọng có sẵn đã chọn lần trước, theo nhân vật
    dub: report ? { engine: report.engine, synth: report.synth, bed: report.bed ?? "vocals-removed", origDb: report.origDb ?? null, lines: report.segments.length, overflow } : null,
    urls: {
      video: videoUrl,
      dub: state.times.dub ? mediaUrl(path.join(e.videoDir, "dub", "dub-vi.mp4")) + `?v=${Math.round(state.times.dub)}` : null,
      review: state.times.review ? `/review/speakers/${encodeURIComponent(slug)}/${encodeURIComponent(e.ep)}` : null,
      srt: tr ? `${api}/subs.srt` : null,
      buildPreview: needsPreview ? `/api/preview/${encodeURIComponent(core.userId)}/${encodeURIComponent(e.videoId)}` : null,
    },
  };
}

/**
 * Kế hoạch lồng tiếng một tập. Giọng lấy từ KHO SERIES (series/<slug>/voices) nếu nhân vật đã có
 * ở đó — tập đầu tiên được lồng tiếng đặt giọng, các tập sau dùng chung, nên một nhân vật đọc
 * cùng một giọng suốt series (dub-video --voices), và khỏi tách mẫu (demucs) lại mỗi tập.
 */
export async function ttsPlan(slug, ep, { reextract = false, preset = false } = {}) {
  const hit = await episodeCore(slug, ep);
  if (!hit) throw new Error(`không có tập ${ep} trong series ${slug}`);
  const { e, core } = hit;
  const tr = await readJson(path.join(e.videoDir, "translation.json"));
  if (!tr?.segments) throw new Error("thư mục video chưa có translation.json — dịch xong tập này trước");
  const speakers = [...new Set(tr.segments.filter((s) => s.vi && s.speaker).map((s) => s.speaker))];
  const bank = path.join(core.dir, "voices");
  const extract = [];
  // giọng có sẵn không cần mẫu: khỏi tách (demucs) và khỏi cập nhật kho giọng
  for (const sp of preset ? [] : speakers) {
    const inBank = await exists(path.join(bank, folderOf(sp), "manifest.json"));
    const inEp = await exists(path.join(e.videoDir, "voice", folderOf(sp), "manifest.json"));
    if (reextract || (!inBank && !inEp)) extract.push(sp);
  }
  const { resume, dropped } = await staleClips(e.videoDir, tr);
  return { videoDir: e.videoDir, bank, speakers, extract, resume, dropped, core };
}

/**
 * Clip tổng hợp đặt tên theo SỐ CÂU. Dịch lại/sửa tay mà dùng lại clip cũ là đọc câu cũ vào chỗ câu
 * mới. So từng clip với câu nó đã đọc (report.json của lần lồng tiếng trước): khác chữ hoặc khác
 * người nói thì xoá clip đó, còn lại dùng lại — sửa một câu chỉ tổng hợp lại đúng một câu. Lần
 * trước bị ngắt giữa chừng (chưa có report) thì so mốc thời gian clip với bản dịch.
 */
async function staleClips(videoDir, tr) {
  const clipDir = path.join(videoDir, "dub", "clips");
  let files = [];
  try {
    files = (await fs.readdir(clipDir)).filter((f) => f.endsWith(".wav"));
  } catch {
    return { resume: false, dropped: 0 };
  }
  if (!files.length) return { resume: false, dropped: 0 };
  const key = (s) => `${s.speaker}|${s.vi}`;
  const now = new Map(tr.segments.map((s, i) => [String(Number(s.index ?? s.id ?? i)), key(s)]));
  const rep = await readJson(path.join(videoDir, "dub", "report.json"));
  const said = new Map((rep?.segments || []).map((s) => [String(Number(s.index)), key(s)]));
  const trTime = await mtime(path.join(videoDir, "translation.json"));
  let dropped = 0;
  for (const f of files) {
    const idx = String(Number(f.slice(0, -4)));
    const stale = !now.has(idx)
      || (said.has(idx) ? said.get(idx) !== now.get(idx) : (await mtime(path.join(clipDir, f))) < trTime);
    if (stale) {
      await fs.rm(path.join(clipDir, f), { force: true });
      dropped += 1;
    }
  }
  return { resume: true, dropped };
}
