/**
 * zhvi — dịch transcript phim ngắn tiên hiệp Trung → Việt bằng LLM Trung Quốc.
 *
 * Lib tự chứa: chỉ phụ thuộc `pinyin-pro` + `@node-rs/jieba` và fetch sẵn có của Node,
 * KHÔNG import gì của douyind-downloader — bê nguyên thư mục này đi chỗ khác là chạy.
 *
 * Dùng:
 *   import { runPipeline } from "./zhvi/index.js";
 *   const res = await runPipeline({ transcript, glossary, biblePath, outDir, video, ... });
 *
 * Điều khiển chạy lại: mặc định **dùng lại mọi thứ đã trả tiền** (đĩa là nguồn sự thật,
 * cùng luật với `src/stt.js`). Muốn tính tiền lại thì `force: ["C"]` / `["A2"]` / "all".
 * `stopAfter: "B"` để dừng sau pass B — đúng chỗ cổng người soát nằm.
 *
 * Cổng người soát mặc định BẬT: hết pass B mà máy còn cụm chưa chắc hoặc còn câu
 * cần soi thì dừng, `report.review.stopped = true`. `skipReview: true` để chạy thẳng.
 */
import fs from "node:fs/promises";
import path from "node:path";

import * as BIBLE from "./bible.js";
import { Ckpt, Store, sig as makeSig } from "./ckpt.js";
import { Llm, modelsFromEnv } from "./llm.js";
import { reviewNeeded } from "./passes/b-speakers.js";
import { writeBack } from "./passes/e-export.js";
import { STAGES, STAGE_IDS, subsOf } from "./stages.js";

export { STAGES, STAGE_IDS, subsOf } from "./stages.js";
export { Llm, modelsFromEnv } from "./llm.js";
export * as bible from "./bible.js";

const NULL_LOG = { info() {}, warn() {}, error() {} };

/** Đọc .env kiểu dotfile đơn giản — để lib chạy được ngoài douyind. */
export async function readEnvFile(p) {
  const out = {};
  let raw;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const i = s.indexOf("=");
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Nhãn người soát đã chốt cho một tập. DÍNH: không bao giờ bị sinh lại đè lên. */
export async function loadLabels(seriesDir, ep) {
  if (!seriesDir || ep === null || ep === undefined) return null;
  const p = path.join(seriesDir, `ep${ep}.speakers.json`);
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

/** Cờ ASR của lượt gộp series cho đúng tập này (`series init` ghi `asr-flags.json`). */
export async function loadAsrFlags(seriesDir, ep) {
  if (!seriesDir || ep === null || ep === undefined) return null;
  try {
    const all = JSON.parse(await fs.readFile(path.join(seriesDir, "asr-flags.json"), "utf8"));
    return all[String(ep)] || null;
  } catch {
    return null;
  }
}

const asSet = (v) => new Set(
  v === undefined || v === null ? []
    : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean)
      : v,
);

export async function runPipeline({
  transcript, glossary = {},
  bible: bibleObj = null, biblePath = null,
  terms = null, ep = null, epTitle = null,
  outDir, seriesDir = null, dataDir = null, video = null,
  cps = 0, rounds = 1,
  force = [], stopAfter = null, skipReview = false,
  vision: visionOpts = {}, noVision = false,
  llm: llmIn = null, env = process.env, models: modelsIn = null,
  log = NULL_LOG,
  // Sự kiện có cấu trúc cho UI (tiến độ từng công đoạn con, từng lượt gọi model). Log chữ
  // vẫn giữ nguyên; đây là kênh thứ hai để khỏi phải đoán tiến độ bằng regex trên log.
  onEvent = null,
} = {}) {
  if (!transcript) throw new Error("thiếu transcript");
  if (!outDir) throw new Error("thiếu outDir");

  const forceSet = asSet(force);
  const bib = bibleObj || (biblePath ? await BIBLE.load(biblePath) : null);
  const series = seriesDir || (biblePath ? path.dirname(biblePath) : null);

  // Thuật ngữ đã chốt: bible thắng --terms; chỉ approved mới được dùng khi dịch.
  const pinned = bib
    ? Object.fromEntries(Object.entries(bib.terms).filter(([, t]) => t.approved).map(([zh, t]) => [zh, t.vi]))
    : terms || {};
  // Cùng vốn từ này dùng luôn cho pass A: chỗ nào đọc gần giống tên riêng của phim
  // mà viết khác thì là nghi lỗi ASR -> các tập dịch rời vẫn gọi tên giống nhau.
  const vocab = bib
    ? [...new Set([...Object.keys(bib.terms), ...bib.cast.map((c) => c.zh), ...bib.cast.flatMap((c) => c.alias || [])])]
    : [...new Set([...Object.keys(pinned), ...Object.keys(glossary)])];

  const llm = llmIn || new Llm({
    qwenBaseUrl: env.QWEN_BASE_URL,
    qwenKey: env.DASHSCOPE_API_KEY,
    deepseekKey: env.DEEPSEEK_API_KEY,
    queueUrl: env.TODO_URL,
    queueToken: env.TODO_TOKEN,
    log,
  });

  if (bib) log.info(`[bible] ${path.basename(series || "")} version ${bib.version} — ${bib.cast.length} nhân vật, ${Object.keys(pinned).length} thuật ngữ đã chốt`);

  const ctx = {
    transcript, glossary, bible: bib, pinned, vocab,
    // tên tập tác giả đặt là bằng chứng mạnh ở B2 — bible đã có thì khỏi bắt gõ lại --ep-title
    ep, epTitle: epTitle ?? bib?.episodes?.find((e) => ep !== null && String(e.ep) === String(ep))?.title ?? null,
    video, cps, rounds,
    outDir, seriesDir: series, dataDir,
    labels: await loadLabels(series, ep),
    asrRaw: await loadAsrFlags(series, ep),
    llm, log,
    models: modelsIn || modelsFromEnv(env),
    opts: { noVision, vision: { frames: 8, anchorsPerCluster: 3, budget: 30, ...visionOpts } },
    // trạng thái tích luỹ
    vision: null, align: null, sheet: null, vi: {}, ent: {}, scores: null,
    suspects: {}, alias: {}, vocatives: [],
    meta: () => buildMeta(ctx),
  };

  const store = new Store(outDir);
  const ckpt = await new Ckpt(outDir).load();
  const report = { stages: [], reused: 0, ran: 0, skipped: 0 };

  const ev = (t, d = {}) => {
    if (!onEvent) return;
    try {
      onEvent({ t, ep, ...d });
    } catch { /* người nghe hỏng không được làm hỏng lượt dịch */ }
  };
  const prevOnCall = llm.onCall;
  if (onEvent) llm.onCall = (c) => ev("call", c);
  ev("plan", {
    subs: STAGES.flatMap((s) => subsOf(s, ctx).map((x) => ({ id: x.id, stage: s.id, name: x.name, title: x.title, cost: x.cost }))),
  });

  for (const stage of STAGES) {
    const row = { id: stage.id, name: stage.name, subs: [] };
    report.stages.push(row);
    log.info(`[${stage.id}] ${stage.title}`);

    for (const sub of subsOf(stage, ctx)) {
      let r;
      try {
        r = await runSub(sub, ctx, { store, ckpt, forceSet, log, ev });
      } catch (ex) {
        ev("sub", { id: sub.id, status: "error", error: String(ex?.message || ex).slice(0, 500) });
        if (onEvent) llm.onCall = prevOnCall;
        throw ex;
      }
      row.subs.push(r);
      report[r.status === "reused" ? "reused" : r.status === "skipped" ? "skipped" : "ran"] += 1;
    }

    if (stopAfter && stage.id === stopAfter) {
      log.info(`dừng sau pass ${stage.id} theo yêu cầu`);
      report.stoppedAfter = stage.id;
      report.review = { ...reviewNeeded(ctx.align, ctx.labels, { hasBible: Boolean(bib), bible: bib }), stopped: stage.id === "B" };
      break;
    }

    // Cổng người soát nằm đúng ở đây, GIỮA B và C. Mặc định là DỪNG: pass C trở đi
    // ăn `sheet`, mà `sheet` dựng từ speakerMap — sai người nói ở đây thì tiền dịch
    // và cả bảng xưng hô đi theo.
    if (stage.id === "B") {
      const g = reviewNeeded(ctx.align, ctx.labels, { hasBible: Boolean(bib), bible: bib });
      report.review = { ...g, stopped: false };
      if (g.need && skipReview) log.warn(`bỏ qua cổng người soát (--skip-review): ${g.why}`);
      else if (g.need) {
        log.info(`dừng cho người soát: ${g.why} — chạy thẳng thì thêm --skip-review`);
        report.stoppedAfter = "B";
        report.review.stopped = true;
        break;
      }
    }
  }

  if (report.review) ev("gate", report.review);

  // Ghi ngược vào thư mục video của douyind là tác dụng phụ ra NGOÀI outDir, nên để
  // hẳn ngoài bảng stage — nó không phải một công đoạn tính toán và không checkpoint.
  if (dataDir && ctx.translation && !report.stoppedAfter) {
    await writeBack(dataDir, outDir, ctx.translation, { log });
  }

  const usage = llm.report();
  report.usage = usage;
  report.tokens = llm.totalTokens();
  // tiền ước tính theo bảng PRICE (giá peak) — llm truyền từ ngoài vào có thể không có cost()
  report.cost = typeof llm.cost === "function" ? Math.round(llm.cost() * 1e4) / 1e4 : null;
  await store.write("usage.json", { ...usage, _costUSD: report.cost });
  if (onEvent) llm.onCall = prevOnCall;
  ev("done", { stoppedAfter: report.stoppedAfter ?? null, cost: report.cost, tokens: report.tokens });
  return { ctx, report, usage };
}

async function runSub(sub, ctx, { store, ckpt, forceSet, log, ev = () => {} }) {
  const stageId = sub.id[0];
  const label = `  ${sub.id} ${sub.name}`;
  const t0 = Date.now();
  const done = (status, extra = {}) => ev("sub", { id: sub.id, status, ms: Date.now() - t0, ...extra });

  if (sub.when && !sub.when(ctx)) {
    log.info(`${label}: bỏ qua`);
    done("skipped");
    return { id: sub.id, status: "skipped" };
  }

  // Công đoạn miễn phí: luôn chạy lại. Không checkpoint, không chữ ký, không bao giờ ôi.
  if (sub.cost === "free") {
    ev("sub", { id: sub.id, status: "start", cost: "free" });
    const v = await sub.run(ctx);
    sub.after?.(ctx, v);
    await emit(sub, ctx, store);
    log.info(`${label}: ${fmt(v)}`);
    done("ran", { cost: "free", info: v });
    return { id: sub.id, status: "ran", cost: "free", info: v };
  }

  const signature = makeSig(sub.sig(ctx));
  const forced = forceSet.has("all") || forceSet.has(sub.id) || forceSet.has(stageId);

  if (!forced) {
    const rec = await ckpt.hit(sub.id, signature);
    if (rec) {
      const raw = await store.read(rec.artifact);
      // `load` được quyền TỪ CHỐI cache dù chữ ký khớp (kênh hình kiểm mốc thời gian).
      const v = sub.load ? sub.load(ctx, raw) : raw;
      if (v !== null && v !== undefined) {
        sub.after?.(ctx, v);
        await emit(sub, ctx, store);
        log.info(`${label}: dùng lại ${rec.artifact}`);
        done("reused", { cost: sub.cost, artifact: rec.artifact });
        return { id: sub.id, status: "reused", artifact: rec.artifact };
      }
    }
  }

  log.info(`${label}: chạy (${sub.cost}${forced ? ", --force" : ""})`);
  ev("sub", { id: sub.id, status: "start", cost: sub.cost, forced });
  const v = await sub.run(ctx);
  await store.write(sub.artifact, v);
  await ckpt.mark(sub.id, signature, sub.artifact);
  sub.after?.(ctx, v);
  await emit(sub, ctx, store);
  done("ran", { cost: sub.cost, artifact: sub.artifact });
  return { id: sub.id, status: "ran", cost: sub.cost, artifact: sub.artifact };
}

/** File cho người đọc (utts.json, sheet.json, vi.srt…) — khác với artifact của checkpoint. */
async function emit(sub, ctx, store) {
  if (!sub.emit) return;
  for (const [name, body] of Object.entries(sub.emit(ctx))) await store.write(name, body);
}

function buildMeta(ctx) {
  return {
    videoId: ctx.transcript.videoId ?? null,
    provider: "zhvi-5pass",
    from: "zh", to: "vi",
    translatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    degradedModel: false,
    glossary: true, glossaryProtect: false,
    models: Object.fromEntries(Object.entries(ctx.models).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])),
    pinnedTerms: Object.keys(ctx.pinned).length > 0,
    cps: ctx.cps || null,
    bibleVersion: ctx.bible?.version ?? null,
    ep: ctx.ep,
    speakerChannels: [
      "cluster", "vocative",
      ...(ctx.bible ? ["text"] : []),
      ...(ctx.video && !ctx.opts.noVision ? ["vision"] : []),
    ],
    speakerReviewed: Boolean(ctx.align?.human),
    speakerSuspect: Object.keys(ctx.suspects || {}).length,
    speakerAliases: ctx.alias || {},
    sourceSegments: ctx.transcript.segments.length,
  };
}

const fmt = (v) => (v && typeof v === "object" ? Object.entries(v).map(([k, x]) => `${k}=${JSON.stringify(x)}`).join(" ") : String(v));
