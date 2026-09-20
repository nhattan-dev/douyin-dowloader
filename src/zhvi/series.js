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
import { isVocative, relevantGlossary, repeatedTerms, vocativeNames } from "./passes/b-speakers.js";
import { LOOK_CONTRAST_SYS, LOOK_SYS, SERIES_SYS } from "./prompts.js";
import { media, roughVi } from "./review.js";
import { buildBiblePage } from "./series-page.js";
import { denied, grab, pool } from "./vision.js";

const NULL_LOG = { info() {}, warn() {}, error() {} };
// Ngắn hơn ngần này thì gần như chắc không phải một tập: gặp thật ở 杂役合道 — clip 10s
// tác giả báo "đang làm tiếp, lên 书旗 đọc trước", nằm lẫn giữa các tập.
export const MIN_EP_SEC = 60;
// Hai câu cách nhau hơn ngần này thì gần như chắc đã sang cảnh khác — kéo vào "cảnh" chỉ làm nhiễu.
const SCENE_GAP_SEC = 6;
const LOOK_CONCURRENCY = 3; // lời gọi VLM tả ngoại hình cùng lúc — vision hay bị giới hạn tần suất
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
  const asr = asrFlagsOf(m, byEp, idMap, cast, taken, doubts);
  return { series: m.series || {}, cast, terms, address, doubts, unassigned, asr };
}

/**
 * Cờ lỗi tách giọng model tự khai (cụm lẫn người, một câu nhiều người) -> dữ liệu cho cổng soát
 * TỪNG TẬP, không cho bible: cụm thuộc về tập, không thuộc về bộ.
 *
 * Nhân vật ghi bằng tên (zh + vi) chứ không bằng id, vì trang duyệt bible được quyền xoá/đánh số
 * lại; câu ghi kèm nguyên văn chữ Hán để lúc dùng kiểm được id câu chưa trôi.
 * Model khai bừa (câu không có, cụm sai, id cast không có) thì bỏ và đếm vào doubts.
 */
function asrFlagsOf(m, byEp, idMap, cast, taken, doubts) {
  const byId = new Map(cast.map((c) => [c.id, c]));
  const who = (x) => {
    const c = byId.get(idMap.get(String(x)));
    return c ? { id: c.id, zh: c.zh, vi: c.vi } : null;
  };
  const name = (w) => w.vi || w.zh;
  const out = {};
  let bad = 0;
  for (const f of [].concat(m.mixedClusters || [])) {
    const d = byEp[String(f?.ep)];
    const line = (i) => d?.utts.find((u) => u.id === Number(i));
    if (!d || !f.spk) {
      bad += 1;
      continue;
    }
    const owner = taken.get(`${d.ep}|${f.spk}`);
    const lines = {};
    for (const [i, x] of Object.entries(f.lines || {})) {
      const u = line(i);
      const w = who(x);
      if (!u || u.speaker !== f.spk || !w) bad += 1;
      else if (w.id !== owner) lines[u.id] = { zh: u.zh, who: { zh: w.zh, vi: w.vi } };
    }
    if (!Object.keys(lines).length) continue;
    const e = (out[d.ep] ||= { clusters: {}, lines: {} });
    e.clusters[f.spk] = { why: String(f.why || ""), lines };
    const ppl = [...new Set(Object.values(lines).map((l) => name(l.who)))];
    doubts.push(`tập ${d.ep}: cụm ${f.spk} lẫn người — ${Object.keys(lines).length} câu là của ${ppl.join(", ")}`
      + `${f.why ? ` (${f.why})` : ""}; soát ở trang người nói của tập`);
  }
  for (const f of [].concat(m.mixedLines || [])) {
    const d = byEp[String(f?.ep)];
    const u = d?.utts.find((x) => x.id === Number(f?.line));
    const ws = [].concat(f?.who || []).map(who).filter(Boolean);
    if (!u) {
      bad += 1;
      continue;
    }
    const e = (out[d.ep] ||= { clusters: {}, lines: {} });
    e.lines[u.id] = { zh: u.zh, who: ws.map((w) => ({ zh: w.zh, vi: w.vi })), why: String(f.why || "") };
    doubts.push(`tập ${d.ep}: câu ${u.id} chứa lời nhiều người${ws.length ? ` (${ws.map(name).join(" → ")})` : ""}`
      + " — máy không cắt được, câu này sẽ không lồng tiếng bằng giọng ai");
  }
  if (bad) doubts.push(`đã bỏ ${bad} cờ lỗi tách giọng máy khai sai chỗ (câu/cụm/nhân vật không có thật)`);
  return out;
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

async function describeLook(llm, c, samples, byEp, { model, frames = 3, width = 480 }) {
  llm.tag = "S-look";
  const content = [{
    type: "text",
    text: `Nhân vật: «${c.vi || c.zh}» (${c.zh}), ${GENDER_VI[c.gender]}. ${c.note}\n\n`
      + `Các khung dưới đây cắt từ ${samples.length} câu mà nhân vật này ĐANG NÓI, mỗi câu ${frames} khung:`,
  }];
  const images = [];
  try {
    const shots = samples.flatMap((s, si) => Array.from({ length: frames }, (_, k) => ({
      si, s, t: s.u.start + ((s.u.end - s.u.start) * (k + 0.5)) / frames,
    })));
    const imgs = await Promise.all(shots.map(({ s, t }) => grab(path.join(byEp[s.ep].episode.videoDir, "video.mp4"), t, width)));
    for (const [i, { si, s }] of shots.entries()) {
      content.push({ type: "text", text: `Khung ${i} (câu ${si + 1}, tập ${s.ep}):` });
      content.push({ type: "image_url", image_url: { url: imgs[i] } });
      images.push(imgs[i]);
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
  // Mẫu nghe + cảnh: tuần tự, rẻ, và thứ tự `sampleUtts` không được phụ thuộc lời gọi nào về trước.
  const smpOf = {};
  for (const c of draft.cast) {
    const smp = samplesOf(c, byEp, 4, { names: castNames });
    smpOf[c.id] = smp;
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
  }

  // look: mỗi nhân vật một lời gọi VLM, chạy song song có trần. 401/403 thì dừng các lượt chưa
  // gọi — những lượt đang bay (≤ LOOK_CONCURRENCY-1) vẫn hỏng, bị từ chối nên không mất tiền.
  let lookDone = 0;
  let lookSave = Promise.resolve(); // ghi nối đuôi: hai writeFile cùng lúc vào một file có thể đan nhau
  await pool(noLooks ? [] : draft.cast, LOOK_CONCURRENCY, async (c) => {
    const smp = smpOf[c.id];
    try {
      if (lookDead || !smp.length) return;
      const key = `${c.zh}|${smp.map((s) => `${s.ep}@${s.u.start}`).join(",")}|${models.vision}`;
      let L = lookCache[key];
      if (!L) {
        log.info(`[look] ${c.id} ${c.vi || c.zh}: ${smp.length} câu × 3 khung`);
        L = await describeLook(llm, c, smp, byEp, { model: models.vision });
        if (L.error) {
          // KHÔNG cache lượt hỏng: đã từng cache nguyên lỗi 403 nên chạy lại cũng không gọi lại
          lookFail.push(`${c.vi || c.zh}: ${L.error}`);
          log.warn(`look ${c.id} hỏng: ${L.error}`);
          if (denied(L.error) && !lookDead) {
            lookDead = true; // hết quota / sai key: các nhân vật sau cũng sẽ hỏng y hệt
            log.warn(`${models.vision} bị từ chối (hết quota/sai key) — bỏ bước look cho các nhân vật còn lại; đổi model bằng ZHVI_VISION`);
          }
        } else {
          lookCache[key] = L;
          lookSave = lookSave.then(() => fs.writeFile(path.join(draftDir, "looks.json"), JSON.stringify(lookCache), "utf8"));
          await lookSave;
        }
      }
      Object.assign(c, { lookRaw: L.look, look: L.look, lookSure: L.sure, lookWhy: L.why, lookFrames: L.frames });
      mediaByCast[c.id].images = L.images;
    } finally {
      step("look", "progress", { done: ++lookDone, total: draft.cast.length });
    }
  });
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
  // Cờ lỗi tách giọng đi thẳng tới cổng soát từng tập, không qua bible (bible không giữ cụm).
  const flagged = Object.keys(draft.asr).length;
  await fs.writeFile(path.join(seriesDir, "asr-flags.json"), JSON.stringify(draft.asr, null, 1), "utf8");
  if (flagged) {
    const n = Object.values(draft.asr).reduce((k, e) => k + Object.keys(e.clusters).length + Object.keys(e.lines).length, 0);
    log.info(`[tách giọng] máy khai ${n} chỗ lỗi ở ${flagged} tập -> asr-flags.json (cổng soát từng tập sẽ hỏi)`);
  }
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

// ---------- thêm một tập vào series đã duyệt ----------

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * Thêm MỘT tập vào series ĐÃ duyệt bible — KHÔNG dựng lại bible.
 *
 * Trước đây đường duy nhất là `series init --force`, và giá của nó không nhìn ra được từ nút
 * bấm: lượt gộp nhân vật không ổn định giữa hai lần chạy (đo trên 4 tập: 10 vs 9 nhân vật, tên
 * nhân vật chính khác), nên cast bị gieo lại và `C<n>` đổi — trong khi `ep<N>.speakers.json`,
 * `asr-flags.json` (khoá bằng tên) và thư mục kho giọng vẫn giữ id/tên cũ. Cộng cả công người
 * duyệt (vi, viShort, alias, look, bảng xưng hô) phải gõ lại từ đầu.
 *
 * Mà tập mới không cần bible mới: nhân vật/thuật ngữ mới của nó đã có đường vào từ 2026-09-19 —
 * cổng soát từng tập gọi `bible.extend()`. Nên việc còn lại chỉ là ĐÁNH SỐ và ghi thêm một hàng
 * vào `bible.episodes`: 0 lời gọi LLM, 0 checkpoint bị vứt.
 *
 * Hai luật, đừng nới:
 *
 * - **Số tập đã gán thì không bao giờ đổi.** `episodeMap` đánh số theo VỊ TRÍ (biến đếm), nên
 *   chèn một tập vào giữa là đẩy số của mọi tập sau: `out/<slug>/ep05` trỏ sang phim khác còn
 *   `ep5.speakers.json` thì ở lại — bẫy B1 leo lên cấp tập, và không có dấu hiệu nào. Vì vậy
 *   hàm này chỉ NỐI ĐUÔI (max + 1). Tập vá vào giữa (gặp thật: 剧情补档 của 飞鸟炮灰 nằm giữa
 *   tập 6 và 7) thì người tự truyền `--ep 6.1`, cùng mẹo với khoá `.k` của câu bị cắt.
 * - **Không đụng `cast`/`terms`/`address`.** `BIBLE.version()` băm đúng ba thứ đó, nên thêm tập
 *   KHÔNG đổi `bible.version`: các tập cũ không phải dịch lại. Hàm tự kiểm điều này và kêu lên
 *   nếu version đổi — version đổi nghĩa là đã đụng nhầm chỗ.
 */
export async function addEpisode(videoDir, seriesDir, {
  ep = null, force = false, minSec = MIN_EP_SEC, by = "fleex", log = NULL_LOG,
} = {}) {
  const biblePath = path.join(seriesDir, "bible.json");
  if (!(await exists(biblePath))) {
    throw new Error(`${biblePath} chưa có — series chưa duyệt bible thì cứ thêm video vào series.json `
      + "rồi chạy `series init` như thường, chưa có gì để giữ gìn cả");
  }
  const b = await BIBLE.load(biblePath);
  const dir = path.resolve(videoDir);
  // `meta.json` là dấu của lượt tải xong, và là nguồn DUY NHẤT của thời lượng ở đây. Thiếu nó thì
  // `duration` thành null và mọi cửa chặn bên dưới im lặng cho qua — đo thật: clip 15s "xem full ở
  // đâu" lọt vào thành một tập mà không một dòng cảnh báo. Thà dừng: đường thật (fetch -> stt)
  // luôn ghi meta.json, nên thiếu nó nghĩa là thư mục này không phải thứ ta tưởng.
  const meta = await readJson(path.join(dir, "meta.json"));
  if (!meta) throw new Error(`${dir} không có meta.json — video chưa tải xong, tải + STT trước rồi thêm`);
  const videoId = String(meta.videoId || path.basename(dir));

  if (!(await exists(path.join(dir, "transcript.json")))) {
    throw new Error(`${videoId} chưa có transcript.json — tải + STT trước rồi thêm`);
  }
  const dup = b.episodes.find((e) => e.videoId === videoId);
  if (dup) throw new Error(`${videoId} đã nằm trong series này${dup.ep ? ` (tập ${dup.ep})` : " (đang bị gạt)"}`);

  const sec = meta.duration ? Math.round(meta.duration / 1000) : null;
  if (sec !== null && sec < minSec && !force) {
    throw new Error(`video chỉ ${sec}s — giống thông báo/trailer hơn là một tập (gặp thật ở 杂役合道: `
      + `clip 10s tác giả báo "lên 书旗 đọc trước", nằm lẫn giữa các tập). Đúng là tập thì thêm --force`);
  }

  const used = b.episodes.filter((e) => e.use);
  // Bộ lọc của init chỉ chặn video NGẮN. Bản gộp nhiều tập thì dài, lọt hết — mà CLAUDE.md đã đo
  // giá của việc nuốt phải: chạy trọn file 47 phút ra 3 cụm giọng cho ~20 nhân vật, 263/542 nhãn
  // thành chuỗi rác. So với trung vị các tập ĐÃ CÓ chứ không so với hằng số: mỗi series một nhịp.
  const med = median(used.map((e) => e.duration));
  if (sec && med && sec > med * 3) {
    log.warn(`video dài ${mmss(sec)} trong khi trung vị các tập là ${mmss(med)} — nghi là BẢN GỘP nhiều `
      + "tập. Gộp nhiều tập vào một lượt làm diarize gom hết vào vài cụm giọng và nhãn người nói "
      + "thành rác. Kiểm lại trước khi dịch.");
  }

  // Nối đuôi: số lớn nhất + 1. Không đánh số lại ai hết.
  const nums = used.map((e) => Number(e.ep)).filter((n) => Number.isFinite(n) && n > 0);
  const num = String(ep ?? (nums.length ? Math.max(...nums) + 1 : 1)).trim();
  if (!num) throw new Error("số tập rỗng");
  const clash = b.episodes.find((e) => e.use && String(e.ep) === num);
  if (clash) throw new Error(`đã có tập ${num} (${clash.videoId}) — chọn số khác bằng --ep`);

  // Thư mục kết quả trùng nghĩa là số tập này từng được dùng rồi: đè lên là trộn hai phim.
  const outRoot = b.series?.inputs?.outRoot || path.join("out", path.basename(path.resolve(seriesDir)));
  const outDir = path.join(outRoot, epDir(num));
  if ((await exists(outDir)) && !force) {
    throw new Error(`${outDir} đã có sẵn — số tập ${num} từng được dùng. Chọn số khác bằng --ep, `
      + "hoặc --force nếu chắc chắn thư mục đó là rác");
  }

  const row = {
    ep: num, videoId, videoDir: dir, duration: sec, title: cleanTitle(meta.desc),
    hasStt: true, use: true, approved: true, reviewedBy: by,
    source: "thêm sau khi duyệt bible", addedAt: new Date().toISOString(),
  };
  b.episodes.push(row);
  // Xếp theo số tập cho trang đọc xuôi. An toàn vì số tập là DANH TÍNH chứ không phải vị trí —
  // mọi nơi đều tra theo `ep`, không nơi nào tra theo chỉ số mảng.
  b.episodes.sort((x, y) => (Number(x.ep) || Infinity) - (Number(y.ep) || Infinity));

  const before = b.version;
  await fs.copyFile(biblePath, biblePath + ".prev");
  const version = await BIBLE.save(b, biblePath);
  if (version !== before) {
    log.warn(`bible.version đổi ${before} -> ${version}: thêm tập lẽ ra chỉ đụng \`episodes\`, `
      + "mà version chỉ băm cast/terms/address. Xem lại hàm addEpisode.");
  }

  // series.json là thứ UI dùng để dò tập mới của 合集 — không ghi vào thì tập vừa thêm cứ hiện ra
  // mãi ở mục "tác giả đã đăng tập mới".
  const metaPath = path.join(seriesDir, "series.json");
  const sm = await readJson(metaPath);
  if (sm) {
    sm.videoIds = [...new Set([...(sm.videoIds || []), videoId])];
    await fs.writeFile(metaPath, JSON.stringify(sm, null, 1), "utf8");
  }

  log.info(`[tập] thêm tập ${num} — ${videoId}${sec ? ` (${mmss(sec)})` : ""}${row.title ? ` 《${row.title}》` : ""}`);
  return { biblePath, bible: b, ep: num, videoId, version, versionChanged: version !== before, row };
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
