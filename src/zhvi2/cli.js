#!/usr/bin/env node
/**
 * CLI của zhvi2. Mọi đường dẫn suy từ bible (tập nào ở thư mục video nào), nên chỉ cần:
 *
 *   node src/zhvi2/cli.js --series series/<slug> --ep 1
 *        [--out out/<slug>/v2/ep01] [--cps 4.5] [--force U,T] [--no-vision]
 *        [--review]        luôn dừng ở cổng soát
 *        [--skip-review]   kệ cổng soát, dịch thẳng
 *        [--write-back]    ghi translation.json + người nói vào thư mục video (bản cũ giữ *.orig)
 *
 *   node src/zhvi2/cli.js --apply ~/Downloads/speaker-review.json --series series/<slug>
 *
 * Bible dựng bằng v1 (`node src/zhvi/cli.js series init …`, ZHVI_PROFILE=queue@… để chạy qua todo).
 */
import fs from "node:fs/promises";
import path from "node:path";

import { readEnvFile } from "../zhvi/index.js";
import { applyExport } from "../zhvi/review.js";
import { epDir } from "../zhvi/series.js";
import { labelsName, runEpisode } from "./index.js";

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) a[t.slice(2)] = true;
      else { a[t.slice(2)] = next; i++; }
    } else a._.push(t);
  }
  return a;
}

const a = parseArgs(process.argv.slice(2));
const log = { info: (s) => console.log(s), warn: (s) => console.warn("⚠ " + s), error: (s) => console.error(s) };
const die = (s) => { console.error(s); process.exit(2); };

if (!a.series) die("thiếu --series series/<slug>");
const biblePath = path.join(a.series, "bible.json");

if (a.apply) {
  await applyExport(a.apply, a.series, a.ep ?? null, { log, labelsName });
  console.log(`\nchạy lại tập để đi tiếp: node src/zhvi2/cli.js --series ${a.series} --ep <N>`);
  process.exit(0);
}

if (a.ep === undefined || a.ep === true) die("thiếu --ep <số tập>");
const bible = JSON.parse(await fs.readFile(biblePath, "utf8"));
const e = bible.episodes?.find((x) => String(x.ep) === String(a.ep));
if (!e?.videoDir) die(`bible không có tập ${a.ep} (có: ${(bible.episodes || []).map((x) => x.ep).join(", ")})`);

const env = { ...(await readEnvFile(".env")), ...process.env };
const transcript = JSON.parse(await fs.readFile(path.join(e.videoDir, "transcript.json"), "utf8"));
const video = path.join(e.videoDir, "video.mp4");
const hasVideo = await fs.access(video).then(() => true, () => false);
const gPath = bible.series?.inputs?.glossary;
const glossary = gPath ? JSON.parse(await fs.readFile(gPath, "utf8").catch(() => "{}")) : {};
const outRoot = bible.series?.inputs?.outRoot || path.join("out", path.basename(a.series));
const outDir = a.out || path.join(outRoot, "v2", epDir(a.ep));

const t0 = Date.now();
const { report } = await runEpisode({
  transcript, biblePath, ep: String(a.ep), outDir,
  video: hasVideo ? video : null, dataDir: e.videoDir, glossary,
  cps: a.cps ? Number(a.cps) : 4.5,
  force: a.force ? String(a.force) : [],
  review: Boolean(a.review), skipReview: Boolean(a["skip-review"]),
  writeBack: Boolean(a["write-back"]), noVision: Boolean(a["no-vision"]),
  env, log,
});

const min = ((Date.now() - t0) / 60_000).toFixed(1);
if (report.review?.stopped) {
  console.log(`\n[cổng soát] ${report.review.why}`);
  console.log(`  mở: ${report.review.page}`);
  console.log(`  soát xong bấm Xuất JSON rồi: node src/zhvi2/cli.js --apply ~/Downloads/speaker-review.json --series ${a.series}`);
  console.log(`  rồi chạy lại lệnh này (U dùng lại, đi thẳng tới dịch). ${min} phút.`);
} else {
  console.log(`\nxong tập ${a.ep}: ${report.segments} câu, ${report.needsReview} cần xem lại -> ${outDir}/translation.json (${min} phút)`);
  if (!a["write-back"]) console.log("  chưa ghi vào thư mục video; thêm --write-back khi muốn dub dùng bản này");
}
