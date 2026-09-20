#!/usr/bin/env node
/**
 * CLI mỏng cho lib zhvi. Lib mới là thứ chính; file này chỉ để chạy tay và để đo.
 *
 *   node src/zhvi/cli.js <transcript.json> --glossary g.json --bible series/x/bible.json \
 *        --ep 2 --out out/ep02 --video .../video.mp4 --cps 4.5 --rounds 2
 *
 *   --force C          chạy lại pass C (tính tiền lại); nhận "all", "A2", "A,C"...
 *   --stop-after B     dừng sau pass B — đúng chỗ cổng người soát nằm
 *   --stages           in bảng stage/substage rồi thoát
 *
 * Cổng người soát (nằm GIỮA pass B và C) — MẶC ĐỊNH BẬT:
 *   hết pass B mà còn cụm chưa chắc / câu cần soi thì dừng lại, dựng review.html.
 *   Chưa có bible thì LUÔN dừng: dựng bible trước (series init).
 *   --review                            luôn dừng ở đó, kể cả khi máy đã chắc
 *   --skip-review                       kệ, dịch thẳng tới E
 *   --apply speaker-review.json --series series/x   nạp nhãn đã soát về
 *
 * Bible cho series mới:
 *   node src/zhvi/cli.js series init <videoDir tập 1> <videoDir tập 2> ... --series series/<tên> \
 *        --glossary g.json [--terms t.json] [--out out/<tên>] [--min-sec 60] [--no-looks] [--force]
 *   node src/zhvi/cli.js series apply ~/Downloads/bible-review.json --series series/<tên>
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Llm, STAGES, modelsFromEnv, readEnvFile, runPipeline, subsOf } from "./index.js";
import { applyExport, buildReview } from "./review.js";
import { applyReview, initSeries } from "./series.js";

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const k = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) a[k] = true;
      else { a[k] = next; i++; }
    } else a._.push(t);
  }
  return a;
}

function printStages() {
  const ctx = { rounds: 2 };
  for (const s of STAGES) {
    console.log(`${s.id}  ${s.name.padEnd(9)} ${s.title}`);
    for (const sub of subsOf(s, ctx)) {
      const tag = sub.cost === "free" ? "miễn phí" : sub.cost.toUpperCase();
      console.log(`   ${sub.id.padEnd(6)} ${sub.name.padEnd(11)} ${tag.padEnd(9)} ${sub.artifact || "—"}`);
    }
  }
  console.log("\nmiễn phí = thuần code, chạy lại mỗi lần, không bao giờ ôi.");
  console.log("còn lại  = có chữ ký nội dung; đầu vào đổi là tự chạy lại, kéo theo mọi thứ sau nó.");
}

/** Dòng tiền cuối lệnh. Đọc từ llm chứ không từ report: trang soát gọi thêm MT sau khi pipeline chốt sổ. */
function printCost(llm) {
  const u = llm.report();
  const cost = typeof llm.cost === "function" ? llm.cost() : null;
  console.log("[$] " + (Object.keys(u).length
    ? Object.entries(u).map(([m, v]) => `${m}: ${v[0]} call, ${v[1]}+${v[2]} tok${v[4] ? ` (${v[4]} nghĩ)` : ""}, ${v[3]}s`).join(" | ")
      + `  => tổng ${llm.totalTokens()} tok` + (cost !== null ? `, ~$${cost.toFixed(4)} (giá peak)` : "")
    : "0 (dùng lại toàn bộ checkpoint)"));
}

const printableCost = (llm) => (typeof llm.cost === "function" ? Math.round(llm.cost() * 1e4) / 1e4 : null);

const readJsonArg = async (p) => (p ? JSON.parse(await fs.readFile(p, "utf8")) : null);

// Mọi dòng log có giờ + khoảng cách với dòng trước ("14:03:21 +12.3s") để nhìn ra bước nào
// ngốn thời gian. Chừa dòng "@@zhvi {json}": UI parse nó bằng startsWith.
{
  let last = Date.now();
  const stamp = () => {
    const now = Date.now();
    const d = (now - last) / 1000;
    last = now;
    const hms = new Date(now).toTimeString().slice(0, 8);
    return `${hms} ${("+" + (d < 60 ? d.toFixed(1) + "s" : Math.floor(d / 60) + "m" + String(Math.round(d % 60)).padStart(2, "0"))).padStart(7)} `;
  };
  for (const k of ["log", "error"]) {
    const orig = console[k].bind(console);
    console[k] = (first, ...rest) => (typeof first === "string" && first.startsWith("@@zhvi ")
      ? orig(first, ...rest)
      : orig(stamp() + (typeof first === "string" ? first : ""), ...(typeof first === "string" ? rest : [first, ...rest])));
  }
}

const a = parseArgs(process.argv.slice(2));
if (a.stages) { printStages(); process.exit(0); }
// --events: thêm dòng "@@zhvi {json}" cho UI đọc tiến độ; log chữ vẫn in như cũ
const onEvent = a.events ? (e) => console.log("@@zhvi " + JSON.stringify(e)) : null;

if (a.apply) {
  if (!a.series) { console.error("--apply cần --series series/<slug>"); process.exit(2); }
  await applyExport(a.apply, a.series, a.ep ?? null, { log: { info: (s) => console.log(s) } });
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const env = { ...(await readEnvFile(path.join(root, ".env"))), ...process.env };

const log = {
  info: (s) => console.log(s),
  warn: (s) => console.log("  [!] " + s),
  error: (s) => console.error("  [X] " + s),
};

if (a._[0] === "series") {
  const [, cmd, ...rest] = a._;
  if (!a.series || !["init", "apply"].includes(cmd) || !rest.length) {
    console.error("dùng: node src/zhvi/cli.js series init <videoDir>... --series series/<tên> --glossary g.json");
    console.error("      node src/zhvi/cli.js series apply <bible-review.json> --series series/<tên>");
    process.exit(2);
  }
  if (cmd === "apply") {
    const r = await applyReview(rest[0], a.series, { log });
    const b = r.bible;
    console.log(`[bible] ${r.biblePath} version ${b.version} — ${b.cast.length} nhân vật, `
      + `${Object.keys(b.terms).length} thuật ngữ, ${b.address.length} cặp xưng hô, ${b.episodes.filter((e) => e.use).length} tập`);
    console.log("[dịch] từng tập (A2 dùng lại checkpoint của lượt init):");
    for (const c of r.commands) console.log("  " + c);
    process.exit(0);
  }

  const llm = new Llm({ qwenBaseUrl: env.QWEN_BASE_URL, qwenKey: env.DASHSCOPE_API_KEY, deepseekKey: env.DEEPSEEK_API_KEY, queueUrl: env.TODO_URL, queueToken: env.TODO_TOKEN, log });
  const r = await initSeries({
    videoDirs: rest,
    seriesDir: a.series,
    outRoot: a.out || null,
    glossary: (await readJsonArg(a.glossary)) || {},
    terms: await readJsonArg(a.terms),
    inputs: {
      glossary: a.glossary ? path.resolve(a.glossary) : null,
      terms: a.terms ? path.resolve(a.terms) : null,
    },
    llm,
    models: modelsFromEnv(env),
    log,
    force: Boolean(a.force),
    minSec: Number(a["min-sec"] || 60),
    noLooks: Boolean(a["no-looks"]),
    onEvent,
  });
  onEvent?.({ t: "draft", page: r.page, draftPath: r.draftPath, cost: printableCost(llm) });
  const d = r.draft;
  const speaking = d.cast.filter((c) => c.samples?.length);
  console.log(`[nháp] ${r.draftPath} — phim «${d.series.titleVi}», ${d.episodes.filter((e) => e.use).length} tập, `
    + `${d.cast.length} nhân vật (${speaking.filter((c) => c.look).length}/${speaking.length} có look), `
    + `${Object.keys(d.terms).length} thuật ngữ, ${d.address.length} xưng hô, ${d.doubts.length} điều máy không chắc`);
  console.log(`[duyệt] mở ${r.page}, soát phía tiếng Việt, bấm Xuất JSON, xong:`);
  console.log(`  node src/zhvi/cli.js series apply ~/Downloads/bible-review.json --series ${a.series}`);
  printCost(llm);
  process.exit(0);
}

if (!a._[0]) {
  console.error("dùng: node src/zhvi/cli.js <transcript.json> --glossary <g.json> [--bible ...] --out <dir>");
  process.exit(2);
}

const res = await runPipeline({
  transcript: JSON.parse(await fs.readFile(a._[0], "utf8")),
  glossary: (await readJsonArg(a.glossary)) || {},
  biblePath: a.bible || null,
  terms: await readJsonArg(a.terms),
  ep: a.ep ?? null,
  epTitle: a["ep-title"] ?? null,
  outDir: a.out || "out",
  seriesDir: a.series || null,
  dataDir: a["data-dir"] || null,
  video: a.video || null,
  cps: Number(a.cps || 0),
  rounds: Number(a.rounds ?? 1),
  force: a.force === true ? "all" : a.force || [],
  // --review dừng ngay sau pass B: cổng người nằm TRƯỚC pass C, soát xong mới dịch
  stopAfter: a.review ? "B" : a["stop-after"] || null,
  skipReview: Boolean(a["skip-review"]),
  noVision: Boolean(a["no-vision"]),
  vision: {
    ...(a["vision-frames"] ? { frames: Number(a["vision-frames"]) } : {}),
    ...(a["vision-anchors"] ? { anchorsPerCluster: Number(a["vision-anchors"]) } : {}),
    ...(a["vision-budget"] ? { budget: Number(a["vision-budget"]) } : {}),
  },
  env,
  log,
  onEvent,
});

// Dừng ở cổng thì thứ cần ngay là đường đi tiếp -> dựng/in luôn, khỏi bắt chạy lại một lượt.
const stopped = Boolean(res.report.review?.stopped);
if (a.review || stopped) {
  if (!res.ctx.bible) {
    console.log("[soát] series chưa có bible — người nói đang do máy đoán từng tập. Dựng bible cho cả series:");
    console.log("  node src/zhvi/cli.js series init <videoDir tập 1> <videoDir tập 2> ... --series series/<tên> --glossary …");
    console.log("  (vẫn muốn dịch thẳng không bible: thêm --skip-review)");
  } else if (!res.ctx.video) {
    console.log("[soát] không dựng được trang (cần --video); xem out/<tập>/align.final.json");
  } else {
    const page = await buildReview(res.ctx, {
      out: a["review-out"] || null,
      thumbs: Number(a.thumbs || 3),
      noRoughVi: Boolean(a["no-rough-vi"]),
    });
    onEvent?.({ t: "review", ep: res.ctx.ep, page, stopped });
    if (stopped) {
      const series = a.series || path.dirname(a.bible);
      console.log(`[soát] mở ${page}, chốt cụm rồi bấm Xuất JSON, xong:`);
      console.log(`  node src/zhvi/cli.js --apply ~/Downloads/speaker-review.json --series ${series}`);
      console.log("  rồi chạy lại lệnh vừa nãy (checkpoint giữ nguyên, không trả tiền lại pass A/B)");
    }
  }
}

printCost(res.ctx.llm);
