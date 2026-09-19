import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sh = (cmd, args) => run(cmd, args, { maxBuffer: 1024 * 1024 * 64 });

/** Độ dài thật của file audio (giây). */
export async function probeDuration(file) {
  const { stdout } = await sh("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
  ]);
  return Number.parseFloat(stdout.trim());
}

/**
 * Gom các clip đã cắt sẵn của một nhân vật (`scripts/extract-voice.js`) thành MỘT
 * mẫu giọng dài `seconds` giây.
 *
 * Ưu tiên câu dài rồi mới xếp lại theo thời gian: câu dài mang đủ ngữ điệu và ít
 * nhiễu đầu/cuối hơn câu một hai chữ, nhưng nghe theo đúng thứ tự trong phim thì
 * mẫu vẫn liền mạch tự nhiên.
 *
 * Cả voice-clone (API đăng ký âm sắc) lẫn voice-conversion (seed-vc) đều cần đúng
 * thứ này với độ dài khác nhau, nên để chung một chỗ.
 */
export async function buildSample({ voiceDir, seconds = 18, outPath, sampleRate = 24000, tmpDir }) {
  const manifest = JSON.parse(await fs.readFile(path.join(voiceDir, "manifest.json"), "utf8"));

  const chosen = [];
  let acc = 0;
  for (const clip of [...manifest.clips].sort((a, b) => b.duration - a.duration)) {
    if (acc >= seconds) break;
    chosen.push(clip);
    acc += clip.duration;
  }
  chosen.sort((a, b) => a.start - b.start);

  const listFile = path.join(tmpDir ?? path.dirname(outPath), `${path.basename(outPath, ".wav")}.txt`);
  await fs.writeFile(listFile, chosen.map((c) => `file '${path.join(voiceDir, c.file)}'`).join("\n"), "utf8");
  await sh("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-ac", "1", "-ar", String(sampleRate), "-c:a", "pcm_s16le", outPath]);

  return { path: outPath, clips: chosen, seconds: await probeDuration(outPath) };
}
