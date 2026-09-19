// Thử voice cloning của VieNeu (TTS tiếng Việt, có clone) — ứng viên thay cả
// chuỗi "TTS giọng hệ thống → seed-vc đổi âm sắc" bằng MỘT tầng tổng hợp.
//
// Vì sao đáng thử: đo được rằng bước voice conversion ăn đứt 1 điểm/5 độ tự nhiên
// và không núm nào lấy lại được (xem scripts/voice-convert.mjs). Nguyên nhân là
// chồng tổng hợp lên tổng hợp. VieNeu clone rồi đọc thẳng tiếng Việt thì chỉ còn
// một tầng — nếu âm sắc đủ giống thì nó thắng cả hai mặt cùng lúc.
//
// Câu hỏi chặn đường: doc VieNeu nói "mẫu nên là tiếng Việt", nhưng mẫu mình có là
// TIẾNG TRUNG. Nên probe này so hai loại mẫu:
//   zh  — clip gốc của nhân vật + `refText` tiếng Trung lấy từ transcript.json
//   vi  — bản seed-vc (tiếng Việt, giọng nhân vật) + `refText` tiếng Việt
// Cách "vi" là đường vòng: seed-vc chỉ còn đóng vai sinh MẪU, không còn nằm trong
// đường tổng hợp chính, nên nhiễu của nó không đi vào từng câu output nữa.
//
// Dùng:
//   node --env-file-if-exists=.env scripts/vieneu-clone-probe.mjs --dir <videoDir> --speaker 孙悟空
//   ... --lines 3        số câu đem thử
//   ... --engine v3,v4   engine đem so (v4 là bản premium làm riêng cho cloning)
//   ... --ref zh,vi      loại mẫu đem so
import fs from "node:fs/promises";
import path from "node:path";

import { alignChars, normalize } from "../src/align.js";
import { fetchBufferLogged, fetchLogged } from "../src/apiLog.js";
import { transcribeQwenAsr } from "../src/asr-qwen.js";
import { createLogger } from "../src/logger.js";

const log = createLogger("VIENEU");

const BASE = "https://api.vieneu.io/api/v1";
const ASR_MODEL = "qwen-audio-3.0-asr-flash-filetrans";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next === undefined || next.startsWith("--") ? true : argv[++i];
  }
  return out;
}
const str = (v, fallback) => (v === undefined || v === true ? fallback : v);

// Tên biến trong .env của máy này là VIENUE_KEY (đánh máy lệch so với tên hãng);
// nhận cả tên đúng để ai chép .env.example sang cũng chạy.
const apiKey = () => {
  const k = process.env.VIENUE_KEY?.trim() || process.env.VIENEU_API_KEY?.trim();
  if (!k) throw new Error("thiếu VIENUE_KEY trong .env");
  return k;
};

async function api(pathname, { method = "POST", body, form } = {}) {
  const { res, raw, json: parsed } = await fetchLogged(log, BASE + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      ...(form ? {} : { "Content-Type": "application/json" }),
    },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  }, { logBody: form ?? body });
  if (raw && (parsed === null || typeof parsed !== "object")) {
    throw new Error(`VieNeu ${res.status}: không parse được — ${raw.slice(0, 300)}`);
  }
  const json = parsed && typeof parsed === "object" ? parsed : {};
  if (!res.ok) throw new Error(`VieNeu ${res.status}: ${json.message ?? raw.slice(0, 300)}`);
  return json;
}

async function upload(file) {
  const form = new FormData();
  form.append("file", new Blob([await fs.readFile(file)], { type: "audio/wav" }), path.basename(file));
  const json = await api("/upload", { form });
  return json.fileId;
}

/**
 * Tải file audio đã tổng hợp.
 *
 * `audioUrl` được ký TRƯỚC khi object ghi xong lên S3, nên tải ngay đôi khi nhận về
 * một tài liệu XML `NoSuchKey` mang status 200 — ffmpeg đọc nó rồi báo lỗi "Invalid
 * argument" ở tận bước sau, rất khó lần ra. Kiểm tra luôn phần đầu file: XML là
 * chưa sẵn sàng, đợi rồi thử lại.
 */
async function download(url, tries = 6) {
  for (let i = 0; ; i += 1) {
    const { buf } = await fetchBufferLogged(log, url);
    if (buf.length > 1000 && buf.subarray(0, 5).toString() !== "<?xml") return buf;
    if (i >= tries) throw new Error(`audio chưa sẵn sàng sau ${tries} lần thử: ${buf.subarray(0, 120)}`);
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
}

const matchRate = (sent, heard) => {
  const a = normalize(sent.toLowerCase()).chars;
  const b = normalize(heard.toLowerCase()).chars;
  return a.length ? alignChars(a, b).matches / a.length : 0;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(str(args.dir, ""));
  const speaker = str(args.speaker, "");
  if (!args.dir || !speaker) throw new Error("cần --dir <videoDir> và --speaker <tên>");
  const nLines = Number.parseInt(str(args.lines, "3"), 10);
  const engines = str(args.engine, "v3,v4").split(",");
  const refKinds = str(args.ref, "zh,vi").split(",");

  const outDir = path.join(dir, "temp", "vieneu");
  await fs.mkdir(outDir, { recursive: true });

  const voiceDir = path.join(dir, "voice", speaker);
  const vcDir = path.join(dir, "temp", "voice-convert");
  const manifest = JSON.parse(await fs.readFile(path.join(voiceDir, "manifest.json"), "utf8"));
  const vcReport = JSON.parse(await fs.readFile(path.join(vcDir, "report.json"), "utf8"));

  // Mẫu: doc VieNeu khuyên 3-5s, dài hơn là phí ngữ cảnh chứ không tốt thêm.
  const inRange = (d) => d >= 3 && d <= 5.5;
  const refs = {};
  if (refKinds.includes("zh")) {
    const clip = manifest.clips.filter((c) => inRange(c.duration)).sort((a, b) => b.duration - a.duration)[0]
      ?? manifest.clips.sort((a, b) => b.duration - a.duration)[0];
    refs.zh = { file: path.join(voiceDir, clip.file), text: clip.text, note: `${clip.duration}s tiếng Trung` };
  }
  if (refKinds.includes("vi")) {
    const line = vcReport.lines.filter((l) => l.after && inRange(l.after.seconds)).sort((a, b) => b.after.seconds - a.after.seconds)[0]
      ?? vcReport.lines.filter((l) => l.after).sort((a, b) => b.after.seconds - a.after.seconds)[0];
    refs.vi = { file: path.join(vcDir, line.after.file), text: line.vi, note: `${line.after.seconds}s tiếng Việt (seed-vc)` };
  }

  for (const [kind, r] of Object.entries(refs)) {
    process.stdout.write(`mẫu ${kind}: ${r.note} — "${r.text.slice(0, 40)}" … `);
    r.fileId = await upload(r.file);
    console.log(`uploaded ${r.fileId}`);
  }

  const translation = JSON.parse(await fs.readFile(path.join(dir, "translation.json"), "utf8"));
  const lines = translation.segments.filter((s) => s.speaker === speaker && s.vi).slice(0, nLines);

  const results = [];
  for (const kind of Object.keys(refs)) {
    for (const engine of engines) {
      const tag = `${kind}-${engine}`;
      const files = [];
      let sumRate = 0;
      for (const [i, seg] of lines.entries()) {
        const json = await api("/clone", {
          body: { text: seg.vi, refFileId: refs[kind].fileId, refText: refs[kind].text, engine },
        });
        const url = json.audioUrl ?? json.url;
        if (!url) throw new Error(`/clone không trả audioUrl: ${JSON.stringify(json).slice(0, 200)}`);
        const ext = new URL(url).pathname.match(/\.(\w+)$/)?.[1] ?? "wav";
        const file = path.join(outDir, `${tag}-${String(i + 1).padStart(2, "0")}.${ext}`);
        await fs.writeFile(file, await download(url));
        const heard = (await transcribeQwenAsr(file, ASR_MODEL)).text;
        sumRate += matchRate(seg.vi, heard);
        files.push(file);
      }
      // Ghép lại để chấm âm sắc và độ tự nhiên trên cả chuỗi (clip rời quá ngắn
      // làm ASR nhận nhầm ngôn ngữ — xem scripts/voice-convert.mjs).
      const listFile = path.join(outDir, `${tag}.txt`);
      await fs.writeFile(listFile, files.map((f) => `file '${f}'`).join("\n"), "utf8");
      const joined = path.join(outDir, `${tag}.wav`);
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0",
        "-i", listFile, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", joined]);
      const full = lines.map((l) => l.vi).join(" ");
      const heardAll = (await transcribeQwenAsr(joined, ASR_MODEL)).text;
      const row = { tag, ref: kind, engine, joined, perLine: sumRate / lines.length, whole: matchRate(full, heardAll), heard: heardAll };
      results.push(row);
      console.log(`${tag.padEnd(8)} đọc đúng cả chuỗi ${(row.whole * 100).toFixed(0)}%  ${heardAll.slice(0, 80)}`);
    }
  }

  await fs.writeFile(path.join(outDir, "report.json"),
    `${JSON.stringify({ speaker, refs, results }, null, 2)}\n`, "utf8");
  console.log(`\n→ ${outDir}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
