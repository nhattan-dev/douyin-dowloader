/**
 * Cắt giọng của MỘT nhân vật ra khỏi audio gốc, tách nhạc nền, xuất bộ mẫu sẵn sàng
 * cho voice-clone / lồng tiếng.
 *
 * Nguồn nhãn người nói là `transcript.json` của video (field `speaker`) — nên chất
 * lượng đầu ra phụ thuộc vào nhãn đó đúng tới đâu; video nào đã soát tay
 * (`speakerSource: "verified"`) thì dùng được ngay, video chưa soát nên xem lại
 * `speaker-review.txt` trước.
 *
 * Vì sao ghép hết rồi mới chạy demucs, thay vì chạy từng đoạn: demucs là neural net
 * CPU, chi phí gần như tỉ lệ với TỔNG số giây và có overhead cố định mỗi lần gọi —
 * gộp 19 đoạn thành 1 file ~70s rẻ hơn nhiều so với 19 lần gọi, và cũng rẻ hơn hẳn
 * so với tách cả file gốc 10 phút rồi mới cắt.
 *
 * Usage:
 *   node scripts/extract-voice.js --dir data/<user>/<video> --speaker 孙悟空
 *   node scripts/extract-voice.js --user <user_id> --video <video_id> --speaker 孙悟空
 * Options:
 *   --pad <s>      đệm thêm mỗi đầu đoạn (mặc định 0.15), tự co lại nếu đụng đoạn kế
 *   --ref <s>      độ dài file reference.wav (mặc định 30)
 *   --sr <hz>      sample rate đầu ra (mặc định 24000, mono 16-bit)
 *   --min <s>      bỏ qua đoạn ngắn hơn ngần này khi chọn reference (mặc định 1.5)
 *   --raw          bỏ qua demucs, xuất thẳng audio gốc đã cắt
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { findAudioFile } from "../src/stt.js";

const run = promisify(execFile);
// PYTHONUTF8: demucs in đường dẫn ra stdout; trên Windows khi bị pipe Python dùng cp1252 và
// chết UnicodeEncodeError ngay khi thư mục có tên tiếng Trung (voice/苏然/...).
const sh = (cmd, args) => run(cmd, args, {
  maxBuffer: 1024 * 1024 * 64,
  env: { ...process.env, PYTHONUTF8: "1" },
});

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function probeDuration(file) {
  const { stdout } = await sh("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    file,
  ]);
  return Number.parseFloat(stdout.trim());
}

const fmt = (n) => n.toFixed(2).padStart(7);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir
    ? path.resolve(args.dir)
    : args.user && args.video
      ? path.resolve("data", args.user, args.video)
      : null;
  if (!dir || !args.speaker || args.speaker === true) {
    console.error("cần --dir <videoDir> (hoặc --user + --video) và --speaker <tên>");
    process.exit(1);
  }

  const pad = Number.parseFloat(args.pad ?? "0.15");
  const refSeconds = Number.parseFloat(args.ref ?? "30");
  const sr = Number.parseInt(args.sr ?? "24000", 10);
  const minSeg = Number.parseFloat(args.min ?? "1.5");
  const separate = !args.raw;

  const transcript = JSON.parse(await fs.readFile(path.join(dir, "transcript.json"), "utf8"));
  const audio = await findAudioFile(dir);
  const totalDuration = await probeDuration(audio);

  const segments = transcript.segments ?? [];
  const picked = segments.filter((s) => s.speaker === args.speaker);
  if (!picked.length) {
    const có = [...new Set(segments.map((s) => s.speaker))].join(", ");
    console.error(`không có đoạn nào của "${args.speaker}". Có: ${có}`);
    process.exit(1);
  }

  // Đệm chỉ được lấn vào khoảng lặng, không lấn sang câu của người khác — nếu không
  // mẫu clone sẽ dính đuôi giọng khác, đúng thứ làm hỏng voice-clone nặng nhất.
  // Hai đoạn liền nhau của cùng nhân vật thì chia đôi khoảng lặng giữa chúng, để
  // ghép lại không bị lặp mất một mẩu.
  const windows = picked.map((seg) => {
    const idx = segments.indexOf(seg);
    const prev = idx > 0 ? segments[idx - 1] : null;
    const next = idx < segments.length - 1 ? segments[idx + 1] : null;
    const floor = prev ? (prev.speaker === seg.speaker ? (prev.end + seg.start) / 2 : prev.end) : 0;
    const ceil = next
      ? next.speaker === seg.speaker
        ? (seg.end + next.start) / 2
        : next.start
      : totalDuration;
    return {
      seg,
      start: Math.max(0, seg.start - pad, floor),
      end: Math.min(totalDuration, seg.end + pad, ceil),
    };
  });

  // "/" trong tên nhân vật (vd. cast_sheet gộp nhiều tên vào 1 cụm giọng, nối bằng
  // " / ") bị path.join hiểu thành phân cách thư mục — đẻ ra cây thư mục lồng nhau
  // ngoài ý muốn thay vì 1 folder phẳng. Chỉ đổi tên THƯ MỤC, giữ nguyên args.speaker
  // ở mọi chỗ khác (khớp transcript, ghi vào manifest.json) để không lệch dữ liệu.
  const folderName = args.speaker.replace(/[/\\]/g, "_").trim();
  const outDir = path.join(dir, "voice", folderName);
  const tmpDir = path.join(outDir, "_tmp");
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });

  // Bước 1: cắt từng đoạn ở 44.1kHz stereo — định dạng gốc demucs làm việc.
  console.log(`[1/4] cắt ${windows.length} đoạn của ${args.speaker}`);
  const clips = [];
  for (const [i, w] of windows.entries()) {
    const file = path.join(tmpDir, `cut-${String(i).padStart(2, "0")}.wav`);
    await sh("ffmpeg", [
      "-v", "error", "-y",
      "-ss", String(w.start), "-to", String(w.end),
      "-i", audio,
      "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le",
      file,
    ]);
    clips.push({ ...w, file, dur: await probeDuration(file) });
  }

  // Bước 2: ghép (chèn 0.6s lặng giữa các đoạn để demucs không dính đuôi câu này vào
  // đầu câu kia) → 1 lần gọi demucs cho cả bộ.
  let source = clips;
  if (separate) {
    const gap = 0.6;
    const silence = path.join(tmpDir, "gap.wav");
    await sh("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", `anullsrc=r=44100:cl=stereo`,
      "-t", String(gap), "-c:a", "pcm_s16le",
      silence,
    ]);
    const listFile = path.join(tmpDir, "concat.txt");
    const lines = [];
    for (const [i, c] of clips.entries()) {
      if (i > 0) lines.push(`file '${silence}'`);
      lines.push(`file '${c.file}'`);
    }
    await fs.writeFile(listFile, lines.join("\n"), "utf8");
    const joined = path.join(tmpDir, "joined.wav");
    await sh("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:a", "pcm_s16le", joined]);

    console.log(`[2/4] demucs tách nhạc nền trên ${(await probeDuration(joined)).toFixed(1)}s`);
    const t0 = Date.now();
    const demucsOut = path.join(tmpDir, "demucs");
    await sh("demucs", ["--two-stems=vocals", "-n", "htdemucs", "-o", demucsOut, joined]);
    console.log(`      xong trong ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const vocals = path.join(demucsOut, "htdemucs", "joined", "vocals.wav");
    await fs.access(vocals);

    // Cắt ngược lại theo offset tích luỹ (dùng độ dài THẬT của từng file, ffmpeg có
    // thể lệch vài sample so với khoảng thời gian yêu cầu).
    let offset = 0;
    source = [];
    for (const [i, c] of clips.entries()) {
      const file = path.join(tmpDir, `clean-${String(i).padStart(2, "0")}.wav`);
      await sh("ffmpeg", ["-v", "error", "-y", "-ss", String(offset), "-t", String(c.dur),
        "-i", vocals, "-c:a", "pcm_s16le", file]);
      source.push({ ...c, file });
      offset += c.dur + gap;
    }
  }

  // Bước 3: xuất từng clip ở định dạng mono/16-bit mà các API clone đều nhận.
  console.log(`[3/4] xuất clip mono ${sr}Hz`);
  const manifest = [];
  for (const [i, c] of source.entries()) {
    const name = `${String(i + 1).padStart(2, "0")}.wav`;
    await sh("ffmpeg", ["-v", "error", "-y", "-i", c.file,
      "-ac", "1", "-ar", String(sr), "-c:a", "pcm_s16le", path.join(outDir, name)]);
    manifest.push({
      file: name,
      start: Number(c.start.toFixed(2)),
      end: Number(c.end.toFixed(2)),
      duration: Number(c.dur.toFixed(2)),
      text: c.seg.text,
    });
  }

  // Bước 4: 2 file ghép sẵn — all.wav để nghe soát, reference.wav để nạp cho clone.
  // Reference ưu tiên đoạn dài (câu dài mang đủ ngữ điệu hơn câu 1 chữ) nhưng vẫn
  // xếp lại theo thứ tự thời gian cho tự nhiên.
  console.log("[4/4] ghép all.wav + reference.wav");
  const makeJoined = async (items, outFile) => {
    const listFile = path.join(tmpDir, `${path.basename(outFile, ".wav")}.txt`);
    await fs.writeFile(listFile, items.map((c) => `file '${c.file}'`).join("\n"), "utf8");
    await sh("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-af", "loudnorm=I=-18:TP=-1.5:LRA=11",
      "-ac", "1", "-ar", String(sr), "-c:a", "pcm_s16le", outFile]);
  };
  await makeJoined(source, path.join(outDir, "all.wav"));

  const ranked = [...source.entries()]
    .filter(([, c]) => c.dur >= minSeg)
    .sort((a, b) => b[1].dur - a[1].dur);
  const chosen = [];
  let acc = 0;
  for (const entry of ranked) {
    if (acc >= refSeconds) break;
    chosen.push(entry);
    acc += entry[1].dur;
  }
  chosen.sort((a, b) => a[0] - b[0]);
  await makeJoined(chosen.map(([, c]) => c), path.join(outDir, "reference.wav"));

  const refText = chosen.map(([i]) => manifest[i].text).join("");
  await fs.writeFile(
    path.join(outDir, "reference.txt"),
    `${refText}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify({
      videoId: transcript.videoId,
      speaker: args.speaker,
      speakerSource: picked[0].speakerSource ?? null,
      separated: separate,
      sampleRate: sr,
      totalSeconds: Number(source.reduce((s, c) => s + c.dur, 0).toFixed(2)),
      reference: { file: "reference.wav", seconds: Number(acc.toFixed(2)), text: refText,
        clips: chosen.map(([i]) => manifest[i].file) },
      clips: manifest,
    }, null, 2)}\n`,
    "utf8",
  );

  await fs.rm(tmpDir, { recursive: true, force: true });

  console.log(`\n→ ${outDir}`);
  for (const [i, m] of manifest.entries()) {
    const mark = chosen.some(([j]) => j === i) ? "★" : " ";
    console.log(`  ${mark} ${m.file}  ${fmt(m.start)}-${fmt(m.end)}  ${m.duration.toFixed(2).padStart(5)}s  ${m.text}`);
  }
  console.log(`\n  all.wav       ${source.reduce((s, c) => s + c.dur, 0).toFixed(1)}s (toàn bộ)`);
  console.log(`  reference.wav ${acc.toFixed(1)}s (★, kèm reference.txt để làm prompt text)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
