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
import { isVocative, relevantGlossary, repeatedTerms } from "./passes/b-speakers.js";
import { LOOK_CONTRAST_SYS, LOOK_SYS, SERIES_SYS } from "./prompts.js";
import { media, roughVi } from "./review.js";
import { buildBiblePage } from "./series-page.js";
import { grab } from "./vision.js";

const NULL_LOG = { info() {}, warn() {}, error() {} };
// Ngắn hơn ngần này thì gần như chắc không phải một tập: gặp thật ở 杂役合道 — clip 10s
// tác giả báo "đang làm tiếp, lên 书旗 đọc trước", nằm lẫn giữa các tập.
export const MIN_EP_SEC = 60;
// Hai câu cách nhau hơn ngần này thì gần như chắc đã sang cảnh khác — kéo vào "cảnh" chỉ làm nhiễu.
const SCENE_GAP_SEC = 6;
// Trần số cụm giọng chưa ai nhận đưa lên trang duyệt: quá thì trang dài mà người đọc bỏ qua hết.
const MAX_UNASSIGNED = 6;
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

  // Cụm giọng không ai nhận = có người nói mà dàn nhân vật không có chỗ cho họ. Trả ra thành dữ
  // liệu chứ không chỉ một dòng chữ: trang duyệt còn phải cho nghe, cho xem, rồi cho thêm người.
  const unassigned = [];
  for (const d of eps) {
    for (const [k, n] of Object.entries(countBy(d.utts))) {
      if (n >= 2 && !taken.has(`${d.ep}|${k}`)) {
        doubts.push(`tập ${d.ep}: cụm giọng ${k} (${n} câu) chưa gán cho nhân vật nào`);
        unassigned.push({ ep: d.ep, spk: k, lines: n });
      }
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
  return { series: m.series || {}, cast, terms, address, doubts, unassigned };
}

// ---------- 4. look + mẫu nghe ----------

/**
 * Câu mẫu của một nhân vật: trải đều qua các tập, ưu tiên câu GỌI TÊN hoặc NHẮC TÊN ai đó.
 *
 * Trước đây lấy câu DÀI NHẤT. Nhìn từ phía người duyệt thì đó là lựa chọn sai: câu dài nhất
 * thường là độc thoại, đọc xong vẫn không biết người này là ai của ai — mà đúng cái đó mới là
 * thứ trang này hỏi. Câu có tên người trong đó trả lời thẳng câu hỏi ấy.
 * Câu dưới 1,2s vẫn loại: không đủ khung để thấy miệng động, cũng không đủ tiếng để nghe ra giọng.
 */
export function samplesOf(c, byEp, n = 4, { names = [] } = {}) {
  const score = (u) => {
    const named = names.filter((nm) => nm && u.zh.includes(nm));
    return (named.some((nm) => isVocative(u.zh, nm)) ? 4 : named.length ? 2 : 0)
      + Math.min(u.end - u.start, 8) / 8;
  };
  const perEp = Object.entries(c.clusters || {}).map(([ep, ks]) => byEp[ep].utts
    .filter((u) => ks.includes(u.speaker) && u.end - u.start >= 1.2)
    .sort((a, b) => score(b) - score(a))
    .map((u) => ({ ep, u })));
  const out = [];
  for (let i = 0; out.length < n && perEp.some((xs) => i < xs.length); i++) {
    for (const xs of perEp) if (i < xs.length && out.length < n) out.push(xs[i]);
  }
  return out;
}

/**
 * Mấy câu quanh câu mẫu, cắt ở chỗ hụt tiếng (đã sang cảnh khác).
 *
 * Một câu đứng lẻ thì không phán được gì: "Ngươi dám!" là ai nói với ai cũng được. Người duyệt
 * cần thấy câu trước và câu sau mới biết đang là cảnh gì.
 */
export function sceneOf(utts, idx, { before = 2, after = 2, maxGap = SCENE_GAP_SEC } = {}) {
  let lo = idx;
  let hi = idx;
  while (lo > 0 && idx - lo < before && utts[lo].start - utts[lo - 1].end <= maxGap) lo -= 1;
  while (hi < utts.length - 1 && hi - idx < after && utts[hi + 1].start - utts[hi].end <= maxGap) hi += 1;
  return utts.slice(lo, hi + 1);
}

/** Một câu mẫu + cảnh quanh nó + chỗ phát video đúng đoạn đó. Dùng cho cả nhân vật lẫn cụm chưa ai nhận. */
function sceneSample(ep, u, byEp, videoRef) {
  const { utts } = byEp[ep];
  const scene = sceneOf(utts, utts.indexOf(u));
  return {
    ep, id: u.id, zh: u.zh, start: u.start, end: u.end,
    video: videoRef[ep] || null,
    sceneStart: scene[0].start,
    sceneEnd: scene[scene.length - 1].end,
    scene: scene.map((x) => ({
      id: x.id, spk: x.speaker, zh: x.zh, start: x.start, end: x.end, self: x.id === u.id,
    })),
  };
}

/**
 * Tên người được GỌI trong thoại («大王，…» / «…，师父») mà dàn nhân vật chưa có.
 *
 * Để làm gì: người duyệt không đọc và không gõ được chữ Hán, nên muốn thêm một nhân vật máy bỏ
 * sót thì phải có sẵn danh sách tên để CHỌN. Đây là nguồn lấy được mà không tốn thêm lượt LLM
 * nào, và lọc theo vị trí gọi tên nên phần lớn là tên người thật chứ không phải thuật ngữ.
 */
export function vocativeNames(eps, known = [], { max = 12, minCount = 2 } = {}) {
  const dup = (nm) => known.some((k) => k && (k.includes(nm) || nm.includes(k)));
  const RE = [/^([一-鿿]{2,4})[，,、]/, /[，,、]([一-鿿]{2,4})[？！。?!]?$/];
  const hits = new Map();
  for (const d of eps) {
    for (const u of d.utts) {
      for (const re of RE) {
        const nm = u.zh.match(re)?.[1];
        if (!nm || dup(nm)) continue;
        const e = hits.get(nm) || { zh: nm, count: 0, ep: d.ep, line: null };
        e.count += 1;
        if (!e.line || u.end - u.start > e.line.end - e.line.start) {
          e.line = u;
          e.ep = d.ep;
        }
        hits.set(nm, e);
      }
    }
  }
  return [...hits.values()].filter((x) => x.count >= minCount)
    .sort((a, b) => b.count - a.count).slice(0, max);
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
      { id: "rough", title: "Dịch thô cảnh mẫu cho người duyệt" },
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
  // Chỗ phát video của từng tập. Trang duyệt mở được cả bằng file:// lẫn qua UI nên ghi hai
  // đường: tương đối (từ series/<slug>/bible-review.html) và từ gốc repo (UI phục vụ /media/…).
  const videoRef = {};
  for (const e of used) {
    const f = path.join(e.videoDir, "video.mp4");
    if (!(await exists(f))) {
      videoRef[e.ep] = null;
      continue;
    }
    const repo = path.relative(process.cwd(), f).split(path.sep).join("/");
    videoRef[e.ep] = {
      rel: path.relative(path.resolve(seriesDir), f).split(path.sep).join("/"),
      repo: repo.startsWith("..") ? null : repo,
    };
  }
  const noVideo = used.filter((e) => !videoRef[e.ep]);
  if (noVideo.length) {
    log.warn(`${noVideo.length} tập không có video.mp4 — trang duyệt sẽ không có nút xem cảnh (tập ${noVideo.map((e) => e.ep).join(", ")})`);
  }

  const lookCache = (await readJson(path.join(draftDir, "looks.json"))) || {};
  const lookFail = [];
  let lookDead = false;
  const mediaByCast = {};
  const sampleUtts = [];
  const castNames = uniq(draft.cast.flatMap((c) => [c.zh, ...(c.alias || [])]));
  if (!noLooks) step("look", "start", { done: 0, total: draft.cast.length });
  for (const [ci, c] of draft.cast.entries()) {
    if (!noLooks && ci) step("look", "progress", { done: ci, total: draft.cast.length });
    const smp = samplesOf(c, byEp, 4, { names: castNames });
    c.samples = smp.map((s) => sceneSample(s.ep, s.u, byEp, videoRef));
    const clips = [];
    for (const [si, s] of smp.entries()) {
      const video = path.join(byEp[s.ep].episode.videoDir, "video.mp4");
      const m = videoRef[s.ep] ? await media(video, [s.u], null, { n: 0 }) : {};
      clips.push(m[s.u.id]?.clip || "");
      // dịch thô CẢ CẢNH, không chỉ câu mẫu — câu lẻ thì người duyệt không phán được gì
      for (const l of c.samples[si].scene) sampleUtts.push({ id: `${c.id}:${s.ep}:${l.id}`, zh: l.zh });
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

  // 4b. cụm giọng chưa ai nhận: có người nói mà dàn nhân vật không có chỗ cho họ. Đưa cả tiếng,
  // cảnh và video lên trang để người duyệt quyết được "đây là nhân vật máy bỏ sót" hay không.
  const unassigned = [];
  for (const un of [...(draft.unassigned || [])].sort((a, b) => b.lines - a.lines).slice(0, MAX_UNASSIGNED)) {
    const { utts, episode } = byEp[un.ep];
    const best = utts.filter((u) => u.speaker === un.spk)
      .sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    if (!best) continue;
    const s = sceneSample(un.ep, best, byEp, videoRef);
    let clip = "";
    if (videoRef[un.ep]) {
      try {
        clip = (await media(path.join(episode.videoDir, "video.mp4"), [best], null, { n: 0 }))[best.id]?.clip || "";
      } catch (ex) {
        log.warn(`không cắt được tiếng cho cụm ${un.spk} tập ${un.ep}: ${ex.message}`);
      }
    }
    unassigned.push({ ...un, ...s, clip });
    for (const l of s.scene) sampleUtts.push({ id: `un:${un.ep}:${un.spk}:${l.id}`, zh: l.zh });
  }

  // 4c. tên được gọi trong thoại mà chưa thành nhân vật — để người duyệt CHỌN khi thêm người,
  // vì họ không gõ được chữ Hán. Dịch thô cả cái tên lẫn một câu có nó.
  const nameCands = vocativeNames(eps, [...castNames, ...Object.keys(draft.terms)]);
  for (const t of nameCands) {
    sampleUtts.push({ id: `cand:${t.zh}`, zh: t.zh }, { id: `candline:${t.zh}`, zh: t.line.zh });
  }

  // bản dịch thô của câu mẫu: người duyệt không đọc được chữ Hán
  const pseudo = {
    terms: Object.fromEntries(Object.entries(draft.terms).map(([zh, t]) => [zh, { ...t, approved: true }])),
    cast: draft.cast,
  };
  step("rough", "start");
  const vi = await roughVi(llm, sampleUtts, pseudo, path.join(draftDir, "rough_vi.json"), { model: models.mt });
  for (const c of draft.cast) {
    for (const s of c.samples) {
      for (const l of s.scene) l.vi = vi[`${c.id}:${s.ep}:${l.id}`] || "";
      s.vi = s.scene.find((l) => l.self)?.vi || "";
    }
  }
  for (const un of unassigned) {
    for (const l of un.scene) l.vi = vi[`un:${un.ep}:${un.spk}:${l.id}`] || "";
    un.vi = un.scene.find((l) => l.self)?.vi || "";
  }
  const candidates = nameCands.map((t) => ({
    zh: t.zh, count: t.count, ep: t.ep,
    vi: vi[`cand:${t.zh}`] || "",
    line: { zh: t.line.zh, vi: vi[`candline:${t.zh}`] || "" },
  }));
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
    unassigned,
    candidates,
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

  /*
   * Nhân vật người duyệt THÊM tay. Máy bỏ sót một người là ngõ cụt thật: trang soát người nói
   * từng tập chỉ cho chọn trong dàn nhân vật của bible, nên không thêm được ở đây thì cả loạt
   * tập sau không có cách nào gán đúng.
   *
   * Ở đây chỉ nhận DANH TÍNH, không nhận cụm giọng: bible không giữ cụm (mỗi tập tự suy lại),
   * và cụm là chuyện của từng tập chứ không phải của cả bộ.
   */
  let maxId = Math.max(0, ...draft.cast.map((c) => Number(String(c.id).replace(/\D+/g, "")) || 0));
  for (const i of uniq(Object.keys(v).filter((k) => /^new\.\d+\./.test(k)).map((k) => k.split(".")[1]))
    .sort((a, b) => Number(a) - Number(b))) {
    const k = (f) => str(`new.${i}.${f}`, "");
    const viName = k("vi");
    if (!viName) continue; // hàng bỏ trống: trang luôn xuất mọi ô, kể cả ô chưa gõ gì
    // Khoá dữ liệu là tên chữ Hán. Người duyệt không gõ được chữ Hán nên bỏ trống thì lấy tên
    // Việt làm khoá: nó không bao giờ khớp chữ trong thoại, tức kênh "gọi tên" im lặng — không
    // đúng thêm được gì, nhưng cũng không gán bừa.
    const zh = k("zh") || viName;
    if (cast.some((c) => c.zh === zh)) {
      log.warn(`[thêm] bỏ qua «${viName}»: tên ${zh} đã có trong bible`);
      continue;
    }
    maxId += 1;
    const row = {
      id: `C${maxId}`, zh, vi: viName, viShort: k("viShort"),
      gender: GENDER[k("gender").toLowerCase()] || "?",
      role: ["main", "episodic", "mentioned"].includes(k("role")) ? k("role") : "episodic",
      alias: [], note: k("note"), look: k("look"),
      source: "người duyệt thêm", approved: true, reviewedBy: who,
    };
    cast.push(row);
    byId.set(row.id, row);
    log.info(`[thêm] ${row.vi} (${row.zh})`);
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
