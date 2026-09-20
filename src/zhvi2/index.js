/**
 * zhvi2 — dịch một tập bằng todo LLM (Claude Sonnet web). Mỗi tập HAI task:
 *
 *   V  vision      VLM xem khung hình ở vài câu mỏ neo (giữ nguyên v1: todo LLM không nhận ảnh)
 *   U  understand  task 1: sửa ASR + gán người nói + tách câu gộp người + dịch thô cho trang soát
 *   —  cổng soát   giữ nguyên v1: `review.html` → `--apply` → nhãn người thắng mọi kênh máy
 *   T  translate   task 2: dịch cả tập, tự soát trong cùng task
 *   E  export      translation.json đúng schema douyind (dùng lại export của v1)
 *
 * Luật giữ nguyên v1: đĩa là nguồn sự thật, checkpoint theo chữ ký nội dung, công đoạn miễn phí
 * không bao giờ checkpoint, cổng soát chặn một lần, chưa có bible thì không chạy.
 *
 * Thêm một luật: **tập đã soát thì U đóng băng.** Nhãn người soát khoá theo số câu, mà U chạy
 * lại (vì bible lớn thêm chẳng hạn) có thể tách câu khác đi -> nhãn trỏ nhầm câu, sai lặng lẽ
 * (đúng bẫy B1 của v1). Muốn làm lại thì `force: ["U"]` và soát lại.
 */
import fs from "node:fs/promises";
import path from "node:path";

import * as BIBLE from "../zhvi/bible.js";
import { Ckpt, Store, sig as makeSig } from "../zhvi/ckpt.js";
import { Llm, modelsFromEnv } from "../zhvi/llm.js";
import { applySpeakers, reviewNeeded, sheetFromBible, vocativeNames } from "../zhvi/passes/b-speakers.js";
import * as E from "../zhvi/passes/e-export.js";
import { build as buildPage, media } from "../zhvi/review.js";
import * as V from "../zhvi/vision.js";
import { TRANSLATE, UNDERSTAND } from "./prompts.js";
import { Todo } from "./todo.js";
import * as T from "./translate.js";
import * as U from "./understand.js";

const NULL_LOG = { info() {}, warn() {}, error() {} };

/** Nhãn soát của v2 nằm file riêng: số câu của v2 khác v1, dùng chung file là trỏ nhầm câu. */
export const labelsName = (ep) => `ep${ep}.v2.speakers.json`;

async function readJson(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

export async function runEpisode({
  transcript, biblePath, ep, outDir, video = null, dataDir = null,
  glossary = {}, cps = 4.5,
  force = [], review = false, skipReview = false, writeBack = false, noVision = false,
  env = process.env, log = NULL_LOG,
  todo: todoIn = null, // chèn client giả để test không đẩy task thật
}) {
  if (!transcript) throw new Error("thiếu transcript");
  if (!outDir) throw new Error("thiếu outDir");
  const bible = biblePath ? await BIBLE.load(biblePath).catch(() => null) : null;
  // v2 không có đường không-bible: đường đó ở v1 là đường ít chắc nhất (không kênh hình, không trang soát)
  if (!bible) throw new Error(`chưa có bible (${biblePath}) — dựng bằng: node src/zhvi/cli.js series init …`);
  const seriesDir = path.dirname(biblePath);
  const forceSet = new Set(typeof force === "string" ? force.split(",").map((s) => s.trim()) : force);
  const epTitle = bible.episodes?.find((e) => String(e.ep) === String(ep))?.title ?? null;
  const labels = await readJson(path.join(seriesDir, labelsName(ep)));

  const todo = todoIn || new Todo({ url: env.TODO_URL, token: env.TODO_TOKEN, log });
  const llm = new Llm({ qwenBaseUrl: env.QWEN_BASE_URL, qwenKey: env.DASHSCOPE_API_KEY, deepseekKey: env.DEEPSEEK_API_KEY, log });
  const models = modelsFromEnv(env);
  // routine của todo cho từng task: "default" (Sonnet 5) | "lite" (Haiku 4.5, nhanh hơn, kém hơn).
  // Nằm trong chữ ký như tên model ở v1: đổi routine là task đó chạy lại.
  const routine = { U: env.ZHVI2_U_ROUTINE || "default", T: env.ZHVI2_T_ROUTINE || "default" };
  const store = new Store(outDir);
  const ckpt = await new Ckpt(outDir).load();
  const report = { ep, ran: [], reused: [] };

  /** Công đoạn tốn tiền/thời gian: chữ ký khớp thì dùng lại. `frozen` = dùng lại dù chữ ký lệch. */
  const cached = async (id, artifact, sigParts, run, { load = (x) => x, frozen = false } = {}) => {
    const signature = makeSig(sigParts);
    if (!forceSet.has(id) && !forceSet.has("all")) {
      let rec = await ckpt.hit(id, signature);
      if (!rec && frozen && ckpt.data[id]) {
        rec = await ckpt.hit(id, ckpt.data[id].sig);
        if (rec) log.warn(`  ${id}: đầu vào đã đổi nhưng tập đã soát -> giữ kết quả cũ (force ${id} để làm lại và soát lại)`);
      }
      if (rec) {
        const v = load(await store.read(artifact));
        if (v !== null && v !== undefined) {
          log.info(`  ${id}: dùng lại ${artifact}`);
          report.reused.push(id);
          return v;
        }
      }
    }
    log.info(`  ${id}: chạy`);
    const v = await run();
    await store.write(artifact, v);
    await ckpt.mark(id, signature, artifact);
    report.ran.push(id);
    return v;
  };

  const lines = U.rawLines(transcript);
  const rawSig = lines.map((l) => [l.id, l.speaker, l.zh, l.start, l.end]);
  log.info(`[zhvi2] tập ${ep}: ${lines.length} câu, ${new Set(lines.map((l) => l.speaker)).size} cụm giọng; bible ${bible.version}`);

  // --- V: kênh hình, trên câu ASR gốc (cụm giọng có từ ASR, không cần chờ U)
  // Hỏi MỌI câu, 2 khung/câu (v1 chỉ hỏi ≤30 câu mỏ neo × 8 khung): cụm U để sure=false thì
  // người phải phán từng câu, mà câu "chưa hỏi" thì không có gì để đối chiếu. ~$0,0005/câu.
  let vision = null;
  if (video && !noVision) {
    const vOpt = { frames: 2, anchorsPerCluster: Infinity, budget: lines.length };
    vision = await cached("V", "vision.json",
      [rawSig, bible.cast.map((c) => [c.zh, c.vi, c.look || c.note || ""]), video, models.vision, [vOpt.frames, "all"]],
      () => V.nameClusters(llm, lines, video, bible, { ...vOpt, model: models.vision, log }),
      { load: (raw) => V.revalidate(raw, lines, bible, log) });
  }

  // --- U: task 1
  const uCtx = U.context(lines, bible, { ep, epTitle, vision });
  const uOut = await cached("U", "u.json", [uCtx, UNDERSTAND, ...(routine.U === "default" ? [] : [routine.U])], async () => {
    const { out, errors } = await todo.ask({
      tag: "U", title: `zhvi2 hiểu tập ${ep} — ${bible.series?.id || ""}`,
      instructions: UNDERSTAND, context: uCtx, schema: U.schema(lines),
      check: (o) => U.check(o, lines, bible), routine: routine.U,
    });
    return { ...out, _errors: errors };
  }, { frozen: Boolean(labels) });

  // --- áp (miễn phí, dựng lại mỗi lần)
  const { utts, roughVi, align, rejected } = U.apply(uOut, lines, bible, { cuts: labels?.cuts || {} });
  const rawToUtt = new Map();
  for (const u of utts) if (!rawToUtt.has(u.segmentIndexes[0])) rawToUtt.set(u.segmentIndexes[0], u.id);
  U.attachVision(align, vision, bible, rawToUtt);
  if (rejected.length) {
    log.warn(`  U: bỏ ${rejected.length} mục task trả mà code không áp được:`);
    for (const r of rejected) log.warn(`      ${r}`);
  }
  log.info(`  U: ${utts.length} câu (${utts.filter((u) => u.edits.length).length} câu sửa ASR, `
    + `${utts.filter((u) => u.speakerSource === "todo-split").length} mảnh tách, ${utts.filter((u) => u.speakerSource === "todo-moved").length} câu đổi người); `
    + Object.entries(align.clusters).map(([k, c]) => `${k}=${c.cid ? bible.cast.find((x) => x.id === c.cid)?.vi : c.who || "?"}/${c.level}`).join(" "));

  if (labels) applySpeakers(utts, align, bible, bySk(labels, utts, log));
  await store.write("utts.json", utts);
  await store.write("align.json", { ...align, rejected });

  // --- cổng soát
  const gate = reviewNeeded(align, labels, { hasBible: true, bible });
  report.review = { ...gate, stopped: false };
  if (review || (gate.need && !skipReview)) {
    const page = await reviewPage({ utts, align, roughVi, bible, video, outDir, ep, log, lines });
    log.info(`dừng cho người soát: ${review ? "--review" : gate.why}`);
    report.review = { ...gate, stopped: true, page };
    return { report, utts, align };
  }
  if (gate.need) log.warn(`bỏ qua cổng người soát: ${gate.why}`);

  // --- T: task 2
  const sheet = sheetFromBible(bible, align, { ep, utts });
  const tCtx = T.context(utts, sheet, { glossary, cps });
  // người nói lúc dịch, khoá theo `sk` (id trôi khi người soát cắt câu) — để biết câu nào bị
  // người soát đổi người SAU khi đã dịch
  const whoBySk = () => Object.fromEntries(utts.map((u, i) => [u.sk ?? String(u.id), tCtx.lines[i].who]));
  const tOut = await cached("T", "t.json", [tCtx, TRANSLATE, cps, ...(routine.T === "default" ? [] : [routine.T])], async () => {
    const { out, errors } = await todo.ask({
      tag: "T", title: `zhvi2 dịch tập ${ep} — ${bible.series?.id || ""}`,
      instructions: TRANSLATE, context: tCtx, schema: T.schema(utts),
      check: (o) => T.check(o, utts, sheet, { cps }), routine: routine.T,
    });
    return { ...out, _errors: errors, _who: whoBySk(), _sk: Object.fromEntries(utts.map((u) => [String(u.id), u.sk ?? String(u.id)])) };
  }, { frozen: Boolean(labels) });

  // Người soát sửa nhãn sau khi đã dịch thì KHÔNG tự dịch lại cả tập: bản của người là bản cuối
  // (luật fleex 2026-09-20). Nhưng xưng hô của câu đó dịch theo người CŨ nên có thể lệch -> đánh
  // dấu để người sửa tay, và `--force T` khi muốn máy dịch lại thật.
  const whoNow = whoBySk();
  const drift = Object.entries(whoNow).filter(([k, w]) => tOut._who?.[k] && tOut._who[k] !== w);
  if (drift.length) {
    const bySkNow = new Map(utts.map((u) => [u.sk ?? String(u.id), u]));
    log.warn(`  T: ${drift.length} câu người soát đổi người nói sau khi dịch — giữ bản dịch cũ, đánh dấu xưng hô cần xem (--force T để dịch lại cả tập):`);
    for (const [k, w] of drift) {
      log.warn(`      @${k}: ${tOut._who[k]} -> ${w}`);
      const u = bySkNow.get(k);
      if (u) u.review = [...(u.review || []), `người nói đổi sau khi dịch (${tOut._who[k]} -> ${w}) — xưng hô có thể lệch`];
    }
  }
  // Dùng lại bản dịch cũ thì phải khớp theo `sk`, KHÔNG theo id: người soát cắt thêm một câu là
  // id mọi câu sau đó đánh lại -> khớp theo id sẽ dán câu dịch của câu khác vào (đúng bẫy B1 của
  // v1). Mảnh mới cắt không có bản dịch nào -> để rỗng và đánh dấu, chứ không mượn câu bên cạnh.
  // t.json ghi trước khi có `_sk` thì không còn đường khớp lại theo khoá ổn định. Nếu số câu đã
  // đổi (người soát cắt/gộp SAU khi dịch) mà vẫn khớp theo `id` thì bản dịch bị dán lệch một nấc
  // cho tới hết tập và KHÔNG có dấu hiệu nào. Đo thật trên ai-qing ep01: cắt 1 câu -> 121/152 câu
  // đổi bản dịch, mảnh «既然姐姐我重生了…» nhận câu dịch của câu kế («Cậu nhìn gì?»). Thà dừng.
  const nOld = Object.keys(tOut.vi || {}).length;
  if (!tOut._sk && nOld !== utts.length) {
    throw new Error(`t.json của tập ${ep} ghi bằng bản cũ (không có khoá \`sk\`) mà số câu đã đổi `
      + `${nOld} -> ${utts.length}: khớp theo id sẽ dán lệch bản dịch cho tới hết tập. `
      + "Dịch lại tập này một lượt để có khoá mới: --force T");
  }
  const viBySk = Object.fromEntries(Object.entries(tOut.vi || {}).map(([id, s]) => [tOut._sk?.[id] ?? id, s]));
  const vi = {};
  const noVi = [];
  for (const u of utts) {
    const k = u.sk ?? String(u.id);
    const s = String((tOut._sk ? viBySk[k] : tOut.vi?.[String(u.id)]) || "").trim();
    vi[u.id] = s;
    if (!s) noVi.push(u);
  }
  if (noVi.length && tOut._sk) {
    log.warn(`  T: ${noVi.length} câu chưa có bản dịch (cắt/tách sau khi dịch) — đánh dấu, --force T để dịch lại cả tập`);
    for (const u of noVi) u.review = [...(u.review || []), "câu mới cắt sau khi dịch — chưa dịch"];
  }
  // Kiểm luật phải chạy trên bản ĐÃ khớp lại theo `sk` (`vi`), không trên `tOut` thô: `tOut.vi`
  // khoá bằng id lúc dịch, mà người soát cắt thêm một câu là id mọi câu sau đó trôi -> ghép câu
  // dịch này với câu Trung kia, báo sai hàng loạt rồi đánh `needsReview` nhầm câu (bẫy B1 lần nữa,
  // đúng chỗ mà comment ngay trên vừa cảnh báo). Đo: cắt 1 câu ở tập 1 -> 28 câu cần xem thành 71.
  const left = T.check({ ...tOut, vi }, utts, sheet, { cps });
  if (left.length) {
    log.warn(`  T: còn ${left.length} câu chưa đạt luật sau khi hỏi lại — đánh dấu needsReview:`);
    for (const e of left) log.warn(`      ${e}`);
  }
  const leftIds = new Set(left.map((e) => Number(e.slice(1, e.indexOf(":")))));
  for (const u of utts) if (leftIds.has(u.id)) u.review = [...(u.review || []), "luật dịch"];

  // --- E: xuất (miễn phí)
  let alias = {};
  if (dataDir) ({ alias } = await E.matchVoices((sheet.characters || []).map((c) => c.zh || c.key), `${dataDir}/voice`));
  const tr = E.exportTranslation(utts, vi, sheet, meta({ transcript, bible, ep, cps, labels, align }), {
    alias, suspects: align.suspects, clusters: align.clusters, asr: null,
  });
  // Câu máy tự đổi người nói/tự tách mà người chưa chốt: dịch theo máy, nhưng KHÔNG làm mẫu clone
  // (cùng luật với cờ lượt gộp series ở v1: một câu người khác lọt vào mẫu là hỏng giọng mọi tập).
  // (exportTranslation sắp lại theo mốc thời gian -> khớp bằng mốc + câu chữ, không bằng vị trí)
  const machine = new Set(utts.filter((u) => ["todo-split", "todo-moved"].includes(u.speakerSource)).map((u) => `${u.start}|${u.zh}`));
  for (const s of tr.segments) if (machine.has(`${s.start}|${s.zh}`)) s.voiceSafe = false;
  await store.write("vi.json", vi);
  await store.write("vi.srt", E.toSrt(utts, vi));
  await store.write("translation.json", tr);
  await store.write("translation.txt", tr.segments.map((s) => s.vi).filter(Boolean).join(" "));
  if (writeBack && dataDir) await E.writeBack(dataDir, outDir, tr, { log });
  report.segments = tr.segments.length;
  report.needsReview = tr.segments.filter((s) => s.needsReview).length;
  report.todo = todo.calls;
  return { report, utts, align, translation: tr };
}

function meta({ transcript, bible, ep, cps, labels, align }) {
  return {
    videoId: transcript.videoId ?? null,
    provider: "zhvi2-todo",
    from: "zh", to: "vi",
    translatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    degradedModel: false,
    models: { understand: "todo", translate: "todo" },
    cps: cps || null,
    bibleVersion: bible.version,
    ep,
    speakerChannels: ["cluster", "text", ...(align.vision ? ["vision"] : [])],
    speakerReviewed: Boolean(labels),
    speakerSuspect: Object.keys(align.suspects || {}).length,
    sourceSegments: transcript.segments.length,
  };
}

/**
 * Nhãn câu của trang soát v2 khoá bằng `sk` ("@18", "@18.1", "@20/0") vì `id` đánh lại mỗi lần
 * người cắt câu. Đổi về `id` hiện tại cho `applySpeakers` của v1. Khoá số trần là file cũ, giữ nguyên.
 */
function bySk(labels, utts, log) {
  const id = new Map(utts.map((u) => [u.sk, String(u.id)]));
  const conv = (k) => (k.startsWith("@") ? id.get(k.slice(1)) : k);
  const lines = {};
  for (const [k, v] of Object.entries(labels.lines || {})) {
    const i = conv(k);
    if (i === undefined) log?.warn?.(`  nhãn câu ${k} không còn khớp câu nào (đã cắt lại?) — bỏ`);
    else lines[i] = v;
  }
  return { ...labels, lines, guessed: (labels.guessed || []).map(conv).filter((x) => x !== undefined) };
}

/**
 * Mốc từ ASR tại ranh giới từ, theo vị trí ký tự trong `u.zh` — để bộ cắt tay điền sẵn mốc.
 * Chỉ khi chữ của các từ ghép lại khớp đúng câu (bỏ dấu câu); lệch (câu đã sửa ASR) thì không
 * điền gì, người tự đặt mốc — không nội suy.
 */
export function wordsOf(utts, lines) {
  const raw = new Map(lines.map((l) => [l.id, l]));
  const bare = (s) => String(s).replace(/[\s\p{P}]/gu, "");
  const out = {};
  for (const u of utts) {
    const ws = (raw.get(u.segmentIndexes[0])?.words || []).filter((w) => w.start >= u.start - 0.005 && w.start < u.end);
    if (!ws.length || bare(ws.map((w) => w.word).join("")) !== bare(u.zh)) continue;
    const at = {};
    let wi = 0, left = 0;
    for (let i = 0; i < u.zh.length && wi < ws.length; i++) {
      if (!bare(u.zh[i])) continue;
      if (left === 0) {
        if (i > 0) at[i] = ws[wi].start;
        left = bare(ws[wi].word).length;
        wi += 1;
      }
      left -= 1;
    }
    out[u.id] = at;
  }
  return out;
}

/** Trang soát của v1, bản dịch thô lấy từ task 1 thay vì qwen-mt. */
async function reviewPage({ utts, align, roughVi, bible, video, outDir, ep, log, lines }) {
  if (!video) throw new Error("dựng trang soát cần video");
  const med = await media(video, utts, path.join(outDir, "media.json"), { n: 3, log });
  const known = bible.cast.flatMap((c) => [c.zh, c.vi, c.viShort, ...(c.alias || [])]).concat(Object.keys(bible.terms || {}));
  const cands = vocativeNames([{ ep, utts }], known);
  const out = path.join(outDir, "review.html");
  await buildPage({ [ep]: { utts, align, media: med, vi: roughVi, cands, video, words: wordsOf(utts, lines) } }, bible, out, { log, sigPrefix: "v2-" });
  return out;
}
