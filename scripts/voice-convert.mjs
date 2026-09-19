// Lồng tiếng Việt bằng ĐÚNG âm sắc nhân vật gốc, KHÔNG cần voice cloning.
//
// Bối cảnh: `voice-enrollment` của DashScope trả 403 AccessDenied.Unpurchased trên
// tài khoản này (đo 2026-09-05, cả key cũ lẫn key mới không giới hạn quyền), nên
// đường đăng ký âm sắc đang tắc. Nhưng bài toán thật không phải "clone" mà là
// "tiếng Việt, giọng nhân vật" — và voice conversion giải thẳng bài đó:
//
//   translation.json (vi) ──TTS qwen-audio-3.0-tts-plus──> tiếng Việt, giọng hệ thống
//                          ──seed-vc, mẫu = clip tiếng Trung──> tiếng Việt, giọng nhân vật
//
// VC lấy NỘI DUNG từ source và ÂM SẮC từ mẫu, nên ngôn ngữ của mẫu không liên quan
// — mẫu tiếng Trung là hợp lệ theo thiết kế, không phải mẹo lách. Nó cũng gỡ luôn
// nút thắt "-plus chỉ có 2 giọng hệ thống cho 7 nhân vật" (xem tts-probe.mjs).
//
// Đo chất lượng: đưa bản trước và sau VC vào ASR rồi so với câu gửi đi.
//
// ĐIỂM CHÍNH LÀ ĐIỂM CHẤM TRÊN CẢ FILE GHÉP, không phải trung bình từng clip. Clip
// ngắn (<2s) tách rời làm ASR nhận nhầm ngôn ngữ sau khi VC đã phủ âm sắc tiếng
// Trung lên: cùng một file, chấm cả chuỗi được 95%, chấm từng clip rồi lấy trung
// bình chỉ 57%, với mấy clip ngắn ra 0% vì bị đọc thành tiếng Trung — nghe kỹ thì
// `躲猫，卢一达` chính là "Tớ ngốc, lui ra". Điểm từng clip vẫn ghi lại trong
// report.json nhưng chỉ để soi tương đối, ĐỪNG dùng nó làm tiêu chí đạt/trượt.
//
// VÌ SAO GHÉP HẾT RỒI MỚI VC, thay vì VC từng câu (đo 2026-09-06, 4 câu 悟空):
//   VC từng câu   : 94%, 92%, 50%, 0%  → trung bình 59%
//   ghép rồi VC   : 85% cho cả chuỗi, câu ngắn hết vỡ
// Câu ngắn (<2s) VC riêng thì vỡ hẳn — "Đồ ngốc, lui ra!" ra `懂了，来吧！`. Mẫu âm
// sắc là tiếng Trung, đoạn quá ngắn không đủ ngữ cảnh nên model kéo phát âm về phía
// tiếng Trung. Hạ `similarity-cfg-rate` xuống 0.4 hay nâng `intelligibility` lên 0.9
// + 50 bước đều KHÔNG cứu được (vẫn 0%, chỉ đổi từ tiếng Trung sang tiếng Thái) —
// đừng thử lại hướng chỉnh tham số. Ngữ cảnh dài mới là thứ chữa được.
//
// Ghép có chèn khoảng lặng rồi cắt ngược ra theo offset, nên vẫn có file rời từng
// câu để xếp vào timeline. seed-vc giữ nguyên độ dài (đo: 12.696s → 12.690s, lệch
// 0.05%), offset vẫn nhân theo tỉ lệ ra/vào cho chắc.
//
// VÌ SAO V1 (`inference.py`) CHỨ KHÔNG PHẢI V2 (`inference_v2.py`) — đo cùng 6 câu,
// cùng mẫu âm sắc, cùng 30 bước:
//                        nghe rõ (ASR)   giống 悟空 (resemblyzer)   tốc độ
//   TTS chưa VC               100%              0.686               —
//   seed-vc V2                 89%              0.846              RTF 4.7
//   seed-vc V1                 96%              0.859              RTF 1.3
//   chính giọng 悟空 (đối chiếu) —               0.966               —
// V1 thắng cả ba. V2 có thêm module tự hồi quy, hay "sáng tác" lại phần nó không
// chắc — với tiếng Việt (không nằm trong dữ liệu huấn luyện chính) thì đó là tai
// hoạ chứ không phải điểm cộng.
//
// Dùng:
//   node --env-file-if-exists=.env scripts/voice-convert.mjs --dir <videoDir> --speaker 孙悟空
//   ... --lines 4         số câu đem thử (mặc định 4)
//   ... --ref-seconds 18  độ dài mẫu âm sắc trích từ voice/<speaker>/
//   ... --voice <id>      giọng hệ thống đọc bản nguồn (mặc định longanlufeng)
//   ... --instruct "..."  chỉ dẫn diễn cảm chung cho mọi câu (tiếng Việt/Anh/Trung
//                         đều ăn). Từng câu có `instruction` riêng trong
//                         translation.json thì câu đó thắng chỉ dẫn chung.
//   ... --steps 30        diffusion steps của seed-vc, cao hơn = chậm + mượt hơn
//   ... --v2              dùng seed-vc V2 thay vì V1 (ĐO ĐƯỢC LÀ TỆ HƠN, xem dưới)
//   ... --per-line        VC riêng từng câu thay vì ghép (ĐO ĐƯỢC LÀ TỆ HƠN, xem dưới)
//   ... --seed-vc <path>  thư mục cài seed-vc (mặc định ../../tools/seed-vc)
//   ... --skip-vc         chỉ sinh bản TTS nguồn rồi dừng (khi seed-vc chưa cài xong)
//
// Ghi ra <videoDir>/temp/voice-convert/.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { alignChars, normalize } from "../src/align.js";
import { fetchBufferLogged, fetchLogged } from "../src/apiLog.js";
import { transcribeQwenAsr } from "../src/asr-qwen.js";
import { config } from "../src/config.js";
import { createLogger } from "../src/logger.js";

const log = createLogger("VOICE-CONVERT");
import { buildSample, probeDuration } from "../src/voice-sample.js";

const run = promisify(execFile);
const sh = (cmd, args, opts) => run(cmd, args, { maxBuffer: 1024 * 1024 * 64, ...opts });

const TTS_MODEL = "qwen-audio-3.0-tts-plus"; // bản duy nhất đọc được tiếng Việt
const ASR_MODEL = "qwen-audio-3.0-asr-flash-filetrans";
const DEFAULT_VOICE = "longanlufeng";

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

function requireConfig(value, name) {
  if (!value) throw new Error(`thiếu ${name} — thêm vào .env`);
  return value;
}

/** TTS 1 câu qua route native DashScope, trả Buffer mp3. Lùi khi 429 như tts-probe. */
async function synthesize(text, voice, instruction) {
  const base = requireConfig(config.dashscopeBaseUrl, "DASHSCOPE_BASE_URL").replace(/\/+$/, "");
  const key = requireConfig(config.dashscopeApiKey, "DASHSCOPE_API_KEY");
  for (let attempt = 0; ; attempt += 1) {
    const payload = {
      model: TTS_MODEL,
      input: { text, voice, format: "mp3", sample_rate: 24000, ...(instruction ? { instruction } : {}) },
    };
    const { res, raw } = await fetchLogged(
      log,
      `${base}/api/v1/services/audio/tts/SpeechSynthesizer`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      { logBody: payload },
    );
    const json = raw ? JSON.parse(raw) : {};
    if (res.ok) {
      const audio = json.output?.audio;
      if (audio?.data) return Buffer.from(audio.data, "base64");
      if (audio?.url) return (await fetchBufferLogged(log, audio.url)).buf;
      throw new Error(`response không có audio: ${JSON.stringify(json).slice(0, 200)}`);
    }
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    throw new Error(`DashScope ${res.status}: ${json.code ?? "?"} — ${json.message ?? raw.slice(0, 200)}`);
  }
}

/** Tỉ lệ ký tự khớp giữa câu gửi đi và câu ASR nghe lại. */
function matchRate(sent, heard) {
  const a = normalize(sent.toLowerCase()).chars;
  const b = normalize(heard.toLowerCase()).chars;
  if (!a.length) return 0;
  return alignChars(a, b).matches / a.length;
}

/**
 * Gọi seed-vc cho 1 câu. Script của nó tự đặt tên file theo tham số nên không đoán
 * trước được — cho ghi vào thư mục riêng từng câu rồi lấy file wav duy nhất ra.
 */
async function convert({ seedVcDir, source, target, outDir, steps, v2 }) {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const args = v2
    ? ["inference_v2.py", "--similarity-cfg-rate", "0.7", "--intelligibility-cfg-rate", "0.7"]
    : ["inference.py", "--inference-cfg-rate", "0.7"];
  await sh(path.join(seedVcDir, ".venv/bin/python"), [
    ...args,
    "--source", source,
    "--target", target,
    "--output", outDir,
    "--diffusion-steps", String(steps),
  ], { cwd: seedVcDir, env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: "1" } });
  const made = (await fs.readdir(outDir)).filter((f) => f.endsWith(".wav"));
  if (!made.length) throw new Error(`seed-vc không sinh ra file wav nào trong ${outDir}`);
  return path.join(outDir, made[0]);
}

/** VC riêng từng câu — giữ lại để đo đối chứng, KHÔNG phải mặc định. */
async function convertPerLine({ sources, sample, outDir, seedVcDir, steps, v2 }) {
  const outs = [];
  for (const src of sources) {
    const raw = await convert({
      seedVcDir, source: src.file, target: sample.path,
      outDir: path.join(outDir, `_vc-${src.tag}`), steps, v2,
    });
    const outFile = path.join(outDir, `out-${src.tag}.wav`);
    await sh("ffmpeg", ["-v", "error", "-y", "-i", raw, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", outFile]);
    await fs.rm(path.join(outDir, `_vc-${src.tag}`), { recursive: true, force: true });
    outs.push(outFile);
  }
  return outs;
}

/**
 * Ghép hết → VC một lần → cắt ngược ra. Khoảng lặng giữa các câu vừa cho model một
 * ranh giới rõ ràng, vừa là chỗ để sai số offset rơi vào mà không xén mất tiếng.
 */
async function convertJoined({ sources, sample, outDir, seedVcDir, steps, v2 }) {
  const GAP = 0.5;
  const tmp = path.join(outDir, "_joined");
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });

  const silence = path.join(tmp, "gap.wav");
  await sh("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
    "-t", String(GAP), "-c:a", "pcm_s16le", silence]);

  // Chuẩn hoá về cùng wav 24k mono trước khi nối, để offset tính được bằng số học.
  const parts = [];
  for (const src of sources) {
    const wav = path.join(tmp, `${src.tag}.wav`);
    await sh("ffmpeg", ["-v", "error", "-y", "-i", src.file, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", wav]);
    parts.push({ ...src, wav, dur: await probeDuration(wav) });
  }
  const listFile = path.join(tmp, "list.txt");
  const lines = [];
  for (const [i, p] of parts.entries()) {
    if (i > 0) lines.push(`file '${silence}'`);
    lines.push(`file '${p.wav}'`);
  }
  await fs.writeFile(listFile, lines.join("\n"), "utf8");
  const joinedSrc = path.join(tmp, "src-joined.wav");
  await sh("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-c:a", "pcm_s16le", joinedSrc]);

  console.log(`\nVC 1 lượt trên ${(await probeDuration(joinedSrc)).toFixed(1)}s…`);
  const t0 = Date.now();
  const raw = await convert({ seedVcDir, source: joinedSrc, target: sample.path, outDir: path.join(tmp, "out"), steps, v2 });
  console.log(`  xong trong ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // seed-vc giữ độ dài nhưng lệch vài ms — co giãn offset theo tỉ lệ thật.
  const scale = (await probeDuration(raw)) / (await probeDuration(joinedSrc));
  const outs = [];
  let offset = 0;
  for (const p of parts) {
    const outFile = path.join(outDir, `out-${p.tag}.wav`);
    await sh("ffmpeg", ["-v", "error", "-y", "-ss", String(offset * scale), "-t", String(p.dur * scale),
      "-i", raw, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", outFile]);
    outs.push(outFile);
    offset += p.dur + GAP;
  }
  await fs.rm(tmp, { recursive: true, force: true });
  return outs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(str(args.dir, ""));
  const speaker = str(args.speaker, "");
  if (!args.dir || !speaker) throw new Error("cần --dir <videoDir> và --speaker <tên>");

  const nLines = Number.parseInt(str(args.lines, "4"), 10);
  const refSeconds = Number.parseFloat(str(args["ref-seconds"], "18"));
  const steps = Number.parseInt(str(args.steps, "30"), 10);
  const sysVoice = str(args.voice, DEFAULT_VOICE);
  const globalInstruct = str(args.instruct, null);
  const seedVcDir = path.resolve(str(args["seed-vc"], path.join(import.meta.dirname, "../../../tools/seed-vc")));

  const outDir = path.join(dir, "temp", "voice-convert");
  await fs.mkdir(outDir, { recursive: true });

  // ── mẫu âm sắc (tiếng Trung) ────────────────────────────────────────────
  const voiceDir = path.join(dir, "voice", speaker);
  const sample = await buildSample({
    voiceDir,
    seconds: refSeconds,
    outPath: path.join(outDir, "ref.wav"),
  });
  console.log(`mẫu âm sắc: ${sample.clips.length} câu, ${sample.seconds.toFixed(1)}s`);

  // ── câu tiếng Việt ──────────────────────────────────────────────────────
  const translation = JSON.parse(await fs.readFile(path.join(dir, "translation.json"), "utf8"));
  const lines = translation.segments.filter((s) => s.speaker === speaker && s.vi).slice(0, nLines);
  if (!lines.length) throw new Error(`không có câu tiếng Việt nào của ${speaker}`);

  const report = { speaker, ttsModel: TTS_MODEL, sysVoice, refSeconds: sample.seconds, steps,
    engine: args.v2 ? "seed-vc V2" : "seed-vc V1", instruct: globalInstruct,
    mode: args["per-line"] ? "per-line" : "joined", lines: [] };
  const converted = [];

  // ── bước 1: TTS tiếng Việt từng câu ─────────────────────────────────────
  const sources = [];
  for (const [i, seg] of lines.entries()) {
    const tag = String(i + 1).padStart(2, "0");
    const srcFile = path.join(outDir, `src-${tag}.mp3`);
    const instruction = seg.instruction ?? seg.style ?? globalInstruct;
    await fs.writeFile(srcFile, await synthesize(seg.vi, sysVoice, instruction));
    const heard = (await transcribeQwenAsr(srcFile, ASR_MODEL)).text;
    const row = {
      index: seg.index, zh: seg.zh, vi: seg.vi,
      slotSeconds: Number((seg.end - seg.start).toFixed(2)),
      instruction: instruction ?? null,
      before: {
        file: path.basename(srcFile),
        seconds: Number((await probeDuration(srcFile)).toFixed(2)),
        heard,
        matchRate: Number(matchRate(seg.vi, heard).toFixed(3)),
      },
    };
    console.log(`[${tag}] ${seg.vi}`);
    console.log(`     trước VC  ${row.before.seconds.toFixed(2)}s  khớp ${(row.before.matchRate * 100).toFixed(0)}%`);
    sources.push({ tag, seg, file: srcFile, dur: row.before.seconds });
    report.lines.push(row);
  }

  if (!args["skip-vc"]) {
    // ── bước 2: VC ────────────────────────────────────────────────────────
    const outs = args["per-line"]
      ? await convertPerLine({ sources, sample, outDir, seedVcDir, steps, v2: !!args.v2 })
      : await convertJoined({ sources, sample, outDir, seedVcDir, steps, v2: !!args.v2 });

    // ── bước 3: chấm lại từng câu sau VC ──────────────────────────────────
    for (const [i, outFile] of outs.entries()) {
      const heard = (await transcribeQwenAsr(outFile, ASR_MODEL)).text;
      report.lines[i].after = {
        file: path.basename(outFile),
        seconds: Number((await probeDuration(outFile)).toFixed(2)),
        heard,
        matchRate: Number(matchRate(sources[i].seg.vi, heard).toFixed(3)),
      };
      const a = report.lines[i].after;
      console.log(`[${sources[i].tag}] sau VC    ${a.seconds.toFixed(2)}s  khớp ${(a.matchRate * 100).toFixed(0)}%  ASR: ${a.heard}`);
      converted.push(outFile);
    }
  }

  if (converted.length) {
    const listFile = path.join(outDir, "joined.txt");
    await fs.writeFile(listFile, converted.map((f) => `file '${f}'`).join("\n"), "utf8");
    const joined = path.join(outDir, `vi-${speaker}.wav`);
    await sh("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", joined]);
    const fullText = report.lines.map((l) => l.vi).join(" ");
    const heard = (await transcribeQwenAsr(joined, ASR_MODEL)).text;
    report.joined = {
      file: path.basename(joined),
      seconds: Number((await probeDuration(joined)).toFixed(2)),
      heard,
      matchRate: Number(matchRate(fullText, heard).toFixed(3)),
    };
    console.log(`\n${path.basename(joined)}: ${report.joined.seconds.toFixed(1)}s tiếng Việt, giọng ${speaker}`);
  }

  await fs.writeFile(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const avg = (k) => report.lines.reduce((s, r) => s + (r[k]?.matchRate ?? 0), 0) / (report.lines.length || 1);
  if (report.joined) console.log(`khớp trên cả file ghép: ${(report.joined.matchRate * 100).toFixed(0)}%  ← điểm chính`);
  console.log(`(tham khảo, chấm rời từng clip — nhiễu với clip <2s: trước VC ${(avg("before") * 100).toFixed(0)}%, sau VC ${(avg("after") * 100).toFixed(0)}%)`);
  console.log(`→ ${outDir}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
