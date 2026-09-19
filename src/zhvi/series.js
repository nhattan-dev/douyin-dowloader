/**
 * Dựng BIBLE cho một series mới — việc trước đây phải làm tay.
 *
 * Vì sao cần: không có bible thì pass B đi đường "tự đoán từng tập": không kênh hình, không
 * trang soát, và mỗi tập tự đặt tên nhân vật một kiểu. Bible đầu tiên (Tiểu Toản Phong) dựng
 * tay một lần; module này làm đúng chuỗi việc đó cho series bất kỳ:
 *
 *   1. bản đồ tập   meta.json -> số tập, tên tập. Video quá ngắn bị gạt (thông báo, trailer).
 *   2. từng tập     pass A (sửa ASR) qua runPipeline. Cùng outDir với lượt dịch sau này, nên lượt
 *                   dịch dùng lại A2 — tiền sửa ASR chỉ trả một lần.
 *   3. tự suy       B2b chạy MỘT lần trên thoại mọi tập được chọn (glossary + cụm lặp lại + kịch bản),
 *                   ra thẳng dàn nhân vật cả series. Code kiểm lại: tên có thật trong thoại, cụm giọng
 *                   có thật trong tập, không cụm nào hai chủ. Trước đây B2b chạy riêng từng tập rồi mới
 *                   gộp: tốn ~60% tiền init, và hồ sơ tập đoán sai kéo lượt gộp sai theo.
 *   4. look         VLM tả ngoại hình từ khung hình của chính các câu nhân vật đó nói, rồi một lượt
 *                   viết lại cho nổi chỗ KHÁC nhau — tả chỗ giống nhau thì kênh hình chia phiếu.
 *   5. trang duyệt  chỉ hỏi phía tiếng Việt, kèm ảnh + tiếng; người duyệt không cần đọc chữ Hán.
 *
 * Kết quả là NHÁP (`draft/bible.draft.json`). `bible.json` chỉ sinh ra ở `applyReview`, sau khi
 * người đã duyệt — dịch một tập là đọc bible đã đóng băng, không đọc thứ máy vừa đoán.
 */
import fs from "node:fs/promises";
import path from "node:path";

import * as BIBLE from "./bible.js";
import { sig } from "./ckpt.js";
import { runPipeline } from "./index.js";
import { jparse } from "./llm.js";
import { relevantGlossary, repeatedTerms } from "./passes/b-speakers.js";
import { LOOK_CONTRAST_SYS, LOOK_SYS, SERIES_SYS } from "./prompts.js";
import { media, roughVi } from "./review.js";
import { buildBiblePage } from "./series-page.js";
import { grab } from "./vision.js";

const NULL_LOG = { info() {}, warn() {}, error() {} };
// Ngắn hơn ngần này thì gần như chắc không phải một tập: gặp thật ở 杂役合道 — clip 10s
// tác giả báo "đang làm tiếp, lên 书旗 đọc trước", nằm lẫn giữa các tập.
export const MIN_EP_SEC = 60;
// Trần ký tự gửi cho lượt gộp; quá thì cắt bớt kịch bản đều các tập, không bỏ tập nào.
// Dưới trần 100k của provider queue (còn chỗ cho system prompt).
const MAX_BRIEF_CHARS = 90_000;
// Tên không phải chữ trong thoại mà vẫn hợp lệ làm "zh"
const NON_DIALOGUE_NAMES = new Set(["旁白"]);

const exists = (p) => fs.access(p).then(() => true, () => false);
const readJson = async (p, dflt = null) => {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return dflt;
  }
};
const uniq = (xs) => [...new Set(xs.filter((x) => x !== null && x !== undefined && x !== ""))];
const GENDER = { male: "male", nam: "male", m: "male", female: "female", "nữ": "female", nu: "female", f: "female" };
export const GENDER_VI = { male: "nam", female: "nữ", "?": "chưa rõ giới tính" };

export const epDir = (ep) => `ep${String(ep).padStart(2, "0")}`;
const cleanTitle = (desc) => String(desc || "").replace(/#\S+/g, "").trim();
const countBy = (utts) => utts.reduce((m, u) => ({ ...m, [u.speaker]: (m[u.speaker] || 0) + 1 }), {});

// ---------- 1. bản đồ tập ----------

/** Thứ tự tập = thứ tự video được đưa vào. Tập bị gạt vẫn nằm trong bản đồ để người duyệt bật lại. */
export async function episodeMap(videoDirs, { minSec = MIN_EP_SEC } = {}) {
  const out = [];
  let n = 0;
  for (const dir of videoDirs) {
    const meta = (await readJson(path.join(dir, "meta.json"))) || {};
    const hasStt = await exists(path.join(dir, "transcript.json"));
    const sec = meta.duration ? Math.round(meta.duration / 1000) : null;
    const short = sec !== null && sec < minSec;
    const use = hasStt && !short;
    out.push({
      ep: use ? String(++n) : "",
      videoId: String(meta.videoId || path.basename(path.resolve(dir))),
      videoDir: path.resolve(dir),
      duration: sec,
      title: cleanTitle(meta.desc),
      // Tên PHIM thường chỉ nằm trong hashtag («#杂役合道后续»), tiêu đề thì là câu mô tả tập.
      tags: (String(meta.desc || "").match(/#[^\s#]+/g) || []).map((s) => s.slice(1)),
      hasStt,
      use,
      why: short ? `chỉ ${sec}s — giống thông báo/trailer hơn là một tập`
        : hasStt ? "" : "chưa có transcript.json — chạy npm run stt trước",
    });
  }
  return out;
}

// ---------- 3. tự suy hồ sơ series: B2b một lượt trên thoại mọi tập ----------

function episodeBrief(d, maxLines = Infinity) {
  const { episode: e, utts } = d;
  const size = countBy(utts);
  const script = utts.slice(0, maxLines).map((u) => `${u.id} ${u.speaker}: ${u.zh}`);
  if (utts.length > maxLines) script.push(`… (cắt ${utts.length - maxLines} câu cuối cho vừa ngân sách)`);
  return [
    `=== TẬP ${e.ep}${e.title ? ` — 《${e.title}》` : ""}`,
    `Cụm giọng: ${Object.entries(size).map(([k, n]) => `${k} (${n} câu)`).join(", ")}`,
    "Kịch bản:",
    ...script,
  ].join("\n");
}

/**
 * Nội dung gửi cho lượt tự suy. Tách riêng để làm khoá cache: cùng đầu vào thì khỏi gọi lại.
 * Cùng đầu vào B2b (glossary + cụm lặp lại + kịch bản) nhưng tính trên thoại MỌI tập: cụm chỉ lặp
 * lại khi cộng các tập vẫn lọt danh sách, và model thấy manh mối xuyên tập ngay trong một lượt.
 */
export function mergeInput(eps, episodes = [], { glossary = {}, pinned = null, log = NULL_LOG } = {}) {
  // mọi video được đưa vào, kể cả video bị gạt — clip thông báo hay mang đúng tên phim
  const videos = episodes.map((e) =>
    `- ${e.use ? `tập ${e.ep}` : "(không phải tập)"}: ${e.title || "—"}${e.tags?.length ? `  #${e.tags.join(" #")}` : ""}`);
  const zhAll = eps.map((d) => d.utts.map((u) => u.zh).join("")).join("\n");
  const g = { ...relevantGlossary(glossary, zhAll), ...relevantGlossary(pinned || {}, zhAll) }; // ghim tay thắng glossary
  const cand = repeatedTerms(zhAll, { top: Math.min(150, 40 + 20 * eps.length) });
  let briefs = eps.map((d) => episodeBrief(d));
  const total = briefs.reduce((n, b) => n + b.length, 0);
  if (total > MAX_BRIEF_CHARS) {
    const keep = MAX_BRIEF_CHARS / total;
    log.warn(`kịch bản ${eps.length} tập dài ${total} ký tự — cắt còn ~${Math.round(keep * 100)}% mỗi tập`);
    briefs = eps.map((d) => episodeBrief(d, Math.floor(d.utts.length * keep)));
  }
  return [
    `VIDEO TÁC GIẢ ĐĂNG (tiêu đề + hashtag):\n${videos.join("\n")}`,
    `GLOSSARY (bắt buộc dùng):\n${Object.entries(g).map(([k, v]) => `${k} = ${v}`).join("\n") || "—"}`,
    "CỤM LẶP LẠI trong series (phải ra phán quyết cho mọi cụm: vào \"terms\" hoặc \"skipped\"):\n"
      + (Object.entries(cand).map(([k, v]) => `${k}(${v})`).join(", ") || "—"),
    briefs.join("\n\n"),
  ].join("\n\n");
}

/** Cụm lặp lại model chưa phán — cùng luật kiểm như B2b. */
function unruled(m, input) {
  const line = input.match(/CỤM LẶP LẠI[^\n]*\n([^\n]*)/)?.[1] || "";
  const cand = line === "—" ? [] : line.split(", ").map((s) => s.replace(/\(\d+\)$/, "")).filter(Boolean);
  const names = (m.cast || []).flatMap((c) => [c?.zh, ...(c?.alias || [])]).filter(Boolean).map(String);
  const ruled = new Set([...Object.keys(m.terms || {}), ...(m.skipped || []).map(String), ...names]);
  return cand.filter((t) => !ruled.has(t) && ![...ruled].some((e) => e.includes(t)));
}

export async function mergeCast(llm, input, { model }) {
  llm.tag = "S-merge";
  const msgs = [
    { role: "system", content: SERIES_SYS },
    { role: "user", content: input },
  ];
  const r = await llm.chat(model, msgs, { jsonMode: true, maxTokens: 16000, temperature: 0.2 });
  const m = jparse(r.text);
  const missing = unruled(m, input);
  if (missing.length) {
    msgs.push(
      { role: "assistant", content: r.text },
      {
        role: "user",
        content: `Chưa ra phán quyết cho các cụm sau: ${missing.join(", ")}\n`
          + 'Trả JSON {"terms":{...}, "skipped":[...]} chỉ gồm các cụm này.',
      },
    );
    const add = jparse((await llm.chat(model, msgs, { jsonMode: true, maxTokens: 3000, temperature: 0.2 })).text);
    m.terms = { ...(m.terms || {}), ...(add.terms || {}) };
    m.skipped = [...(m.skipped || []), ...(add.skipped || [])];
  }
  return m;
}

/**
 * Model đề xuất, CODE kiểm. Không có bước này thì nháp tin được bao nhiêu là tuỳ lượt chạy.
 * Thứ bị loại không biến mất lặng lẽ: nó thành dòng `doubt` trên trang duyệt.
 */
export function validateDraft(m, eps, pinned = {}) {
  const byEp = Object.fromEntries(eps.map((d) => [d.ep, d]));
  const text = eps.map((d) => d.utts.map((u) => u.zh).join("\n")).join("\n");
  const seen = (s) => Boolean(s) && (text.includes(s) || NON_DIALOGUE_NAMES.has(s));

  const doubts = (m.doubts || []).map(String).filter(Boolean);
  const taken = new Map(); // "ep|S0" -> id
  const idMap = new Map();
  const cast = [];
  for (const c of m.cast || []) {
    if (!c?.zh) continue;
    const id = `C${cast.length + 1}`;
    if (c.id !== undefined) idMap.set(String(c.id), id);
    const notes = [];
    if (!seen(c.zh)) notes.push("tên chữ Hán không có trong thoại — có thể máy bịa");
    const alias = uniq((c.alias || []).map(String)).filter((a) => a !== c.zh);
    const fake = alias.filter((a) => !seen(a));
    if (fake.length) notes.push(`đã bỏ ${fake.length} biệt danh không có trong thoại`);

    const clusters = {};
    for (const [ep, keys] of Object.entries(c.clusters || {})) {
      const d = byEp[String(ep)];
      if (!d) continue;
      const present = new Set(d.utts.map((u) => u.speaker));
      for (const k of [].concat(keys || [])) {
        if (!present.has(k)) continue; // model bịa ra cụm không có trong tập
        const slot = `${ep}|${k}`;
        if (taken.has(slot)) {
          notes.push(`tập ${ep} cụm ${k} máy gán cho cả ${taken.get(slot)} — giữ cho ${taken.get(slot)}`);
          continue;
        }
        taken.set(slot, id);
        (clusters[ep] ||= []).push(k);
      }
    }
    const lines = Object.entries(clusters)
      .reduce((n, [ep, ks]) => n + byEp[ep].utts.filter((u) => ks.includes(u.speaker)).length, 0);
    cast.push({
      id,
      zh: String(c.zh),
      vi: String(c.vi || ""),
      viShort: String(c.viShort || ""),
      gender: GENDER[String(c.gender || "").toLowerCase()] || "?",
      role: ["main", "episodic", "mentioned"].includes(c.role) ? c.role : lines ? "episodic" : "mentioned",
      alias: alias.filter(seen),
      note: String(c.note || ""),
      clusters,
      lines,
      confidence: Number(c.confidence ?? 0.5),
      doubt: [c.doubt, ...notes].filter(Boolean).join("; "),
    });
  }

  for (const d of eps) {
    for (const [k, n] of Object.entries(countBy(d.utts))) {
      if (n >= 2 && !taken.has(`${d.ep}|${k}`)) doubts.push(`tập ${d.ep}: cụm giọng ${k} (${n} câu) chưa gán cho nhân vật nào`);
    }
  }

  const castNames = new Set(cast.flatMap((c) => [c.zh, ...c.alias]));
  const terms = {};
  let droppedTerms = 0;
  for (const [zh, vi] of Object.entries(m.terms || {})) {
    if (!vi || castNames.has(zh)) continue;
    if (!text.includes(zh)) {
      droppedTerms += 1;
      continue;
    }
    terms[zh] = { vi: String(vi), approved: false, source: "series init" };
  }
  // thuật ngữ người đã ghim tay (--terms) thắng đề xuất của máy, và không bắt duyệt lại
  for (const [zh, vi] of Object.entries(pinned || {})) {
    terms[zh] = { vi: String(vi), approved: true, pinned: true, source: "terms ghim tay" };
  }
  if (droppedTerms) doubts.push(`đã bỏ ${droppedTerms} thuật ngữ máy đề xuất mà chữ Hán không có trong thoại`);

  const address = [];
  for (const a of m.address || []) {
    const from = idMap.get(String(a.from));
    const to = idMap.get(String(a.to));
    if (!from || !to || from === to || !a.self || !a.other) continue;
    address.push({
      from, to, self: String(a.self), other: String(a.other),
      fromEp: String(a.fromEp || "1"), why: String(a.why || ""),
    });
  }
  return { series: m.series || {}, cast, terms, address, doubts };
}

// ---------- 4. look + mẫu nghe ----------

/**
 * Câu mẫu của một nhân vật: dài nhất, trải đều qua các tập. Câu dưới 1,2s không đủ khung
 * để thấy miệng động, cũng không đủ tiếng để người duyệt nghe ra giọng.
 */
export function samplesOf(c, byEp, n = 4) {
  const perEp = Object.entries(c.clusters || {}).map(([ep, ks]) => byEp[ep].utts
    .filter((u) => ks.includes(u.speaker) && u.end - u.start >= 1.2)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))
    .map((u) => ({ ep, u })));
  const out = [];
  for (let i = 0; out.length < n && perEp.some((xs) => i < xs.length); i++) {
    for (const xs of perEp) if (i < xs.length && out.length < n) out.push(xs[i]);
  }
  return out;
}

async function describeLook(llm, c, samples, byEp, { model, frames = 3, width = 480 }) {
  llm.tag = "S-look";
  const content = [{
    type: "text",
    text: `Nhân vật: «${c.vi || c.zh}» (${c.zh}), ${GENDER_VI[c.gender]}. ${c.note}\n\n`
      + `Các khung dưới đây cắt từ ${samples.length} câu mà nhân vật này ĐANG NÓI, mỗi câu ${frames} khung:`,
  }];
  const images = [];
  try {
    for (const [si, s] of samples.entries()) {
      const video = path.join(byEp[s.ep].episode.videoDir, "video.mp4");
      for (let k = 0; k < frames; k++) {
        const t = s.u.start + ((s.u.end - s.u.start) * (k + 0.5)) / frames;
        const img = await grab(video, t, width);
        content.push({ type: "text", text: `Khung ${images.length} (câu ${si + 1}, tập ${s.ep}):` });
        content.push({ type: "image_url", image_url: { url: img } });
        images.push(img);
      }
    }
    const r = await llm.chat(model, [
      { role: "system", content: LOOK_SYS },
      { role: "user", content },
    ], { temperature: 0.0, maxTokens: 800 });
    const j = jparse(r.text);
    return {
      look: String(j.look || ""),
      frames: [].concat(j.frames || []).map(Number).filter((i) => i >= 0 && i < images.length),
      sure: Boolean(j.sure),
      why: String(j.why || ""),
      images,
    };
  } catch (ex) {
    const error = String(ex?.message || ex).slice(0, 300);
    return { look: "", frames: [], sure: false, why: `lỗi: ${error.slice(0, 120)}`, images, error };
  }
}

/**
 * Giới tính mà câu tả ngoại hình tự nói ra ("Nữ, tóc…", "Ông già…") — null nếu không nói.
 * Lệch với giới tính trong hồ sơ là dấu hiệu VLM tả nhầm NGƯỜI NGHE (máy quay hay chiếu mặt
 * người nghe) hoặc hồ sơ sai giới tính. Gặp thật: 苏宇 hồ sơ nam, look "Nữ, ấn tím giữa trán".
 */
export function lookGender(look) {
  const t = String(look || "").toLowerCase().split(/[^\p{L}]+/u).filter(Boolean).slice(0, 3);
  if (!t.length) return null;
  const has = (...ws) => ws.some((w) => t.includes(w));
  const f = has("nữ", "nàng") || ["cô", "bà"].includes(t[0]);
  const m = has("nam", "chàng") || ["ông", "lão"].includes(t[0]) || (t[0] === "thanh" && t[1] === "niên")
    || (t[0] === "thiếu" && t[1] === "niên") || (t[0] === "đàn" && t[1] === "ông");
  return f === m ? null : f ? "female" : "male";
}

export async function contrastLooks(llm, cast, { model }) {
  const xs = cast.filter((c) => c.lookRaw);
  if (xs.length < 2) return {};
  llm.tag = "S-look";
  const r = await llm.chat(model, [
    { role: "system", content: LOOK_CONTRAST_SYS },
    { role: "user", content: xs.map((c) => `${c.id} — ${c.vi || c.zh} (${GENDER_VI[c.gender]}): ${c.lookRaw}`).join("\n") },
  ], { jsonMode: true, maxTokens: 4000, temperature: 0.2 });
  return jparse(r.text);
}

// ---------- chạy cả chuỗi ----------

export async function initSeries({
  videoDirs, seriesDir, outRoot = null,
  glossary = {}, terms = null, inputs = {},
  llm, models, log = NULL_LOG,
  force = false, minSec = MIN_EP_SEC, noLooks = false,
  onEvent = null,
} = {}) {
  if (!videoDirs?.length) throw new Error("thiếu danh sách thư mục video");
  if (!seriesDir) throw new Error("thiếu seriesDir");
  const biblePath = path.join(seriesDir, "bible.json");
  if (!force && (await exists(biblePath))) {
    throw new Error(`${biblePath} đã có. Bổ sung tập mới vào bible có sẵn chưa làm; --force để dựng lại nháp từ đầu`);
  }
  const draftDir = path.join(seriesDir, "draft");
  await fs.mkdir(draftDir, { recursive: true });
  const root = path.resolve(outRoot || path.join("out", path.basename(path.resolve(seriesDir))));

  const episodes = await episodeMap(videoDirs, { minSec });
  for (const e of episodes) {
    log.info(`[tập] ${e.use ? `tập ${e.ep}` : "BỎ   "}  ${e.videoId}  ${e.duration ?? "?"}s  ${e.title}${e.why ? `  — ${e.why}` : ""}`);
  }
  const used = episodes.filter((e) => e.use);
  if (!used.length) throw new Error("không còn tập nào dùng được (thiếu STT hoặc video quá ngắn)");

  // sự kiện tiến độ cho UI — cùng khuôn với runPipeline, thêm các bước cấp series
  const ev = (t, d = {}) => {
    if (!onEvent) return;
    try {
      onEvent({ t, ...d });
    } catch { /* người nghe hỏng không được làm hỏng lượt init */ }
  };
  const step = (id, status, d = {}) => ev("step", { id, status, ...d });
  const prevOnCall = llm.onCall;
  if (onEvent) llm.onCall = (c) => ev("call", { ...c, ep: null });
  ev("plan", {
    kind: "series",
    episodes: episodes.map(({ ep, videoId, duration, title, use, why }) => ({ ep, videoId, duration, title, use, why })),
    steps: [
      ...used.map((e) => ({ id: `ep${e.ep}`, title: `Tập ${e.ep}: sửa ASR` })),
      { id: "merge", title: `Tự suy dàn nhân vật (gộp ${used.length} tập)` },
      ...(noLooks ? [] : [{ id: "look", title: "Tả ngoại hình từng nhân vật" }, { id: "contrast", title: "Viết lại ngoại hình cho nổi khác biệt" }]),
      { id: "rough", title: "Dịch thô câu mẫu cho người duyệt" },
    ],
  });

  // 2. từng tập: pass A. Mỗi tập một sổ usage riêng, cuối cùng dồn về sổ chung.
  const eps = [];
  for (const e of used) {
    log.info(`[tập ${e.ep}] pass A (sửa ASR)`);
    step(`ep${e.ep}`, "start");
    const sub = llm.fork();
    const res = await runPipeline({
      transcript: await readJson(path.join(e.videoDir, "transcript.json")),
      glossary, terms, ep: e.ep, epTitle: e.title || null,
      outDir: path.join(root, epDir(e.ep)),
      video: path.join(e.videoDir, "video.mp4"),
      stopAfter: "A", skipReview: true,
      llm: sub, models,
      log: { info: (s) => log.info("  " + s), warn: (s) => log.warn("  " + s), error: (s) => log.error("  " + s) },
      onEvent,
    });
    llm.usage.push(...sub.usage);
    step(`ep${e.ep}`, "done", { cost: sub.cost() });
    eps.push({ ep: e.ep, episode: e, utts: res.ctx.utts });
  }
  const byEp = Object.fromEntries(eps.map((d) => [d.ep, d]));

  // 3. tự suy — có cache: chạy lại init (vd. sau khi sửa bước look) không được xáo lại dàn nhân vật
  const input = mergeInput(eps, episodes, { glossary, pinned: terms, log });
  const mergeKey = sig(models.profile, SERIES_SYS, input);
  const mergeFile = path.join(draftDir, "merge.json");
  const cached = await readJson(mergeFile);
  let merged;
  if (cached?.key === mergeKey) {
    merged = cached.value;
    log.info("[gộp] dùng lại draft/merge.json");
    step("merge", "reused");
  } else {
    log.info(`[tự suy] B2b một lượt trên thoại ${eps.length} tập -> dàn nhân vật (${models.profile})`);
    step("merge", "start");
    merged = await mergeCast(llm, input, { model: models.profile });
    await fs.writeFile(mergeFile, JSON.stringify({ key: mergeKey, value: merged }, null, 1), "utf8");
  }
  const draft = validateDraft(merged, eps, terms || {});
  step("merge", "done", { cast: draft.cast.length, doubts: draft.doubts.length });
  log.info(`[gộp] ${draft.cast.length} nhân vật, ${Object.keys(draft.terms).length} thuật ngữ, `
    + `${draft.address.length} cặp xưng hô, ${draft.doubts.length} điều máy không chắc`);

  // 4. mẫu nghe + look
  const lookCache = (await readJson(path.join(draftDir, "looks.json"))) || {};
  const lookFail = [];
  let lookDead = false;
  const mediaByCast = {};
  const sampleUtts = [];
  if (!noLooks) step("look", "start", { done: 0, total: draft.cast.length });
  for (const [ci, c] of draft.cast.entries()) {
    if (!noLooks && ci) step("look", "progress", { done: ci, total: draft.cast.length });
    const smp = samplesOf(c, byEp);
    c.samples = smp.map((s) => ({ ep: s.ep, id: s.u.id, zh: s.u.zh, start: s.u.start, end: s.u.end }));
    const clips = [];
    for (const s of smp) {
      const video = path.join(byEp[s.ep].episode.videoDir, "video.mp4");
      const m = await media(video, [s.u], null, { n: 0 });
      clips.push(m[s.u.id]?.clip || "");
      sampleUtts.push({ id: `${c.id}:${s.ep}:${s.u.id}`, zh: s.u.zh });
    }
    mediaByCast[c.id] = { clips, images: [] };
    if (noLooks || lookDead || !smp.length) continue;

    const key = `${c.zh}|${smp.map((s) => `${s.ep}@${s.u.start}`).join(",")}|${models.vision}`;
    let L = lookCache[key];
    if (!L) {
      log.info(`[look] ${c.id} ${c.vi || c.zh}: ${smp.length} câu × 3 khung`);
      L = await describeLook(llm, c, smp, byEp, { model: models.vision });
      if (L.error) {
        // KHÔNG cache lượt hỏng: đã từng cache nguyên lỗi 403 nên chạy lại cũng không gọi lại
        lookFail.push(`${c.vi || c.zh}: ${L.error}`);
        log.warn(`look ${c.id} hỏng: ${L.error}`);
        if (/\b40[13]\b/.test(L.error)) {
          lookDead = true; // hết quota / sai key: các nhân vật sau cũng sẽ hỏng y hệt
          log.warn(`${models.vision} bị từ chối (hết quota/sai key) — bỏ bước look cho các nhân vật còn lại; đổi model bằng ZHVI_VISION`);
        }
      } else {
        lookCache[key] = L;
        await fs.writeFile(path.join(draftDir, "looks.json"), JSON.stringify(lookCache), "utf8");
      }
    }
    Object.assign(c, { lookRaw: L.look, look: L.look, lookSure: L.sure, lookWhy: L.why, lookFrames: L.frames });
    mediaByCast[c.id].images = L.images;
  }
  if (lookFail.length) {
    draft.doubts.unshift(`KHÔNG tả được ngoại hình ${lookFail.length} nhân vật — look để trống thì kênh hình khi dịch sẽ yếu. `
      + `Lỗi: ${lookFail[0].slice(0, 160)}`);
  }
  if (!noLooks) step("look", lookFail.length ? "warn" : "done", { done: draft.cast.length, total: draft.cast.length, failed: lookFail.length });
  if (!noLooks) {
    step("contrast", "start");
    // có cache như lượt gộp: chạy lại init không được trả tiền lại lẫn đổi chữ của look
    const xs = draft.cast.filter((c) => c.lookRaw).map((c) => [c.id, c.vi || c.zh, c.gender, c.lookRaw]);
    const key = sig(models.cast, LOOK_CONTRAST_SYS, xs);
    const file = path.join(draftDir, "contrast.json");
    const cached = await readJson(file);
    try {
      let sharp = cached?.key === key ? cached.value : null;
      if (!sharp) {
        sharp = await contrastLooks(llm, draft.cast, { model: models.cast });
        await fs.writeFile(file, JSON.stringify({ key, value: sharp }, null, 1), "utf8");
      }
      for (const c of draft.cast) if (sharp[c.id]) c.look = String(sharp[c.id]);
      step("contrast", "done");
    } catch (ex) {
      log.warn(`viết lại look cho nổi chỗ khác nhau hỏng (${ex.message}) — giữ bản tả riêng từng người`);
      step("contrast", "warn", { error: ex.message });
    }
  }
  for (const c of draft.cast) {
    const g = lookGender(c.lookRaw);
    if (g && c.gender !== "?" && g !== c.gender) {
      const vi = { male: "nam", female: "nữ" };
      c.doubt = [c.doubt, `ảnh tả là ${vi[g]} nhưng hồ sơ ghi ${vi[c.gender]} — hoặc máy tả nhầm người đang nghe, `
        + "hoặc sai giới tính: nghe tiếng + nhìn ảnh rồi sửa một trong hai"].filter(Boolean).join("; ");
    }
  }

  // bản dịch thô của câu mẫu: người duyệt không đọc được chữ Hán
  const pseudo = {
    terms: Object.fromEntries(Object.entries(draft.terms).map(([zh, t]) => [zh, { ...t, approved: true }])),
    cast: draft.cast,
  };
  step("rough", "start");
  const vi = await roughVi(llm, sampleUtts, pseudo, path.join(draftDir, "rough_vi.json"), { model: models.mt });
  for (const c of draft.cast) {
    for (const s of c.samples) s.vi = vi[`${c.id}:${s.ep}:${s.id}`] || "";
  }
  step("rough", "done");
  if (onEvent) llm.onCall = prevOnCall;

  const out = {
    schema: BIBLE.SCHEMA,
    draft: true,
    createdAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    series: {
      id: path.basename(path.resolve(seriesDir)),
      titleZh: String(draft.series.titleZh || ""),
      titleVi: String(draft.series.titleVi || ""),
      inputs: { ...inputs, outRoot: root },
    },
    episodes,
    cast: draft.cast,
    terms: draft.terms,
    address: draft.address,
    doubts: draft.doubts,
  };
  out.version = BIBLE.version(out);
  const draftPath = path.join(draftDir, "bible.draft.json");
  await fs.writeFile(draftPath, JSON.stringify(out, null, 1), "utf8");
  const page = await buildBiblePage(out, mediaByCast, path.join(seriesDir, "bible-review.html"));
  return { draft: out, draftPath, page };
}

// ---------- đường về ----------

/**
 * Nháp + file trang duyệt xuất ra -> `bible.json`.
 *
 * File duyệt chứa GIÁ TRỊ CUỐI của mọi ô, không chỉ ô đã sửa: nạp lại bao nhiêu lần cũng ra
 * cùng một bible, và không phụ thuộc trình duyệt còn giữ localStorage hay không.
 */
export async function applyReview(reviewFile, seriesDir, { by = null, log = NULL_LOG } = {}) {
  const draftPath = path.join(seriesDir, "draft", "bible.draft.json");
  const draft = await readJson(draftPath);
  if (!draft) throw new Error(`không có ${draftPath} — chạy series init trước`);
  const rv = JSON.parse(await fs.readFile(reviewFile, "utf8"));
  if (rv.draftVersion && rv.draftVersion !== draft.version) {
    log.warn(`file duyệt dựng từ nháp ${rv.draftVersion}, nháp hiện tại là ${draft.version} — vẫn nạp theo khoá, soát lại kết quả`);
  }
  const v = rv.values || {};
  const who = by || rv.by || "fleex";
  const get = (k, dflt) => (k in v ? v[k] : dflt);
  const str = (k, dflt) => String(get(k, dflt) ?? "").trim();

  const episodes = draft.episodes.map((e) => ({
    ep: str(`ep.${e.videoId}.ep`, e.ep),
    videoId: e.videoId, videoDir: e.videoDir, duration: e.duration, title: e.title,
    hasStt: e.hasStt, use: Boolean(get(`ep.${e.videoId}.use`, e.use)),
    approved: true, reviewedBy: who,
  }));
  const nums = episodes.filter((e) => e.use).map((e) => e.ep);
  if (nums.some((n) => !n)) throw new Error("có tập được dùng mà chưa có số tập");
  if (new Set(nums).size !== nums.length) throw new Error(`số tập bị trùng: ${nums.join(", ")}`);

  const ids = new Set(draft.cast.map((c) => c.id));
  const dropped = new Set(draft.cast.filter((c) => get(`cast.${c.id}.drop`, false)).map((c) => c.id));
  const into = new Map(draft.cast
    .map((c) => [c.id, str(`cast.${c.id}.merge`, "")])
    .filter(([id, t]) => t && t !== id && ids.has(t)));
  const final = (id) => {
    const seenIds = new Set();
    let cur = id;
    while (into.has(cur) && !seenIds.has(cur)) {
      seenIds.add(cur);
      cur = into.get(cur);
    }
    return cur;
  };

  const cast = [];
  const byId = new Map();
  for (const c of draft.cast) {
    if (dropped.has(c.id) || into.has(c.id)) continue;
    const k = (f, d) => str(`cast.${c.id}.${f}`, d);
    const row = {
      id: c.id, zh: c.zh, vi: k("vi", c.vi), viShort: k("viShort", c.viShort),
      gender: k("gender", c.gender), role: k("role", c.role),
      alias: [...c.alias], note: k("note", c.note), look: k("look", c.look || ""),
      approved: true, reviewedBy: who,
    };
    cast.push(row);
    byId.set(c.id, row);
  }
  for (const c of draft.cast) {
    if (!into.has(c.id) || dropped.has(c.id)) continue;
    const t = byId.get(final(c.id));
    if (!t) continue; // gộp vào một nhân vật đã bị bỏ
    t.alias = uniq([...t.alias, c.zh, ...c.alias]).filter((a) => a !== t.zh);
    log.info(`[gộp] ${c.zh} -> ${t.zh}`);
  }

  const address = [];
  const seenPair = new Set();
  draft.address.forEach((a, i) => {
    if (get(`addr.${i}.drop`, false)) return;
    const from = final(a.from);
    const to = final(a.to);
    if (!byId.has(from) || !byId.has(to) || from === to) return;
    const key = `${from}|${to}|${a.fromEp}`;
    if (seenPair.has(key)) return;
    seenPair.add(key);
    address.push({
      from, to, self: str(`addr.${i}.self`, a.self), other: str(`addr.${i}.other`, a.other),
      fromEp: a.fromEp, why: a.why, approved: true, reviewedBy: who,
    });
  });

  const terms = {};
  for (const [zh, t] of Object.entries(draft.terms)) {
    if (!t.pinned && get(`term.${zh}.drop`, false)) continue;
    terms[zh] = {
      vi: t.pinned ? t.vi : str(`term.${zh}.vi`, t.vi),
      approved: true, source: t.source, reviewedBy: t.pinned ? "ghim tay" : who,
    };
  }

  const bible = {
    schema: BIBLE.SCHEMA,
    series: {
      id: draft.series.id, titleZh: draft.series.titleZh,
      titleVi: str("series.titleVi", draft.series.titleVi),
      approved: true, reviewedBy: who, inputs: draft.series.inputs,
    },
    episodes, cast, address, terms,
    pending: { terms: {}, cast: [], address: [] },
    suspectTerms: {},
    doubtsAtInit: draft.doubts,
    fromDraft: draft.version,
  };
  const biblePath = path.join(seriesDir, "bible.json");
  if (await exists(biblePath)) await fs.copyFile(biblePath, biblePath + ".prev");
  await BIBLE.save(bible, biblePath);
  return { biblePath, bible, commands: translateCommands(bible, biblePath) };
}

/** Lệnh dịch từng tập — cùng outDir với lượt init, nên A2 dùng lại checkpoint. */
/** Đối số lệnh dịch một tập (sau "node src/zhvi/cli.js"). CLI in ra, UI chạy thẳng — một nguồn, không lệch nhau. */
export function translateArgs(bible, biblePath, e) {
  const rel = (p) => path.relative(process.cwd(), p) || ".";
  const inp = bible.series.inputs || {};
  return [
    rel(path.join(e.videoDir, "transcript.json")),
    ...(inp.glossary ? ["--glossary", rel(inp.glossary)] : []),
    "--bible", rel(biblePath), "--ep", String(e.ep),
    "--out", rel(path.join(inp.outRoot || "out", epDir(e.ep))),
    "--video", rel(path.join(e.videoDir, "video.mp4")),
    "--data-dir", rel(e.videoDir),
    "--cps", "4.5", "--rounds", "2",
  ];
}

export function translateCommands(bible, biblePath) {
  const q = (s) => (/[\s"'$]/.test(s) ? JSON.stringify(s) : s);
  return bible.episodes.filter((e) => e.use)
    .map((e) => ["node src/zhvi/cli.js", ...translateArgs(bible, biblePath, e).map(q)].join(" "));
}
